/**
 * T2A.19 — PDS attestation publishing: signing, lexicon, publish.
 *
 * Wire-contract tests against the Attestation shape that
 * AppView's `attestationSchema` Zod validator accepts. Records that
 * pass `validateLexicon` here MUST be accepted by AppView's ingester;
 * records that AppView rejects MUST fail here. Drift between the two
 * is the regression class this file guards.
 *
 * Source: core/test/pds_test.go (portable parts) +
 *         appview/src/ingester/record-validator.ts (wire contract).
 */

import {
  signAttestation,
  validateLexicon,
  publishToPDS,
  verifyAttestation,
  setPDSFetchFn,
  resetPDSFetchFn,
} from '../../src/trust/pds_publish';
import type { Attestation } from '../../src/trust/pds_publish';
import { getPublicKey } from '../../src/crypto/ed25519';
import { TEST_ED25519_SEED } from '@dina/test-harness';

describe('PDS Attestation Publishing', () => {
  // Fixed timestamp keeps signatures deterministic across runs.
  const FIXED_CREATED_AT = '2026-01-15T12:00:00.000Z';

  function makeRecord(overrides: Partial<Attestation> = {}): Attestation {
    return {
      subject: { type: 'did', did: 'did:plc:seller123' },
      category: 'product',
      sentiment: 'positive',
      createdAt: FIXED_CREATED_AT,
      text: 'Aeron Chair — recommend buy',
      dimensions: [{ dimension: 'quality', value: 'exceeded' }],
      evidence: [{ type: 'video', uri: 'https://youtube.com/watch?v=abc123' }],
      ...overrides,
    };
  }

  const testRecord = makeRecord();
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
      const tampered = {
        ...signed,
        record: { ...signed.record, sentiment: 'negative' as const },
      };
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
    it('accepts a fully populated valid record', () => {
      expect(validateLexicon(testRecord)).toEqual([]);
    });

    it('accepts the minimum required fields', () => {
      const minimal: Attestation = {
        subject: { type: 'did', did: 'did:plc:abc' },
        category: 'identity',
        sentiment: 'neutral',
        createdAt: FIXED_CREATED_AT,
      };
      expect(validateLexicon(minimal)).toEqual([]);
    });

    it('rejects a record missing subject entirely', () => {
      const bad = { ...testRecord, subject: undefined as unknown as Attestation['subject'] };
      expect(validateLexicon(bad).some((e) => e.includes('subject'))).toBe(true);
    });

    it('rejects subject without any identifier (no did/uri/name/identifier)', () => {
      const bad = makeRecord({ subject: { type: 'did' } });
      expect(
        validateLexicon(bad).some((e) => e.includes('at least one of: did, uri, name, identifier')),
      ).toBe(true);
    });

    it('rejects subject.did that does not look like a DID', () => {
      const bad = makeRecord({ subject: { type: 'did', did: 'not-a-did' } });
      expect(validateLexicon(bad).some((e) => e.includes('subject.did'))).toBe(true);
    });

    it('rejects subject.did shorter than 8 chars (matches AppView min)', () => {
      // 'did:a:y' = 7 chars: passes the regex, fails AppView's min(8).
      // Lite must reject too, otherwise records get dropped at ingest.
      const bad = makeRecord({ subject: { type: 'did', did: 'did:a:y' } });
      expect(validateLexicon(bad).some((e) => e.includes('subject.did'))).toBe(true);
    });

    it('rejects unknown subject.type values', () => {
      const bad = makeRecord({
        subject: {
          type: 'made-up' as unknown as Attestation['subject']['type'],
          identifier: 'x',
        },
      });
      expect(validateLexicon(bad).some((e) => e.includes('subject.type'))).toBe(true);
    });

    it('accepts each documented subject.type (incl. place — TN-DB-011)', () => {
      const types: Attestation['subject']['type'][] = [
        'did',
        'content',
        'product',
        'dataset',
        'organization',
        'claim',
        'place',
      ];
      for (const t of types) {
        const ref =
          t === 'did'
            ? { type: t, did: 'did:plc:abc' }
            : { type: t, identifier: 'sample-id' };
        const rec = makeRecord({ subject: ref });
        expect(validateLexicon(rec)).toEqual([]);
      }
    });

    it('rejects record missing category', () => {
      const bad = makeRecord({ category: '' });
      expect(validateLexicon(bad).some((e) => e.includes('category'))).toBe(true);
    });

    it('rejects category longer than 200 chars', () => {
      const bad = makeRecord({ category: 'x'.repeat(201) });
      expect(validateLexicon(bad).some((e) => e.includes('category must be ≤200'))).toBe(true);
    });

    it('rejects record missing sentiment', () => {
      const bad = { ...testRecord, sentiment: undefined as unknown as Attestation['sentiment'] };
      expect(validateLexicon(bad).some((e) => e.includes('sentiment'))).toBe(true);
    });

    it('rejects unknown sentiment values', () => {
      const bad = makeRecord({
        sentiment: 'meh' as unknown as Attestation['sentiment'],
      });
      expect(validateLexicon(bad).some((e) => e.includes('sentiment'))).toBe(true);
    });

    it('rejects record missing createdAt', () => {
      const bad = { ...testRecord, createdAt: '' };
      expect(validateLexicon(bad).some((e) => e.includes('createdAt'))).toBe(true);
    });

    it('rejects createdAt more than 5 minutes in the future', () => {
      const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const bad = makeRecord({ createdAt: future });
      expect(validateLexicon(bad).some((e) => e.includes('createdAt'))).toBe(true);
    });

    it('rejects text longer than 2000 chars', () => {
      const bad = makeRecord({ text: 'x'.repeat(2001) });
      expect(validateLexicon(bad).some((e) => e.includes('text must be'))).toBe(true);
    });

    it('rejects more than 10 dimensions', () => {
      const dimensions = Array.from({ length: 11 }, (_, i) => ({
        dimension: `d${i}`,
        value: 'met' as const,
      }));
      const bad = makeRecord({ dimensions });
      expect(validateLexicon(bad).some((e) => e.includes('dimensions must have at most'))).toBe(
        true,
      );
    });

    it('rejects dimension with unknown value', () => {
      type DimValue = NonNullable<Attestation['dimensions']>[number]['value'];
      const bad = makeRecord({
        dimensions: [
          {
            dimension: 'quality',
            value: 'awesome' as unknown as DimValue,
          },
        ],
      });
      expect(validateLexicon(bad).some((e) => e.includes('dimensions[0].value'))).toBe(true);
    });

    it('rejects more than 10 tags', () => {
      const bad = makeRecord({ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) });
      expect(validateLexicon(bad).some((e) => e.includes('tags must have at most'))).toBe(true);
    });

    it('rejects tag longer than 50 chars', () => {
      const bad = makeRecord({ tags: ['x'.repeat(51)] });
      expect(validateLexicon(bad).some((e) => e.includes('tags[0]'))).toBe(true);
    });

    it('rejects more than 10 evidence items', () => {
      const evidence = Array.from({ length: 11 }, () => ({
        type: 'video',
        uri: 'https://example.com',
      }));
      const bad = makeRecord({ evidence });
      expect(validateLexicon(bad).some((e) => e.includes('evidence must have at most'))).toBe(
        true,
      );
    });

    it('rejects evidence with type longer than 100 chars', () => {
      const bad = makeRecord({
        evidence: [{ type: 'x'.repeat(101), uri: 'https://example.com' }],
      });
      expect(validateLexicon(bad).some((e) => e.includes('evidence[0].type'))).toBe(true);
    });

    it('rejects unknown confidence values', () => {
      const bad = makeRecord({
        confidence: 'maybe' as unknown as Attestation['confidence'],
      });
      expect(validateLexicon(bad).some((e) => e.includes('confidence'))).toBe(true);
    });

    it('accepts all documented confidence values', () => {
      for (const c of ['certain', 'high', 'moderate', 'speculative'] as const) {
        const rec = makeRecord({ confidence: c });
        expect(validateLexicon(rec)).toEqual([]);
      }
    });

    it('collects multiple errors at once', () => {
      const bad: Attestation = {
        subject: { type: 'unknown' as unknown as Attestation['subject']['type'] },
        category: '',
        sentiment: 'wrong' as unknown as Attestation['sentiment'],
        createdAt: '',
      };
      expect(validateLexicon(bad).length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('publishToPDS', () => {
    it('posts to PDS XRPC createRecord endpoint with correct collection', async () => {
      let capturedURL = '';
      let capturedBody: Record<string, unknown> = {};
      setPDSFetchFn(async (url: any, opts: any) => {
        capturedURL = String(url);
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            uri: 'at://did:key:z6MkTest/com.dina.trust.attestation/rkey1',
          }),
        } as Response;
      });
      const signed = signAttestation(testRecord, TEST_ED25519_SEED, signerDID);
      const uri = await publishToPDS(signed, 'https://pds.dinakernel.com');
      expect(capturedURL).toBe('https://pds.dinakernel.com/xrpc/com.atproto.repo.createRecord');
      expect(capturedBody.repo).toBe(signerDID);
      expect(capturedBody.collection).toBe('com.dina.trust.attestation');
      expect(uri).toContain('at://');
    });

    it('returns the AT-URI from the PDS response', async () => {
      const expectedURI = 'at://did:key:z6MkTest/com.dina.trust.attestation/abc';
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

    it('runs validation before publishing — invalid records never reach the wire', async () => {
      let fetchCalled = false;
      setPDSFetchFn(async () => {
        fetchCalled = true;
        return { ok: true, json: async () => ({ uri: 'at://x/y/z' }) } as Response;
      });
      const badRecord = makeRecord({ subject: { type: 'did', did: 'not-a-did' } });
      const signed = signAttestation(badRecord, TEST_ED25519_SEED, signerDID);
      await expect(publishToPDS(signed, 'https://pds.example.com')).rejects.toThrow(
        'validation failed',
      );
      expect(fetchCalled).toBe(false);
    });

    it('throws on non-2xx HTTP response', async () => {
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

    it('throws when PDS response is missing the AT-URI', async () => {
      setPDSFetchFn(
        async () =>
          ({
            ok: true,
            json: async () => ({}),
          }) as Response,
      );
      const signed = signAttestation(testRecord, TEST_ED25519_SEED, signerDID);
      await expect(publishToPDS(signed, 'https://pds.example.com')).rejects.toThrow(
        'missing AT-URI',
      );
    });

    it('attaches signature, signer, and $type to the published record', async () => {
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
      expect(capturedRecord.$type).toBe('com.dina.trust.attestation');
    });

    it('strips a trailing slash from the PDS URL', async () => {
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
