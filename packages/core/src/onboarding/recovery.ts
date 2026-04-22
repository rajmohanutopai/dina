/**
 * Identity recovery — restore from BIP-39 mnemonic.
 *
 * Portable recovery flow:
 *   1. Validate the 24-word mnemonic (checksum + wordlist)
 *   2. Derive 64-byte seed via PBKDF2
 *   3. Derive root signing key (SLIP-0010 m/9999'/0'/0')
 *   4. Derive did:key from root public key
 *   5. Wrap seed with new passphrase (Argon2id + AES-256-GCM)
 *   6. Return recovered identity
 *
 * The recovered DID must match the original — this verifies the mnemonic
 * is correct. If the DID doesn't match the expected DID, recovery fails.
 *
 * Source: ARCHITECTURE.md Task 4.3
 */

import { validateMnemonic, mnemonicToEntropy } from '../crypto/bip39';
import { deriveRootSigningKey } from '../crypto/slip0010';
import { deriveDIDKey } from '../identity/did';
import { wrapSeed } from '../crypto/aesgcm';
import { serializeWrappedSeed } from '../storage/seed_file';

export interface RecoveryResult {
  did: string;
  wrapped: Uint8Array;
  mnemonicValid: boolean;
}

/**
 * Recover identity from a BIP-39 mnemonic.
 *
 * @param words — the 24-word mnemonic (space-separated string or array)
 * @param passphrase — new passphrase to wrap the recovered seed
 * @param expectedDID — optional: verify the recovered DID matches
 * @throws on invalid mnemonic or DID mismatch
 */
export async function recoverFromMnemonic(
  words: string | string[],
  passphrase: string,
  expectedDID?: string,
): Promise<RecoveryResult> {
  // 1. Normalize to string
  const mnemonicStr = Array.isArray(words) ? words.join(' ') : words.trim();

  // 2. Validate mnemonic
  if (!validateMnemonic(mnemonicStr)) {
    throw new Error('recovery: invalid mnemonic — checksum or wordlist mismatch');
  }

  // 3. Extract 32-byte entropy (Go-compatible master seed)
  const seed = mnemonicToEntropy(mnemonicStr);

  // 4. Derive root key + DID
  const rootKey = deriveRootSigningKey(seed, 0);
  const did = deriveDIDKey(rootKey.publicKey);

  // 5. Verify DID matches expected (if provided)
  if (expectedDID && did !== expectedDID) {
    throw new Error(`recovery: DID mismatch — recovered "${did}" but expected "${expectedDID}"`);
  }

  // 6. Wrap seed with new passphrase
  const wrappedSeed = await wrapSeed(passphrase, seed);
  const wrapped = serializeWrappedSeed(wrappedSeed);

  return { did, wrapped, mnemonicValid: true };
}

/**
 * Validate a mnemonic without recovering (quick check).
 *
 * Returns { valid, wordCount, error? }.
 */
export function validateRecoveryMnemonic(words: string | string[]): {
  valid: boolean;
  wordCount: number;
  error?: string;
} {
  const mnemonicStr = Array.isArray(words) ? words.join(' ') : words.trim();
  const wordList = mnemonicStr.split(/\s+/).filter((w) => w.length > 0);

  if (wordList.length !== 24) {
    return {
      valid: false,
      wordCount: wordList.length,
      error: `Expected 24 words, got ${wordList.length}`,
    };
  }

  if (!validateMnemonic(mnemonicStr)) {
    return { valid: false, wordCount: 24, error: 'Invalid checksum or unknown words' };
  }

  return { valid: true, wordCount: 24 };
}
