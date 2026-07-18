/**
 * Generic symmetric AEAD (AES-256-GCM) over a caller-supplied 32-byte key.
 *
 * The shipping `aesgcm.ts` is purpose-built for seed-wrapping under an
 * Argon2id KEK; this is the generic primitive the interactive-run
 * envelope-encrypted payload store needs (a fresh per-payload data key, the
 * persona-DEK confidentiality wrap, and the per-payload leaf erasure wrap —
 * INTERACTIVE_SERVICES_ARCHITECTURE.md §13). Same wire shape as `aesgcm.ts`:
 *
 *   output = nonce(12) || ciphertext || GCM tag(16)
 *
 * Uses `@noble/ciphers` (audited, pure JS) so it runs byte-identically on
 * Node and Hermes.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';

/** AES-256 key size. */
export const AEAD_KEY_BYTES = 32;
const NONCE_BYTES = 12;

export class AeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AeadError';
  }
}

/** Generate a fresh random 32-byte AEAD key. */
export function generateAeadKey(): Uint8Array {
  return randomBytes(AEAD_KEY_BYTES);
}

/**
 * AES-256-GCM encrypt. `key` must be exactly 32 bytes. Optional `aad` is
 * authenticated but not encrypted. Returns `nonce || ciphertext+tag`.
 */
export function aeadEncrypt(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
  if (key.length !== AEAD_KEY_BYTES) {
    throw new AeadError(`key must be ${AEAD_KEY_BYTES} bytes, got ${key.length}`);
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = aad === undefined ? gcm(key, nonce) : gcm(key, nonce, aad);
  const ct = cipher.encrypt(plaintext);
  const out = new Uint8Array(NONCE_BYTES + ct.length);
  out.set(nonce, 0);
  out.set(ct, NONCE_BYTES);
  return out;
}

/**
 * AES-256-GCM decrypt of `nonce || ciphertext+tag`. Throws `AeadError` on a
 * wrong key / corrupted data / tag mismatch (fail-closed). The optional `aad`
 * must match what was supplied at encryption.
 */
export function aeadDecrypt(key: Uint8Array, envelope: Uint8Array, aad?: Uint8Array): Uint8Array {
  if (key.length !== AEAD_KEY_BYTES) {
    throw new AeadError(`key must be ${AEAD_KEY_BYTES} bytes, got ${key.length}`);
  }
  if (envelope.length <= NONCE_BYTES) {
    throw new AeadError('envelope too short');
  }
  const nonce = envelope.slice(0, NONCE_BYTES);
  const ct = envelope.slice(NONCE_BYTES);
  const decipher = aad === undefined ? gcm(key, nonce) : gcm(key, nonce, aad);
  try {
    return decipher.decrypt(ct);
  } catch {
    throw new AeadError('decryption failed — wrong key or corrupted data');
  }
}
