/**
 * T1A.5 — Argon2id KEK derivation.
 *
 * Category A: fixture-based. Verifies:
 * - Same passphrase + salt → same KEK as Go (128MB/3/4)
 * - Output is 32 bytes
 * - Different passphrases → different KEKs
 *
 * Note: Argon2id with 128MB memory takes ~2-5s in WASM. Tests use
 * extended timeout.
 *
 * Source: core/test/crypto_test.go (TestCrypto_4_*)
 */

import { deriveKEK, ARGON2ID_PARAMS } from '../../src/crypto/argon2id';
import {
  TEST_PASSPHRASE,
  TEST_PASSPHRASE_WRONG,
  ARGON2ID_MEMORY_KB,
  ARGON2ID_ITERATIONS,
  ARGON2ID_PARALLELISM,
  ARGON2ID_KEY_LENGTH,
  hasFixture,
  loadVectors,
  hexToBytes,
  bytesToHex,
} from '@dina/test-harness';

// 128MB argon2id in WASM is slow — allow up to 30s per test
jest.setTimeout(30_000);

describe('Argon2id KEK Derivation', () => {
  // Use a 16-byte salt for tests (standard argon2id salt length)
  const testSalt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

  it('derives a 32-byte KEK from passphrase and salt', async () => {
    const kek = await deriveKEK(TEST_PASSPHRASE, testSalt);
    expect(kek).toBeInstanceOf(Uint8Array);
    expect(kek.length).toBe(32);
  });

  it('is deterministic (same passphrase + salt → same KEK)', async () => {
    const kek1 = await deriveKEK(TEST_PASSPHRASE, testSalt);
    const kek2 = await deriveKEK(TEST_PASSPHRASE, testSalt);
    expect(bytesToHex(kek1)).toBe(bytesToHex(kek2));
  });

  it('produces different KEK for different passphrase', async () => {
    const kek1 = await deriveKEK(TEST_PASSPHRASE, testSalt);
    const kek2 = await deriveKEK(TEST_PASSPHRASE_WRONG, testSalt);
    expect(bytesToHex(kek1)).not.toBe(bytesToHex(kek2));
  });

  it('rejects empty passphrase', async () => {
    await expect(deriveKEK('', testSalt)).rejects.toThrow('empty passphrase');
  });

  it('rejects short salt', async () => {
    await expect(deriveKEK(TEST_PASSPHRASE, new Uint8Array(4))).rejects.toThrow(
      'salt must be at least 8 bytes',
    );
  });

  it('exported params match server constants', () => {
    expect(ARGON2ID_PARAMS.memorySize).toBe(ARGON2ID_MEMORY_KB);
    expect(ARGON2ID_PARAMS.iterations).toBe(ARGON2ID_ITERATIONS);
    expect(ARGON2ID_PARAMS.parallelism).toBe(ARGON2ID_PARALLELISM);
    expect(ARGON2ID_PARAMS.hashLength).toBe(ARGON2ID_KEY_LENGTH);
  });

  // ------------------------------------------------------------------
  // Cross-language verification against Go fixtures
  // ------------------------------------------------------------------

  const fixture = 'crypto/argon2id_kek.json';
  const suite = hasFixture(fixture) ? describe : describe.skip;
  suite('cross-language: Argon2id KEK (Go fixtures)', () => {
    const vectors = loadVectors<
      {
        passphrase: string;
        salt_hex: string;
        memory_kb: string;
        iterations: string;
        parallelism: string;
      },
      { kek_hex: string }
    >(fixture);

    for (const v of vectors) {
      it(v.description, async () => {
        const kek = await deriveKEK(v.inputs.passphrase, hexToBytes(v.inputs.salt_hex));
        expect(bytesToHex(kek)).toBe(v.expected.kek_hex);
      });
    }
  });
});
