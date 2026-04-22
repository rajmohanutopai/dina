/**
 * T1A.1 — BIP-39 mnemonic generation and seed derivation.
 *
 * Category A: fixture-based + real implementation tests.
 *
 * Source: core/test/crypto_test.go (TestCrypto_1_*)
 */

import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '../../src/crypto/bip39';
import { bytesToHex } from '@dina/test-harness';

describe('BIP-39 Mnemonic', () => {
  describe('generateMnemonic', () => {
    it('generates a 24-word mnemonic', () => {
      const mnemonic = generateMnemonic();
      const words = mnemonic.split(' ');
      expect(words.length).toBe(24);
    });

    it('generates different mnemonics on each call', () => {
      const m1 = generateMnemonic();
      const m2 = generateMnemonic();
      expect(m1).not.toBe(m2);
    });

    it('generated mnemonic passes validation', () => {
      const mnemonic = generateMnemonic();
      expect(validateMnemonic(mnemonic)).toBe(true);
    });
  });

  describe('validateMnemonic', () => {
    it('accepts a valid mnemonic', () => {
      const mnemonic = generateMnemonic();
      expect(validateMnemonic(mnemonic)).toBe(true);
    });

    it('rejects a truncated mnemonic', () => {
      expect(validateMnemonic('abandon '.repeat(11) + 'art')).toBe(false);
    });

    it('rejects invalid words', () => {
      expect(validateMnemonic('notaword '.repeat(23) + 'notaword')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(validateMnemonic('')).toBe(false);
    });
  });

  describe('mnemonicToSeed', () => {
    it('converts mnemonic to 64-byte seed', () => {
      const mnemonic = generateMnemonic();
      const seed = mnemonicToSeed(mnemonic);
      expect(seed).toBeInstanceOf(Uint8Array);
      expect(seed.length).toBe(64);
    });

    it('produces deterministic seed for same mnemonic', () => {
      const mnemonic = generateMnemonic();
      const seed1 = mnemonicToSeed(mnemonic);
      const seed2 = mnemonicToSeed(mnemonic);
      expect(bytesToHex(seed1)).toBe(bytesToHex(seed2));
    });

    it('different mnemonics produce different seeds', () => {
      const m1 = generateMnemonic();
      const m2 = generateMnemonic();
      const seed1 = mnemonicToSeed(m1);
      const seed2 = mnemonicToSeed(m2);
      expect(bytesToHex(seed1)).not.toBe(bytesToHex(seed2));
    });
  });
});
