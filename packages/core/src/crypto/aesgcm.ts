/**
 * AES-256-GCM seed wrapping.
 *
 * Wraps the master seed with a KEK (from Argon2id).
 * Format: nonce (12 bytes) || ciphertext + GCM tag (16 bytes)
 *
 * Uses @noble/ciphers (audited, pure JS AES-GCM).
 * Source of truth: core/internal/adapter/crypto/keywrap.go
 */

import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { deriveKEK, ARGON2ID_PARAMS } from './argon2id';

export interface WrappedSeed {
  salt: Uint8Array; // 16 bytes — Argon2id salt
  wrapped: Uint8Array; // nonce (12) + ciphertext + GCM tag (16)
  params: {
    memory: number; // 131072 KiB = 128 MB
    iterations: number; // 3
    parallelism: number; // 4
  };
}

/**
 * Wrap (encrypt) a master seed with a passphrase.
 *
 * 1. Generate random Argon2id salt (16 bytes)
 * 2. Argon2id(passphrase, salt) → KEK
 * 3. Generate random GCM nonce (12 bytes)
 * 4. AES-256-GCM.encrypt(KEK, nonce, seed) → ciphertext + tag
 * 5. Return { salt, wrapped: nonce || ciphertext || tag, params }
 */
export async function wrapSeed(passphrase: string, seed: Uint8Array): Promise<WrappedSeed> {
  if (!passphrase || passphrase.length === 0) {
    throw new Error('aesgcm: empty passphrase');
  }
  if (!seed || seed.length === 0) {
    throw new Error('aesgcm: empty seed');
  }

  // Reject all-zero seed before wrapping
  let allZero = true;
  for (let i = 0; i < seed.length; i++) {
    if (seed[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) {
    throw new Error('aesgcm: all-zero seed rejected (fail-closed)');
  }

  const salt = randomBytes(16);
  const kek = await deriveKEK(passphrase, salt);

  const nonce = randomBytes(12);
  const cipher = gcm(kek, nonce);
  const ciphertext = cipher.encrypt(seed);

  // wrapped = nonce (12) + ciphertext + GCM tag
  const wrapped = new Uint8Array(12 + ciphertext.length);
  wrapped.set(nonce, 0);
  wrapped.set(ciphertext, 12);

  return {
    salt,
    wrapped,
    params: {
      memory: ARGON2ID_PARAMS.memorySize,
      iterations: ARGON2ID_PARAMS.iterations,
      parallelism: ARGON2ID_PARAMS.parallelism,
    },
  };
}

/**
 * Unwrap (decrypt) a master seed from a wrapped blob.
 *
 * @throws if passphrase is wrong (GCM tag mismatch)
 * @throws if unwrapped seed is all zeros (fail-closed)
 */
export async function unwrapSeed(passphrase: string, wrapped: WrappedSeed): Promise<Uint8Array> {
  if (!passphrase || passphrase.length === 0) {
    throw new Error('aesgcm: empty passphrase');
  }
  if (!wrapped.wrapped || wrapped.wrapped.length <= 12) {
    throw new Error('aesgcm: wrapped data too short');
  }

  // Honour the params the wrap recorded, not the current module defaults.
  // A seed wrapped under the old 128 MB / p=4 defaults must still unwrap
  // after we tune the defaults down for RN — without this, a params tweak
  // silently bricks every returning user's vault.
  const kek = await deriveKEK(passphrase, wrapped.salt, {
    memory: wrapped.params.memory,
    iterations: wrapped.params.iterations,
    parallelism: wrapped.params.parallelism,
  });

  const nonce = wrapped.wrapped.slice(0, 12);
  const ciphertext = wrapped.wrapped.slice(12);

  const decipher = gcm(kek, nonce);
  let seed: Uint8Array;
  try {
    seed = decipher.decrypt(ciphertext);
  } catch {
    throw new Error('aesgcm: decryption failed — wrong passphrase or corrupted data');
  }

  // Reject all-zero seed after unwrapping (fail-closed)
  let allZero = true;
  for (let i = 0; i < seed.length; i++) {
    if (seed[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) {
    throw new Error('aesgcm: unwrapped seed is all-zero — rejected (fail-closed)');
  }

  return seed;
}

/**
 * Re-wrap seed with a new passphrase.
 * Unwraps with old passphrase, re-wraps with new.
 */
export async function changePassphrase(
  oldPassphrase: string,
  newPassphrase: string,
  wrapped: WrappedSeed,
): Promise<WrappedSeed> {
  const seed = await unwrapSeed(oldPassphrase, wrapped);
  return wrapSeed(newPassphrase, seed);
}
