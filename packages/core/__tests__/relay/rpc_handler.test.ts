/**
 * T2.22/2.23 — Core RPC request handler: unseal → identity binding → auth.
 *
 * Source: ARCHITECTURE.md Tasks 2.22, 2.23
 */

import { handleRPCRequest, resetRPCHandler } from '../../src/relay/rpc_handler';
import { buildRPCRequest, sealRPCRequest } from '../../src/relay/rpc_envelope';
import { getPublicKey } from '../../src/crypto/ed25519';
import { deriveDIDKey } from '../../src/identity/did';
import { resetAuditState, queryAudit } from '../../src/audit/service';
import { TEST_ED25519_SEED } from '@dina/test-harness';

const senderPriv = TEST_ED25519_SEED;
const senderPub = getPublicKey(senderPriv);
const senderDID = deriveDIDKey(senderPub);

const corePriv = new Uint8Array(32).fill(0x42);
const corePub = getPublicKey(corePriv);

/** Build a properly formed sealed RPC request. */
function buildSealed(overrides?: { from?: string; xDID?: string }) {
  const from = overrides?.from ?? senderDID;
  const xDID = overrides?.xDID ?? senderDID;
  const req = buildRPCRequest(
    'POST',
    '/v1/vault/query',
    '',
    '{"text":"test"}',
    {
      'X-DID': xDID,
      'X-Timestamp': '2026-04-12T12:00:00Z',
      'X-Nonce': 'abc123',
      'X-Signature': 'deadbeef',
    },
    from,
  );
  return sealRPCRequest(req, corePub);
}

describe('Core RPC Request Handler', () => {
  beforeEach(() => {
    resetRPCHandler();
    resetAuditState();
  });

  describe('handleRPCRequest — happy path', () => {
    it('valid request passes all checks', () => {
      const sealed = buildSealed();
      const result = handleRPCRequest(sealed, corePub, corePriv);
      expect(result.valid).toBe(true);
      expect(result.request).toBeDefined();
      expect(result.request!.method).toBe('POST');
      expect(result.request!.path).toBe('/v1/vault/query');
      expect(result.senderDID).toBe(senderDID);
    });

    it('audit logs accepted request', () => {
      handleRPCRequest(buildSealed(), corePub, corePriv);
      expect(queryAudit({ action: 'rpc_accepted' }).length).toBeGreaterThan(0);
    });
  });

  describe('unseal failure', () => {
    it('wrong recipient key → rejected at unseal', () => {
      const sealed = buildSealed();
      const wrongPriv = new Uint8Array(32).fill(0x99);
      const wrongPub = getPublicKey(wrongPriv);
      const result = handleRPCRequest(sealed, wrongPub, wrongPriv);
      expect(result.valid).toBe(false);
      expect(result.rejectedAt).toBe('unseal');
    });

    it('corrupted blob → rejected at unseal', () => {
      const result = handleRPCRequest(new Uint8Array([0xde, 0xad]), corePub, corePriv);
      expect(result.valid).toBe(false);
      expect(result.rejectedAt).toBe('unseal');
    });
  });

  describe('identity binding', () => {
    it('mismatched envelope.from vs X-DID → rejected', () => {
      const req = buildRPCRequest(
        'GET',
        '/',
        '',
        '',
        { 'X-DID': 'did:key:z6MkOther', 'X-Timestamp': 't', 'X-Nonce': 'n', 'X-Signature': 's' },
        senderDID,
      );
      const sealed = sealRPCRequest(req, corePub);
      const result = handleRPCRequest(sealed, corePub, corePriv);
      expect(result.valid).toBe(false);
      expect(result.rejectedAt).toBe('identity_binding');
    });

    it('missing X-DID → rejected at identity binding', () => {
      const req = buildRPCRequest('GET', '/', '', '', {}, senderDID);
      const sealed = sealRPCRequest(req, corePub);
      const result = handleRPCRequest(sealed, corePub, corePriv);
      expect(result.valid).toBe(false);
      expect(result.rejectedAt).toBe('identity_binding');
    });

    it('identity rejection is audit-logged', () => {
      const req = buildRPCRequest('GET', '/', '', '', { 'X-DID': 'did:key:z6MkWrong' }, senderDID);
      const sealed = sealRPCRequest(req, corePub);
      handleRPCRequest(sealed, corePub, corePriv);
      expect(queryAudit({ action: 'rpc_identity_rejected' }).length).toBeGreaterThan(0);
    });
  });

  describe('inner auth validation', () => {
    it('missing auth headers → rejected', () => {
      const req = buildRPCRequest('GET', '/', '', '', { 'X-DID': senderDID }, senderDID);
      const sealed = sealRPCRequest(req, corePub);
      const result = handleRPCRequest(sealed, corePub, corePriv);
      expect(result.valid).toBe(false);
      expect(result.rejectedAt).toBe('inner_auth');
    });

    it('partial auth headers → rejected', () => {
      const req = buildRPCRequest(
        'GET',
        '/',
        '',
        '',
        { 'X-DID': senderDID, 'X-Timestamp': '2026-04-12T12:00:00Z' },
        senderDID,
      );
      const sealed = sealRPCRequest(req, corePub);
      const result = handleRPCRequest(sealed, corePub, corePriv);
      expect(result.valid).toBe(false);
      expect(result.rejectedAt).toBe('inner_auth');
    });
  });
});
