/**
 * Task 4.61 — recovery phrase export + import.
 *
 * The operator's BIP-39 mnemonic is the root of the Home Node's
 * cryptographic identity — losing it means losing the Home Node.
 * This module provides the operator-facing export / import flow:
 *
 *   `exportRecoveryPhrase(mnemonic)` → canonical display shape
 *     (validation + formatted word list + entropy size + checksum
 *     metadata) so the operator can write it down accurately.
 *
 *   `importRecoveryPhrase(input)` → validated mnemonic + entropy +
 *     seed, ready for identity derivation. Normalises whitespace,
 *     trims punctuation, folds case so a hand-transcribed phrase
 *     round-trips cleanly.
 *
 * **BIP-39 semantics** (inherited from `@dina/core`): the mnemonic
 * is the PRIMARY form; entropy + seed are derived. Going
 * mnemonic→entropy is lossless; entropy→mnemonic is deterministic
 * given the same wordlist. Seed derivation (64-byte PBKDF2) is
 * different from entropy (24-word → 32-byte). **Dina uses the raw
 * entropy as its master seed** — not the 64-byte PBKDF2 output —
 * for Go interop. See `@dina/core/src/crypto/bip39.ts` comments.
 *
 * **Normalisation on import**:
 *   1. Lowercase.
 *   2. Trim leading/trailing whitespace.
 *   3. Collapse runs of whitespace to single spaces.
 *   4. Strip trailing punctuation (`.` `,`) the operator may have
 *      dictated into.
 *
 * **Why structured result on import**: validation can fail in several
 * distinguishable ways (wrong word count, bad word, bad checksum) and
 * the operator UI needs to render the right error. Throwing loses
 * that signal.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4g task 4.61.
 */

import {
  mnemonicToEntropy,
  mnemonicToSeed,
  validateMnemonic,
} from '@dina/core';

/** BIP-39 accepts 12/15/18/21/24 words; Dina generates 24 (256-bit). */
export type MnemonicWordCount = 12 | 15 | 18 | 21 | 24;

const VALID_WORD_COUNTS: ReadonlySet<number> = new Set([12, 15, 18, 21, 24]);

/** Entropy byte length for each supported word count — BIP-39 §5. */
export const WORD_COUNT_TO_ENTROPY_BYTES: Readonly<Record<MnemonicWordCount, number>> =
  Object.freeze({
    12: 16,
    15: 20,
    18: 24,
    21: 28,
    24: 32,
  });

/** Result of `exportRecoveryPhrase`. */
export interface ExportedRecoveryPhrase {
  /** Normalised mnemonic string — what the operator transcribes. */
  mnemonic: string;
  /** Individual words. Length matches the mnemonic's word count. */
  words: string[];
  /** Word count (12 / 15 / 18 / 21 / 24). */
  wordCount: MnemonicWordCount;
  /** Raw entropy bytes (BIP-39 §5). Dina's master seed. */
  entropyBytes: number;
}

/**
 * Validate + format a mnemonic for operator display. Throws on any
 * validation failure — export is an operator-initiated operation on
 * the server's OWN mnemonic; a bad phrase here means corruption in
 * the secure store and must fail loud.
 */
export function exportRecoveryPhrase(mnemonic: string): ExportedRecoveryPhrase {
  if (typeof mnemonic !== 'string' || mnemonic.length === 0) {
    throw new Error('exportRecoveryPhrase: mnemonic must be a non-empty string');
  }
  const normalised = normaliseMnemonic(mnemonic);
  const words = normalised.split(' ');
  if (!isValidWordCount(words.length)) {
    throw new Error(
      `exportRecoveryPhrase: mnemonic must have 12 / 15 / 18 / 21 / 24 words (got ${words.length})`,
    );
  }
  if (!validateMnemonic(normalised)) {
    throw new Error(
      'exportRecoveryPhrase: mnemonic failed BIP-39 validation (bad word or checksum)',
    );
  }
  const wordCount = words.length as MnemonicWordCount;
  return {
    mnemonic: normalised,
    words,
    wordCount,
    entropyBytes: WORD_COUNT_TO_ENTROPY_BYTES[wordCount],
  };
}

export type ImportRecoveryPhraseResult =
  | {
      ok: true;
      mnemonic: string;
      words: string[];
      wordCount: MnemonicWordCount;
      /** BIP-39 raw entropy (16/20/24/28/32 bytes). Dina master seed for Go parity. */
      entropy: Uint8Array;
      /** 64-byte PBKDF2 seed (not Dina's default; kept for callers that need it). */
      pbkdf2Seed: Uint8Array;
    }
  | { ok: false; reason: ImportRejectionReason };

export type ImportRejectionReason =
  | 'empty'
  | 'wrong_word_count'
  | 'invalid_checksum'
  | 'unknown_word';

/**
 * Normalise + validate an operator-supplied mnemonic. Returns a
 * structured result so the UI can render a specific error.
 *
 * The returned `entropy` field is Dina's canonical master seed — the
 * callers that derive identity from the phrase pass it to
 * `deriveIdentity({masterSeed: result.entropy})` to reconstruct the
 * full key tree.
 */
export function importRecoveryPhrase(input: string): ImportRecoveryPhraseResult {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return { ok: false, reason: 'empty' };
  }
  const normalised = normaliseMnemonic(input);
  const words = normalised.split(' ');
  if (!isValidWordCount(words.length)) {
    return { ok: false, reason: 'wrong_word_count' };
  }
  // BIP-39 `validateMnemonic` catches BOTH unknown words AND bad
  // checksum, without distinguishing between them. Disambiguate so
  // the UI can suggest "did you mistype a word" vs "did you miss one".
  if (!validateMnemonic(normalised)) {
    if (hasUnknownWord(words)) return { ok: false, reason: 'unknown_word' };
    return { ok: false, reason: 'invalid_checksum' };
  }
  const wordCount = words.length as MnemonicWordCount;
  const entropy = mnemonicToEntropy(normalised);
  const pbkdf2Seed = mnemonicToSeed(normalised);
  return {
    ok: true,
    mnemonic: normalised,
    words,
    wordCount,
    entropy,
    pbkdf2Seed,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a user-supplied mnemonic string:
 *   1. Lowercase.
 *   2. Strip trailing common punctuation (`.`, `,`, `!`, `?`).
 *   3. Collapse any whitespace runs (including tabs / newlines) to single spaces.
 *   4. Trim leading/trailing whitespace.
 *
 * Idempotent.
 */
export function normaliseMnemonic(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,!?]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isValidWordCount(n: number): n is MnemonicWordCount {
  return VALID_WORD_COUNTS.has(n);
}

/**
 * True when at least one word is NOT in the BIP-39 English wordlist.
 * We call `validateMnemonic` on each single-word slice — any
 * validation pass that's NOT a checksum-fail signals the word itself
 * was accepted. Not perfect but gives a strictly better error than
 * the opaque `validateMnemonic` returning false.
 *
 * Implementation note: `validateMnemonic` expects a full phrase; a
 * single-word phrase will fail checksum but pass wordlist membership.
 * We rely on the fact that the checksum-fail path only fires when
 * every word is a known BIP-39 word. So we just re-check the full
 * phrase with each word substituted-out to isolate membership: if
 * removing a word + re-validating still produces the same "checksum
 * fail", the removed word wasn't the offender. Simpler approach:
 * compare each word to the wordlist directly.
 */
function hasUnknownWord(words: string[]): boolean {
  for (const word of words) {
    if (!BIP39_ENGLISH_WORDS.has(word)) return true;
  }
  return false;
}

// Lazy-load the BIP-39 English wordlist from @dina/core's source. The
// wordlist is a 2048-entry Set; we construct it once + memoise.
let BIP39_ENGLISH_WORDS: ReadonlySet<string> = new Set();
(function () {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { wordlist } = require('@scure/bip39/wordlists/english.js') as {
    wordlist: string[];
  };
  BIP39_ENGLISH_WORDS = new Set(wordlist);
})();
