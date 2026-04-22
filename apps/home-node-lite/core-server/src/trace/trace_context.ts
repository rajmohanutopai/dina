/**
 * Task 4.86 — trace correlation primitives.
 *
 * Brain → Core distributed-tracing works by having Brain set an
 * `X-Request-Id` header on every outbound request; Core preserves
 * that id through its `onRequest` hook, threads it into the
 * per-request pino child logger, and echoes it back on the response.
 * The existing wiring lives in `src/server.ts` (task 4.35); this
 * module formalises the header name + the validator so Brain and
 * Core agree on a single contract rather than both sides
 * independently hardcoding `"x-request-id"`.
 *
 * **Why a validator at all** — an inbound header value is attacker-
 * controllable. Blindly echoing it creates log-injection vectors
 * (CRLF in `request_id` → log line corruption) and unbounded-size
 * risks (a gigabyte header gets into every log line for that
 * request). The validator:
 *
 *   - Caps length at 128 chars (ample for UUIDs, W3C trace ids,
 *     app-specific prefixes; way under typical header-size limits).
 *   - Rejects non-printable ASCII, CR, LF, NUL (log-injection
 *     surface).
 *   - Rejects empty.
 *
 * When validation FAILS, callers fall back to their own generator
 * (Core does this via Fastify's `genReqId`). That's fail-safe: the
 * upstream might be a misconfigured proxy — losing the trace
 * correlation is better than allowing injection.
 *
 * **Brain-Core contract surface**: `REQUEST_ID_HEADER` is the only
 * agreed name. Brain-server will import this constant when it lands
 * (Phase 5) so a single literal drives both sides.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4l task 4.86.
 */

/** Canonical header name. Lowercase to match Fastify's normalized shape. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Maximum length of a client-supplied request_id we'll preserve. */
export const REQUEST_ID_MAX_LENGTH = 128;

export type RequestIdValidationResult =
  | { ok: true; value: string }
  | { ok: false; reason: RequestIdRejectionReason };

export type RequestIdRejectionReason =
  | 'empty'
  | 'too_long'
  | 'bad_characters';

/**
 * Validate an inbound `X-Request-Id` header value for preservation.
 *
 * Returns structured success with the cleaned value, or a reason
 * code. Callers that want to fall back to a locally-generated id
 * can do so on any failure.
 *
 * **Canonical form**: the input is returned verbatim on success (no
 * case-folding, no whitespace trim). Clients that want a canonical
 * form should do it before calling — we preserve whatever passed the
 * character + length checks because some tracing schemes (W3C
 * traceparent) are case-sensitive.
 */
export function validateRequestId(
  raw: string | undefined | null,
): RequestIdValidationResult {
  if (raw === undefined || raw === null || raw.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (raw.length > REQUEST_ID_MAX_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }
  // Printable ASCII (0x20 space .. 0x7E ~) only. Covers URL-safe +
  // most trace id grammars; rejects CR/LF/NUL/tabs which are the
  // log-injection surface.
  for (let i = 0; i < raw.length; i++) {
    const cc = raw.charCodeAt(i);
    if (cc < 0x20 || cc > 0x7e) {
      return { ok: false, reason: 'bad_characters' };
    }
  }
  return { ok: true, value: raw };
}

/**
 * Resolve an inbound header into a usable id, falling back to a
 * generator on any validation failure. Pure helper — `genFn` is the
 * caller's monotonic id generator (Fastify's `genReqId`).
 *
 * Returns the resolved id + whether the fallback was used (so the
 * caller can log the rejection reason once).
 */
export function resolveRequestId(
  inbound: string | undefined | null,
  genFn: () => string,
): { id: string; generated: boolean; rejectionReason?: RequestIdRejectionReason } {
  const v = validateRequestId(inbound);
  if (v.ok) return { id: v.value, generated: false };
  return { id: genFn(), generated: true, rejectionReason: v.reason };
}
