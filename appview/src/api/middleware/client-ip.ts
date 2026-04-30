/**
 * Client IP extraction with proxy-header trust boundary (TN-TEST-082).
 *
 * Inputs to rate limiting / per-IP buckets are only as honest as the
 * IP they're keyed on. If the AppView accepted `X-Forwarded-For`
 * unconditionally, anyone could trivially bypass per-IP caps by
 * sending `X-Forwarded-For: 1.2.3.4` per request — every request
 * looks like a different client. The HIGH-01 hardening pinned this:
 * proxy headers are ONLY consulted when `TRUST_PROXY=1` (or
 * deployment-equivalent), explicitly opting in to a proxy that the
 * operator has configured.
 *
 * This module owns the **extraction logic**. Pure function: no
 * imports of `node:http`, no `req.socket` access — the caller hands
 * in the inputs (header value + remote address + trust flag) and
 * gets back the IP string. Pinned by adversarial tests covering:
 *
 *   - proxy-trust off: `X-Forwarded-For` ignored even when present
 *   - proxy-trust on: leftmost (=client) entry of comma-list wins
 *   - proxy-trust on but header absent: falls back to remoteAddress
 *   - whitespace + empty / repeated commas in the header
 *   - IPv6 brackets, IPv4-mapped IPv6, port suffixes
 *   - missing remoteAddress: returns `'unknown'` rather than throwing
 *
 * Why a separate module rather than inline in `web/server.ts`: the
 * extraction logic is non-trivial (4 inputs, 3 outcomes, several
 * edge cases). Inline, it's untestable; extracted, it's pinned by
 * a focused test surface that surfaces a regression at unit-test
 * speed. The web server now imports `extractClientIp` and the
 * function is the source of truth for proxy semantics.
 */

// ─── Public API ───────────────────────────────────────────────────────────

export interface ExtractClientIpInput {
  /**
   * Whether the deployment's reverse proxy is trusted to set
   * `X-Forwarded-For`. Read by the caller from `process.env.TRUST_PROXY`
   * — passed in so this module stays env-pure.
   */
  readonly trustProxy: boolean;
  /**
   * The raw `X-Forwarded-For` header value (or undefined when
   * absent). The HTTP type system surfaces this as
   * `string | string[] | undefined`; callers should pre-flatten to
   * a string when it arrives as an array (Node's first-array-element
   * matches the standard).
   */
  readonly forwardedFor: string | undefined;
  /**
   * `req.socket.remoteAddress` — the actual TCP peer's address.
   * Falls back to `undefined` only when the socket has detached
   * before extraction (rare, but possible on disconnect races).
   */
  readonly remoteAddress: string | undefined;
}

/**
 * The string returned when no IP can be determined. Used as a
 * cache-key bucket for rate limiting; treats "unknown" as a single
 * shared bucket which is conservative (one bad actor on a detached
 * socket can't get a free pass at the cost of one of "everyone with
 * detached sockets" sharing a cap).
 */
export const UNKNOWN_IP_BUCKET = 'unknown';

/**
 * Extract the client IP for rate-limiting purposes.
 *
 * Algorithm:
 *   1. If `trustProxy === true` AND `forwardedFor` is non-empty:
 *      - take the leftmost comma-separated entry (= original client
 *        per RFC 7239 / proxy convention)
 *      - trim whitespace
 *      - if it's non-empty, return it
 *      - else fall through to step 2 (header was malformed)
 *   2. If `remoteAddress` is non-empty, return it.
 *   3. Return `UNKNOWN_IP_BUCKET`.
 *
 * Note: this function does NOT validate that the result is a
 * syntactically-valid IPv4/IPv6 address. The output is a cache-key
 * string — even a hostile "I am `<script>`" XFF value just lands
 * the request in a separate (probably unique) bucket; it doesn't
 * affect the limiter's correctness. A regex check would just shift
 * the attack surface to the regex itself.
 */
export function extractClientIp(input: ExtractClientIpInput): string {
  if (input.trustProxy === true && typeof input.forwardedFor === 'string' && input.forwardedFor.length > 0) {
    // Standard XFF format: `client, proxy1, proxy2`. Leftmost = client.
    // Multiple commas / empty entries (`,,1.2.3.4`) are tolerated by
    // skipping leading empties — but only the FIRST non-empty entry
    // is used.
    for (const candidate of input.forwardedFor.split(',')) {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
    // All-whitespace / all-empty XFF — fall through to remoteAddress.
  }

  if (typeof input.remoteAddress === 'string' && input.remoteAddress.length > 0) {
    return input.remoteAddress;
  }

  return UNKNOWN_IP_BUCKET;
}
