/**
 * Outbound service.query orchestrator (GAP.md row #21 closure — M3).
 *
 * Before 5.46 preflight (task 6.24) covered the "should I trust this
 * provider?" step. This orchestrator wraps the full pipeline:
 *
 *   1. **preflight** — `service_query_preflight.ts` ranks candidates
 *      by trust + context.
 *   2. **build** — compose the D2D `service.query` message body
 *      including schema_hash pin + ttl.
 *   3. **send** — injected transport fires the message at the chosen
 *      provider; returns a raw response envelope.
 *   4. **interpret** — classify the response shape: success / error
 *      / schema-mismatch-retry.
 *   5. **retry-on-schema-mismatch (once)** — refresh provider profile
 *      from AppView, re-build with the fresh schema_hash, re-send.
 *   6. **format** — hand the successful result back as a structured
 *      outcome the caller can render.
 *
 * **What's injected**:
 *   - `preflightFn` — returns `{ok, verdicts, hasProceed}` from the
 *     existing preflight primitive.
 *   - `sendFn({toDid, body}) → rawResponse` — the transport. Tests
 *     pass an in-memory stub; production wires D2D.
 *   - `refreshProfileFn(did)` — pulls the provider's current
 *     schema_hash from AppView after a mismatch.
 *   - `makeQueryIdFn` — generates D2D query ids; defaults to crypto
 *     random hex.
 *   - `nowSecFn` — unix seconds for the ttl + receivedAt echo.
 *
 * **Retry once** — schema_hash mismatch is a known transient (the
 * provider just published a new version); one refresh + retry. Any
 * other error is returned as-is; the caller decides whether to retry
 * on the next tick.
 *
 * **Never throws** — the outcome is always a tagged union. `rejected`
 * reasons expose `preflight_no_candidates`, `preflight_no_proceed`,
 * `provider_error`, `schema_mismatch_after_retry`, `transport_failed`.
 *
 * Source: GAP.md (task 5.46 follow-up) — M3 service-network gate.
 */

import { randomBytes } from 'node:crypto';

import type {
  PreflightCandidate,
  PreflightOutcome,
  PreflightRequest,
} from '../appview/service_query_preflight';

export type ServiceQueryRejection =
  | 'invalid_input'
  | 'preflight_failed'
  | 'preflight_no_candidates'
  | 'preflight_no_proceed'
  | 'transport_failed'
  | 'provider_error'
  | 'schema_mismatch_after_retry';

export interface ServiceQueryRequest {
  /** Capability we're querying. */
  capability: string;
  /** Params to send — already conformant to provider's schema. */
  params: Record<string, unknown>;
  /** Preflight request — capability + context + optional location/limit. */
  preflight: PreflightRequest;
  /** TTL seconds — provider discards the query after this. Default 60. */
  ttlSeconds?: number;
}

export interface ProviderResponseEnvelope {
  queryId: string;
  status: 'success' | 'error';
  /** Present on success. */
  result?: Record<string, unknown>;
  /** Present on error — machine-readable. */
  error?: string;
  /** Optional error detail. */
  detail?: string;
  /** The schema_hash the provider used when responding. */
  schemaHash?: string;
}

export interface QueryBody {
  query_id: string;
  capability: string;
  schema_hash: string;
  params: Record<string, unknown>;
  ttl_seconds: number;
}

export interface SuccessfulQuery {
  ok: true;
  queryId: string;
  /** The candidate that answered. */
  candidate: PreflightCandidate;
  result: Record<string, unknown>;
  /** Whether we retried after a schema mismatch. */
  retried: boolean;
}

export interface FailedQuery {
  ok: false;
  reason: ServiceQueryRejection;
  detail?: string;
  /** Candidate we attempted, when applicable. */
  candidate?: PreflightCandidate;
}

export type ServiceQueryOutcome = SuccessfulQuery | FailedQuery;

export interface ServiceQueryOptions {
  preflightFn: (req: PreflightRequest) => Promise<PreflightOutcome>;
  sendFn: (input: { toDid: string; body: QueryBody }) => Promise<ProviderResponseEnvelope>;
  refreshProfileFn: (did: string) => Promise<{ ok: true; schemaHash: string } | { ok: false }>;
  makeQueryIdFn?: () => string;
  nowSecFn?: () => number;
}

export const DEFAULT_TTL_SECONDS = 60;

/**
 * Build the outbound orchestrator. Returns a function the caller
 * invokes with `(req) → Promise<ServiceQueryOutcome>`.
 */
export function createServiceQuery(
  opts: ServiceQueryOptions,
): (req: ServiceQueryRequest) => Promise<ServiceQueryOutcome> {
  if (typeof opts?.preflightFn !== 'function') {
    throw new TypeError('createServiceQuery: preflightFn required');
  }
  if (typeof opts.sendFn !== 'function') {
    throw new TypeError('createServiceQuery: sendFn required');
  }
  if (typeof opts.refreshProfileFn !== 'function') {
    throw new TypeError('createServiceQuery: refreshProfileFn required');
  }
  const makeQueryId = opts.makeQueryIdFn ?? defaultMakeQueryId;

  return async function runServiceQuery(
    req: ServiceQueryRequest,
  ): Promise<ServiceQueryOutcome> {
    const validation = validate(req);
    if (validation !== null) {
      return { ok: false, reason: 'invalid_input', detail: validation };
    }

    // 1. Preflight.
    const preflight = await opts.preflightFn(req.preflight);
    if (!preflight.ok) {
      return {
        ok: false,
        reason: 'preflight_failed',
        detail: preflight.reason === 'search_failed' ? preflight.error : preflight.detail,
      };
    }
    if (preflight.verdicts.length === 0) {
      return { ok: false, reason: 'preflight_no_candidates' };
    }
    if (!preflight.hasProceed) {
      return { ok: false, reason: 'preflight_no_proceed' };
    }
    const candidate = preflight.verdicts.find(
      (v) => v.decision?.action === 'proceed',
    )!.candidate;

    // 2. Build.
    const ttlSeconds = req.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const queryId = makeQueryId();
    const firstBody: QueryBody = {
      query_id: queryId,
      capability: req.capability,
      schema_hash: candidate.schemaHash,
      params: { ...req.params },
      ttl_seconds: ttlSeconds,
    };

    // 3. Send + 4. Interpret + 5. Retry-on-mismatch-once.
    const first = await tryOnce(opts.sendFn, candidate.operatorDid, firstBody);
    if (first.kind === 'success') {
      return {
        ok: true,
        queryId,
        candidate,
        result: first.result,
        retried: false,
      };
    }
    if (first.kind === 'transport_failed') {
      return {
        ok: false,
        reason: 'transport_failed',
        detail: first.detail,
        candidate,
      };
    }
    if (first.kind === 'schema_mismatch') {
      // Refresh and retry once.
      const refreshed = await opts.refreshProfileFn(candidate.operatorDid);
      if (!refreshed.ok) {
        return {
          ok: false,
          reason: 'schema_mismatch_after_retry',
          detail: 'profile refresh failed',
          candidate,
        };
      }
      const secondBody: QueryBody = { ...firstBody, schema_hash: refreshed.schemaHash };
      const second = await tryOnce(opts.sendFn, candidate.operatorDid, secondBody);
      if (second.kind === 'success') {
        return {
          ok: true,
          queryId,
          candidate,
          result: second.result,
          retried: true,
        };
      }
      if (second.kind === 'transport_failed') {
        return {
          ok: false,
          reason: 'transport_failed',
          detail: second.detail,
          candidate,
        };
      }
      // Still mismatch OR any other error — give up.
      return {
        ok: false,
        reason: 'schema_mismatch_after_retry',
        detail: second.kind === 'schema_mismatch' ? 'still mismatch after refresh' : second.detail,
        candidate,
      };
    }
    // `provider_error`
    return {
      ok: false,
      reason: 'provider_error',
      detail: first.detail,
      candidate,
    };
  };
}

// ── Internals ──────────────────────────────────────────────────────────

type SendAttempt =
  | { kind: 'success'; result: Record<string, unknown> }
  | { kind: 'schema_mismatch'; detail: string }
  | { kind: 'provider_error'; detail: string }
  | { kind: 'transport_failed'; detail: string };

async function tryOnce(
  sendFn: (input: { toDid: string; body: QueryBody }) => Promise<ProviderResponseEnvelope>,
  toDid: string,
  body: QueryBody,
): Promise<SendAttempt> {
  let envelope: ProviderResponseEnvelope;
  try {
    envelope = await sendFn({ toDid, body });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'transport_failed', detail: msg };
  }
  if (envelope.status === 'success' && envelope.result) {
    return { kind: 'success', result: envelope.result };
  }
  if (envelope.status === 'error') {
    if (envelope.error === 'schema_version_mismatch') {
      return {
        kind: 'schema_mismatch',
        detail: envelope.detail ?? 'schema_version_mismatch',
      };
    }
    return {
      kind: 'provider_error',
      detail: envelope.error ?? envelope.detail ?? 'unknown provider error',
    };
  }
  // success without result, or unknown shape — treat as provider error.
  return {
    kind: 'provider_error',
    detail: 'provider returned unexpected envelope shape',
  };
}

function validate(req: ServiceQueryRequest): string | null {
  if (!req || typeof req !== 'object') return 'request required';
  if (typeof req.capability !== 'string' || req.capability === '') return 'capability required';
  if (!req.params || typeof req.params !== 'object') return 'params must be an object';
  if (!req.preflight || typeof req.preflight !== 'object') return 'preflight request required';
  if (typeof req.preflight.capability !== 'string') return 'preflight.capability required';
  if (req.ttlSeconds !== undefined) {
    if (!Number.isInteger(req.ttlSeconds) || req.ttlSeconds < 1) {
      return 'ttlSeconds must be a positive integer';
    }
  }
  return null;
}

function defaultMakeQueryId(): string {
  return `q-${randomBytes(8).toString('hex')}`;
}
