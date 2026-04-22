/**
 * T2A.19 — PDS attestation publishing: signing, lexicon, rating, publish.
 *
 * Category B: contract test.
 *
 * Source: core/test/pds_test.go (portable parts)
 */

import {
  signAttestation,
  validateLexicon,
  isValidRating,
  publishToPDS,
  verifyAttestation,
  setPDSFetchFn,
  resetPDSFetchFn,
} from '../../src/trust/pds_publish';
import type { AttestationRecord } from '../../src/trust/pds_publish';
import { getPublicKey } from '../../src/crypto/ed25519';
import { TEST_ED25519_SEED } from '@dina/test-harness';

describe('PDS Attestation Publishing', () => {
  const testRecord: AttestationRecord = {
    subject_did: 'did:plc:seller123',
    category: 'product_review',
    rating: 85,
    verdict: { product: 'Aeron Chair', recommendation: 'BUY' },
    evidence_uri: 'https://youtube.com/watch?v=abc123',
  };

  const signerDID = 'did:key:z6MkTest';
  const pubKey = getPublicKey(TEST_ED25519_SEED);

  afterEach(() => resetPDSFetchFn());

  describe('signAttestation', () => {
    it('signs a record with Ed25519 identity key', () => {
      const signed = signAttestation(testRecord, TEST_ED25519_SEED, signerDID);
      expect(signed.record).toEqual(testRecord);
      expect(signed.signature_hex).toBeTruthy();
      expect(signed.signer_did).toBe(signerDID);
    });

    it('includes signer_did in result', () => {
      const signed = signAttestation(testRecord, TEST_ED25519_SEED, signerDID);
      expect(signed.signer_did).toBe(signerDID);
    });

    it('signature is hex-encoded (128 hex chars = 64 bytes)', () => {
      const signed = signAttestation(testRecord, TEST_ED25519_SEED, signerDID);
      expect(signed.signature_hex).toMatch(/^[0-9a-f]{128}$/);
    });

    it('signature verifies against public key', () => {
      const signed = signAttestation(testRecord, TEST_ED25519_SEED, signerDID);
      expect(verifyAttestation(signed, pubKey)).toBe(true);
    });

    it('tampered record fails verification', () => {
      const signed = signAttestation(testRecord, TEST_ED25519_SEED, signerDID);
      const tampered = { ...signed, record: { ...signed.record, rating: 10 } };
      expect(verifyAttestation(tampered, pubKey)).toBe(false);
    });

    it('wrong public key fails verification', () => {
      const signed = signAttestation(testRecord, TEST_ED25519_SEED, signerDID);
      const wrongPub = getPublicKey(new Uint8Array(32).fill(0x99));
      expect(verifyAttestation(signed, wrongPub)).toBe(false);
    });

    it('same record → same signature (deterministic)', () => {
      const s1 = signAttestation(testRecord, TEST_ED25519_SEED, signerDID);
      const s2 = signAttestation(testRecord, TEST_ED25519_SEED, signerDID);
      expect(s1.signature_hex).toBe(s2.signature_hex);
    });
  });

  describe('validateLexicon', () => {
    it('accepts valid record with all required fields', () => {
      expect(validateLexicon(testRecord)).toEqual([]);
    });

    it('rejects record missing subject_did', () => {
      const bad = { ...testRecord, subject_did: '' };
      expect(validateLexicon(bad).some((e) => e.includes('subject_did'))).toBe(true);
    });

    it('rejects record with non-DID subject_did', () => {
      const bad = { ...testRecord, subject_did: 'not-a-did' };
      expect(validateLexicon(bad).some((e) => e.includes('valid DID'))).toBe(true);
    });

    it('rejects record missing category', () => {
      const bad = { ...testRecord, category: '' };
      expect(validateLexicon(bad).some((e) => e.includes('category'))).toBe(true);
    });

    it('rejects record with invalid category', () => {
      const bad = { ...testRecord, category: 'made_up_category' };
      expect(validateLexicon(bad).some((e) => e.includes('category must be'))).toBe(true);
    });

    it('rejects record with out-of-range rating', () => {
      const bad = { ...testRecord, rating: 150 };
      expect(validateLexicon(bad).some((e) => e.includes('rating'))).toBe(true);
    });

    it('rejects record with negative rating', () => {
      const bad = { ...testRecord, rating: -5 };
      expect(validateLexicon(bad).some((e) => e.includes('rating'))).toBe(true);
    });

    it('accepts record without optional evidence_uri', () => {
      const { evidence_uri, ...noEvidence } = testRecord;
      expect(validateLexicon(noEvidence as AttestationRecord)).toEqual([]);
    });

    it('validates evidence_uri format when present', () => {
      const bad = { ...testRecord, evidence_uri: 'not-a-uri' };
      expect(validateLexicon(bad).some((e) => e.includes('evidence_uri'))).toBe(true);
    });

    it('accepts http:// evidence_uri', () => {
      const rec = { ...testRecord, evidence_uri: 'http://example.com/review' };
      expect(validateLexicon(rec)).toEqual([]);
    });

    it('collects multiple errors', () => {
      const bad = { ...testRecord, subject_did: '', category: '', rating: 200 };
      expect(validateLexicon(bad).length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('isValidRating', () => {
    it('accepts 0', () => expect(isValidRating(0)).toBe(true));
    it('accepts 100', () => expect(isValidRating(100)).toBe(true));
    it('accepts 50', () => expect(isValidRating(50)).toBe(true));
    it('rejects -1', () => expect(isValidRating(-1)).toBe(false));
    it('rejects 101', () => expect(isValidRating(101)).toBe(false));
    it('rejects fractional numbers', () => expect(isValidRating(50.5)).toBe(false));
    it('rejects NaN', () => expect(isValidRating(NaN)).toBe(false));
  });

  describe('publishToPDS', () => {
    it('publishes to PDS XRPC endpoint', async () => {
      let capturedURL = '';
      let capturedBody: Record<string, unknown> = {};
      setPDSFetchFn(async (url: any, opts: any) => {
        capturedURL = String(url);
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            uri: 'at://did:key:z6MkTest/community.dina.trust.attestation/rkey1',
          }),
        } as Response;
      });
      const signed = signAttestation(testRecord, TEST_ED25519_SEED, signerDID);
      const uri = await publishToPDS(signed, 'https://pds.dinakernel.com');
      expect(capturedURL).toBe('https://pds.dinakernel.com/xrpc/com.atproto.repo.createRecord');
      expect(capturedBody.repo).toBe(signerDID);
      expect(capturedBody.collection).toBe('community.dina.trust.attestation');
      expect(uri).toContain('at://');
    });

    it('returns AT-URI from response', async () => {
      const expectedURI = 'at://did:key:z6MkTest/community.dina.trust.attestation/abc';
      setPDSFetchFn(
        async () =>
          ({
            ok: true,
            json: async () => ({ uri: expectedURI }),
          }) as Response,
      );
      const signed = signAttestation(testRecord, TEST_ED25519_SEED, signerDID);
      const uri = await publishToPDS(signed, 'https://pds.example.com');
      expect(uri).toBe(expectedURI);
    });

    it('validates record before publishing', async () => {
      const badRecord: AttestationRecord = { ...testRecord, subject_did: '' };
      const signed = signAttestation(badRecord, TEST_ED25519_SEED, signerDID);
      await expect(publishToPDS(signed, 'https://pds.example.com')).rejects.toThrow(
        'validation failed',
      );
    });

    it('throws on HTTP error', async () => {
      setPDSFetchFn(
        async () =>
          ({
            ok: false,
            status: 401,
            text: async () => 'Unauthorized',
          }) as Response,
      );
      const signed = signAttestation(testRecord, TEST_ED25519_SEED, signerDID);
      await expect(publishToPDS(signed, 'https://pds.example.com')).rejects.toThrow('HTTP 401');
    });

    it('includes signature and signer in record body', async () => {
      let capturedRecord: Record<string, unknown> = {};
      setPDSFetchFn(async (_url: any, opts: any) => {
        const body = JSON.parse(opts.body);
        capturedRecord = body.record;
        return { ok: true, json: async () => ({ uri: 'at://x/y/z' }) } as Response;
      });
      const signed = signAttestation(testRecord, TEST_ED25519_SEED, signerDID);
      await publishToPDS(signed, 'https://pds.example.com');
      expect(capturedRecord.signature_hex).toBe(signed.signature_hex);
      expect(capturedRecord.signer_did).toBe(signerDID);
      expect(capturedRecord.$type).toBe('community.dina.trust.attestation');
    });

    it('strips trailing slash from PDS URL', async () => {
      let capturedURL = '';
      setPDSFetchFn(async (url: any) => {
        capturedURL = String(url);
        return { ok: true, json: async () => ({ uri: 'at://x/y/z' }) } as Response;
      });
      const signed = signAttestation(testRecord, TEST_ED25519_SEED, signerDID);
      await publishToPDS(signed, 'https://pds.example.com/');
      expect(capturedURL).toBe('https://pds.example.com/xrpc/com.atproto.repo.createRecord');
    });
  });
});
