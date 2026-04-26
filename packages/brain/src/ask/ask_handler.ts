/**
 * Tasks 5.17 + 5.18 — `POST /api/v1/ask` + `GET /api/v1/ask/:id/status`.
 *
 * Brain's ask endpoint is asynchronous. When the client submits a
 * question, the handler runs the LLM pipeline with a **3-second fast
 * path**:
 *
 *   - If the answer arrives within 3s → return **200** with the full
 *     answer payload; the client never sees a polling hop.
 *   - Otherwise → return **202** with `{request_id, status}`; the
 *     client polls `GET /api/v1/ask/:id/status` until it sees a
 *     terminal state (`complete` | `failed` | `expired` |
 *     `pending_approval`).
 *
 * The background execution KEEPS running even after the 202 response
 * — the caller just doesn't block for it. Completion updates land in
 * the `AskRegistry` (task 5.19) which the status endpoint reads.
 *
 * **Pure handler primitives** — this module exports two handler-
 * factories (`createAskHandler`, `createAskStatusHandler`) that take
 * a registry + an `executeFn` (the LLM pipeline) and return plain
 * `async (req) => AskHandlerResult` / `async (id) => AskStatusView`
 * functions. The brain-server app will wrap them in Fastify routes
 * when 5.1-5.7 land — keeping the handler logic framework-free makes
 * the whole thing unit-testable without spinning up HTTP.
 *
 * **Trace correlation** (task 5.58): the inbound header `X-Request-Id`
 * (if valid) becomes the ask's `id`. If absent or malformed, a fresh
 * id is generated via `newRequestId()`. The id surfaces in the 202
 * response AND in every downstream log line via `withTrace`.
 *
 * **Fast-path cancellation**: the 3s timer doesn't CANCEL the
 * background execution — it only decides when the HTTP response
 * returns. The execution continues; whichever path resolves second
 * (fast-path completes before timer OR timer fires first with
 * execution still running) the registry is updated exactly once
 * (first-writer wins via the terminal-state guard in the registry).
 *
 * **Status transitions on failure** (the registry owns these — the
 * handler just emits `markFailed`): the LLM throwing, the
 * EntityVault refusing to scrub, a cloud-gate refusal — all flow
 * into the same `failed` terminal state with a structured
 * `errorJson` the status endpoint echoes back.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5c tasks 5.17 + 5.18.
 */

import type { AskRecord, AskRegistry } from './ask_registry';
import {
  inboundRequestId,
  newRequestId,
  withTrace,
  type TraceContext,
} from '../diagnostics/trace_correlation';

export const ASK_FAST_PATH_TIMEOUT_MS = 3_000;

/** Answer value — whatever the LLM pipeline produced. Kept opaque. */
export type AskAnswer = Record<string, unknown>;

/** Structured failure description — serialisable via JSON. */
export interface AskFailure {
  /** Short kind like 'provider_error' / 'scrub_refused' / 'cloud_blocked'. */
  kind: string;
  message: string;
  /** Optional details (provider code, redacted context). */
  detail?: Record<string, unknown>;
}

/**
 * Outcome of the LLM pipeline. The `executeFn` resolves with one
 * of these. The handler translates the outcome into either an
 * `ok: true` answer (marked complete in the registry) or a failure
 * (marked failed / pending_approval).
 *
 * **Pattern A `pausedStateJson`**: when the agentic loop bails on a
 * sensitive-persona tool call, `executeFn` SHOULD include the
 * serialised `PausedAgenticState` so `applyOutcome` can persist it
 * via `markPendingApproval(id, approvalId, pausedStateJson)`. The
 * resumer (5.21-C) then resumes the LLM at the bail point on
 * approval — zero re-LLM cost. When omitted, the resumer falls
 * back to Pattern B (re-run from question, higher LLM cost but
 * still correct). Task 5.21-G.
 */
export type ExecuteOutcome =
  | { kind: 'answer'; answer: AskAnswer }
  | { kind: 'failure'; failure: AskFailure }
  | { kind: 'approval'; approvalId: string; pausedStateJson?: string };

export type AskExecuteFn = (input: {
  id: string;
  question: string;
  requesterDid: string;
  signal?: AbortSignal;
}) => Promise<ExecuteOutcome>;

export interface AskSubmitRequest {
  question: string;
  requesterDid: string;
  /** Raw `X-Request-Id` header (validated; falls back to a fresh id if invalid). */
  requestIdHeader?: string | null;
  /** TTL override. */
  ttlMs?: number;
}

export interface AskSubmitFastPath {
  kind: 'fast_path';
  status: 200;
  body: {
    request_id: string;
    status: 'complete' | 'failed' | 'pending_approval';
    answer?: AskAnswer;
    error?: AskFailure;
    approval_id?: string;
  };
}

export interface AskSubmitAsync {
  kind: 'async';
  status: 202;
  body: { request_id: string; status: 'in_flight' };
}

export type AskSubmitResult = AskSubmitFastPath | AskSubmitAsync;

export interface AskHandlerOptions {
  registry: AskRegistry;
  executeFn: AskExecuteFn;
  /** Fast-path window before returning 202. Default 3 000 ms. */
  fastPathMs?: number;
  /** Injectable clock. */
  nowMsFn?: () => number;
  /** Injectable setTimeout — tests use a mock scheduler. */
  setTimerFn?: (fn: () => void, ms: number) => unknown;
  clearTimerFn?: (handle: unknown) => void;
  /** Diagnostic hook. */
  onEvent?: (event: AskHandlerEvent) => void;
}

export type AskHandlerEvent =
  | { kind: 'submitted'; id: string; fastPath: boolean }
  | { kind: 'fast_path_complete'; id: string }
  | { kind: 'fast_path_failed'; id: string; failureKind: string }
  | { kind: 'fast_path_pending_approval'; id: string }
  | { kind: 'async_timeout'; id: string }
  | { kind: 'background_complete'; id: string }
  | { kind: 'background_failed'; id: string; failureKind: string }
  | { kind: 'background_pending_approval'; id: string }
  | { kind: 'background_crashed'; id: string; error: string };

/**
 * Factory for the `POST /api/v1/ask` handler. Returns
 * `async (req) => AskSubmitResult` — callers wrap in Fastify:
 *
 * ```ts
 * const handleAsk = createAskHandler({registry, executeFn});
 * app.post('/api/v1/ask', async (req) => {
 *   const r = await handleAsk({ question: ..., requesterDid: ..., requestIdHeader: req.headers['x-request-id'] });
 *   reply.status(r.status).send(r.body);
 * });
 * ```
 */
export function createAskHandler(
  opts: AskHandlerOptions,
): (req: AskSubmitRequest) => Promise<AskSubmitResult> {
  if (!opts?.registry) {
    throw new TypeError('createAskHandler: registry is required');
  }
  if (typeof opts.executeFn !== 'function') {
    throw new TypeError('createAskHandler: executeFn is required');
  }
  const registry = opts.registry;
  const executeFn = opts.executeFn;
  const fastPathMs = opts.fastPathMs ?? ASK_FAST_PATH_TIMEOUT_MS;
  const nowMsFn = opts.nowMsFn ?? (() => Date.now());
  const setTimerFn =
    opts.setTimerFn ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimerFn =
    opts.clearTimerFn ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>));
  const onEvent = opts.onEvent;

  return async function handleAsk(req: AskSubmitRequest): Promise<AskSubmitResult> {
    if (typeof req?.question !== 'string' || req.question.trim() === '') {
      throw new TypeError('handleAsk: question must be a non-empty string');
    }
    if (typeof req.requesterDid !== 'string' || req.requesterDid.trim() === '') {
      throw new TypeError('handleAsk: requesterDid must be a non-empty string');
    }
    const id = inboundRequestId(req.requestIdHeader ?? null) ?? newRequestId();

    const enqueueInput: Parameters<typeof registry.enqueue>[0] = {
      id,
      question: req.question,
      requesterDid: req.requesterDid,
    };
    if (req.ttlMs !== undefined) enqueueInput.ttlMs = req.ttlMs;
    await registry.enqueue(enqueueInput);

    const trace: TraceContext = Object.freeze({
      requestId: id,
      parentId: null,
      startedAtMs: nowMsFn(),
    });

    // Kick off background execution under the trace scope. Do NOT
    // await yet — we want the fast-path race below to own the wait.
    const executionPromise = withTrace(trace, async () => {
      try {
        return await executeFn({
          id,
          question: req.question,
          requesterDid: req.requesterDid,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          kind: 'failure' as const,
          failure: {
            kind: 'execute_crashed',
            message: msg,
          },
        };
      }
    });

    // Race the execution against a fast-path timer. Whichever wins
    // decides the HTTP response. The execution always continues to
    // completion in the background — the timer only bounds the HTTP
    // wait.
    let timerHandle: unknown = null;
    const timerPromise = new Promise<'timeout'>((resolve) => {
      timerHandle = setTimerFn(() => resolve('timeout'), fastPathMs);
    });
    const raceResult = await Promise.race([
      executionPromise.then((outcome) => ({ kind: 'outcome' as const, outcome })),
      timerPromise.then(() => ({ kind: 'timeout' as const })),
    ]);
    if (timerHandle !== null) clearTimerFn(timerHandle);

    if (raceResult.kind === 'outcome') {
      // Fast path won. Apply + respond inline.
      const applied = await applyOutcome(registry, id, raceResult.outcome);
      onEvent?.({ kind: 'submitted', id, fastPath: true });
      emitFastPathEvent(onEvent, id, raceResult.outcome);
      return {
        kind: 'fast_path',
        status: 200,
        body: bodyForOutcome(id, raceResult.outcome, applied),
      };
    }

    // Timer won. Hand the client a 202; keep the execution rolling
    // in the background so `status` polls eventually see a terminal
    // state.
    onEvent?.({ kind: 'submitted', id, fastPath: false });
    onEvent?.({ kind: 'async_timeout', id });
    // Attach a terminal `.catch` so the floating promise doesn't
    // produce an unhandled rejection — all failure paths funnel
    // through `applyOutcome` which already handles errors.
    void executionPromise.then(
      async (outcome) => {
        await applyOutcome(registry, id, outcome);
        emitBackgroundEvent(onEvent, id, outcome);
      },
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        // Treat as a failure outcome so the registry reflects it.
        void registry
          .markFailed(
            id,
            JSON.stringify({
              kind: 'background_crashed',
              message: msg,
            }),
          )
          .catch(() => {
            /* registry already terminal — ignore */
          });
        onEvent?.({ kind: 'background_crashed', id, error: msg });
      },
    );
    return {
      kind: 'async',
      status: 202,
      body: { request_id: id, status: 'in_flight' },
    };
  };
}

/**
 * Status view returned by `GET /api/v1/ask/:id/status`. Mirrors the
 * registry's state machine exactly.
 */
export interface AskStatusView {
  request_id: string;
  status: AskRecord['status'];
  created_at_ms: number;
  updated_at_ms: number;
  deadline_ms: number;
  /** Present on `complete`. */
  answer?: unknown;
  /** Present on `failed`. */
  error?: unknown;
  /** Present on `pending_approval`. */
  approval_id?: string;
}

export type AskStatusOutcome =
  | { kind: 'found'; status: 200; body: AskStatusView }
  | { kind: 'not_found'; status: 404; body: { error: 'not_found'; request_id: string } };

export interface AskStatusHandlerOptions {
  registry: AskRegistry;
  onEvent?: (event: AskStatusHandlerEvent) => void;
}

export type AskStatusHandlerEvent =
  | { kind: 'status_served'; id: string; status: AskRecord['status'] }
  | { kind: 'status_not_found'; id: string };

/**
 * Factory for the `GET /api/v1/ask/:id/status` handler. Returns
 * `async (id) => AskStatusOutcome`. The record-shape transformation
 * (snake_case body fields + decoded JSON answer / error) happens
 * here so the registry's internal types stay framework-free.
 */
export function createAskStatusHandler(
  opts: AskStatusHandlerOptions,
): (id: string) => Promise<AskStatusOutcome> {
  if (!opts?.registry) {
    throw new TypeError('createAskStatusHandler: registry is required');
  }
  const registry = opts.registry;
  const onEvent = opts.onEvent;
  return async function handleStatus(id: string): Promise<AskStatusOutcome> {
    if (typeof id !== 'string' || id.trim() === '') {
      return {
        kind: 'not_found',
        status: 404,
        body: { error: 'not_found', request_id: id ?? '' },
      };
    }
    const record = await registry.get(id);
    if (!record) {
      onEvent?.({ kind: 'status_not_found', id });
      return {
        kind: 'not_found',
        status: 404,
        body: { error: 'not_found', request_id: id },
      };
    }
    onEvent?.({ kind: 'status_served', id, status: record.status });
    const body: AskStatusView = {
      request_id: record.id,
      status: record.status,
      created_at_ms: record.createdAtMs,
      updated_at_ms: record.updatedAtMs,
      deadline_ms: record.deadlineMs,
    };
    if (record.answerJson !== undefined) {
      body.answer = safeJsonParse(record.answerJson);
    }
    if (record.errorJson !== undefined) {
      body.error = safeJsonParse(record.errorJson);
    }
    if (record.approvalId !== undefined) {
      body.approval_id = record.approvalId;
    }
    return { kind: 'found', status: 200, body };
  };
}

// ── Internals ──────────────────────────────────────────────────────────

async function applyOutcome(
  registry: AskRegistry,
  id: string,
  outcome: ExecuteOutcome,
): Promise<AskRecord | null> {
  try {
    if (outcome.kind === 'answer') {
      return await registry.markComplete(id, JSON.stringify(outcome.answer));
    }
    if (outcome.kind === 'approval') {
      return await registry.markPendingApproval(
        id,
        outcome.approvalId,
        outcome.pausedStateJson,
      );
    }
    return await registry.markFailed(id, JSON.stringify(outcome.failure));
  } catch {
    // Registry already in terminal state (could be expired-swept or
    // a concurrent writer beat us). The status endpoint will still
    // return the current record; we just swallow the second-writer
    // error.
    return null;
  }
}

function bodyForOutcome(
  id: string,
  outcome: ExecuteOutcome,
  applied: AskRecord | null,
): AskSubmitFastPath['body'] {
  if (outcome.kind === 'answer') {
    return {
      request_id: id,
      status: 'complete',
      answer: outcome.answer,
    };
  }
  if (outcome.kind === 'approval') {
    return {
      request_id: id,
      status: 'pending_approval',
      approval_id: outcome.approvalId,
    };
  }
  // Prefer the registry's current failure payload if the mark
  // succeeded; otherwise use the outcome's failure directly.
  if (applied?.errorJson) {
    return {
      request_id: id,
      status: 'failed',
      error: safeJsonParse(applied.errorJson) as AskFailure,
    };
  }
  return {
    request_id: id,
    status: 'failed',
    error: outcome.failure,
  };
}

function emitFastPathEvent(
  onEvent: AskHandlerOptions['onEvent'],
  id: string,
  outcome: ExecuteOutcome,
): void {
  if (!onEvent) return;
  if (outcome.kind === 'answer') {
    onEvent({ kind: 'fast_path_complete', id });
  } else if (outcome.kind === 'approval') {
    onEvent({ kind: 'fast_path_pending_approval', id });
  } else {
    onEvent({ kind: 'fast_path_failed', id, failureKind: outcome.failure.kind });
  }
}

function emitBackgroundEvent(
  onEvent: AskHandlerOptions['onEvent'],
  id: string,
  outcome: ExecuteOutcome,
): void {
  if (!onEvent) return;
  if (outcome.kind === 'answer') {
    onEvent({ kind: 'background_complete', id });
  } else if (outcome.kind === 'approval') {
    onEvent({ kind: 'background_pending_approval', id });
  } else {
    onEvent({ kind: 'background_failed', id, failureKind: outcome.failure.kind });
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s; // malformed payload — hand back the raw string
  }
}
