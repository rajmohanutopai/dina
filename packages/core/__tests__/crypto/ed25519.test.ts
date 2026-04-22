/**
 * T1A.7 — Ed25519 signing and verification.
 *
 * Category A: fixture-based. Verifies signatures match Go output for
 * same key + message, and cross-verify.
 *
 * Source: core/test/crypto_test.go + signature_test.go
 */

import { sign, verify, getPublicKey } from '../../src/crypto/ed25519';
import {
  TEST_ED25519_SEED,
  TEST_MESSAGE,
  hasFixture,
  loadVectors,
  hexToBytes,
  bytesToHex,
} from '@dina/test-harness';

describe('Ed25519 Signing & Verification', () => {
  const privateKey = TEST_ED25519_SEED;

  describe('getPublicKey', () => {
    it('derives 32-byte public key from private key', () => {
      const pub = getPublicKey(privateKey);
      expect(pub).toBeInstanceOf(Uint8Array);
      expect(pub.length).toBe(32);
    });

    it('is deterministic (same private key → same public key)', () => {
      const pub1 = getPublicKey(privateKey);
      const pub2 = getPublicKey(privateKey);
      expect(bytesToHex(pub1)).toBe(bytesToHex(pub2));
    });

    it('different private keys produce different public keys', () => {
      const otherKey = new Uint8Array(32).fill(0x42);
      const pub1 = getPublicKey(privateKey);
      const pub2 = getPublicKey(otherKey);
      expect(bytesToHex(pub1)).not.toBe(bytesToHex(pub2));
    });
  });

  describe('sign', () => {
    it('produces a 64-byte signature', () => {
      const sig = sign(privateKey, TEST_MESSAGE);
      expect(sig).toBeInstanceOf(Uint8Array);
      expect(sig.length).toBe(64);
    });

    it('is deterministic (Ed25519 signatures are deterministic)', () => {
      const sig1 = sign(privateKey, TEST_MESSAGE);
      const sig2 = sign(privateKey, TEST_MESSAGE);
      expect(bytesToHex(sig1)).toBe(bytesToHex(sig2));
    });

    it('different messages produce different signatures', () => {
      const otherMessage = new TextEncoder().encode('different message');
      const sig1 = sign(privateKey, TEST_MESSAGE);
      const sig2 = sign(privateKey, otherMessage);
      expect(bytesToHex(sig1)).not.toBe(bytesToHex(sig2));
    });

    it('different keys produce different signatures for same message', () => {
      const otherKey = new Uint8Array(32).fill(0x42);
      const sig1 = sign(privateKey, TEST_MESSAGE);
      const sig2 = sign(otherKey, TEST_MESSAGE);
      expect(bytesToHex(sig1)).not.toBe(bytesToHex(sig2));
    });

    it('signs empty message', () => {
      const sig = sign(privateKey, new Uint8Array(0));
      expect(sig.length).toBe(64);
    });

    it('signs large message', () => {
      const largeMessage = new Uint8Array(100_000).fill(0xab);
      const sig = sign(privateKey, largeMessage);
      expect(sig.length).toBe(64);
    });
  });

  describe('verify', () => {
    it('returns true for valid signature', () => {
      const sig = sign(privateKey, TEST_MESSAGE);
      const pub = getPublicKey(privateKey);
      expect(verify(pub, TEST_MESSAGE, sig)).toBe(true);
    });

    it('returns false for tampered message', () => {
      const sig = sign(privateKey, TEST_MESSAGE);
      const pub = getPublicKey(privateKey);
      const tampered = new TextEncoder().encode('tampered message');
      expect(verify(pub, tampered, sig)).toBe(false);
    });

    it('returns false for tampered signature', () => {
      const sig = sign(privateKey, TEST_MESSAGE);
      const pub = getPublicKey(privateKey);
      const tamperedSig = new Uint8Array(sig);
      tamperedSig[0] ^= 0xff;
      expect(verify(pub, TEST_MESSAGE, tamperedSig)).toBe(false);
    });

    it('returns false for wrong public key', () => {
      const sig = sign(privateKey, TEST_MESSAGE);
      const wrongKey = new Uint8Array(32).fill(0x42);
      const wrongPub = getPublicKey(wrongKey);
      expect(verify(wrongPub, TEST_MESSAGE, sig)).toBe(false);
    });

    it('verifies empty-message signature', () => {
      const sig = sign(privateKey, new Uint8Array(0));
      const pub = getPublicKey(privateKey);
      expect(verify(pub, new Uint8Array(0), sig)).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Cross-language verification against Go fixtures
  // ------------------------------------------------------------------

  const fixture = 'crypto/ed25519_sign_verify.json';
  const crossSuite = hasFixture(fixture) ? describe : describe.skip;
  crossSuite('cross-language: Ed25519 (Go fixtures)', () => {
    const vectors = loadVectors<Record<string, string>, Record<string, unknown>>(fixture);

    for (const v of vectors) {
      it(v.description, () => {
        if (v.inputs.seed_hex && v.expected.public_key_hex) {
          const pub = getPublicKey(hexToBytes(v.inputs.seed_hex));
          expect(bytesToHex(pub)).toBe(v.expected.public_key_hex as string);
        } else if (v.inputs.private_key_hex && v.inputs.message_hex && v.expected.signature_hex) {
          const sig = sign(hexToBytes(v.inputs.private_key_hex), hexToBytes(v.inputs.message_hex));
          expect(bytesToHex(sig)).toBe(v.expected.signature_hex as string);
        } else if (
          v.inputs.public_key_hex &&
          v.inputs.signature_hex &&
          v.expected.valid !== undefined
        ) {
          const result = verify(
            hexToBytes(v.inputs.public_key_hex),
            hexToBytes(v.inputs.message_hex),
            hexToBytes(v.inputs.signature_hex),
          );
          expect(result).toBe(v.expected.valid);
        }
      });
    }
  });
});
