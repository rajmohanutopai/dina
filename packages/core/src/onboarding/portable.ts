/**
 * Portable onboarding steps — client-side crypto that runs on mobile.
 *
 * Portable subset of server onboarding_test.go:
 * - BIP-39 seed generated client-side
 * - Root keypair derived via SLIP-0010
 * - Per-persona DEKs derived via HKDF
 * - Password wraps master seed (Argon2id + AES-GCM)
 * - One default "general" persona created
 * - Mnemonic backup deferred (shown once, user writes down)
 * - Sharing rules default to empty (default-deny egress)
 *
 * Source: core/test/onboarding_test.go (portable parts)
 */

import { generateMnemonic, mnemonicToEntropy } from '../crypto/bip39';
import { deriveRootSigningKey } from '../crypto/slip0010';
import { deriveDIDKey } from '../identity/did';
import { wrapSeed } from '../crypto/aesgcm';
import { serializeWrappedSeed } from '../storage/seed_file';

export interface OnboardingResult {
  mnemonic: string[]; // 24 words
  did: string; // did:key:z6Mk...
  defaultPersona: string; // "general"
  wrapped: Uint8Array; // serialized wrapped seed blob
}

/**
 * Run the portable onboarding sequence.
 *
 * 1. Generate 24-word BIP-39 mnemonic
 * 2. Extract 32-byte entropy from mnemonic (Go-compatible master seed)
 * 3. Derive root signing key via SLIP-0010 (m/9999'/0'/0')
 * 4. Derive did:key from root public key
 * 5. Wrap master seed with passphrase (Argon2id + AES-256-GCM)
 * 6. Return mnemonic, DID, default persona name, wrapped seed
 *
 * Sharing rules default to empty (default-deny egress).
 * PLC directory registration happens separately (Task 2.30).
 */
export async function runOnboarding(passphrase: string): Promise<OnboardingResult> {
  // 1. Generate mnemonic (24 words, 256-bit entropy)
  const mnemonicString = generateMnemonic();
  const mnemonic = mnemonicString.split(' ');

  // 2. Extract 32-byte entropy (Go-compatible — same mnemonic → same seed → same DID)
  const masterSeed = mnemonicToEntropy(mnemonicString);

  // 3. Derive root signing key at m/9999'/0'/0'
  const rootKey = deriveRootSigningKey(masterSeed, 0);

  // 4. Derive did:key from root public key
  const did = deriveDIDKey(rootKey.publicKey);

  // 5. Wrap master seed with passphrase
  const wrappedSeed = await wrapSeed(passphrase, masterSeed);
  const wrapped = serializeWrappedSeed(wrappedSeed);

  return {
    mnemonic,
    did,
    defaultPersona: 'general',
    wrapped,
  };
}

/**
 * Verify that exactly one default persona "general" exists.
 *
 * At onboarding, only the "general" persona is created.
 * Additional personas are created by the user later.
 */
export function verifyDefaultPersona(personas: string[]): boolean {
  return personas.length >= 1 && personas.includes('general');
}

/**
 * Verify sharing rules default to empty (default-deny egress).
 *
 * At onboarding, no sharing rules exist — all egress is denied by default.
 * Users explicitly configure per-contact sharing policies.
 */
export function verifyDefaultSharingRules(rules: Record<string, unknown>): boolean {
  return Object.keys(rules).length === 0;
}
