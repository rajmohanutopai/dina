/**
 * T2.4 — Ed25519 auth middleware orchestration: full pipeline.
 *
 * Source: ARCHITECTURE.md Section 2.4
 */

import {
  authenticateRequest,
  registerPublicKeyResolver,
  resetMiddlewareState,
} from '../../src/auth/middleware';
import { signRequest } from '../../src/auth/canonical';
import { getPublicKey } from '../../src/crypto/ed25519';
import { registerService, resetCallerTypeState } from '../../src/auth/caller_type';
import { TEST_ED25519_SEED } from '@dina/test-harness';

const pubKey = getPublicKey(TEST_ED25519_SEED);
const did = 'did:key:z6MkBrainService';

/** Helper: build a properly signed request. */
function signedRequest(
  method: string,
  path: string,
  body = '',
): {
  method: string;
  path: string;
  query: string;
  body: Uint8Array;
  headers: Record<string, string>;
} {
  const bodyBytes = new TextEncoder().encode(body);
  const authHeaders = signRequest(method, path, '', bodyBytes, TEST_ED25519_SEED, did);
  return { method, path, query: '', body: bodyBytes, headers: { ...authHeaders } };
}

describe('Auth Middleware Orchestration', () => {
  beforeEach(() => {
    resetMiddlewareState();
    resetCallerTypeState();
    registerPublicKeyResolver((d) => (d === did ? pubKey : null));
    registerService(did, 'brain');
  });

  describe('full pipeline success', () => {
    it('authenticates a valid signed request', () => {
      const req = signedRequest('POST', '/v1/vault/query', '{"text":"test"}');
      const result = authenticateRequest(req);
      expect(result.authenticated).toBe(true);
      expect(result.did).toBe(did);
      expect(result.callerType).toBe('service');
    });

    it('authenticates GET request', () => {
      const req = signedRequest('GET', '/healthz');
      const result = authenticateRequest(req);
      expect(result.authenticated).toBe(true);
    });
  });

  describe('header validation', () => {
    it('rejects missing X-DID', () => {
      const req = signedRequest('GET', '/healthz');
      delete req.headers['X-DID'];
      const result = authenticateRequest(req);
      expect(result.authenticated).toBe(false);
      expect(result.rejectedAt).toBe('headers');
    });

    it('rejects missing X-Signature', () => {
      const req = signedRequest('GET', '/healthz');
      delete req.headers['X-Signature'];
      const result = authenticateRequest(req);
      expect(result.authenticated).toBe(false);
      expect(result.rejectedAt).toBe('headers');
    });

    it('rejects missing X-Timestamp', () => {
      const req = signedRequest('GET', '/healthz');
      delete req.headers['X-Timestamp'];
      expect(authenticateRequest(req).rejectedAt).toBe('headers');
    });

    it('rejects missing X-Nonce', () => {
      const req = signedRequest('GET', '/healthz');
      delete req.headers['X-Nonce'];
      expect(authenticateRequest(req).rejectedAt).toBe('headers');
    });
  });

  describe('timestamp validation', () => {
    it('rejects expired timestamp', () => {
      const req = signedRequest('GET', '/healthz');
      req.headers['X-Timestamp'] = '2020-01-01T00:00:00Z';
      const result = authenticateRequest(req);
      expect(result.authenticated).toBe(false);
      expect(result.rejectedAt).toBe('timestamp');
    });
  });

  describe('nonce replay', () => {
    it('rejects replayed nonce', () => {
      const req = signedRequest('GET', '/healthz');
      authenticateRequest(req); // first use — succeeds
      const result = authenticateRequest(req); // replay — fails
      expect(result.authenticated).toBe(false);
      expect(result.rejectedAt).toBe('nonce');
    });
  });

  describe('signature verification', () => {
    it('rejects tampered signature', () => {
      const req = signedRequest('GET', '/healthz');
      req.headers['X-Signature'] = 'aa'.repeat(64); // wrong signature
      const result = authenticateRequest(req);
      expect(result.authenticated).toBe(false);
      expect(result.rejectedAt).toBe('signature');
    });

    it('rejects unknown DID (no public key)', () => {
      const req = signedRequest('GET', '/healthz');
      req.headers['X-DID'] = 'did:key:z6MkUnknown';
      const result = authenticateRequest(req);
      expect(result.authenticated).toBe(false);
      expect(result.rejectedAt).toBe('signature');
    });
  });

  describe('rate limiting', () => {
    it('rejects after rate limit exceeded', () => {
      // Exhaust rate limit (default 50/60s)
      for (let i = 0; i < 50; i++) {
        const req = signedRequest('GET', '/healthz');
        authenticateRequest(req);
      }
      const req = signedRequest('GET', '/healthz');
      const result = authenticateRequest(req);
      expect(result.authenticated).toBe(false);
      expect(result.rejectedAt).toBe('rate_limit');
    });
  });

  describe('authorization', () => {
    it('rejects unauthorized path for caller type', () => {
      // Register as device (not brain) — device can't access /v1/vault/store
      resetCallerTypeState();
      const { registerDevice } = require('../../src/auth/caller_type');
      registerDevice(did, 'phone');
      registerPublicKeyResolver((d) => (d === did ? pubKey : null));

      const req = signedRequest('POST', '/v1/vault/store', '{}');
      const result = authenticateRequest(req);
      // Device is NOT authorized for /v1/vault/store (brain-only endpoint)
      expect(result.authenticated).toBe(false);
      expect(result.rejectedAt).toBe('authorization');
    });
  });

  describe('result shape', () => {
    it('success includes did and callerType', () => {
      const req = signedRequest('GET', '/healthz');
      const result = authenticateRequest(req);
      expect(result.authenticated).toBe(true);
      expect(typeof result.did).toBe('string');
      expect(typeof result.callerType).toBe('string');
    });

    it('failure includes rejectedAt and reason', () => {
      const result = authenticateRequest({
        method: 'GET',
        path: '/',
        query: '',
        body: new Uint8Array(0),
        headers: {},
      });
      expect(result.authenticated).toBe(false);
      expect(result.rejectedAt).toBeTruthy();
      expect(result.reason).toBeTruthy();
    });
  });
});
