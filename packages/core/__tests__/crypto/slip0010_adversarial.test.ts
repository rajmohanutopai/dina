/**
 * T1A.3 — SLIP-0010 adversarial tests.
 *
 * Category A: fixture-based. Verifies rejection of invalid inputs:
 * all-zero seed, short seed, forbidden BIP-44 paths, non-hardened indices.
 *
 * Source: core/test/crypto_adversarial_test.go
 */

import { derivePath } from '../../src/crypto/slip0010';
import { TEST_MNEMONIC_SEED, FORBIDDEN_BIP44_PATH, NON_HARDENED_PATH } from '@dina/test-harness';

describe('SLIP-0010 Adversarial', () => {
  const seed = TEST_MNEMONIC_SEED;

  it('rejects all-zero seed', () => {
    const zeroSeed = new Uint8Array(64);
    expect(() => derivePath(zeroSeed, "m/9999'/0'/0'")).toThrow('all-zero seed rejected');
  });

  it('rejects seed shorter than 16 bytes', () => {
    const shortSeed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(() => derivePath(shortSeed, "m/9999'/0'/0'")).toThrow('seed too short');
  });

  it('rejects empty seed', () => {
    const emptySeed = new Uint8Array(0);
    expect(() => derivePath(emptySeed, "m/9999'/0'/0'")).toThrow('empty seed');
  });

  it("rejects BIP-44 purpose 44' (forbidden path)", () => {
    expect(() => derivePath(seed, FORBIDDEN_BIP44_PATH)).toThrow("BIP-44 purpose 44' is forbidden");
  });

  it('rejects non-hardened path indices', () => {
    expect(() => derivePath(seed, NON_HARDENED_PATH)).toThrow(
      'Dina requires hardened-only derivation',
    );
  });

  it('rejects path without m/ prefix', () => {
    expect(() => derivePath(seed, "9999'/0'/0'")).toThrow('must start with "m/"');
  });

  it('rejects empty path', () => {
    expect(() => derivePath(seed, '')).toThrow('must start with "m/"');
  });

  it('rejects path with non-numeric segments', () => {
    expect(() => derivePath(seed, "m/abc'/0'/0'")).toThrow('must be a non-negative integer');
  });

  it('rejects mixed hardened/non-hardened in single path', () => {
    expect(() => derivePath(seed, "m/9999'/0/0'")).toThrow(
      'Dina requires hardened-only derivation',
    );
  });
});
