/**
 * Master-seed export coverage check (TN-IDENT-010).
 *
 * Property pinned by this file: the BIP-39 mnemonic is the *single*
 * sufficient artefact to recover all pseudonymous-namespace keys.
 * No side-channel state — no per-namespace metadata, no chain-code
 * journal, no wrapped-key file — is needed to re-derive the full
 * namespace lineage.
 *
 * This is what makes the Trust Network V1 namespace recovery flow
 * (plan §3.5.5) work: a wiped device + the user's BIP-39 backup
 * → re-derived namespace keys → unchanged identity → all prior
 * attestations remain verifiable under the recovered namespace
 * key.
 *
 * Two seed paths are pinned because the Dina codebase has both:
 *   - 64-byte BIP-39 PBKDF2 (`mnemonicToSeed`)        — fixture path
 *   - 32-byte raw BIP-39 entropy (`mnemonicToEntropy`) — live recovery path
 *
 * Each path is internally consistent — same mnemonic always re-derives
 * to the same key under the same path. The two paths produce different
 * keys (which is documented in `bip39.ts`). This test guards against
 * regression in either.
 */

import { bytesToHex } from '@noble/hashes/utils.js';

import {
  generateMnemonic,
  deriveNamespaceKey,
  mnemonicToEntropy,
  mnemonicToSeed,
  validateMnemonic,
} from '../../src';

describe('Master-seed export coverage (TN-IDENT-010)', () => {
  describe('64-byte BIP-39 PBKDF2 seed path', () => {
    it('the same mnemonic re-derives identical namespace keys', () => {
      const mnemonic = generateMnemonic();
      expect(validateMnemonic(mnemonic)).toBe(true);

      const firstSeed = mnemonicToSeed(mnemonic);
      const firstKeys = [0, 1, 2, 3, 7].map((n) =>
        bytesToHex(deriveNamespaceKey(firstSeed, n).privateKey),
      );

      // Simulate "wipe + recover": only the mnemonic survives.
      const recoveredSeed = mnemonicToSeed(mnemonic);
      const recoveredKeys = [0, 1, 2, 3, 7].map((n) =>
        bytesToHex(deriveNamespaceKey(recoveredSeed, n).privateKey),
      );

      expect(recoveredKeys).toEqual(firstKeys);
    });

    it('chain-codes also round-trip — descendant derivation stays valid', () => {
      // chain_code is what makes the next child-derivation step
      // deterministic. If chain_code regresses, future child keys
      // diverge silently — no immediate symptom, but a long-term
      // recovery break. Pinning byte-equality here closes that hole.
      const mnemonic = generateMnemonic();
      const seedA = mnemonicToSeed(mnemonic);
      const seedB = mnemonicToSeed(mnemonic);
      for (const n of [0, 1, 5, 42]) {
        const a = deriveNamespaceKey(seedA, n);
        const b = deriveNamespaceKey(seedB, n);
        expect(bytesToHex(a.chainCode)).toBe(bytesToHex(b.chainCode));
        expect(bytesToHex(a.publicKey)).toBe(bytesToHex(b.publicKey));
      }
    });
  });

  describe('32-byte BIP-39 entropy seed path (Go-compatible recovery)', () => {
    it('the same mnemonic re-derives identical namespace keys', () => {
      const mnemonic = generateMnemonic();
      const firstEntropy = mnemonicToEntropy(mnemonic);
      const firstKeys = [0, 1, 2, 3, 7].map((n) =>
        bytesToHex(deriveNamespaceKey(firstEntropy, n).privateKey),
      );

      const recoveredEntropy = mnemonicToEntropy(mnemonic);
      const recoveredKeys = [0, 1, 2, 3, 7].map((n) =>
        bytesToHex(deriveNamespaceKey(recoveredEntropy, n).privateKey),
      );

      expect(recoveredKeys).toEqual(firstKeys);
    });
  });

  describe('cross-path independence', () => {
    it('64-byte seed and 32-byte entropy produce DIFFERENT namespace keys', () => {
      // Documented behaviour: the two seed paths live in disjoint key
      // spaces. This test pins that distinction so a future "make
      // them equal" refactor doesn't silently break either side's
      // recovery — switching either side would orphan every key
      // already derived under the old path.
      const mnemonic = generateMnemonic();
      const seed64 = mnemonicToSeed(mnemonic);
      const entropy32 = mnemonicToEntropy(mnemonic);
      const k64 = bytesToHex(deriveNamespaceKey(seed64, 0).privateKey);
      const k32 = bytesToHex(deriveNamespaceKey(entropy32, 0).privateKey);
      expect(k64).not.toBe(k32);
    });
  });

  describe('determinism across many indices', () => {
    it('100 namespace keys at indices 0..99 are stable under re-derivation', () => {
      const mnemonic = generateMnemonic();
      const seed = mnemonicToSeed(mnemonic);

      const first: string[] = [];
      const second: string[] = [];
      for (let n = 0; n < 100; n++) {
        first.push(bytesToHex(deriveNamespaceKey(seed, n).privateKey));
      }
      // Re-derive from the SAME seed and assert byte-equality across
      // all 100 indices. Catches any latent randomness / once-only
      // caching that would otherwise drift across calls.
      for (let n = 0; n < 100; n++) {
        second.push(bytesToHex(deriveNamespaceKey(seed, n).privateKey));
      }
      expect(second).toEqual(first);

      // All 100 must be distinct — purpose-4 derivation must not
      // collide on any index pair (would silently overwrite namespaces).
      expect(new Set(first).size).toBe(100);
    });
  });

  describe('mnemonic export round-trip (the user-visible flow)', () => {
    it('mnemonic → seed → namespace key → mnemonic → seed → namespace key is a closed loop', () => {
      // Phase 1: user creates an identity, derives namespace_0.
      const mnemonic = generateMnemonic();
      const seed = mnemonicToSeed(mnemonic);
      const original = bytesToHex(deriveNamespaceKey(seed, 0).privateKey);

      // Phase 2: user "exports" the mnemonic (writes 24 words on paper).
      const exported = mnemonic;

      // Phase 3: device wiped, no other state survives.
      // Phase 4: user reimports the mnemonic on a new device.
      expect(validateMnemonic(exported)).toBe(true);
      const recoveredSeed = mnemonicToSeed(exported);
      const recovered = bytesToHex(deriveNamespaceKey(recoveredSeed, 0).privateKey);

      expect(recovered).toBe(original);
    });
  });
});
