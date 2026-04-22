/**
 * Task 5.14 — nonce generation for outbound signed requests.
 *
 * Brain's signed-request client (task 5.9) emits an `X-Nonce` header
 * on every request for Core's replay-guard to check against
 * `NonceReplayCache`. The spec: 16 random bytes, hex-encoded → 32
 * characters. This module is the canonical generator.
 *
 * **Why a separate module**: this pattern (16 bytes hex) recurs —
 * Dead Drop blob ids (task 4.34), device tokens (task 4.64), etc.
 * Each use case has different security properties (uniqueness scope,
 * lifetime, storage), so they don't share. But the Brain-side nonce
 * specifically needs:
 *   - 16 bytes = 128 bits, which at reasonable QPS (say 100/s) takes
 *     ~10^16 requests before birthday-collision probability exceeds
 *     1/10^12 — far past any realistic Brain lifetime.
 *   - No monotonic component — monotonic nonces leak request ordering
 *     to an observer capable of timing-correlating outbound traffic.
 *   - 32 chars hex fits comfortably in an HTTP header; no base64url
 *     padding concerns.
 *
 * **Injectable randomness**: `randomBytesFn` is overridable for
 * tests. Production uses `node:crypto.randomBytes`.
 *
 * **Brain-Core contract**: the matching server-side validator is
 * `src/auth/nonce_guard.ts`. Both sides need to agree on the hex
 * string length + format; this module is the source of truth for
 * the client half.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5b task 5.14.
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto';

/** Spec: 16 bytes = 128 bits of unpredictability. */
export const NONCE_BYTES = 16;

/** 16 bytes → 32 hex characters. */
export const NONCE_HEX_LENGTH = NONCE_BYTES * 2;

export interface NonceGeneratorOptions {
  /** Byte source. Default `node:crypto.randomBytes`. */
  randomBytesFn?: (n: number) => Uint8Array;
}

/**
 * Generator closure. Each call produces an independent 32-char hex
 * nonce — no internal state, so concurrent calls can't race.
 *
 * Throws if `randomBytesFn` returns the wrong length; a malformed
 * nonce would make the request fail signature verification on Core's
 * side, so fail-fast here.
 */
export function createNonceGenerator(
  opts: NonceGeneratorOptions = {},
): () => string {
  const randomBytesFn = opts.randomBytesFn ?? defaultRandomBytes;
  return () => {
    const bytes = randomBytesFn(NONCE_BYTES);
    if (bytes.length !== NONCE_BYTES) {
      throw new Error(
        `createNonceGenerator: randomBytesFn returned ${bytes.length} bytes, expected ${NONCE_BYTES}`,
      );
    }
    return bytesToHex(bytes);
  };
}

/**
 * One-shot helper for callers that don't want to plumb a closure. Uses
 * the default byte source. Prefer `createNonceGenerator` in long-lived
 * clients so tests can inject deterministic randomness.
 */
export function generateNonce(): string {
  return createNonceGenerator()();
}

/**
 * Validator for caller-supplied values — useful when a Brain config
 * path hands us an explicit nonce and we want to reject shape errors
 * loud instead of sending an un-verifiable request. Kept in the same
 * module because the format contract is this module's responsibility.
 */
export function isValidNonceFormat(candidate: unknown): candidate is string {
  return (
    typeof candidate === 'string' &&
    candidate.length === NONCE_HEX_LENGTH &&
    /^[0-9a-f]+$/.test(candidate)
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultRandomBytes(n: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(n));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}
