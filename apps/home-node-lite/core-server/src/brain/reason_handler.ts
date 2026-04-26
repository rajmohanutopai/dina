/**
 * Task 5.15 — `POST /api/v1/reason`.
 *
 * Synchronous reasoning endpoint. The client submits a query + the
 * active persona; Brain runs:
 *
 *   1. **Intent classify** (task 5.31) → picks sources (vault,
 *      trust_network, provider_services).
 *   2. **Vault query** → caller-supplied `vaultQueryFn` fetches
 *      relevant vault items (when `sources` includes `vault`).
 *   3. **Reason** → caller-supplied `reasonFn` runs the LLM with the
 *      gathered context + produces an answer.
 *   4. **Respond** → returns `{answer, sources_used, reasoning_hint,
 *      elapsed_ms}`. Always synchronous — the caller expects a
 *      single round-trip.
 *
 * **Framework-free**: the handler factory returns a plain
 * `(req) => ReasonHandlerResult` function. The brain-server (5.1-5.7)
 * wraps it in a Fastify route when that app scaffolds. Tests
 * exercise the full flow without HTTP.
 *
 * **Fast + synchronous**: unlike `POST /api/v1/ask` (task 5.17) which
 * has a 3-second fast-path + async fallback, `/reason` is always
 * synchronous. The intent-classifier + single LLM call typically
 * complete in <2s; a timeout caps the response. Callers expecting
 * long LLM chains use `/ask` instead.
 *
 * **Structured failure**: never throws HTTP 500 on LLM / vault
 * errors — the handler returns a structured `failed` outcome with
 * an `error` field the client can render + retry.
 *
 * **Trace correlation** (task 5.58): inbound `X-Request-Id` header
 * is validated + promoted to a `TraceContext` scope so every
 * downstream log line correlates to the reasoning request.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5c task 5.15.
 */

import {
  defaultClassification,
  type IntentClassification,
  type IntentClassifier,
} from './intent_classifier';
import {
  inboundRequestId,
  newRequestId,
  withTrace,
  type TraceContext,
} from '@dina/brain/src/diagnostics/trace_correlation';

export const REASON_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * One vault item the query returned. Shape is intentionally loose —
 * the reasoner treats them as opaque context strings.
 */
export interface VaultItem {
  id: string;
  summary: string;
  /** 0..1 relevance to the query, from the vault's ranking. */
  score: number;
}

export type VaultQueryFn = (input: {
  query: string;
  persona: string;
  personas: string[];
  maxItems?: number;
}) => Promise<VaultItem[]>;

/**
 * LLM reasoning call. Receives the original query + retrieved
 * context + routing hint from the classifier. Returns an opaque
 * answer object (typically `{text, citations[]}`).
 */
export type ReasonFn = (input: {
  query: string;
  persona: string;
  context: VaultItem[];
  classification: IntentClassification;
}) => Promise<{ answer: Record<string, unknown> }>;

export interface ReasonRequest {
  query: string;
  persona: string;
  requestIdHeader?: string | null;
  /** Upper bound on vault items threaded to the reasoner. Default 10. */
  maxVaultItems?: number;
}

export interface ReasonSuccessBody {
  request_id: string;
  answer: Record<string, unknown>;
  intent: {
    sources: IntentClassification['sources'];
    relevant_personas: string[];
    temporal: IntentClassification['temporal'];
    reasoning_hint: string;
  };
  sources_used: { vault_item_ids: string[] };
  elapsed_ms: number;
}

export interface ReasonFailureBody {
  request_id: string;
  error: {
    kind: 'vault_query_failed' | 'reason_failed' | 'timeout' | 'invalid_input';
    message: string;
  };
  intent?: ReasonSuccessBody['intent'];
  elapsed_ms: number;
}

export type ReasonResult =
  | { status: 200; body: ReasonSuccessBody }
  | { status: 500; body: ReasonFailureBody }
  | { status: 504; body: ReasonFailureBody }
  | { status: 400; body: ReasonFailureBody };

export interface ReasonHandlerOptions {
  intentClassifier: Pick<IntentClassifier, 'classify'>;
  vaultQueryFn: VaultQueryFn;
  reasonFn: ReasonFn;
  /** Upper bound on the full pipeline. Default 15s. */
  timeoutMs?: number;
  /** Clock. Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /** Diagnostic hook. */
  onEvent?: (event: ReasonHandlerEvent) => void;
}

export type ReasonHandlerEvent =
  | { kind: 'invalid_input'; reason: string }
  | { kind: 'classified'; id: string; sources: IntentClassification['sources'] }
  | { kind: 'vault_queried'; id: string; itemCount: number }
  | { kind: 'vault_query_failed'; id: string; error: string }
  | { kind: 'reasoned'; id: string; durationMs: number }
  | { kind: 'reason_failed'; id: string; error: string }
  | { kind: 'timed_out'; id: string };

/**
 * Factory for the reason handler. Returns an `(req) => ReasonResult`.
 */
export function createReasonHandler(
  opts: ReasonHandlerOptions,
): (req: ReasonRequest) => Promise<ReasonResult> {
  validateOpts(opts);
  const classifier = opts.intentClassifier;
  const vaultQueryFn = opts.vaultQueryFn;
  const reasonFn = opts.reasonFn;
  const timeoutMs = opts.timeoutMs ?? REASON_DEFAULT_TIMEOUT_MS;
  const nowMsFn = opts.nowMsFn ?? (() => Date.now());
  const onEvent = opts.onEvent;

  return async function handleReason(req: ReasonRequest): Promise<ReasonResult> {
    const start = nowMsFn();
    if (typeof req?.query !== 'string' || req.query.trim() === '') {
      onEvent?.({ kind: 'invalid_input', reason: 'query is empty' });
      const id =
        inboundRequestId(req?.requestIdHeader ?? null) ?? newRequestId();
      return {
        status: 400,
        body: {
          request_id: id,
          error: { kind: 'invalid_input', message: 'query is empty' },
          elapsed_ms: nowMsFn() - start,
        },
      };
    }
    if (typeof req.persona !== 'string' || req.persona.trim() === '') {
      const id =
        inboundRequestId(req.requestIdHeader ?? null) ?? newRequestId();
      return {
        status: 400,
        body: {
          request_id: id,
          error: { kind: 'invalid_input', message: 'persona is empty' },
          elapsed_ms: nowMsFn() - start,
        },
      };
    }

    const id =
      inboundRequestId(req.requestIdHeader ?? null) ?? newRequestId();
    const trace: TraceContext = Object.freeze({
      requestId: id,
      parentId: null,
      startedAtMs: start,
    });

    return withTrace(trace, async () => {
      // Race the whole pipeline against the timeout. `timerHandle` is
      // captured + cleared on pipeline win so we don't leak timers
      // to the Node event loop (test runners flag those as a worker
      // teardown failure).
      const pipelinePromise = runPipeline({
        req,
        id,
        classifier,
        vaultQueryFn,
        reasonFn,
        onEvent,
        nowMsFn,
        start,
      });
      let timerHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<void>((resolve) => {
        timerHandle = setTimeout(() => resolve(), timeoutMs);
      });
      const result = await Promise.race([
        pipelinePromise.then((r) => ({ ok: true as const, value: r })),
        timeoutPromise.then(() => ({ ok: false as const })),
      ]);
      if (timerHandle !== null) clearTimeout(timerHandle);
      if (!result.ok) {
        onEvent?.({ kind: 'timed_out', id });
        return {
          status: 504,
          body: {
            request_id: id,
            error: {
              kind: 'timeout',
              message: `reason pipeline exceeded ${timeoutMs}ms`,
            },
            elapsed_ms: nowMsFn() - start,
          },
        };
      }
      return result.value;
    });
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validateOpts(opts: ReasonHandlerOptions): void {
  if (!opts?.intentClassifier || typeof opts.intentClassifier.classify !== 'function') {
    throw new TypeError('createReasonHandler: intentClassifier is required');
  }
  if (typeof opts.vaultQueryFn !== 'function') {
    throw new TypeError('createReasonHandler: vaultQueryFn is required');
  }
  if (typeof opts.reasonFn !== 'function') {
    throw new TypeError('createReasonHandler: reasonFn is required');
  }
}

async function runPipeline(args: {
  req: ReasonRequest;
  id: string;
  classifier: Pick<IntentClassifier, 'classify'>;
  vaultQueryFn: VaultQueryFn;
  reasonFn: ReasonFn;
  onEvent?: (event: ReasonHandlerEvent) => void;
  nowMsFn: () => number;
  start: number;
}): Promise<ReasonResult> {
  const { req, id, classifier, vaultQueryFn, reasonFn, onEvent, nowMsFn, start } = args;

  // 1. Classify (never throws — returns default on error).
  let classification: IntentClassification;
  try {
    classification = await classifier.classify(req.query);
  } catch {
    classification = defaultClassification();
  }
  onEvent?.({
    kind: 'classified',
    id,
    sources: classification.sources,
  });

  // 2. Vault query (only when classifier says 'vault' is relevant).
  let context: VaultItem[] = [];
  if (classification.sources.includes('vault')) {
    try {
      context = await vaultQueryFn({
        query: req.query,
        persona: req.persona,
        personas: classification.relevantPersonas,
        maxItems: req.maxVaultItems ?? 10,
      });
      onEvent?.({
        kind: 'vault_queried',
        id,
        itemCount: context.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent?.({ kind: 'vault_query_failed', id, error: msg });
      return {
        status: 500,
        body: {
          request_id: id,
          error: { kind: 'vault_query_failed', message: msg },
          intent: intentView(classification),
          elapsed_ms: nowMsFn() - start,
        },
      };
    }
  }

  // 3. Reason.
  const reasonStart = nowMsFn();
  try {
    const { answer } = await reasonFn({
      query: req.query,
      persona: req.persona,
      context,
      classification,
    });
    onEvent?.({
      kind: 'reasoned',
      id,
      durationMs: nowMsFn() - reasonStart,
    });
    return {
      status: 200,
      body: {
        request_id: id,
        answer,
        intent: intentView(classification),
        sources_used: { vault_item_ids: context.map((c) => c.id) },
        elapsed_ms: nowMsFn() - start,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onEvent?.({ kind: 'reason_failed', id, error: msg });
    return {
      status: 500,
      body: {
        request_id: id,
        error: { kind: 'reason_failed', message: msg },
        intent: intentView(classification),
        elapsed_ms: nowMsFn() - start,
      },
    };
  }
}

function intentView(c: IntentClassification): ReasonSuccessBody['intent'] {
  return {
    sources: c.sources,
    relevant_personas: c.relevantPersonas,
    temporal: c.temporal,
    reasoning_hint: c.reasoningHint,
  };
}
