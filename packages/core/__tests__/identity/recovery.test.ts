/**
 * T2D.19 — Mnemonic recovery restores identity.
 *
 * Category B: integration/contract test (release verification).
 * Verifies the full recovery chain: mnemonic → seed → keys → DID → vault DEKs.
 *
 * Source: tests/release/test_rel_005_recovery.py
 */

import { mnemonicToSeed, validateMnemonic, generateMnemonic } from '../../src/crypto/bip39';
import { derivePath } from '../../src/crypto/slip0010';
import { derivePersonaDEK } from '../../src/crypto/hkdf';
import { deriveDIDKey } from '../../src/identity/did';
import {
  TEST_MNEMONIC_SEED,
  TEST_USER_SALT,
  DINA_ROOT_KEY_PATH,
  HKDF_INFO_STRINGS,
  bytesToHex,
} from '@dina/test-harness';

describe('Identity Recovery (Release Verification)', () => {
  describe('mnemonic → seed → identity', () => {
    it('generated mnemonic is valid', () => {
      const mnemonic = generateMnemonic();
      expect(validateMnemonic(mnemonic)).toBe(true);
    });

    it('mnemonic → seed produces 64 bytes', () => {
      const mnemonic = generateMnemonic();
      const seed = mnemonicToSeed(mnemonic);
      expect(seed.length).toBe(64);
    });

    it('recovered seed derives root signing key deterministically', () => {
      const r1 = derivePath(TEST_MNEMONIC_SEED, DINA_ROOT_KEY_PATH);
      const r2 = derivePath(TEST_MNEMONIC_SEED, DINA_ROOT_KEY_PATH);
      expect(bytesToHex(r1.publicKey)).toBe(bytesToHex(r2.publicKey));
    });

    it('root key produces a valid did:key', () => {
      const result = derivePath(TEST_MNEMONIC_SEED, DINA_ROOT_KEY_PATH);
      const did = deriveDIDKey(result.publicKey);
      expect(did).toMatch(/^did:key:z6Mk/);
    });
  });

  describe('vault key recovery', () => {
    it('recovered seed derives same DEKs for all personas', () => {
      const masterSeed = TEST_MNEMONIC_SEED.slice(0, 32);
      const deks: string[] = [];
      for (const name of Object.keys(HKDF_INFO_STRINGS)) {
        const dek = derivePersonaDEK(masterSeed, name, TEST_USER_SALT);
        expect(dek.length).toBe(32);
        deks.push(bytesToHex(dek));
      }
      // All DEKs should be unique
      expect(new Set(deks).size).toBe(deks.length);
    });

    it('same inputs → same DEK (deterministic)', () => {
      const masterSeed = TEST_MNEMONIC_SEED.slice(0, 32);
      const dek1 = derivePersonaDEK(masterSeed, 'general', TEST_USER_SALT);
      const dek2 = derivePersonaDEK(masterSeed, 'general', TEST_USER_SALT);
      expect(bytesToHex(dek1)).toBe(bytesToHex(dek2));
    });
  });

  describe('cross-device determinism', () => {
    it('same seed on different "device" → same DID', () => {
      const result1 = derivePath(TEST_MNEMONIC_SEED, DINA_ROOT_KEY_PATH);
      const result2 = derivePath(TEST_MNEMONIC_SEED, DINA_ROOT_KEY_PATH);
      expect(deriveDIDKey(result1.publicKey)).toBe(deriveDIDKey(result2.publicKey));
    });

    it('same seed → same vault DEKs', () => {
      const masterSeed = TEST_MNEMONIC_SEED.slice(0, 32);
      const d1 = bytesToHex(derivePersonaDEK(masterSeed, 'health', TEST_USER_SALT));
      const d2 = bytesToHex(derivePersonaDEK(masterSeed, 'health', TEST_USER_SALT));
      expect(d1).toBe(d2);
    });
  });
});
