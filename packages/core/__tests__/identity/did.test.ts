/**
 * T1C.1 — DID generation from Ed25519 public key.
 *
 * Category A: fixture-based. Basic DID tests (comprehensive tests in did_key.test.ts).
 *
 * Source: core/test/identity_test.go
 */

import {
  deriveDIDKey,
  extractPublicKey,
  publicKeyToMultibase,
  multibaseToPublicKey,
} from '../../src/identity/did';
import { bytesToHex } from '@dina/test-harness';

describe('DID Generation', () => {
  const publicKey = new Uint8Array(32).fill(0x42);

  describe('deriveDIDKey', () => {
    it('produces a did:key:z6Mk... identifier', () => {
      expect(deriveDIDKey(publicKey)).toMatch(/^did:key:z6Mk/);
    });

    it('is deterministic (same key → same DID)', () => {
      expect(deriveDIDKey(publicKey)).toBe(deriveDIDKey(publicKey));
    });

    it('different keys produce different DIDs', () => {
      const otherKey = new Uint8Array(32).fill(0x99);
      expect(deriveDIDKey(publicKey)).not.toBe(deriveDIDKey(otherKey));
    });

    it('starts with the expected prefix', () => {
      expect(deriveDIDKey(publicKey).startsWith('did:key:z6Mk')).toBe(true);
    });

    it('rejects non-32-byte input', () => {
      expect(() => deriveDIDKey(new Uint8Array(16))).toThrow('32 bytes');
    });
  });

  describe('extractPublicKey', () => {
    it('round-trip: deriveDIDKey → extractPublicKey', () => {
      const did = deriveDIDKey(publicKey);
      const extracted = extractPublicKey(did);
      expect(bytesToHex(extracted)).toBe(bytesToHex(publicKey));
    });

    it('rejects invalid DID format', () => {
      expect(() => extractPublicKey('not-a-did')).toThrow();
    });

    it('rejects DID with wrong multicodec prefix', () => {
      expect(() => extractPublicKey('did:key:zBadPrefix')).toThrow();
    });
  });

  describe('multibase round-trip', () => {
    it('publicKeyToMultibase produces z-prefixed string', () => {
      expect(publicKeyToMultibase(publicKey)[0]).toBe('z');
    });

    it('multibaseToPublicKey recovers original key', () => {
      const mb = publicKeyToMultibase(publicKey);
      const recovered = multibaseToPublicKey(mb);
      expect(bytesToHex(recovered)).toBe(bytesToHex(publicKey));
    });

    it('multibase starts with z (base58btc)', () => {
      expect(publicKeyToMultibase(publicKey)).toMatch(/^z/);
    });
  });
});
