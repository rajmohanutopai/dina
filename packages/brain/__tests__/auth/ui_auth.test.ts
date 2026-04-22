/**
 * T3.30 — UI device key auth: Brain validates Ed25519 from UI.
 *
 * Source: ARCHITECTURE.md Task 3.30
 */

import {
  authenticateUIRequest,
  registerUIDeviceKey,
  revokeUIDeviceKey,
  isRegisteredUIDevice,
  resetUIAuth,
} from '../../src/auth/ui_auth';
import { signRequest } from '../../../core/src/auth/canonical';
import { getPublicKey } from '../../../core/src/crypto/ed25519';
import { TEST_ED25519_SEED } from '@dina/test-harness';

const deviceDID = 'did:key:z6MkUIDevice';
const devicePub = getPublicKey(TEST_ED25519_SEED);

function signedUIRequest(method: string, path: string, body = '') {
  const bodyBytes = new TextEncoder().encode(body);
  const headers = signRequest(method, path, '', bodyBytes, TEST_ED25519_SEED, deviceDID);
  return { method, path, body: bodyBytes, headers: { ...headers } };
}

describe('UI Device Key Auth', () => {
  beforeEach(() => {
    resetUIAuth();
    registerUIDeviceKey(deviceDID, devicePub);
  });

  describe('authenticateUIRequest', () => {
    it('authenticates valid signed request', () => {
      const req = signedUIRequest('POST', '/api/chat', '{"text":"hello"}');
      const result = authenticateUIRequest(req);
      expect(result.authenticated).toBe(true);
      expect(result.deviceDID).toBe(deviceDID);
    });

    it('public paths bypass auth', () => {
      const result = authenticateUIRequest({
        method: 'GET',
        path: '/healthz',
        body: new Uint8Array(0),
        headers: {},
      });
      expect(result.authenticated).toBe(true);
    });

    it('readyz bypasses auth', () => {
      const result = authenticateUIRequest({
        method: 'GET',
        path: '/readyz',
        body: new Uint8Array(0),
        headers: {},
      });
      expect(result.authenticated).toBe(true);
    });

    it('rejects missing headers', () => {
      const result = authenticateUIRequest({
        method: 'POST',
        path: '/api/chat',
        body: new Uint8Array(0),
        headers: {},
      });
      expect(result.authenticated).toBe(false);
      expect(result.rejectedAt).toBe('headers');
    });

    it('rejects expired timestamp', () => {
      const req = signedUIRequest('POST', '/api/chat');
      req.headers['X-Timestamp'] = '2020-01-01T00:00:00Z';
      const result = authenticateUIRequest(req);
      expect(result.authenticated).toBe(false);
      expect(result.rejectedAt).toBe('timestamp');
    });

    it('rejects unregistered device', () => {
      resetUIAuth(); // clear all devices
      const req = signedUIRequest('POST', '/api/chat');
      const result = authenticateUIRequest(req);
      expect(result.authenticated).toBe(false);
      expect(result.rejectedAt).toBe('device');
    });

    it('rejects tampered signature', () => {
      const req = signedUIRequest('POST', '/api/chat');
      req.headers['X-Signature'] = 'bb'.repeat(64);
      const result = authenticateUIRequest(req);
      expect(result.authenticated).toBe(false);
      expect(result.rejectedAt).toBe('signature');
    });

    it('rejects wrong body (signature mismatch)', () => {
      const req = signedUIRequest('POST', '/api/chat', '{"original":"body"}');
      req.body = new TextEncoder().encode('{"tampered":"body"}');
      const result = authenticateUIRequest(req);
      expect(result.authenticated).toBe(false);
      expect(result.rejectedAt).toBe('signature');
    });
  });

  describe('device registration', () => {
    it('registerUIDeviceKey makes device recognized', () => {
      expect(isRegisteredUIDevice(deviceDID)).toBe(true);
    });

    it('unregistered device is not recognized', () => {
      expect(isRegisteredUIDevice('did:key:z6MkUnknown')).toBe(false);
    });

    it('revokeUIDeviceKey removes device', () => {
      revokeUIDeviceKey(deviceDID);
      expect(isRegisteredUIDevice(deviceDID)).toBe(false);

      // Revoked device fails auth
      const req = signedUIRequest('POST', '/api/chat');
      expect(authenticateUIRequest(req).authenticated).toBe(false);
    });
  });
});
