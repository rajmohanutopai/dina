/**
 * BIP-39 mnemonic generation and seed derivation.
 *
 * Uses @scure/bip39 — audited, zero-dep.
 * Uses @noble/hashes for the PBKDF2 used internally by mnemonicToSeedSync.
 */

import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/** Generate a new 24-word BIP-39 mnemonic from 256-bit entropy. */
export function generateMnemonic(): string {
  return bip39.generateMnemonic(wordlist, 256);
}

/**
 * Convert a BIP-39 mnemonic to a 64-byte PBKDF2 seed.
 * Uses PBKDF2 with empty passphrase (standard BIP-39 behavior).
 *
 * NOTE: This returns 64 bytes. For Go-compatible 32-byte master seed,
 * use mnemonicToEntropy() instead.
 */
export function mnemonicToSeed(mnemonic: string): Uint8Array {
  return bip39.mnemonicToSeedSync(mnemonic, '');
}

/**
 * Convert a BIP-39 mnemonic back to its raw 32-byte entropy.
 *
 * This is the Go-compatible master seed: Go validates len(seed)==32
 * and uses raw entropy directly. The 64-byte PBKDF2 output from
 * mnemonicToSeed() produces DIFFERENT keys than Go's 32-byte path.
 *
 * Use this for all new key derivation to ensure cross-node compatibility:
 * same mnemonic → same 32-byte entropy → same SLIP-0010 keys → same DID.
 */
export function mnemonicToEntropy(mnemonic: string): Uint8Array {
  return bip39.mnemonicToEntropy(mnemonic, wordlist);
}

/** Validate a BIP-39 mnemonic (checksum + wordlist check). */
export function validateMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic, wordlist);
}
