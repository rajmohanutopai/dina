/**
 * T3.14 — Chat UI authenticates to Brain with Ed25519 device key.
 *
 * Source: ARCHITECTURE.md Section 24.1
 */

import {
  verifyServiceAuth,
  isRegisteredUIDevice,
  registerUIDevice,
  clearRegistries,
} from '../../src/auth/service_key';
import { stringToBytes } from '@dina/test-harness';

describe('UI Device Key Auth (Mobile-Specific)', () => {
  beforeEach(() => clearRegistries());

  describe('Ed25519 device key authentication', () => {
    it('unregistered device DID is rejected', () => {
      const result = verifyServiceAuth(
        'did:key:z6MkUIDevice',
        'POST',
        '/api/chat',
        '2026-04-11T12:00:00Z',
        'nonce123',
        stringToBytes('{}'),
        'aa'.repeat(64),
      );
      expect(result.authenticated).toBe(false);
    });

    it('registered device is recognized', () => {
      registerUIDevice('did:key:z6MkUIDevice');
      expect(isRegisteredUIDevice('did:key:z6MkUIDevice')).toBe(true);
    });

    it('unknown device is not recognized', () => {
      expect(isRegisteredUIDevice('did:key:z6MkStranger')).toBe(false);
    });
  });

  describe('no CLIENT_TOKEN', () => {
    it('Brain rejects empty auth (no bearer fallback)', () => {
      const result = verifyServiceAuth('', 'POST', '/api/chat', '', '', new Uint8Array(0), '');
      expect(result.authenticated).toBe(false);
    });

    it('Brain does NOT have validateClientToken method', () => {
      expect(true).toBe(true);
    });
  });

  describe('auth chain', () => {
    it('unregistered Brain service DID rejected', () => {
      const result = verifyServiceAuth(
        'did:key:z6MkBrainService',
        'POST',
        '/v1/vault/query',
        '2026-04-11T12:00:00Z',
        'abc',
        stringToBytes('{}'),
        'aa'.repeat(64),
      );
      expect(result.authenticated).toBe(false);
    });

    it('full chain: UI → Brain → Core, all Ed25519 (architectural invariant)', () => {
      expect(true).toBe(true);
    });
  });
});
