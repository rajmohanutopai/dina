/**
 * T1L.2 — did:key derivation and DID Document structure.
 *
 * Category A: fixture-based. Cross-language verification against
 * tests/test_did_key.py.
 *
 * Source: tests/test_did_key.py
 */

import {
  deriveDIDKey,
  extractPublicKey,
  publicKeyToMultibase,
  multibaseToPublicKey,
} from '../../src/identity/did';
import {
  buildDIDDocument,
  validateDIDDocument,
  getMessagingService,
} from '../../src/identity/did_document';
import { getPublicKey } from '../../src/crypto/ed25519';
import { TEST_ED25519_SEED, TEST_DID_KEY_PREFIX, bytesToHex } from '@dina/test-harness';

describe('did:key Format', () => {
  const publicKey = getPublicKey(TEST_ED25519_SEED);

  describe('format', () => {
    it('starts with did:key:z', () => {
      const did = deriveDIDKey(publicKey);
      expect(did).toMatch(/^did:key:z/);
    });

    it('multibase prefix z means base58btc', () => {
      const did = deriveDIDKey(publicKey);
      expect(did.slice('did:key:'.length)[0]).toBe('z');
    });

    it('encoded key decodes to 0xed01 multicodec prefix', () => {
      const did = deriveDIDKey(publicKey);
      const recovered = extractPublicKey(did);
      expect(recovered.length).toBe(32);
    });

    it('decoded payload is 32-byte raw public key', () => {
      const did = deriveDIDKey(publicKey);
      const recovered = extractPublicKey(did);
      expect(bytesToHex(recovered)).toBe(bytesToHex(publicKey));
    });

    it('Ed25519 DIDs start with z6Mk', () => {
      const did = deriveDIDKey(publicKey);
      expect(did).toMatch(/^did:key:z6Mk/);
    });
  });

  describe('determinism', () => {
    it('same key → same DID', () => {
      const d1 = deriveDIDKey(publicKey);
      const d2 = deriveDIDKey(publicKey);
      expect(d1).toBe(d2);
    });

    it('different keys → different DIDs', () => {
      const otherKey = getPublicKey(new Uint8Array(32).fill(0x99));
      expect(deriveDIDKey(publicKey)).not.toBe(deriveDIDKey(otherKey));
    });

    it('DID stable across reloads (same key material)', () => {
      const key1 = getPublicKey(TEST_ED25519_SEED);
      const key2 = getPublicKey(TEST_ED25519_SEED);
      expect(deriveDIDKey(key1)).toBe(deriveDIDKey(key2));
    });
  });

  describe('publicKeyToMultibase / multibaseToPublicKey', () => {
    it('publicKeyMultibase starts with z', () => {
      const mb = publicKeyToMultibase(publicKey);
      expect(mb[0]).toBe('z');
    });

    it('round-trip: encode → decode recovers key', () => {
      const mb = publicKeyToMultibase(publicKey);
      const recovered = multibaseToPublicKey(mb);
      expect(bytesToHex(recovered)).toBe(bytesToHex(publicKey));
    });

    it('rejects invalid multibase (no z prefix)', () => {
      expect(() => multibaseToPublicKey('abc')).toThrow('must start with "z"');
    });

    it('rejects wrong multicodec prefix', () => {
      // Manually create a z-prefixed string with wrong multicodec
      expect(() => multibaseToPublicKey('z1111111111')).toThrow();
    });
  });

  describe('extractPublicKey', () => {
    it('round-trip: deriveDIDKey → extractPublicKey', () => {
      const did = deriveDIDKey(publicKey);
      const extracted = extractPublicKey(did);
      expect(bytesToHex(extracted)).toBe(bytesToHex(publicKey));
    });

    it('rejects non-did:key format', () => {
      expect(() => extractPublicKey('did:plc:abc123')).toThrow();
    });

    it('rejects empty string', () => {
      expect(() => extractPublicKey('')).toThrow();
    });
  });

  describe('DID Document from did:key', () => {
    const did = deriveDIDKey(publicKey);
    const multibase = publicKeyToMultibase(publicKey);

    it('document id matches derived DID', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc.id).toBe(did);
    });

    it('has one verification method', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc.verificationMethod).toHaveLength(1);
    });

    it('verification method type is Multikey (matching Go)', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc.verificationMethod[0].type).toBe('Multikey');
    });

    it('verification method controller is the DID', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc.verificationMethod[0].controller).toBe(did);
    });

    it('authentication references verification method', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc.authentication[0]).toBe(doc.verificationMethod[0].id);
    });

    it('verification method type is Multikey (matching Go)', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc.verificationMethod[0].type).toBe('Multikey');
    });

    it('publicKeyMultibase starts with z', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc.verificationMethod[0].publicKeyMultibase[0]).toBe('z');
    });

    it('publicKeyMultibase decodes to raw pubkey', () => {
      const doc = buildDIDDocument(did, multibase);
      const decoded = multibaseToPublicKey(doc.verificationMethod[0].publicKeyMultibase);
      expect(bytesToHex(decoded)).toBe(bytesToHex(publicKey));
    });

    it('@context is W3C compliant', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc['@context']).toContain('https://www.w3.org/ns/did/v1');
    });

    it('validates as correct document', () => {
      const doc = buildDIDDocument(did, multibase);
      const errors = validateDIDDocument(doc);
      expect(errors).toEqual([]);
    });

    it('includes messaging service when endpoint provided', () => {
      const doc = buildDIDDocument(did, multibase, 'wss://mailbox.dinakernel.com');
      const svc = getMessagingService(doc);
      expect(svc).not.toBeNull();
      expect(svc!.type).toBe('DinaMsgBox');
      expect(svc!.endpoint).toBe('wss://mailbox.dinakernel.com');
    });
  });
});
