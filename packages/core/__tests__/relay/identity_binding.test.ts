/**
 * T3.7 — Identity binding invariant: reject if envelope.from != inner X-DID,
 * DID must derive from Ed25519 signing key.
 *
 * Source: ARCHITECTURE.md Section 19.3.
 */

import {
  verifyEnvelopeBinding,
  verifyDIDDerivesFromKey,
  validateIdentityBinding,
} from '../../src/relay/identity_binding';
import { deriveDIDKey } from '../../src/identity/did';
import { getPublicKey } from '../../src/crypto/ed25519';
import type { CoreRPCRequest } from '../../src/relay/rpc_envelope';
import { TEST_ED25519_SEED } from '@dina/test-harness';

describe('Core RPC Identity Binding', () => {
  const pubKey = getPublicKey(TEST_ED25519_SEED);
  const realDID = deriveDIDKey(pubKey);

  describe('verifyEnvelopeBinding', () => {
    it('matching from + X-DID → true', () => {
      expect(verifyEnvelopeBinding(realDID, realDID)).toBe(true);
    });

    it('mismatched from vs X-DID → false', () => {
      expect(verifyEnvelopeBinding(realDID, 'did:key:z6MkDifferent')).toBe(false);
    });

    it('empty from → false', () => {
      expect(verifyEnvelopeBinding('', realDID)).toBe(false);
    });

    it('empty X-DID → false', () => {
      expect(verifyEnvelopeBinding(realDID, '')).toBe(false);
    });
  });

  describe('verifyDIDDerivesFromKey', () => {
    it('DID derived from presented public key → true', () => {
      expect(verifyDIDDerivesFromKey(realDID, pubKey)).toBe(true);
    });

    it('DID NOT derived from key → false', () => {
      const wrongPub = new Uint8Array(32).fill(0x99);
      expect(verifyDIDDerivesFromKey(realDID, wrongPub)).toBe(false);
    });

    it('invalid DID format → false', () => {
      expect(verifyDIDDerivesFromKey('not-a-did', pubKey)).toBe(false);
    });

    it('empty public key → false', () => {
      expect(verifyDIDDerivesFromKey(realDID, new Uint8Array(0))).toBe(false);
    });
  });

  describe('validateIdentityBinding (full check)', () => {
    it('all three identities match → valid', () => {
      const request: CoreRPCRequest = {
        type: 'core_rpc_request',
        request_id: 'r1',
        from: realDID,
        method: 'POST',
        path: '/',
        query: '',
        headers: { 'X-DID': realDID, 'X-Signature': 'abc' },
        body: '{}',
      };
      const result = validateIdentityBinding(request);
      expect(result.valid).toBe(true);
    });

    it('envelope.from != inner X-DID → rejected with error', () => {
      const request: CoreRPCRequest = {
        type: 'core_rpc_request',
        request_id: 'r1',
        from: realDID,
        method: 'POST',
        path: '/',
        query: '',
        headers: { 'X-DID': 'did:key:z6MkOther', 'X-Signature': 'abc' },
        body: '{}',
      };
      const result = validateIdentityBinding(request);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('mismatch');
    });

    it('missing X-DID header → rejected', () => {
      const request: CoreRPCRequest = {
        type: 'core_rpc_request',
        request_id: 'r1',
        from: realDID,
        method: 'POST',
        path: '/',
        query: '',
        headers: {},
        body: '{}',
      };
      const result = validateIdentityBinding(request);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Missing X-DID');
    });

    it('returns error string describing which check failed', () => {
      const request: CoreRPCRequest = {
        type: 'core_rpc_request',
        request_id: 'r1',
        from: 'did:a',
        method: 'POST',
        path: '/',
        query: '',
        headers: { 'X-DID': 'did:b' },
        body: '{}',
      };
      const result = validateIdentityBinding(request);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('did:a');
      expect(result.error).toContain('did:b');
    });
  });
});
