/**
 * Task 4.19 — Ed25519 signature verifier over the canonical request string.
 *
 * Thin composition of:
 *   - `Crypto.ed25519Verify(pubKey, message, signature)` from
 *     `@dina/adapters-node` (which delegates to `@noble/ed25519` — same
 *     library Go Core uses transitively, so cross-runtime signatures
 *     verify byte-identically).
 *   - Header + timestamp + nonce validators from peer files (tasks
 *     4.21-4.23); callers compose them.
 *
 * This module does NOT:
 *   - Resolve a DID → pub-key (lands with task 4.24 per-service
 *     allowlists: the caller passes the pub-key already resolved from
 *     the service-config allowlist).
 *   - Extract headers (task 4.21's `extractSignedHeaders`).
 *   - Validate timestamp window (task 4.22's `validateTimestamp`).
 *   - Check nonce replay (task 4.23's `NonceGuard`).
 *
 * The auth middleware (pending) chains these modules in order:
 *   extract → timestamp → nonce → verify → authorize.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4c task 4.19.
 */

import { Crypto } from '@dina/adapters-node';

export interface VerifySignatureInput {
  /** Canonical string that was signed (output of `buildCanonicalRequest`). */
  canonicalString: string;
  /** 64-byte Ed25519 signature, hex-encoded (128 lowercase hex chars).
   *  Shape already validated by `extractSignedHeaders`. */
  signatureHex: string;
  /** Caller's Ed25519 public key (32 bytes). Resolved by the allowlist
   *  layer (task 4.24) before calling this verifier. */
  publicKey: Uint8Array;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'bad_signature_encoding' | 'bad_public_key' | 'signature_mismatch' };

/**
 * Verify an Ed25519 signature over a canonical request string.
 *
 * Returns a structured result so the auth middleware can map to the
 * right HTTP status + log reason. Fail-closed on all malformed inputs
 * (wrong-length pub key, odd-length hex, non-hex sig) — the underlying
 * `ed25519Verify` contract is "return false on malformed, don't throw",
 * so any error here is an encoding-layer issue this function handles
 * explicitly.
 */
export async function verifySignature(
  input: VerifySignatureInput,
  crypto: Crypto = new Crypto(),
): Promise<VerifyResult> {
  if (input.publicKey.length !== 32) {
    return { ok: false, reason: 'bad_public_key' };
  }

  let signature: Uint8Array;
  try {
    signature = hexToBytes(input.signatureHex);
  } catch {
    return { ok: false, reason: 'bad_signature_encoding' };
  }
  if (signature.length !== 64) {
    return { ok: false, reason: 'bad_signature_encoding' };
  }

  const message = new TextEncoder().encode(input.canonicalString);
  const valid = await crypto.ed25519Verify(input.publicKey, message, signature);
  if (!valid) return { ok: false, reason: 'signature_mismatch' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('non-hex char');
    out[i] = byte;
  }
  return out;
}
