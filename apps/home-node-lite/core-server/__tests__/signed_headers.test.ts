/**
 * Task 4.21 — signed-header extraction tests.
 */

import {
  extractSignedHeaders,
  HEADER_DID,
  HEADER_TIMESTAMP,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  type HeaderBag,
} from '../src/auth/signed_headers';

const VALID_DID = 'did:plc:abcd1234efgh5678';
const VALID_TS = '2026-04-21T22:00:00.000Z';
const VALID_NONCE = 'a'.repeat(32);
const VALID_SIG = 'f'.repeat(128);

function validHeaders(): HeaderBag {
  return {
    [HEADER_DID]: VALID_DID,
    [HEADER_TIMESTAMP]: VALID_TS,
    [HEADER_NONCE]: VALID_NONCE,
    [HEADER_SIGNATURE]: VALID_SIG,
  };
}

describe('extractSignedHeaders (task 4.21)', () => {
  describe('happy path', () => {
    it('returns all 4 fields when all present + well-formed', () => {
      const res = extractSignedHeaders(validHeaders());
      expect(res).toEqual({
        ok: true,
        headers: {
          did: VALID_DID,
          timestamp: VALID_TS,
          nonce: VALID_NONCE,
          signature: VALID_SIG,
        },
      });
    });

    it('accepts did:key: method', () => {
      const h = validHeaders();
      h[HEADER_DID] = 'did:key:z6Mkabc';
      const res = extractSignedHeaders(h);
      expect(res.ok).toBe(true);
    });

    it('accepts epoch-ms timestamp passthrough (window check is downstream)', () => {
      const h = validHeaders();
      h[HEADER_TIMESTAMP] = '1745270000000';
      const res = extractSignedHeaders(h);
      expect(res.ok).toBe(true);
    });

    it('ignores extra unrelated headers', () => {
      const h = validHeaders();
      h['x-unrelated'] = 'whatever';
      h['user-agent'] = 'dina-cli/0.1';
      const res = extractSignedHeaders(h);
      expect(res.ok).toBe(true);
    });
  });

  describe('missing headers', () => {
    it.each([
      [HEADER_DID, 'missing_did'],
      [HEADER_TIMESTAMP, 'missing_timestamp'],
      [HEADER_NONCE, 'missing_nonce'],
      [HEADER_SIGNATURE, 'missing_signature'],
    ])('undefined %s → %s', (header, reason) => {
      const h = validHeaders();
      delete h[header];
      expect(extractSignedHeaders(h)).toEqual({ ok: false, reason });
    });

    it.each([
      [HEADER_DID, 'missing_did'],
      [HEADER_TIMESTAMP, 'missing_timestamp'],
      [HEADER_NONCE, 'missing_nonce'],
      [HEADER_SIGNATURE, 'missing_signature'],
    ])('empty-string %s → %s', (header, reason) => {
      const h = validHeaders();
      h[header] = '';
      expect(extractSignedHeaders(h)).toEqual({ ok: false, reason });
    });
  });

  describe('multi-value headers (ambiguous signing context)', () => {
    it('rejects X-DID sent as array', () => {
      const h = validHeaders();
      h[HEADER_DID] = [VALID_DID, 'did:plc:other'];
      const res = extractSignedHeaders(h);
      expect(res).toMatchObject({ ok: false, reason: 'multiple_values', detail: HEADER_DID });
    });

    it('rejects X-Signature sent as array', () => {
      const h = validHeaders();
      h[HEADER_SIGNATURE] = [VALID_SIG, VALID_SIG];
      expect(extractSignedHeaders(h)).toMatchObject({
        ok: false,
        reason: 'multiple_values',
        detail: HEADER_SIGNATURE,
      });
    });

    it('empty array is treated as missing, not multi-value', () => {
      const h = validHeaders();
      h[HEADER_NONCE] = [];
      expect(extractSignedHeaders(h)).toMatchObject({
        ok: false,
        reason: 'missing_nonce',
      });
    });
  });

  describe('shape validation', () => {
    it('rejects malformed DID (no method)', () => {
      const h = validHeaders();
      h[HEADER_DID] = 'plc:abc';
      const res = extractSignedHeaders(h);
      expect(res).toMatchObject({ ok: false, reason: 'malformed_did' });
    });

    it('rejects DID with uppercase method', () => {
      const h = validHeaders();
      h[HEADER_DID] = 'did:PLC:abc';
      expect(extractSignedHeaders(h)).toMatchObject({ ok: false, reason: 'malformed_did' });
    });

    it('rejects nonce shorter than 32 hex', () => {
      const h = validHeaders();
      h[HEADER_NONCE] = 'a'.repeat(31);
      expect(extractSignedHeaders(h)).toMatchObject({ ok: false, reason: 'malformed_nonce' });
    });

    it('rejects nonce longer than 32 hex', () => {
      const h = validHeaders();
      h[HEADER_NONCE] = 'a'.repeat(33);
      expect(extractSignedHeaders(h)).toMatchObject({ ok: false, reason: 'malformed_nonce' });
    });

    it('rejects nonce with uppercase hex', () => {
      const h = validHeaders();
      h[HEADER_NONCE] = 'A'.repeat(32);
      expect(extractSignedHeaders(h)).toMatchObject({ ok: false, reason: 'malformed_nonce' });
    });

    it('rejects nonce with non-hex char', () => {
      const h = validHeaders();
      h[HEADER_NONCE] = 'z'.repeat(32);
      expect(extractSignedHeaders(h)).toMatchObject({ ok: false, reason: 'malformed_nonce' });
    });

    it('rejects signature not 128 hex chars', () => {
      const h = validHeaders();
      h[HEADER_SIGNATURE] = 'f'.repeat(127);
      expect(extractSignedHeaders(h)).toMatchObject({
        ok: false,
        reason: 'malformed_signature',
      });
    });

    it('rejects signature with non-hex char', () => {
      const h = validHeaders();
      h[HEADER_SIGNATURE] = 'g'.repeat(128);
      expect(extractSignedHeaders(h)).toMatchObject({
        ok: false,
        reason: 'malformed_signature',
      });
    });
  });

  describe('failure priority', () => {
    // When MULTIPLE headers fail, we report the first one encountered
    // in the fixed order: did → timestamp → nonce → signature. Stable
    // order helps log-grepping.
    it('reports missing_did before other failures', () => {
      const h = validHeaders();
      delete h[HEADER_DID];
      delete h[HEADER_NONCE];
      expect(extractSignedHeaders(h)).toMatchObject({ ok: false, reason: 'missing_did' });
    });

    it('reports missing headers before malformed headers', () => {
      const h = validHeaders();
      delete h[HEADER_DID];
      h[HEADER_SIGNATURE] = 'bad';
      expect(extractSignedHeaders(h)).toMatchObject({ ok: false, reason: 'missing_did' });
    });
  });
});
