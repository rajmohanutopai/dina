/**
 * T2.24/2.25 — Core RPC response: build → sign → seal → forward.
 *
 * Source: ARCHITECTURE.md Tasks 2.24, 2.25
 */

import { sendRPCResponse } from '../../src/relay/rpc_responder';
import { verifyResponseSignature } from '../../src/relay/rpc_response';
import { getPublicKey } from '../../src/crypto/ed25519';
import { deriveDIDKey } from '../../src/identity/did';
import { setFetchFn, resetFetchFn } from '../../src/relay/msgbox_forward';
import { resetAuditState, queryAudit } from '../../src/audit/service';
import { TEST_ED25519_SEED } from '@dina/test-harness';

const corePriv = TEST_ED25519_SEED;
const corePub = getPublicKey(corePriv);
const coreDID = deriveDIDKey(corePub);

const senderPub = getPublicKey(new Uint8Array(32).fill(0x42));
const senderDID = 'did:plc:cli-device';

describe('Core RPC Response Send', () => {
  beforeEach(() => {
    resetFetchFn();
    resetAuditState();
  });

  afterEach(() => resetFetchFn());

  describe('sendRPCResponse — happy path', () => {
    it('builds, signs, seals, and forwards response', async () => {
      let capturedURL = '';
      let capturedHeaders: Record<string, string> = {};
      setFetchFn(async (url: any, opts: any) => {
        capturedURL = String(url);
        capturedHeaders = opts.headers;
        return {
          ok: true,
          json: async () => ({ status: 'delivered', msg_id: 'r-001' }),
        } as Response;
      });

      const result = await sendRPCResponse({
        requestId: 'req-abc',
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: '{"items":[]}',
        coreDID,
        corePrivateKey: corePriv,
        senderDID,
        senderEd25519Pub: senderPub,
        msgboxURL: 'https://mailbox.dinakernel.com',
      });

      expect(result.sent).toBe(true);
      expect(result.forwardResult!.status).toBe('delivered');
      expect(capturedURL).toContain('/forward');
      expect(capturedHeaders['X-Sender-DID']).toBe(coreDID);
      expect(capturedHeaders['X-Recipient-DID']).toBe(senderDID);
      expect(capturedHeaders['X-Signature']).toMatch(/^[0-9a-f]{128}$/);
    });

    it('audit logs successful send', async () => {
      setFetchFn(
        async () =>
          ({
            ok: true,
            json: async () => ({ status: 'delivered', msg_id: 'x' }),
          }) as Response,
      );

      await sendRPCResponse({
        requestId: 'req-001',
        status: 200,
        headers: {},
        body: '{}',
        coreDID,
        corePrivateKey: corePriv,
        senderDID,
        senderEd25519Pub: senderPub,
        msgboxURL: 'https://mb.com',
      });

      expect(queryAudit({ action: 'rpc_response_sent' }).length).toBeGreaterThan(0);
    });
  });

  describe('sendRPCResponse — failure', () => {
    it('network failure → sent false + error', async () => {
      setFetchFn(async () => {
        throw new Error('ECONNREFUSED');
      });

      const result = await sendRPCResponse({
        requestId: 'req-fail',
        status: 200,
        headers: {},
        body: '{}',
        coreDID,
        corePrivateKey: corePriv,
        senderDID,
        senderEd25519Pub: senderPub,
        msgboxURL: 'https://unreachable.com',
      });

      expect(result.sent).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('failure is audit-logged', async () => {
      setFetchFn(async () => {
        throw new Error('timeout');
      });

      await sendRPCResponse({
        requestId: 'req-timeout',
        status: 200,
        headers: {},
        body: '{}',
        coreDID,
        corePrivateKey: corePriv,
        senderDID,
        senderEd25519Pub: senderPub,
        msgboxURL: 'https://slow.com',
      });

      expect(queryAudit({ action: 'rpc_response_failed' }).length).toBeGreaterThan(0);
    });
  });

  describe('response includes all 6 forward headers', () => {
    it('all MsgBox required headers present', async () => {
      let headers: Record<string, string> = {};
      setFetchFn(async (_url: any, opts: any) => {
        headers = opts.headers;
        return { ok: true, json: async () => ({ status: 'delivered', msg_id: 'x' }) } as Response;
      });

      await sendRPCResponse({
        requestId: 'req-headers',
        status: 200,
        headers: {},
        body: '{}',
        coreDID,
        corePrivateKey: corePriv,
        senderDID,
        senderEd25519Pub: senderPub,
        msgboxURL: 'https://mb.com',
      });

      expect(headers['X-Sender-DID']).toBe(coreDID);
      expect(headers['X-Recipient-DID']).toBe(senderDID);
      expect(headers['X-Timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(headers['X-Nonce']).toMatch(/^[0-9a-f]{32}$/);
      expect(headers['X-Signature']).toMatch(/^[0-9a-f]{128}$/);
      expect(headers['X-Sender-Pub']).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('buffered response', () => {
    it('returns buffered status when recipient offline', async () => {
      setFetchFn(
        async () =>
          ({
            ok: true,
            json: async () => ({ status: 'buffered', msg_id: 'buf-1' }),
          }) as Response,
      );

      const result = await sendRPCResponse({
        requestId: 'req-buf',
        status: 200,
        headers: {},
        body: '{}',
        coreDID,
        corePrivateKey: corePriv,
        senderDID,
        senderEd25519Pub: senderPub,
        msgboxURL: 'https://mb.com',
      });

      expect(result.sent).toBe(true);
      expect(result.forwardResult!.status).toBe('buffered');
    });
  });
});
