/**
 * T7.2 — Identity binding E2E: full Core RPC pipeline with binding verification.
 *
 * Build RPC request → seal → unseal → verify envelope binding → verify DID.
 * Mismatched identities → rejected.
 *
 * Source: ARCHITECTURE.md Task 7.2
 */

import { buildRPCRequest, sealRPCRequest, unsealRPCRequest } from '../../src/relay/rpc_envelope';
import { buildSignedResponse, verifyResponseSignature } from '../../src/relay/rpc_response';
import {
  verifyEnvelopeBinding,
  verifyDIDDerivesFromKey,
  validateIdentityBinding,
} from '../../src/relay/identity_binding';
import { deriveDIDKey } from '../../src/identity/did';
import { getPublicKey } from '../../src/crypto/ed25519';
import { TEST_ED25519_SEED } from '@dina/test-harness';

describe('Identity Binding E2E (Task 7.2)', () => {
  // Sender (CLI / paired device)
  const senderPriv = TEST_ED25519_SEED;
  const senderPub = getPublicKey(senderPriv);
  const senderDID = deriveDIDKey(senderPub);

  // Recipient (Core node)
  const corePriv = new Uint8Array(32).fill(0x42);
  const corePub = getPublicKey(corePriv);
  const coreDID = deriveDIDKey(corePub);

  describe('full round-trip: request → seal → unseal → verify', () => {
    it('valid request passes all binding checks', () => {
      // 1. Sender builds request with their DID
      const request = buildRPCRequest(
        'POST',
        '/v1/vault/query',
        '',
        '{"text":"test"}',
        { 'X-DID': senderDID },
        senderDID,
      );
      expect(request.from).toBe(senderDID);

      // 2. Seal for Core's public key
      const sealed = sealRPCRequest(request, corePub);
      expect(sealed).toBeInstanceOf(Uint8Array);

      // 3. Core unseals
      const recovered = unsealRPCRequest(sealed, corePub, corePriv);
      expect(recovered.from).toBe(senderDID);
      expect(recovered.headers['X-DID']).toBe(senderDID);

      // 4. Verify envelope binding: from == inner X-DID
      expect(verifyEnvelopeBinding(recovered.from, recovered.headers['X-DID'])).toBe(true);

      // 5. Full identity binding validation
      const binding = validateIdentityBinding(recovered);
      expect(binding.valid).toBe(true);
    });

    it('valid response round-trip: sign → seal → verify', () => {
      // Core builds signed response
      const response = buildSignedResponse('req-001', 200, {}, '{"items":[]}', coreDID, corePriv);

      // Verify response signature
      expect(verifyResponseSignature(response, corePub)).toBe(true);
      expect(response.from).toBe(coreDID);
    });
  });

  describe('mismatched envelope.from vs inner X-DID → rejected', () => {
    it('forged envelope.from is caught', () => {
      const request = buildRPCRequest(
        'POST',
        '/v1/vault/query',
        '',
        '{}',
        { 'X-DID': senderDID },
        senderDID,
      );

      // Attacker tampers with envelope.from
      const tampered = { ...request, from: 'did:key:z6MkAttacker' };

      const binding = validateIdentityBinding(tampered);
      expect(binding.valid).toBe(false);
      expect(binding.error).toContain('mismatch');
    });

    it('forged inner X-DID is caught', () => {
      const request = buildRPCRequest(
        'POST',
        '/v1/vault/query',
        '',
        '{}',
        { 'X-DID': 'did:key:z6MkForged' },
        senderDID,
      );

      const binding = validateIdentityBinding(request);
      expect(binding.valid).toBe(false);
    });

    it('missing inner X-DID is caught', () => {
      const request = buildRPCRequest('POST', '/v1/vault/query', '', '{}', {}, senderDID);

      const binding = validateIdentityBinding(request);
      expect(binding.valid).toBe(false);
      expect(binding.error).toContain('Missing X-DID');
    });
  });

  describe('DID derives from signing key', () => {
    it('DID derived from presented public key → true', () => {
      expect(verifyDIDDerivesFromKey(senderDID, senderPub)).toBe(true);
    });

    it('DID NOT derived from wrong key → false', () => {
      const wrongPub = getPublicKey(new Uint8Array(32).fill(0x99));
      expect(verifyDIDDerivesFromKey(senderDID, wrongPub)).toBe(false);
    });

    it('Core DID derives from Core key', () => {
      expect(verifyDIDDerivesFromKey(coreDID, corePub)).toBe(true);
    });
  });

  describe('sealed transport security', () => {
    it('wrong recipient key cannot unseal', () => {
      const request = buildRPCRequest('GET', '/', '', '', {}, senderDID);
      const sealed = sealRPCRequest(request, corePub);

      const wrongPriv = new Uint8Array(32).fill(0x99);
      const wrongPub = getPublicKey(wrongPriv);
      expect(() => unsealRPCRequest(sealed, wrongPub, wrongPriv)).toThrow();
    });

    it('plaintext not visible in sealed envelope', () => {
      const request = buildRPCRequest(
        'POST',
        '/v1/vault/store',
        '',
        '{"secret":"data"}',
        { 'X-DID': senderDID },
        senderDID,
      );
      const sealed = sealRPCRequest(request, corePub);
      const asString = Buffer.from(sealed).toString('utf-8');
      expect(asString).not.toContain('secret');
    });
  });
});
