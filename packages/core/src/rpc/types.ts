/**
 * RPC Bridge inner request/response types + size guard.
 *
 * These types model one HTTP-shaped message travelling inside a NaCl
 * envelope over the MsgBox transport. The outer envelope handles
 * encryption + sender DID; this inner layer carries the method / path /
 * headers / body that the existing HTTP handler chain consumes.
 *
 * Size guard: inner bodies are capped at 1 MiB after NaCl decryption, so
 * a malicious peer cannot force Core into unbounded allocation by framing
 * a huge plaintext inside a small ciphertext.
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md CORE-P0-001 / CORE-P0-003.
 */

/** Maximum inner-body size in bytes: 1 MiB. */
export const MAX_INNER_BODY_SIZE = 1 * 1024 * 1024;

/**
 * Inner HTTP request carried by the RPC envelope. `path` is server-relative
 * (e.g. `/v1/identity`). `headers` is a flat string→string map — the bridge
 * re-canonicalises header names before dispatch to the HTTP chain.
 */
export interface RPCInnerRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * Inner HTTP response the bridge returns to the peer. Status codes mirror
 * HTTP semantics; the bridge does not re-interpret them.
 */
export interface RPCInnerResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * Throws if the body exceeds `MAX_INNER_BODY_SIZE`. Used at the decryption
 * boundary — the peer's envelope may have decrypted to a body larger than
 * the cap, which we reject before it reaches the HTTP chain. The error
 * carries an HTTP-ish status for the caller to surface in the inner
 * response.
 */
export class InnerBodyTooLargeError extends Error {
  readonly status = 413;
  constructor(readonly size: number) {
    super(`RPC inner body size ${size} exceeds MAX_INNER_BODY_SIZE ${MAX_INNER_BODY_SIZE}`);
    this.name = 'InnerBodyTooLargeError';
  }
}

/** Assert the given body fits the inner-body cap. Throws `InnerBodyTooLargeError` otherwise. */
export function assertInnerBodyWithinSize(body: Uint8Array): void {
  if (body.byteLength > MAX_INNER_BODY_SIZE) {
    throw new InnerBodyTooLargeError(body.byteLength);
  }
}
