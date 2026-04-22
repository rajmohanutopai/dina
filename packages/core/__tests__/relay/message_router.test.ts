/**
 * T2.21 — MsgBox incoming message handler: unseal → route by type.
 *
 * Source: ARCHITECTURE.md Task 2.21
 */

import {
  handleIncomingMessage,
  classifyMessageType,
  registerRPCHandler,
  registerD2DHandler,
  resetMessageRouter,
} from '../../src/relay/message_router';
import { sealEncrypt } from '../../src/crypto/nacl';
import { getPublicKey } from '../../src/crypto/ed25519';
import { resetAuditState, queryAudit } from '../../src/audit/service';
import { TEST_ED25519_SEED } from '@dina/test-harness';

const recipientPriv = TEST_ED25519_SEED;
const recipientPub = getPublicKey(recipientPriv);

/** Helper: seal a JSON object for the recipient. */
function sealJSON(obj: Record<string, unknown>): Uint8Array {
  return sealEncrypt(new TextEncoder().encode(JSON.stringify(obj)), recipientPub);
}

describe('MsgBox Incoming Message Handler', () => {
  beforeEach(() => {
    resetMessageRouter();
    resetAuditState();
  });

  describe('classifyMessageType', () => {
    it('core_rpc_request → core_rpc_request', () => {
      expect(classifyMessageType({ type: 'core_rpc_request', request_id: 'r1' })).toBe(
        'core_rpc_request',
      );
    });

    it('D2D payload (c + s fields) → d2d_payload', () => {
      expect(classifyMessageType({ c: 'base64data', s: 'hexsig' })).toBe('d2d_payload');
    });

    it('DinaMessage format (from/to/body) → d2d_payload', () => {
      expect(
        classifyMessageType({
          from: 'did:plc:sender',
          to: 'did:plc:recipient',
          body: '{}',
          created_time: 123,
        }),
      ).toBe('d2d_payload');
    });

    it('unknown type → unknown', () => {
      expect(classifyMessageType({ random: 'data' })).toBe('unknown');
    });

    it('empty object → unknown', () => {
      expect(classifyMessageType({})).toBe('unknown');
    });
  });

  describe('handleIncomingMessage', () => {
    it('routes core_rpc_request to RPC handler', async () => {
      let received: Record<string, unknown> | null = null;
      registerRPCHandler(async (req) => {
        received = req;
      });

      const sealed = sealJSON({ type: 'core_rpc_request', request_id: 'r1', from: 'did:plc:cli' });
      const result = await handleIncomingMessage(sealed, recipientPub, recipientPriv);

      expect(result.type).toBe('core_rpc_request');
      expect(result.routed).toBe(true);
      expect(received).not.toBeNull();
      expect(received!.request_id).toBe('r1');
    });

    it('routes D2D payload to D2D handler', async () => {
      let received: Record<string, unknown> | null = null;
      registerD2DHandler(async (payload) => {
        received = payload;
      });

      const sealed = sealJSON({ c: 'encrypted', s: 'signature' });
      const result = await handleIncomingMessage(sealed, recipientPub, recipientPriv);

      expect(result.type).toBe('d2d_payload');
      expect(result.routed).toBe(true);
    });

    it('rejects unknown message type', async () => {
      const sealed = sealJSON({ random: 'garbage' });
      const result = await handleIncomingMessage(sealed, recipientPub, recipientPriv);
      expect(result.type).toBe('unknown');
      expect(result.routed).toBe(false);
      expect(result.error).toContain('Unknown');
    });

    it('fails gracefully on unseal error (wrong key)', async () => {
      const wrongPub = getPublicKey(new Uint8Array(32).fill(0x99));
      const wrongPriv = new Uint8Array(32).fill(0x99);
      const sealed = sealJSON({ type: 'core_rpc_request' });
      const result = await handleIncomingMessage(sealed, wrongPub, wrongPriv);
      expect(result.routed).toBe(false);
      expect(result.error).toContain('Unseal failed');
    });

    it('fails gracefully on invalid JSON', async () => {
      const sealed = sealEncrypt(new TextEncoder().encode('not json'), recipientPub);
      const result = await handleIncomingMessage(sealed, recipientPub, recipientPriv);
      expect(result.routed).toBe(false);
      expect(result.error).toContain('Invalid JSON');
    });

    it('returns error when no handler registered', async () => {
      const sealed = sealJSON({ type: 'core_rpc_request' });
      const result = await handleIncomingMessage(sealed, recipientPub, recipientPriv);
      expect(result.routed).toBe(false);
      expect(result.error).toContain('No handler');
    });

    it('audit logs RPC route', async () => {
      registerRPCHandler(async () => {});
      const sealed = sealJSON({ type: 'core_rpc_request', from: 'did:plc:cli', request_id: 'r1' });
      await handleIncomingMessage(sealed, recipientPub, recipientPriv);
      expect(queryAudit({ action: 'route_rpc' }).length).toBeGreaterThan(0);
    });

    it('audit logs D2D route', async () => {
      registerD2DHandler(async () => {});
      const sealed = sealJSON({
        c: 'data',
        s: 'sig',
        from: 'did:plc:sender',
        type: 'social.update',
      });
      await handleIncomingMessage(sealed, recipientPub, recipientPriv);
      expect(queryAudit({ action: 'route_d2d' }).length).toBeGreaterThan(0);
    });

    it('handles handler errors gracefully', async () => {
      registerRPCHandler(async () => {
        throw new Error('handler crashed');
      });
      const sealed = sealJSON({ type: 'core_rpc_request' });
      const result = await handleIncomingMessage(sealed, recipientPub, recipientPriv);
      expect(result.routed).toBe(false);
      expect(result.error).toContain('Handler error');
    });
  });
});
