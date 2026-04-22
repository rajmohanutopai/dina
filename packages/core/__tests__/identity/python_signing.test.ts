/**
 * T1L.1 — Python signing vectors: canonical JSON, Ed25519 sign/verify,
 * deterministic signatures, tamper detection.
 *
 * Category A: fixture-based. Cross-language verification against
 * tests/test_signing.py vectors.
 *
 * Source: tests/test_signing.py (26 tests)
 */

import { canonicalize, signCanonical, verifyCanonical } from '../../src/identity/signing';
import { getPublicKey } from '../../src/crypto/ed25519';
import { TEST_ED25519_SEED, bytesToHex } from '@dina/test-harness';

describe('Python Signing Vectors', () => {
  const testVerdict = {
    product: 'Aeron Chair',
    verdict: 'BUY',
    confidence_score: 85,
    reasons: ['ergonomic', 'durable'],
    hidden_warnings: [],
  };

  const pubKey = getPublicKey(TEST_ED25519_SEED);

  describe('canonicalize', () => {
    it('returns JSON string', () => {
      const result = canonicalize(testVerdict);
      expect(typeof result).toBe('string');
      JSON.parse(result); // should not throw
    });

    it('excludes signature fields', () => {
      const withSig = { ...testVerdict, signature_hex: 'abc', signer_did: 'did:key:z' };
      const result = canonicalize(withSig, ['signature_hex', 'signer_did']);
      expect(result).not.toContain('signature_hex');
      expect(result).not.toContain('signer_did');
    });

    it('sorts keys alphabetically', () => {
      const result = canonicalize(testVerdict);
      const parsed = JSON.parse(result);
      const keys = Object.keys(parsed);
      expect(keys).toEqual([...keys].sort());
    });

    it('uses compact separators (no whitespace)', () => {
      const result = canonicalize(testVerdict);
      // No spaces after : or ,
      expect(result).not.toMatch(/: /);
      expect(result).not.toMatch(/, /);
    });

    it('is deterministic', () => {
      expect(canonicalize(testVerdict)).toBe(canonicalize(testVerdict));
    });

    it('includes all non-excluded fields', () => {
      const result = canonicalize(testVerdict);
      expect(result).toContain('product');
      expect(result).toContain('verdict');
      expect(result).toContain('confidence_score');
      expect(result).toContain('reasons');
      expect(result).toContain('hidden_warnings');
    });

    it('excludes stream_id when specified', () => {
      const withStream = { ...testVerdict, stream_id: 'ceramic:abc' };
      const result = canonicalize(withStream, ['stream_id']);
      expect(result).not.toContain('stream_id');
      expect(result).toContain('product'); // other fields preserved
    });

    it('different objects produce different canonical', () => {
      const other = { ...testVerdict, verdict: 'AVOID' };
      expect(canonicalize(testVerdict)).not.toBe(canonicalize(other));
    });

    it('preserves empty lists', () => {
      const result = canonicalize({ items: [] });
      expect(result).toContain('[]');
    });

    it('handles nested objects with sorted keys', () => {
      const nested = { z: 1, a: { c: 3, b: 2 } };
      const result = canonicalize(nested);
      const parsed = JSON.parse(result);
      expect(Object.keys(parsed)).toEqual(['a', 'z']);
      expect(Object.keys(parsed.a)).toEqual(['b', 'c']);
    });
  });

  describe('signCanonical', () => {
    it('returns hex-encoded signature', () => {
      const sig = signCanonical('{"test":true}', TEST_ED25519_SEED);
      expect(/^[0-9a-f]+$/.test(sig)).toBe(true);
    });

    it('signature is 128 hex characters (64 bytes)', () => {
      const sig = signCanonical('{"test":true}', TEST_ED25519_SEED);
      expect(sig.length).toBe(128);
    });

    it('is deterministic', () => {
      const s1 = signCanonical('{"test":true}', TEST_ED25519_SEED);
      const s2 = signCanonical('{"test":true}', TEST_ED25519_SEED);
      expect(s1).toBe(s2);
    });

    it('different content → different signature', () => {
      const s1 = signCanonical('{"test":true}', TEST_ED25519_SEED);
      const s2 = signCanonical('{"other":true}', TEST_ED25519_SEED);
      expect(s1).not.toBe(s2);
    });

    it('different key → different signature', () => {
      const otherKey = new Uint8Array(32).fill(0x42);
      const s1 = signCanonical('{"test":true}', TEST_ED25519_SEED);
      const s2 = signCanonical('{"test":true}', otherKey);
      expect(s1).not.toBe(s2);
    });
  });

  describe('verifyCanonical', () => {
    it('valid signature verifies', () => {
      const canonical = '{"test":true}';
      const sig = signCanonical(canonical, TEST_ED25519_SEED);
      expect(verifyCanonical(canonical, sig, pubKey)).toBe(true);
    });

    it('tampered canonical fails', () => {
      const sig = signCanonical('{"test":true}', TEST_ED25519_SEED);
      expect(verifyCanonical('{"tampered":true}', sig, pubKey)).toBe(false);
    });

    it('tampered signature fails', () => {
      const sig = signCanonical('{"test":true}', TEST_ED25519_SEED);
      const tampered = 'aa'.repeat(64); // valid hex, wrong signature
      expect(verifyCanonical('{"test":true}', tampered, pubKey)).toBe(false);
    });

    it('wrong identity fails', () => {
      const sig = signCanonical('{"test":true}', TEST_ED25519_SEED);
      const wrongKey = getPublicKey(new Uint8Array(32).fill(0x99));
      expect(verifyCanonical('{"test":true}', sig, wrongKey)).toBe(false);
    });

    it('invalid hex returns false (no throw)', () => {
      expect(verifyCanonical('{"test":true}', 'not-hex!', pubKey)).toBe(false);
    });

    it('short signature returns false', () => {
      expect(verifyCanonical('{"test":true}', 'abcd', pubKey)).toBe(false);
    });
  });

  describe('full workflow: canonicalize → sign → verify', () => {
    it('sign then verify succeeds', () => {
      const canonical = canonicalize(testVerdict);
      const sig = signCanonical(canonical, TEST_ED25519_SEED);
      expect(verifyCanonical(canonical, sig, pubKey)).toBe(true);
    });

    it('sign, exclude fields, then verify', () => {
      const withSig = { ...testVerdict, signature_hex: '', signer_did: '' };
      const canonical = canonicalize(withSig, ['signature_hex', 'signer_did']);
      const sig = signCanonical(canonical, TEST_ED25519_SEED);
      expect(verifyCanonical(canonical, sig, pubKey)).toBe(true);
    });

    it('roundtrip through JSON serialization', () => {
      const canonical = canonicalize(testVerdict);
      const sig = signCanonical(canonical, TEST_ED25519_SEED);
      // Simulate JSON storage
      const stored = JSON.stringify({ canonical, sig });
      const restored = JSON.parse(stored);
      expect(verifyCanonical(restored.canonical, restored.sig, pubKey)).toBe(true);
    });
  });
});
