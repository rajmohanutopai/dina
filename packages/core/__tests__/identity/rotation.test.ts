/**
 * T10.1 — Key rotation: generation increment, old keys remain verifiable.
 *
 * Source: ARCHITECTURE.md Section 10.1
 */

import {
  initializeRotation,
  rotateKey,
  getCurrentGeneration,
  getCurrentPublicKey,
  getAllVerificationKeys,
  getKeyHistory,
  signWithCurrentKey,
  verifyWithAnyKey,
  resetRotationState,
} from '../../src/identity/rotation';
import { TEST_ED25519_SEED } from '@dina/test-harness';

describe('Key Rotation Manager', () => {
  beforeEach(() => resetRotationState());

  describe('initialization', () => {
    it('initializes with generation 0', () => {
      const entry = initializeRotation(TEST_ED25519_SEED);
      expect(entry.generation).toBe(0);
      expect(getCurrentGeneration()).toBe(0);
    });

    it('derives a 32-byte public key', () => {
      const entry = initializeRotation(TEST_ED25519_SEED);
      expect(entry.publicKey.length).toBe(32);
      expect(entry.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    });

    it('getCurrentPublicKey returns the initial key', () => {
      initializeRotation(TEST_ED25519_SEED);
      const pubKey = getCurrentPublicKey();
      expect(pubKey).not.toBeNull();
      expect(pubKey!.length).toBe(32);
    });

    it('key history has exactly 1 entry after init', () => {
      initializeRotation(TEST_ED25519_SEED);
      expect(getKeyHistory()).toHaveLength(1);
    });
  });

  describe('rotation', () => {
    it('rotateKey increments generation', () => {
      initializeRotation(TEST_ED25519_SEED);
      const rotated = rotateKey();
      expect(rotated.generation).toBe(1);
      expect(getCurrentGeneration()).toBe(1);
    });

    it('rotated key is different from initial key', () => {
      const initial = initializeRotation(TEST_ED25519_SEED);
      const rotated = rotateKey();
      expect(rotated.publicKeyHex).not.toBe(initial.publicKeyHex);
    });

    it('multiple rotations increment sequentially', () => {
      initializeRotation(TEST_ED25519_SEED);
      rotateKey(); // gen 1
      rotateKey(); // gen 2
      const third = rotateKey(); // gen 3
      expect(third.generation).toBe(3);
      expect(getCurrentGeneration()).toBe(3);
    });

    it('all keys are retained in history', () => {
      initializeRotation(TEST_ED25519_SEED);
      rotateKey();
      rotateKey();
      const history = getKeyHistory();
      expect(history).toHaveLength(3); // gen 0, 1, 2
      expect(history[0].generation).toBe(0);
      expect(history[1].generation).toBe(1);
      expect(history[2].generation).toBe(2);
    });

    it('getAllVerificationKeys returns all public keys', () => {
      initializeRotation(TEST_ED25519_SEED);
      rotateKey();
      const keys = getAllVerificationKeys();
      expect(keys).toHaveLength(2);
      expect(keys[0].length).toBe(32);
      expect(keys[1].length).toBe(32);
    });

    it('throws if not initialized', () => {
      expect(() => rotateKey()).toThrow('not initialized');
    });
  });

  describe('signing + verification across generations', () => {
    it('sign with current key → verify succeeds', () => {
      initializeRotation(TEST_ED25519_SEED);
      const data = new TextEncoder().encode('hello world');
      const sig = signWithCurrentKey(data);
      expect(sig).toMatch(/^[0-9a-f]{128}$/);
      expect(verifyWithAnyKey(data, sig)).toBe(true);
    });

    it('sign with gen 0, rotate, verify with gen 0 still works', () => {
      initializeRotation(TEST_ED25519_SEED);
      const data = new TextEncoder().encode('signed before rotation');
      const sigGen0 = signWithCurrentKey(data);

      rotateKey(); // now gen 1

      // Old signature from gen 0 still verifies
      expect(verifyWithAnyKey(data, sigGen0)).toBe(true);
    });

    it('sign with gen 1 after rotation → verify succeeds', () => {
      initializeRotation(TEST_ED25519_SEED);
      rotateKey();
      const data = new TextEncoder().encode('signed after rotation');
      const sigGen1 = signWithCurrentKey(data);
      expect(verifyWithAnyKey(data, sigGen1)).toBe(true);
    });

    it('old AND new signatures coexist and verify', () => {
      initializeRotation(TEST_ED25519_SEED);
      const data = new TextEncoder().encode('multi-gen test');
      const sigGen0 = signWithCurrentKey(data);

      rotateKey();
      const sigGen1 = signWithCurrentKey(data);

      rotateKey();
      const sigGen2 = signWithCurrentKey(data);

      // All three signatures verify
      expect(verifyWithAnyKey(data, sigGen0)).toBe(true);
      expect(verifyWithAnyKey(data, sigGen1)).toBe(true);
      expect(verifyWithAnyKey(data, sigGen2)).toBe(true);
    });

    it('tampered data fails verification', () => {
      initializeRotation(TEST_ED25519_SEED);
      const data = new TextEncoder().encode('original');
      const sig = signWithCurrentKey(data);
      const tampered = new TextEncoder().encode('tampered');
      expect(verifyWithAnyKey(tampered, sig)).toBe(false);
    });

    it('invalid signature format returns false', () => {
      initializeRotation(TEST_ED25519_SEED);
      expect(verifyWithAnyKey(new Uint8Array(0), 'invalid')).toBe(false);
      expect(verifyWithAnyKey(new Uint8Array(0), '')).toBe(false);
    });

    it('throws signWithCurrentKey if not initialized', () => {
      expect(() => signWithCurrentKey(new Uint8Array(0))).toThrow('not initialized');
    });
  });

  describe('deterministic derivation', () => {
    it('same seed → same key at each generation', () => {
      initializeRotation(TEST_ED25519_SEED);
      const gen0hex = getKeyHistory()[0].publicKeyHex;
      rotateKey();
      const gen1hex = getKeyHistory()[1].publicKeyHex;

      // Re-initialize → same keys
      resetRotationState();
      initializeRotation(TEST_ED25519_SEED);
      expect(getKeyHistory()[0].publicKeyHex).toBe(gen0hex);
      rotateKey();
      expect(getKeyHistory()[1].publicKeyHex).toBe(gen1hex);
    });
  });
});
