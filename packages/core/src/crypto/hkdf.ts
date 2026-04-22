/**
 * HKDF-SHA256 per-persona DEK derivation.
 *
 * Derives 32-byte Data Encryption Keys for persona SQLCipher vaults.
 *
 * Go source of truth: core/internal/adapter/crypto/keyderiver.go
 *   HKDF(sha256, masterSeed, userSalt, "dina:vault:{name}:v1", 32)
 *
 * Uses @noble/hashes/hkdf + @noble/hashes/sha256.
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * Derive a 32-byte Data Encryption Key for a persona vault.
 *
 * @param masterSeed - First 32 bytes of the BIP-39 seed
 * @param personaName - e.g., "health", "general", "identity"
 * @param userSalt - 32-byte user salt (stored alongside wrapped seed)
 * @returns 32-byte DEK for SQLCipher
 */
export function derivePersonaDEK(
  masterSeed: Uint8Array,
  personaName: string,
  userSalt: Uint8Array,
): Uint8Array {
  if (!masterSeed || masterSeed.length < 16) {
    throw new Error('hkdf: master seed too short');
  }
  if (!personaName || personaName.length === 0) {
    throw new Error('hkdf: empty persona name');
  }
  if (!userSalt || userSalt.length < 16) {
    throw new Error('hkdf: user salt too short');
  }

  const info = new TextEncoder().encode(`dina:vault:${personaName}:v1`);
  return hkdf(sha256, masterSeed, userSalt, info, 32);
}

/**
 * Derive the backup encryption key.
 *
 * @param masterSeed - First 32 bytes of the BIP-39 seed
 * @param userSalt - 32-byte user salt
 * @returns 32-byte backup key
 */
export function deriveBackupKey(masterSeed: Uint8Array, userSalt: Uint8Array): Uint8Array {
  if (!masterSeed || masterSeed.length < 16) {
    throw new Error('hkdf: master seed too short');
  }
  if (!userSalt || userSalt.length < 16) {
    throw new Error('hkdf: user salt too short');
  }

  const info = new TextEncoder().encode('dina:backup:key:v1');
  return hkdf(sha256, masterSeed, userSalt, info, 32);
}

/**
 * Compute the SHA-256 hash of a DEK for validation storage.
 * The hash is stored in persona state; the DEK itself is never stored.
 */
export function deriveDEKHash(dek: Uint8Array): string {
  if (!dek || dek.length !== 32) {
    throw new Error('hkdf: DEK must be exactly 32 bytes');
  }
  return bytesToHex(sha256(dek));
}
