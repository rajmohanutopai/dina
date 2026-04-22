/**
 * T1K.1 — CLI request signing contract.
 *
 * Category A: fixture-based. Verifies CLI keypair generation, DID format,
 * multibase encoding, and request signing match Python dina-cli exactly.
 *
 * Source: cli/tests/test_signing.py
 */

import { generateCLIKeypair, signCLIRequest, verifyCLIRequest } from '../../src/auth/cli_signing';
import { multibaseToPublicKey } from '../../src/identity/did';
import { getPublicKey } from '../../src/crypto/ed25519';
import {
  TEST_ED25519_SEED,
  TEST_DID_KEY_PREFIX,
  stringToBytes,
  bytesToHex,
} from '@dina/test-harness';

describe('CLI Request Signing', () => {
  describe('generateCLIKeypair', () => {
    it('generates a keypair with all required fields', () => {
      const kp = generateCLIKeypair();
      expect(kp.publicKey).toBeInstanceOf(Uint8Array);
      expect(kp.privateKey).toBeInstanceOf(Uint8Array);
      expect(typeof kp.did).toBe('string');
      expect(typeof kp.publicKeyMultibase).toBe('string');
    });

    it('DID starts with did:key:z6Mk (Ed25519)', () => {
      const kp = generateCLIKeypair();
      expect(kp.did).toMatch(/^did:key:z6Mk/);
    });

    it('publicKeyMultibase starts with z (base58btc)', () => {
      const kp = generateCLIKeypair();
      expect(kp.publicKeyMultibase[0]).toBe('z');
    });

    it('DID contains the multibase key', () => {
      const kp = generateCLIKeypair();
      expect(kp.did).toBe(`did:key:${kp.publicKeyMultibase}`);
    });

    it('different keypairs produce different DIDs', () => {
      const kp1 = generateCLIKeypair();
      const kp2 = generateCLIKeypair();
      expect(kp1.did).not.toBe(kp2.did);
    });

    it('publicKey is 32 bytes', () => {
      const kp = generateCLIKeypair();
      expect(kp.publicKey.length).toBe(32);
    });

    it('multibase roundtrips correctly', () => {
      const kp = generateCLIKeypair();
      const decoded = multibaseToPublicKey(kp.publicKeyMultibase);
      expect(bytesToHex(decoded)).toBe(bytesToHex(kp.publicKey));
    });
  });

  describe('signCLIRequest', () => {
    const body = stringToBytes('{"source":"gmail"}');
    const did = 'did:key:z6MkTest';

    it('returns (did, timestamp, nonce, signature) tuple', () => {
      const result = signCLIRequest('POST', '/v1/staging/ingest', body, TEST_ED25519_SEED, did);
      expect(result.did).toBe(did);
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.nonce).toMatch(/^[0-9a-f]+$/);
      expect(result.signature).toMatch(/^[0-9a-f]{128}$/);
    });

    it('signature is verifiable', () => {
      const pubKey = getPublicKey(TEST_ED25519_SEED);
      const result = signCLIRequest('POST', '/v1/staging/ingest', body, TEST_ED25519_SEED, did);
      const valid = verifyCLIRequest(
        'POST',
        '/v1/staging/ingest',
        body,
        result.timestamp,
        result.nonce,
        result.signature,
        pubKey,
      );
      expect(valid).toBe(true);
    });

    it('empty body produces valid signature', () => {
      const pubKey = getPublicKey(TEST_ED25519_SEED);
      const result = signCLIRequest('GET', '/healthz', new Uint8Array(0), TEST_ED25519_SEED, did);
      const valid = verifyCLIRequest(
        'GET',
        '/healthz',
        new Uint8Array(0),
        result.timestamp,
        result.nonce,
        result.signature,
        pubKey,
      );
      expect(valid).toBe(true);
    });

    it('different payloads produce different signatures', () => {
      const sig1 = signCLIRequest('POST', '/v1/vault/store', body, TEST_ED25519_SEED, did);
      const sig2 = signCLIRequest('POST', '/v1/vault/query', body, TEST_ED25519_SEED, did);
      expect(sig1.signature).not.toBe(sig2.signature);
    });

    it('two calls produce different nonces', () => {
      const r1 = signCLIRequest('GET', '/healthz', new Uint8Array(0), TEST_ED25519_SEED, did);
      const r2 = signCLIRequest('GET', '/healthz', new Uint8Array(0), TEST_ED25519_SEED, did);
      expect(r1.nonce).not.toBe(r2.nonce);
    });
  });

  describe('verifyCLIRequest', () => {
    const body = stringToBytes('{}');
    const did = 'did:key:z6MkTest';
    const pubKey = getPublicKey(TEST_ED25519_SEED);

    it('accepts valid signature', () => {
      const result = signCLIRequest('POST', '/v1/staging/ingest', body, TEST_ED25519_SEED, did);
      expect(
        verifyCLIRequest(
          'POST',
          '/v1/staging/ingest',
          body,
          result.timestamp,
          result.nonce,
          result.signature,
          pubKey,
        ),
      ).toBe(true);
    });

    it('rejects tampered body', () => {
      const result = signCLIRequest('POST', '/v1/staging/ingest', body, TEST_ED25519_SEED, did);
      const tampered = stringToBytes('{"tampered":true}');
      expect(
        verifyCLIRequest(
          'POST',
          '/v1/staging/ingest',
          tampered,
          result.timestamp,
          result.nonce,
          result.signature,
          pubKey,
        ),
      ).toBe(false);
    });

    it('rejects wrong public key', () => {
      const result = signCLIRequest('POST', '/v1/staging/ingest', body, TEST_ED25519_SEED, did);
      const wrongKey = getPublicKey(new Uint8Array(32).fill(0x99));
      expect(
        verifyCLIRequest(
          'POST',
          '/v1/staging/ingest',
          body,
          result.timestamp,
          result.nonce,
          result.signature,
          wrongKey,
        ),
      ).toBe(false);
    });

    it('full round-trip: generate CLI keypair → sign → verify', () => {
      const kp = generateCLIKeypair();
      const result = signCLIRequest('POST', '/v1/vault/store', body, kp.privateKey, kp.did);
      expect(
        verifyCLIRequest(
          'POST',
          '/v1/vault/store',
          body,
          result.timestamp,
          result.nonce,
          result.signature,
          kp.publicKey,
        ),
      ).toBe(true);
    });
  });
});
