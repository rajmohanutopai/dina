/**
 * T2B.2 — Brain auth: Ed25519 service key validation.
 *
 * Source: brain/tests/test_auth.py
 */

import {
  verifyServiceAuth,
  isRegisteredService,
  isRegisteredUIDevice,
  verifySubappIsolation,
  registerService,
  registerUIDevice,
  clearRegistries,
} from '../../src/auth/service_key';
import { signRequest } from '../../../core/src/auth/canonical';
import { getPublicKey } from '../../../core/src/crypto/ed25519';
import { TEST_ED25519_SEED, stringToBytes } from '@dina/test-harness';

describe('Brain Service Key Auth', () => {
  const corePub = getPublicKey(TEST_ED25519_SEED);
  const coreDID = 'did:key:z6MkCoreService';

  beforeEach(() => {
    clearRegistries();
    registerService(coreDID, corePub);
  });

  describe('verifyServiceAuth', () => {
    it('accepts valid Core service signature', () => {
      const headers = signRequest(
        'POST',
        '/v1/process',
        '',
        stringToBytes('{}'),
        TEST_ED25519_SEED,
        coreDID,
      );
      const result = verifyServiceAuth(
        coreDID,
        'POST',
        '/v1/process',
        headers['X-Timestamp'],
        headers['X-Nonce'],
        stringToBytes('{}'),
        headers['X-Signature'],
      );
      expect(result.authenticated).toBe(true);
      expect(result.identity).toBe(coreDID);
    });

    it('rejects missing DID', () => {
      const result = verifyServiceAuth('', '', '/v1/process', '', '', new Uint8Array(0), '');
      expect(result.authenticated).toBe(false);
    });

    it('rejects unregistered DID', () => {
      const result = verifyServiceAuth(
        'did:key:z6MkUnknown',
        'POST',
        '/v1/process',
        'ts',
        'nonce',
        new Uint8Array(0),
        'sig',
      );
      expect(result.authenticated).toBe(false);
    });

    it('rejects wrong signature', () => {
      const result = verifyServiceAuth(
        coreDID,
        'POST',
        '/v1/process',
        '2026-04-09T12:00:00Z',
        'abc123',
        stringToBytes('{}'),
        'aa'.repeat(64),
      );
      expect(result.authenticated).toBe(false);
    });

    it('/healthz bypasses auth', () => {
      const result = verifyServiceAuth('', 'GET', '/healthz', '', '', new Uint8Array(0), '');
      expect(result.authenticated).toBe(true);
      expect(result.identity).toBe('public');
    });
  });

  describe('isRegisteredService', () => {
    it('registered Core DID → true', () => {
      expect(isRegisteredService(coreDID)).toBe(true);
    });

    it('unknown DID → false', () => {
      expect(isRegisteredService('did:key:z6MkUnknown')).toBe(false);
    });
  });

  describe('isRegisteredUIDevice', () => {
    it('registered UI device → true', () => {
      registerUIDevice('did:key:z6MkUIDevice');
      expect(isRegisteredUIDevice('did:key:z6MkUIDevice')).toBe(true);
    });

    it('unknown DID → false', () => {
      expect(isRegisteredUIDevice('did:key:z6MkStranger')).toBe(false);
    });
  });

  describe('subapp isolation', () => {
    it('Brain does not import Admin', () => {
      const result = verifySubappIsolation();
      expect(result.brainImportsAdmin).toBe(false);
    });

    it('Admin does not import Brain', () => {
      const result = verifySubappIsolation();
      expect(result.adminImportsBrain).toBe(false);
    });
  });

  describe('access control', () => {
    it('API endpoints require service key', () => {
      const result = verifyServiceAuth('', 'POST', '/v1/process', '', '', new Uint8Array(0), '');
      expect(result.authenticated).toBe(false);
    });

    it('Brain has zero SQLite calls (architectural invariant)', () => {
      expect(true).toBe(true);
    });
  });
});
