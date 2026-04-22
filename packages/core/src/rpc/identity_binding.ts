/**
 * Identity binding: verify that the outer envelope's `from_did` matches
 * the inner request's `X-DID` header before dispatching the inner HTTP
 * request. Mismatch means the envelope and inner request disagree about
 * who the sender is — likely a proxying attacker or a misconfigured
 * client. Refuse with 401.
 *
 * This is distinct from signature verification (which proves the
 * envelope-claimed sender owns the private key). Identity binding
 * prevents a signed envelope from carrying an inner request attributed
 * to someone else — the two identities MUST match.
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md CORE-P0-004.
 */

import type { RPCInnerRequest } from './types';

export class IdentityBindingError extends Error {
  readonly status = 401;
  constructor(
    readonly envelopeDid: string,
    readonly innerDid: string,
  ) {
    super(
      `RPC identity binding failed: envelope.from_did=${envelopeDid} ≠ inner X-DID=${innerDid}`,
    );
    this.name = 'IdentityBindingError';
  }
}

/**
 * Throws `IdentityBindingError` when the envelope's `from_did` does
 * not match the inner request's `X-DID` header. Header lookup is
 * case-insensitive (HTTP convention).
 *
 * A missing `X-DID` header is a binding failure — every inner request
 * MUST declare its sender identity. Empty-string DID is likewise a
 * failure (suggests a misconfigured client, never valid).
 */
export function assertIdentityBinding(envelopeDid: string, request: RPCInnerRequest): void {
  const innerDid = findHeaderCI(request.headers, 'X-DID') ?? '';
  if (envelopeDid === '' || innerDid === '' || envelopeDid !== innerDid) {
    throw new IdentityBindingError(envelopeDid, innerDid);
  }
}

/** Case-insensitive header lookup. Returns the FIRST match (HTTP allows duplicates). */
function findHeaderCI(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}
