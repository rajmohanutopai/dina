/**
 * Core RPC Relay — identity binding invariant.
 *
 * Three identities in a relayed request must match:
 *   1. Outer MsgBox X-Sender-DID (envelope "from")
 *   2. Envelope "from" field (after NaCl decryption)
 *   3. Inner request X-DID header
 *
 * Additionally: the DID must derive from the Ed25519 public key that
 * signed the inner request (prove key possession).
 *
 * Mobile-specific protocol: Section 19.3 of ARCHITECTURE.md.
 */

import { deriveDIDKey } from '../identity/did';
import type { CoreRPCRequest } from './rpc_envelope';

/**
 * Verify envelope.from matches inner X-DID (identity must be consistent).
 */
export function verifyEnvelopeBinding(envelopeFrom: string, innerXDID: string): boolean {
  if (!envelopeFrom || !innerXDID) return false;
  return envelopeFrom === innerXDID;
}

/**
 * Verify DID derives from the Ed25519 public key that signed the request.
 * Proves the signer possesses the key corresponding to the claimed DID.
 */
export function verifyDIDDerivesFromKey(did: string, publicKey: Uint8Array): boolean {
  if (!did || !publicKey || publicKey.length !== 32) return false;

  try {
    const derivedDID = deriveDIDKey(publicKey);
    return derivedDID === did;
  } catch {
    return false;
  }
}

/**
 * Full identity binding check on a Core RPC request.
 *
 * Checks:
 * 1. envelope.from == inner X-DID header
 * 2. X-DID header is present
 *
 * Note: DID-from-key verification requires the public key from signature
 * verification, which happens in the auth middleware layer. This function
 * checks the structural binding only.
 */
export function validateIdentityBinding(request: CoreRPCRequest): {
  valid: boolean;
  error?: string;
} {
  const innerXDID = request.headers?.['X-DID'];

  if (!innerXDID) {
    return { valid: false, error: 'Missing X-DID header in inner request' };
  }

  if (!request.from) {
    return { valid: false, error: 'Missing envelope "from" field' };
  }

  if (!verifyEnvelopeBinding(request.from, innerXDID)) {
    return {
      valid: false,
      error: `Identity mismatch: envelope.from="${request.from}" != inner X-DID="${innerXDID}"`,
    };
  }

  return { valid: true };
}
