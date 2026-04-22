/**
 * T1A.6 — AES-256-GCM seed wrapping.
 *
 * Category A: fixture-based. Verifies wrap/unwrap round-trip,
 * wrong passphrase rejected, all-zero seed rejected, changePassphrase.
 *
 * Note: Each wrap/unwrap involves Argon2id (128MB) which takes ~200ms in WASM.
 *
 * Source: core/test/crypto_test.go (TestCrypto_5_*)
 */

import { wrapSeed, unwrapSeed, changePassphrase, WrappedSeed } from '../../src/crypto/aesgcm';
import { deriveKEK, ARGON2ID_PARAMS } from '../../src/crypto/argon2id';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import {
  TEST_PASSPHRASE,
  TEST_PASSPHRASE_WRONG,
  TEST_MNEMONIC_SEED,
  hasFixture,
  loadVectors,
  hexToBytes,
  bytesToHex,
} from '@dina/test-harness';

// Each test involves Argon2id (128MB WASM) — allow time
jest.setTimeout(60_000);

describe('AES-256-GCM Seed Wrapping', () => {
  const seed = TEST_MNEMONIC_SEED;

  describe('wrapSeed', () => {
    it('wraps a seed and returns salt, wrapped blob, and params', async () => {
      const result = await wrapSeed(TEST_PASSPHRASE, seed);
      expect(result.salt).toBeInstanceOf(Uint8Array);
      expect(result.salt.length).toBe(16);
      // wrapped = nonce(12) + ciphertext(seed.length) + GCM tag(16)
      expect(result.wrapped.length).toBe(12 + seed.length + 16);
      expect(result.params.memory).toBe(ARGON2ID_PARAMS.memorySize);
      expect(result.params.iterations).toBe(ARGON2ID_PARAMS.iterations);
      expect(result.params.parallelism).toBe(ARGON2ID_PARAMS.parallelism);
    });

    it('produces different wrapped output each time (random nonce + salt)', async () => {
      const r1 = await wrapSeed(TEST_PASSPHRASE, seed);
      const r2 = await wrapSeed(TEST_PASSPHRASE, seed);
      // Different random salt → different KEK → different ciphertext
      expect(bytesToHex(r1.wrapped)).not.toBe(bytesToHex(r2.wrapped));
    });

    it('rejects empty passphrase', async () => {
      await expect(wrapSeed('', seed)).rejects.toThrow('empty passphrase');
    });

    it('rejects all-zero seed (fail-closed)', async () => {
      await expect(wrapSeed(TEST_PASSPHRASE, new Uint8Array(64))).rejects.toThrow(
        'all-zero seed rejected',
      );
    });
  });

  describe('unwrapSeed', () => {
    it('unwraps with correct passphrase → recovers original seed', async () => {
      const wrapped = await wrapSeed(TEST_PASSPHRASE, seed);
      const recovered = await unwrapSeed(TEST_PASSPHRASE, wrapped);
      expect(bytesToHex(recovered)).toBe(bytesToHex(seed));
    });

    it('rejects wrong passphrase (GCM tag mismatch)', async () => {
      const wrapped = await wrapSeed(TEST_PASSPHRASE, seed);
      await expect(unwrapSeed(TEST_PASSPHRASE_WRONG, wrapped)).rejects.toThrow('decryption failed');
    });

    it('rejects empty passphrase', async () => {
      const fakeWrapped: WrappedSeed = {
        salt: new Uint8Array(16),
        wrapped: new Uint8Array(60),
        params: { memory: 131072, iterations: 3, parallelism: 4 },
      };
      await expect(unwrapSeed('', fakeWrapped)).rejects.toThrow('empty passphrase');
    });
  });

  describe('changePassphrase', () => {
    it('re-wraps seed: new passphrase works, old does not', async () => {
      const original = await wrapSeed(TEST_PASSPHRASE, seed);

      const changed = await changePassphrase(
        TEST_PASSPHRASE,
        TEST_PASSPHRASE_WRONG, // using "wrong" as the new passphrase
        original,
      );

      // New passphrase works
      const recovered = await unwrapSeed(TEST_PASSPHRASE_WRONG, changed);
      expect(bytesToHex(recovered)).toBe(bytesToHex(seed));

      // Old passphrase fails on the new wrapped blob
      await expect(unwrapSeed(TEST_PASSPHRASE, changed)).rejects.toThrow('decryption failed');
    });
  });

  // ------------------------------------------------------------------
  // Cross-language: verify Go's wrapped data decrypts correctly
  // ------------------------------------------------------------------

  const fixture = 'crypto/aesgcm_wrap_unwrap.json';
  const suite = hasFixture(fixture) ? describe : describe.skip;
  suite('cross-language: AES-GCM wrap/unwrap (Go fixtures)', () => {
    const vectors = loadVectors<
      { kek_hex: string; dek_hex: string },
      { wrapped_hex: string; unwrapped_hex: string; roundtrip: boolean }
    >(fixture);

    for (const v of vectors) {
      it(`${v.description}: Go-wrapped data decrypts correctly`, () => {
        const kek = hexToBytes(v.inputs.kek_hex);
        const goWrapped = hexToBytes(v.expected.wrapped_hex);

        // Extract nonce and ciphertext from Go's wrapped output
        const nonce = goWrapped.slice(0, 12);
        const ciphertext = goWrapped.slice(12);

        const decipher = gcm(kek, nonce);
        const unwrapped = decipher.decrypt(ciphertext);
        expect(bytesToHex(unwrapped)).toBe(v.expected.unwrapped_hex);
      });

      it(`${v.description}: TS-wrapped data round-trips`, () => {
        const kek = hexToBytes(v.inputs.kek_hex);
        const dek = hexToBytes(v.inputs.dek_hex);

        // Wrap with TS
        const nonce = randomBytes(12);
        const cipher = gcm(kek, nonce);
        const ciphertext = cipher.encrypt(dek);

        // Unwrap
        const decipher = gcm(kek, nonce);
        const recovered = decipher.decrypt(ciphertext);
        expect(bytesToHex(recovered)).toBe(bytesToHex(dek));
      });
    }
  });
});
