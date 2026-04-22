/**
 * T1C.2 — W3C DID Document construction and validation.
 *
 * Aligned with Go's identity adapter format:
 * - 2 @context values (DID v1 + Multikey v1)
 * - Multikey verification method type
 * - #key-1 fragment (singular)
 * - created timestamp
 *
 * Source: core/test/identity_test.go
 */

import {
  buildDIDDocument,
  validateDIDDocument,
  getMessagingService,
} from '../../src/identity/did_document';

describe('DID Document', () => {
  const did = 'did:plc:test123abc';
  const multibase = 'z6MkTestPublicKeyMultibase';
  const msgboxURL = 'wss://mailbox.dinakernel.com';

  describe('buildDIDDocument', () => {
    it('builds a valid DID Document', () => {
      const doc = buildDIDDocument(did, multibase, msgboxURL);
      expect(doc.id).toBe(did);
      expect(validateDIDDocument(doc)).toEqual([]);
    });

    it('builds document without service endpoint', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc.service).toEqual([]);
    });
  });

  describe('document structure (aligned with Go)', () => {
    it('@context includes W3C DID v1', () => {
      const doc = buildDIDDocument(did, multibase, msgboxURL);
      expect(doc['@context']).toContain('https://www.w3.org/ns/did/v1');
    });

    it('@context includes Multikey v1 (matching Go)', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc['@context']).toContain('https://w3id.org/security/multikey/v1');
    });

    it('@context has exactly 2 values (matching Go)', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc['@context']).toHaveLength(2);
    });

    it('id matches provided DID', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc.id).toBe(did);
    });

    it('has exactly one verification method', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc.verificationMethod).toHaveLength(1);
    });

    it('verification method type is Multikey (matching Go)', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc.verificationMethod[0].type).toBe('Multikey');
    });

    it('verification method fragment is #key-1 (singular, matching Go)', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc.verificationMethod[0].id).toBe(`${did}#key-1`);
    });

    it('verification method controller is the DID', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc.verificationMethod[0].controller).toBe(did);
    });

    it('verification method publicKeyMultibase matches input', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc.verificationMethod[0].publicKeyMultibase).toBe(multibase);
    });

    it('authentication references the verification method', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc.authentication[0]).toBe(doc.verificationMethod[0].id);
    });

    it('service has #dina-messaging with type DinaMsgBox', () => {
      const doc = buildDIDDocument(did, multibase, msgboxURL);
      const svc = doc.service.find((s) => s.id === '#dina-messaging');
      expect(svc).toBeDefined();
      expect(svc!.type).toBe('DinaMsgBox');
    });

    it('service endpoint is the provided MsgBox URL', () => {
      const doc = buildDIDDocument(did, multibase, msgboxURL);
      expect(doc.service[0].serviceEndpoint).toBe(msgboxURL);
    });

    it('has created timestamp (matching Go created_at)', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(doc.created).toBeDefined();
      // Should be a valid ISO 8601 date
      expect(new Date(doc.created!).getTime()).toBeGreaterThan(0);
    });
  });

  describe('validateDIDDocument', () => {
    it('validates a well-formed document', () => {
      const doc = buildDIDDocument(did, multibase, msgboxURL);
      expect(validateDIDDocument(doc)).toEqual([]);
    });

    it('reports missing DID v1 @context', () => {
      const doc = buildDIDDocument(did, multibase);
      doc['@context'] = ['https://w3id.org/security/multikey/v1'];
      const errors = validateDIDDocument(doc);
      expect(errors.some((e) => e.includes('DID v1'))).toBe(true);
    });

    it('reports missing Multikey @context', () => {
      const doc = buildDIDDocument(did, multibase);
      doc['@context'] = ['https://www.w3.org/ns/did/v1'];
      const errors = validateDIDDocument(doc);
      expect(errors.some((e) => e.includes('Multikey'))).toBe(true);
    });

    it('reports wrong verification method type', () => {
      const doc = buildDIDDocument(did, multibase);
      (doc.verificationMethod[0] as any).type = 'Ed25519VerificationKey2020';
      const errors = validateDIDDocument(doc);
      expect(errors.some((e) => e.includes('Multikey'))).toBe(true);
    });
  });

  describe('getMessagingService', () => {
    it('extracts messaging service from document', () => {
      const doc = buildDIDDocument(did, multibase, msgboxURL);
      const svc = getMessagingService(doc);
      expect(svc).toEqual({ type: 'DinaMsgBox', endpoint: msgboxURL });
    });

    it('returns null when no messaging service', () => {
      const doc = buildDIDDocument(did, multibase);
      expect(getMessagingService(doc)).toBeNull();
    });
  });
});
