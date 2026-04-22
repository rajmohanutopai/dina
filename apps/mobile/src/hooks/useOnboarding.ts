/**
 * Onboarding hooks — create and recover identity.
 *
 * Create flow (4.2):
 *   1. Generate 24-word BIP-39 mnemonic
 *   2. User verifies selected words
 *   3. User sets passphrase
 *   4. Derive seed from mnemonic
 *   5. Wrap seed with passphrase (Argon2id → AES-256-GCM)
 *   6. Derive DID from seed
 *   7. Create "general" persona (default tier)
 *
 * Recover flow (4.3):
 *   1. User enters 24 words
 *   2. Validate mnemonic
 *   3. Derive seed → DID (verify matches expected)
 *   4. User sets passphrase
 *   5. Wrap seed
 *   6. Re-create general persona
 *
 * Source: ARCHITECTURE.md Tasks 4.2, 4.3
 */

import {
  generateMnemonic,
  mnemonicToEntropy,
  validateMnemonic,
} from '../../../core/src/crypto/bip39';
import { wrapSeed, type WrappedSeed } from '../../../core/src/crypto/aesgcm';
import { getPublicKey } from '../../../core/src/crypto/ed25519';
import { deriveRootSigningKey } from '../../../core/src/crypto/slip0010';
import { deriveDIDKey } from '../../../core/src/identity/did';
import { createPersona, personaExists, resetPersonaState } from '../../../core/src/persona/service';

export type OnboardingStep =
  | 'welcome'
  | 'generate_mnemonic'
  | 'verify_mnemonic'
  | 'set_passphrase'
  | 'creating'
  | 'complete'
  | 'error';

export interface OnboardingState {
  step: OnboardingStep;
  mnemonic: string[];
  did: string | null;
  wrappedSeed: WrappedSeed | null;
  error: string | null;
}

export interface VerificationChallenge {
  /** Indices of words the user must confirm (0-based). */
  indices: number[];
  /** Expected answers (lowercase). */
  expected: string[];
}

import { ONBOARDING_VERIFY_WORD_COUNT } from '../../../core/src/constants';
/** Number of words to verify during onboarding. */
const VERIFY_WORD_COUNT = ONBOARDING_VERIFY_WORD_COUNT;

// ---------------------------------------------------------------
// Create Identity (4.2)
// ---------------------------------------------------------------

/**
 * Step 1: Generate a new 24-word mnemonic.
 */
export function generateNewMnemonic(): string[] {
  const mnemonic = generateMnemonic();
  return mnemonic.split(' ');
}

/**
 * Step 2: Create a verification challenge — pick random words for the user to confirm.
 */
export function createVerificationChallenge(words: string[]): VerificationChallenge {
  const indices: number[] = [];
  const pool = [...Array(words.length).keys()]; // [0, 1, 2, ..., 23]

  // Pick VERIFY_WORD_COUNT random unique indices
  for (let i = 0; i < VERIFY_WORD_COUNT && pool.length > 0; i++) {
    const pick = Math.floor(Math.random() * pool.length);
    indices.push(pool[pick]);
    pool.splice(pick, 1);
  }

  indices.sort((a, b) => a - b);

  return {
    indices,
    expected: indices.map((i) => words[i].toLowerCase()),
  };
}

/**
 * Step 2b: Verify the user's answers against the challenge.
 */
export function verifyMnemonicAnswers(
  challenge: VerificationChallenge,
  answers: string[],
): { valid: boolean; wrongIndices: number[] } {
  const wrongIndices: number[] = [];

  for (let i = 0; i < challenge.expected.length; i++) {
    if (i >= answers.length || answers[i].trim().toLowerCase() !== challenge.expected[i]) {
      wrongIndices.push(challenge.indices[i]);
    }
  }

  return { valid: wrongIndices.length === 0, wrongIndices };
}

/**
 * Step 3-7: Complete the create flow — derive seed, wrap, create DID + persona.
 */
export async function completeCreateIdentity(
  words: string[],
  passphrase: string,
): Promise<{ did: string; wrappedSeed: WrappedSeed }> {
  const mnemonic = words.join(' ');

  if (!validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }

  // Derive 64-byte master seed from mnemonic (PBKDF2)
  const masterSeed = mnemonicToEntropy(mnemonic);

  // Wrap master seed with passphrase (Argon2id → AES-256-GCM)
  const wrappedSeed = await wrapSeed(passphrase, masterSeed);

  // Derive root signing key via SLIP-0010 (m/9999'/0'/0')
  const rootKey = deriveRootSigningKey(masterSeed, 0);
  const pubKey = getPublicKey(rootKey.privateKey);
  const did = deriveDIDKey(pubKey);

  // Create general persona
  if (!personaExists('general')) {
    createPersona('general', 'default', 'Default persona');
  }

  return { did, wrappedSeed };
}

// ---------------------------------------------------------------
// Recover Identity (4.3)
// ---------------------------------------------------------------

/**
 * Step 1: Validate entered mnemonic words.
 */
export function validateRecoveryMnemonic(words: string[]): {
  valid: boolean;
  error: string | null;
} {
  if (words.length !== 24) {
    return { valid: false, error: `Expected 24 words, got ${words.length}` };
  }

  const mnemonic = words.map((w) => w.trim().toLowerCase()).join(' ');

  if (!validateMnemonic(mnemonic)) {
    return { valid: false, error: 'Invalid mnemonic — check the words and order' };
  }

  return { valid: true, error: null };
}

/**
 * Step 2: Preview the DID that will be restored (before setting passphrase).
 */
export function previewRecoveryDID(words: string[]): string | null {
  const mnemonic = words.map((w) => w.trim().toLowerCase()).join(' ');
  if (!validateMnemonic(mnemonic)) return null;

  const masterSeed = mnemonicToEntropy(mnemonic);
  const rootKey = deriveRootSigningKey(masterSeed, 0);
  const pubKey = getPublicKey(rootKey.privateKey);
  return deriveDIDKey(pubKey);
}

/**
 * Step 3-6: Complete the recovery flow.
 */
export async function completeRecoverIdentity(
  words: string[],
  passphrase: string,
): Promise<{ did: string; wrappedSeed: WrappedSeed }> {
  // Same as create — mnemonic→seed→wrap→DID→persona
  return completeCreateIdentity(
    words.map((w) => w.trim().toLowerCase()),
    passphrase,
  );
}

/**
 * Verify recovery produces the expected DID.
 */
export function verifyRecoveredDID(words: string[], expectedDID: string): boolean {
  const did = previewRecoveryDID(words);
  return did === expectedDID;
}

/**
 * Reset onboarding state (for testing).
 */
export function resetOnboarding(): void {
  resetPersonaState();
}
