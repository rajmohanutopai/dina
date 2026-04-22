/**
 * Task 4.22 — 5-minute timestamp window validator for signed requests.
 *
 * Dina's canonical-signed-request protocol includes an `X-Timestamp`
 * header (RFC3339 / Unix epoch ms). The server rejects requests whose
 * timestamp is more than ±5 minutes from the server's clock. This
 * bounds the replay window: a captured signed request stays valid for
 * at most 10 minutes end-to-end, even if the nonce-replay cache is
 * ever missed.
 *
 * **Why ±5 minutes (not a one-sided "≤5 minutes old").**
 * Reasonable client clock skew can land timestamps in the future; a
 * strict "past only" window forces every client to sync to the
 * server's clock. ±5 minutes tolerates typical NTP drift without
 * silently accepting "last year's replay".
 *
 * **Format parity with Go Core.** Go's `auth/timestamp.go` parses
 * RFC3339 first, falls back to unix epoch ms (stringified) — we do
 * the same so a request signed by Brain (TS) or by a Go client hits
 * the same acceptance predicate.
 *
 * Plugs into the auth middleware (task 4.19–4.21) which extracts
 * `X-Timestamp` from the request headers and passes it here before
 * canonicalising + verifying the signature.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4c task 4.22.
 */

/** Hard-coded per Dina protocol spec. */
export const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000; // ±5 minutes

export interface TimestampValidationOptions {
  /** Milliseconds of clock-skew tolerance (symmetric). Default: 5 min. */
  windowMs?: number;
  /** Now provider — injected for deterministic tests. Default: `Date.now`. */
  now?: () => number;
}

export type TimestampValidationResult =
  | { ok: true; timestampMs: number }
  | { ok: false; reason: TimestampRejectionReason; detail?: string };

export type TimestampRejectionReason =
  | 'missing'
  | 'malformed'
  | 'too_old'
  | 'too_future';

/**
 * Validate an `X-Timestamp` header value against the server clock.
 *
 * Accepts:
 *   - RFC3339 (e.g. `"2026-04-21T22:13:20.000Z"`)
 *   - Unix epoch ms as a decimal string (e.g. `"1745270000000"`)
 *
 * Returns `{ok: true, timestampMs}` on success or `{ok: false, reason}` with
 * a stable enum string for the rejection cause (so callers — typically
 * the auth middleware — can render a consistent error envelope).
 */
export function validateTimestamp(
  header: string | undefined | null,
  opts: TimestampValidationOptions = {},
): TimestampValidationResult {
  if (header === undefined || header === null || header === '') {
    return { ok: false, reason: 'missing' };
  }

  const parsed = parseTimestamp(header);
  if (parsed === null) {
    return { ok: false, reason: 'malformed', detail: header };
  }

  const windowMs = opts.windowMs ?? TIMESTAMP_WINDOW_MS;
  const now = (opts.now ?? Date.now)();
  const delta = parsed - now;

  if (delta < -windowMs) {
    return { ok: false, reason: 'too_old', detail: `${-delta}ms behind` };
  }
  if (delta > windowMs) {
    return { ok: false, reason: 'too_future', detail: `${delta}ms ahead` };
  }

  return { ok: true, timestampMs: parsed };
}

/**
 * Parse either an RFC3339 date-time or a unix-epoch-ms decimal string.
 * Returns the timestamp in Unix milliseconds, or `null` if unparseable.
 *
 * **RFC3339 branch.** Uses `Date.parse` which accepts the RFC3339
 * subset ISO-8601 shape (`YYYY-MM-DDTHH:MM:SS[.sss](Z|±HH:MM)`). That
 * shape is what Go's `time.RFC3339` emits.
 *
 * **Epoch branch.** All-digit strings (optionally positive) up to a
 * safe-integer range. Anything else returns null.
 */
function parseTimestamp(header: string): number | null {
  const trimmed = header.trim();

  // Epoch-ms branch first: cheaper, deterministic, and un-ambiguous
  // (no RFC3339 timestamp starts with a digit-only run that's also a
  // valid epoch — RFC3339 requires the `-` separator by position 5).
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return null;
    if (n < 0 || n > Number.MAX_SAFE_INTEGER) return null;
    return n;
  }

  // RFC3339 branch.
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;
  return ms;
}
