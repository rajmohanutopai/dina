/**
 * T1B.1 — Auth canonical payload construction and request signing.
 *
 * Category A: fixture-based. Verifies the canonical string format matches
 * Go exactly — same inputs produce same canonical → same signature.
 *
 * Wire format (from auth.go):
 *   {METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{NONCE}\n{SHA256_HEX(BODY)}
 *
 * Source: core/test/signature_test.go, auth_test.go
 */

import {
  buildCanonicalPayload,
  sha256Hex,
  signRequest,
  verifyRequest,
} from '../../src/auth/canonical';
import { getPublicKey } from '../../src/crypto/ed25519';
import {
  TEST_ED25519_SEED,
  stringToBytes,
  hasFixture,
  loadVectors,
  bytesToHex,
} from '@dina/test-harness';

describe('Canonical Payload Construction', () => {
  const body = stringToBytes('{"source":"gmail","type":"email"}');

  describe('buildCanonicalPayload', () => {
    it('builds canonical string from request components', () => {
      const result = buildCanonicalPayload(
        'POST',
        '/v1/vault/store',
        '',
        '2026-04-09T12:00:00Z',
        'abc123def456',
        body,
      );
      expect(typeof result).toBe('string');
      expect(result.split('\n').length).toBe(6);
    });

    it('includes all 6 components separated by newlines', () => {
      const result = buildCanonicalPayload(
        'GET',
        '/v1/personas',
        'limit=10',
        '2026-04-09T12:00:00Z',
        'def456',
        new Uint8Array(0),
      );
      const parts = result.split('\n');
      expect(parts[0]).toBe('GET');
      expect(parts[1]).toBe('/v1/personas');
      expect(parts[2]).toBe('limit=10');
      expect(parts[3]).toBe('2026-04-09T12:00:00Z');
      expect(parts[4]).toBe('def456');
      expect(parts[5].length).toBe(64); // SHA-256 hex
    });

    it('uses SHA-256 hex of body as last component', () => {
      const result = buildCanonicalPayload(
        'POST',
        '/v1/staging/ingest',
        '',
        '2026-04-09T12:00:00Z',
        '789abc',
        body,
      );
      const bodyHash = result.split('\n')[5];
      expect(bodyHash).toBe(sha256Hex(body));
    });

    it('handles empty body (SHA-256 of empty bytes)', () => {
      const result = buildCanonicalPayload(
        'GET',
        '/healthz',
        '',
        '2026-04-09T12:00:00Z',
        'abc123',
        new Uint8Array(0),
      );
      const emptyHash = result.split('\n')[5];
      // SHA-256 of empty string
      expect(emptyHash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('handles empty query string', () => {
      const result = buildCanonicalPayload(
        'POST',
        '/v1/vault/store',
        '',
        '2026-04-09T12:00:00Z',
        'abc123',
        body,
      );
      expect(result.split('\n')[2]).toBe('');
    });

    it('preserves method case (uppercase)', () => {
      const result = buildCanonicalPayload(
        'POST',
        '/v1/vault/store',
        '',
        '2026-04-09T12:00:00Z',
        'abc123',
        body,
      );
      expect(result.split('\n')[0]).toBe('POST');
    });
  });

  describe('sha256Hex', () => {
    it('computes hex digest of data', () => {
      const hash = sha256Hex(body);
      expect(hash.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
    });

    it('computes known hash of empty data', () => {
      expect(sha256Hex(new Uint8Array(0))).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    });

    it('is deterministic', () => {
      expect(sha256Hex(body)).toBe(sha256Hex(body));
    });
  });

  describe('signRequest', () => {
    it('returns 4 auth headers', () => {
      const headers = signRequest(
        'POST',
        '/v1/vault/store',
        '',
        body,
        TEST_ED25519_SEED,
        'did:key:z6MkTest',
      );
      expect(headers['X-DID']).toBe('did:key:z6MkTest');
      expect(headers['X-Timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(headers['X-Nonce']).toMatch(/^[0-9a-f]+$/);
      expect(headers['X-Signature']).toMatch(/^[0-9a-f]{128}$/); // 64-byte sig → 128 hex chars
    });

    it('X-Nonce is 32 hex characters (16 random bytes)', () => {
      const headers = signRequest(
        'POST',
        '/test',
        '',
        new Uint8Array(0),
        TEST_ED25519_SEED,
        'did:key:z6MkTest',
      );
      expect(headers['X-Nonce'].length).toBe(32);
    });

    it('two calls produce different nonces', () => {
      const h1 = signRequest('GET', '/test', '', new Uint8Array(0), TEST_ED25519_SEED, 'did:test');
      const h2 = signRequest('GET', '/test', '', new Uint8Array(0), TEST_ED25519_SEED, 'did:test');
      expect(h1['X-Nonce']).not.toBe(h2['X-Nonce']);
    });
  });

  describe('verifyRequest', () => {
    const publicKey = getPublicKey(TEST_ED25519_SEED);

    it('returns true for valid signed request', () => {
      const headers = signRequest(
        'POST',
        '/v1/vault/store',
        '',
        body,
        TEST_ED25519_SEED,
        'did:key:z6MkTest',
      );
      const valid = verifyRequest(
        'POST',
        '/v1/vault/store',
        '',
        headers['X-Timestamp'],
        headers['X-Nonce'],
        body,
        headers['X-Signature'],
        publicKey,
      );
      expect(valid).toBe(true);
    });

    it('returns false for tampered body', () => {
      const headers = signRequest(
        'POST',
        '/v1/vault/store',
        '',
        body,
        TEST_ED25519_SEED,
        'did:key:z6MkTest',
      );
      const tamperedBody = stringToBytes('{"tampered":true}');
      const valid = verifyRequest(
        'POST',
        '/v1/vault/store',
        '',
        headers['X-Timestamp'],
        headers['X-Nonce'],
        tamperedBody,
        headers['X-Signature'],
        publicKey,
      );
      expect(valid).toBe(false);
    });

    it('returns false for tampered path', () => {
      const headers = signRequest(
        'POST',
        '/v1/vault/store',
        '',
        body,
        TEST_ED25519_SEED,
        'did:key:z6MkTest',
      );
      const valid = verifyRequest(
        'POST',
        '/v1/vault/delete',
        '',
        headers['X-Timestamp'],
        headers['X-Nonce'],
        body,
        headers['X-Signature'],
        publicKey,
      );
      expect(valid).toBe(false);
    });

    it('returns false for wrong public key', () => {
      const headers = signRequest(
        'POST',
        '/v1/vault/store',
        '',
        body,
        TEST_ED25519_SEED,
        'did:key:z6MkTest',
      );
      const wrongKey = new Uint8Array(32).fill(0x99);
      const valid = verifyRequest(
        'POST',
        '/v1/vault/store',
        '',
        headers['X-Timestamp'],
        headers['X-Nonce'],
        body,
        headers['X-Signature'],
        getPublicKey(wrongKey),
      );
      expect(valid).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // Cross-language verification against Go fixtures
  // ------------------------------------------------------------------

  const fixture = 'auth/canonical_payload.json';
  const suite = hasFixture(fixture) ? describe : describe.skip;
  suite('cross-language: canonical payload (Go fixtures)', () => {
    const vectors = loadVectors<
      {
        method: string;
        path: string;
        query: string;
        timestamp: string;
        nonce: string;
        body: string;
      },
      { canonical_string: string; body_hash_hex: string }
    >(fixture);

    for (const v of vectors) {
      it(`${v.description}: body hash`, () => {
        const bodyBytes = stringToBytes(v.inputs.body);
        expect(sha256Hex(bodyBytes)).toBe(v.expected.body_hash_hex);
      });

      it(`${v.description}: canonical string`, () => {
        const bodyBytes = stringToBytes(v.inputs.body);
        const canonical = buildCanonicalPayload(
          v.inputs.method,
          v.inputs.path,
          v.inputs.query,
          v.inputs.timestamp,
          v.inputs.nonce,
          bodyBytes,
        );
        expect(canonical).toBe(v.expected.canonical_string);
      });
    }
  });

  const tsFixture = 'auth/timestamp_validation.json';
  const tsSuite = hasFixture(tsFixture) ? describe : describe.skip;
  tsSuite('cross-language: timestamp validation (Go fixtures)', () => {
    const { isTimestampValid } = require('../../src/auth/timestamp');
    const vectors = loadVectors<{ timestamp: string; now: string }, { valid: boolean }>(tsFixture);

    for (const v of vectors) {
      it(v.description, () => {
        expect(isTimestampValid(v.inputs.timestamp, new Date(v.inputs.now))).toBe(v.expected.valid);
      });
    }
  });
});
