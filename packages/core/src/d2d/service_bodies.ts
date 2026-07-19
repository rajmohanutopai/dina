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

import type {
  ServiceResponseStatus as ProtocolServiceResponseStatus,
  ServiceQueryBody as ProtocolServiceQueryBody,
  ServiceResponseBody as ProtocolServiceResponseBody,
} from '@dina/protocol';

// `@dina/protocol` is the SINGLE SOURCE OF TRUTH for these wire types
// (task 1.20 + the card/ttl_seconds unification). Core re-exports them under
// the historical names so every existing call-site keeps compiling AND
// automatically picks up `card?` / `schema_hash?` on the response body —
// the divergent Core copy that dropped `card` is gone. Third-party
// implementers and Core now agree byte-for-byte.

/** Valid response statuses on the wire. */
export type ServiceResponseStatus = ProtocolServiceResponseStatus;

/** Body of a `service.query` D2D message. Re-exported from `@dina/protocol`. */
export type ServiceQueryBody = ProtocolServiceQueryBody;

/** Body of a `service.response` D2D message. Re-exported from `@dina/protocol`.
 *  Carries `result`, `error`, `ttl_seconds`, optional `schema_hash`, and the
 *  optional provider-authored `card` (CardSpec). */
export type ServiceResponseBody = ProtocolServiceResponseBody;

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
