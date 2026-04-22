/**
 * D2D `service.query` / `service.response` body schemas + validators.
 *
 * These messages are ephemeral (never persisted) and bypass the contact gate
 * via a reservation window (see `packages/core/src/service/query_window.ts`).
 * Core treats `params` and `result` as opaque JSON payloads — Brain owns
 * capability-specific schema validation.
 *
 * Field naming: `snake_case` to match the D2D wire format and the rest of the
 * dina-mobile TS surface (e.g. `DinaMessage.created_time`). Callers receive
 * JSON off the wire and validate it directly; we do not introduce a
 * camelCase↔snake_case translation layer.
 *
 * Source:
 *   core/internal/domain/message.go  — ServiceQueryBody / ServiceResponseBody
 *   core/internal/domain/message.go  — ValidateV1Body (service.query / service.response)
 *
 * Wire invariants (enforced here):
 *   - `query_id` non-empty
 *   - `capability` non-empty
 *   - `ttl_seconds` in (0, MAX_SERVICE_TTL]
 *   - response `status` ∈ {"success", "unavailable", "error"}
 *   - future-skew guard on message `created_time` (caller-provided)
 */

import {
  validateServiceQueryBody as protocolValidateServiceQueryBody,
  validateServiceResponseBody as protocolValidateServiceResponseBody,
  validateFutureSkew as protocolValidateFutureSkew,
} from '@dina/protocol';

/** Valid response statuses on the wire. */
export type ServiceResponseStatus = 'success' | 'unavailable' | 'error';

/**
 * Body of a `service.query` D2D message.
 *
 * `params` is a capability-specific JSON-serialisable value. Core does not
 * inspect its shape — schema validation is the Brain's responsibility (and is
 * gated by `schema_hash` when both sides agree on a published schema).
 */
export interface ServiceQueryBody {
  query_id: string;
  capability: string;
  params: unknown;
  ttl_seconds: number;
  /**
   * Optional SHA-256 of the provider's published capability schema. When both
   * sides supply this field, a mismatch produces an `error` response with
   * `schema_version_mismatch` rather than reaching the capability handler.
   * (Introduced in commit 9b1c4a4.)
   */
  schema_hash?: string;
}

/**
 * Body of a `service.response` D2D message. Sent by the provider back to the
 * requester (or by the requester's Core on behalf of an internal failure).
 */
export interface ServiceResponseBody {
  query_id: string;
  capability: string;
  status: ServiceResponseStatus;
  /** Capability-specific result payload. Present iff `status === 'success'`. */
  result?: unknown;
  /** Human-readable error detail. Present iff `status !== 'success'`. */
  error?: string;
  ttl_seconds: number;
}

// Validators delegate to @dina/protocol (task 1.20) — protocol is the
// single source of truth for wire-format invariants. Re-exported under
// the existing names so all existing callers keep compiling.

export const validateServiceQueryBody = protocolValidateServiceQueryBody;
export const validateServiceResponseBody = protocolValidateServiceResponseBody;

/** Backwards-compat wrapper — protocol's version uses camelCase params
 *  (createdTime, nowUnix, maxSkewSeconds); core keeps the historical
 *  snake_case signature so existing call-sites don't churn. */
export function validateFutureSkew(
  created_time: number,
  now_unix: number,
  max_skew_seconds = 60,
): string | null {
  return protocolValidateFutureSkew(created_time, now_unix, max_skew_seconds);
}
