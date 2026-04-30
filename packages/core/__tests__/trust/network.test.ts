/**
 * T2D.14 — Trust network: attestation signing, expert reviews, outcome
 * tracking, anonymization, trust scoring, PDS forgery prevention.
 *
 * Category B: integration/contract test against the AppView wire shape.
 *
 * Source: tests/integration/test_trust_network.py
 */

import {
  signAttestation,
  validateLexicon,
  verifyAttestation,
} from '../../src/trust/pds_publish';
import type { Attestation } from '../../src/trust/pds_publish';
import { getPublicKey } from '../../src/crypto/ed25519';
import { TEST_ED25519_SEED } from '@dina/test-harness';

describe('Trust Network Integration', () => {
  const FIXED_CREATED_AT = '2026-01-15T12:00:00.000Z';

  const testRecord: Attestation = {
    subject: { type: 'did', did: 'did:plc:seller' },
    category: 'product',
    sentiment: 'positive',
    createdAt: FIXED_CREATED_AT,
    text: 'Aeron Chair — recommend buy',
    dimensions: [{ dimension: 'comfort', value: 'exceeded' }],
    evidence: [{ type: 'video', uri: 'https://youtube.com/watch?v=abc' }],
  };

  const pubKey = getPublicKey(TEST_ED25519_SEED);

  describe('attestation signing', () => {
    it('review becomes signed attestation', () => {
      const signed = signAttestation(testRecord, TEST_ED25519_SEED, 'did:key:z6MkReviewer');
      expect(signed.record).toEqual(testRecord);
      expect(signed.signature_hex).toMatch(/^[0-9a-f]{128}$/);
      expect(signed.signer_did).toBe('did:key:z6MkReviewer');
    });

    it('attestation carries cryptographic signature', () => {
      const signed = signAttestation(testRecord, TEST_ED25519_SEED, 'did:key:z6MkReviewer');
      expect(verifyAttestation(signed, pubKey)).toBe(true);
    });

    it('multiple experts can attest the same subject', () => {
      // Different signers → different signatures, same subject DID.
      const s1 = signAttestation(testRecord, TEST_ED25519_SEED, 'did:key:z6MkExpert1');
      const key2 = new Uint8Array(32).fill(0x42);
      const s2 = signAttestation(testRecord, key2, 'did:key:z6MkExpert2');
      expect(s1.signature_hex).not.toBe(s2.signature_hex);
      expect(s1.record.subject.did).toBe(s2.record.subject.did);
    });
  });

  describe('outcome tracking', () => {
    it('user can record a purchase outcome', () => {
      const outcome: Attestation = {
        subject: { type: 'did', did: 'did:plc:seller' },
        category: 'product',
        sentiment: 'positive',
        createdAt: FIXED_CREATED_AT,
        dimensions: [{ dimension: 'overall', value: 'met' }],
        text: 'Order arrived on time, quality matched listing.',
      };
      expect(validateLexicon(outcome)).toEqual([]);
    });

    it('outcome lexicon validation does not enforce PII presence (scrubber owns that)', () => {
      // Lexicon validation is structural. PII is the scrubber's job —
      // the wire format itself doesn't try to detect names/emails.
      expect(validateLexicon(testRecord)).toEqual([]);
    });

    it('dimensions carry structured ratings, not free-form opinion', () => {
      // Structure enforced by the lexicon: dimension values must come
      // from a closed enum (exceeded/met/below/failed), not free text.
      expect(validateLexicon(testRecord)).toEqual([]);
      expect(testRecord.dimensions?.[0]?.value).toBe('exceeded');
    });
  });

  describe('PDS forgery prevention', () => {
    it('records are signed by the author DID — PDS cannot forge', () => {
      // Ed25519 signature binds the record to the author's identity.
      const signed = signAttestation(testRecord, TEST_ED25519_SEED, 'did:key:z6MkAuthor');
      expect(verifyAttestation(signed, pubKey)).toBe(true);

      // Tampering — swapping sentiment positive→negative — invalidates
      // the signature.
      const tampered = {
        ...signed,
        record: { ...signed.record, sentiment: 'negative' as const },
      };
      expect(verifyAttestation(tampered, pubKey)).toBe(false);
    });

    it('tampering with subject DID invalidates the signature', () => {
      const signed = signAttestation(testRecord, TEST_ED25519_SEED, 'did:key:z6MkAuthor');
      const tampered = {
        ...signed,
        record: {
          ...signed.record,
          subject: { ...signed.record.subject, did: 'did:plc:attacker' },
        },
      };
      expect(verifyAttestation(tampered, pubKey)).toBe(false);
    });
  });
});
