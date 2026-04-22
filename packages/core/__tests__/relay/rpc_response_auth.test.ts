/**
 * T3.6 — Core RPC response authentication: Ed25519 signature binds
 * request_id + status + body hash.
 *
 * Category B+: NEW mobile-specific test.
 *
 * Source: ARCHITECTURE.md Section 19.2 (response envelope).
 */

import {
  buildSignedResponse,
  buildResponseCanonical,
  verifyResponseSignature,
  sealRPCResponse,
} from '../../src/relay/rpc_response';
import { getPublicKey } from '../../src/crypto/ed25519';
import { sealDecrypt } from '../../src/crypto/nacl';
import { TEST_ED25519_SEED } from '@dina/test-harness';

describe('Core RPC Response Auth', () => {
  const coreDID = 'did:plc:mobileCore123';
  const corePriv = TEST_ED25519_SEED;
  const corePub = getPublicKey(corePriv);

  describe('buildResponseCanonical', () => {
    it('format: core_rpc_response\\n{request_id}\\n{status}\\n{sha256_hex(body)}', () => {
      const canonical = buildResponseCanonical('req-001', 200, '{"id":"stg_abc"}');
      const parts = canonical.split('\n');
      expect(parts[0]).toBe('core_rpc_response');
      expect(parts[1]).toBe('req-001');
      expect(parts[2]).toBe('200');
      expect(parts[3]).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
    });

    it('different request_id → different canonical', () => {
      const c1 = buildResponseCanonical('req-001', 200, '{}');
      const c2 = buildResponseCanonical('req-002', 200, '{}');
      expect(c1).not.toBe(c2);
    });

    it('different status → different canonical', () => {
      const c1 = buildResponseCanonical('req-001', 200, '{}');
      const c2 = buildResponseCanonical('req-001', 404, '{}');
      expect(c1).not.toBe(c2);
    });

    it('different body → different canonical (body hash changes)', () => {
      const c1 = buildResponseCanonical('req-001', 200, '{"a":1}');
      const c2 = buildResponseCanonical('req-001', 200, '{"b":2}');
      expect(c1).not.toBe(c2);
    });

    it('same inputs → same canonical (deterministic)', () => {
      const c1 = buildResponseCanonical('req-001', 200, '{}');
      const c2 = buildResponseCanonical('req-001', 200, '{}');
      expect(c1).toBe(c2);
    });
  });

  describe('buildSignedResponse', () => {
    it('builds response with Ed25519 signature', () => {
      const resp = buildSignedResponse(
        'req-001',
        200,
        { 'Content-Type': 'application/json' },
        '{"id":"stg_abc"}',
        coreDID,
        corePriv,
      );
      expect(resp.type).toBe('core_rpc_response');
      expect(resp.request_id).toBe('req-001');
      expect(resp.status).toBe(200);
      expect(resp.body).toBe('{"id":"stg_abc"}');
      expect(resp.signature).toBeTruthy();
    });

    it('signature is hex-encoded (128 hex chars = 64 bytes)', () => {
      const resp = buildSignedResponse('req-001', 200, {}, '{}', coreDID, corePriv);
      expect(resp.signature).toMatch(/^[0-9a-f]{128}$/);
    });

    it('from field is Core DID', () => {
      const resp = buildSignedResponse('req-001', 200, {}, '{}', coreDID, corePriv);
      expect(resp.from).toBe(coreDID);
    });

    it('preserves headers', () => {
      const headers = { 'Content-Type': 'application/json', 'X-Custom': 'value' };
      const resp = buildSignedResponse('req-001', 200, headers, '{}', coreDID, corePriv);
      expect(resp.headers).toEqual(headers);
    });

    it('signature verifies against Core public key', () => {
      const resp = buildSignedResponse('req-001', 200, {}, '{"ok":true}', coreDID, corePriv);
      expect(verifyResponseSignature(resp, corePub)).toBe(true);
    });
  });

  describe('verifyResponseSignature', () => {
    it('valid signature → true', () => {
      const resp = buildSignedResponse('req-001', 200, {}, '{}', coreDID, corePriv);
      expect(verifyResponseSignature(resp, corePub)).toBe(true);
    });

    it('tampered body → false', () => {
      const resp = buildSignedResponse('req-001', 200, {}, '{}', coreDID, corePriv);
      resp.body = '{"tampered":true}';
      expect(verifyResponseSignature(resp, corePub)).toBe(false);
    });

    it('wrong Core public key → false', () => {
      const resp = buildSignedResponse('req-001', 200, {}, '{}', coreDID, corePriv);
      const wrongPub = getPublicKey(new Uint8Array(32).fill(0x99));
      expect(verifyResponseSignature(resp, wrongPub)).toBe(false);
    });

    it('signature binds request_id (prevents response reuse)', () => {
      const resp = buildSignedResponse('req-001', 200, {}, '{}', coreDID, corePriv);
      resp.request_id = 'req-WRONG';
      expect(verifyResponseSignature(resp, corePub)).toBe(false);
    });

    it('tampered status → false', () => {
      const resp = buildSignedResponse('req-001', 200, {}, '{}', coreDID, corePriv);
      resp.status = 500;
      expect(verifyResponseSignature(resp, corePub)).toBe(false);
    });
  });

  describe('sealRPCResponse', () => {
    it('NaCl-seals response for MsgBox transport', () => {
      const resp = buildSignedResponse('req-001', 200, {}, '{}', coreDID, corePriv);
      const sealed = sealRPCResponse(resp, corePub);
      expect(sealed).toBeInstanceOf(Uint8Array);
      expect(sealed.length).toBeGreaterThan(32);
    });

    it('sealed output does not contain plaintext', () => {
      const resp = buildSignedResponse('req-001', 200, {}, '{"secret":"data"}', coreDID, corePriv);
      const sealed = sealRPCResponse(resp, corePub);
      const asString = Buffer.from(sealed).toString('utf-8');
      expect(asString).not.toContain('secret');
    });

    it('sealed output can be decrypted with matching key', () => {
      const resp = buildSignedResponse('req-001', 200, {}, '{"ok":true}', coreDID, corePriv);
      const sealed = sealRPCResponse(resp, corePub);
      const plaintext = sealDecrypt(sealed, corePub, corePriv);
      const recovered = JSON.parse(new TextDecoder().decode(plaintext));
      expect(recovered.type).toBe('core_rpc_response');
      expect(recovered.request_id).toBe('req-001');
      expect(recovered.body).toBe('{"ok":true}');
    });
  });
});
