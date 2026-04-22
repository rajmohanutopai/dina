/**
 * T6.3–6.7 — D2D send pipeline: build → gate → sign → seal → deliver → audit.
 *
 * Source: ARCHITECTURE.md Tasks 6.3–6.7
 */

import { sendD2D } from '../../src/d2d/send';
import { addContact, clearGatesState } from '../../src/d2d/gates';
import { setDeliveryFetchFn, resetDeliveryDeps } from '../../src/transport/delivery';
import { clearOutbox, outboxSize } from '../../src/transport/outbox';
import { resetAuditState, queryAudit } from '../../src/audit/service';
import { getPublicKey } from '../../src/crypto/ed25519';
import { TEST_ED25519_SEED } from '@dina/test-harness';

const senderPriv = TEST_ED25519_SEED;
const senderDID = 'did:plc:sender';
const recipientDID = 'did:plc:recipient';
const recipientPub = getPublicKey(new Uint8Array(32).fill(0x42));

const baseReq = {
  recipientDID,
  messageType: 'social.update',
  body: '{"text":"Hello"}',
  senderDID,
  senderPrivateKey: senderPriv,
  recipientPublicKey: recipientPub,
  serviceType: 'DinaMsgBox' as const,
  endpoint: 'wss://mailbox.dinakernel.com',
};

describe('D2D Send Pipeline', () => {
  beforeEach(() => {
    clearGatesState();
    clearOutbox();
    resetAuditState();
    resetDeliveryDeps();
  });

  describe('gate checks', () => {
    it('unknown contact → denied at gate 1', async () => {
      const result = await sendD2D(baseReq);
      expect(result.sent).toBe(false);
      expect(result.deniedAt).toBe('contact');
    });

    it('denial is audit-logged', async () => {
      await sendD2D(baseReq);
      const audits = queryAudit({ action: 'd2d_send_denied' });
      expect(audits.length).toBeGreaterThan(0);
    });
  });

  describe('successful send', () => {
    beforeEach(() => {
      addContact(recipientDID);
      setDeliveryFetchFn(
        async () =>
          ({
            ok: true,
            json: async () => ({ status: 'delivered', msg_id: 'mx-1' }),
          }) as Response,
      );
    });

    it('delivers message to recipient', async () => {
      const result = await sendD2D(baseReq);
      expect(result.sent).toBe(true);
      expect(result.delivered).toBe(true);
      expect(result.messageId).toMatch(/^d2d-/);
    });

    it('audit logs the send', async () => {
      await sendD2D(baseReq);
      const audits = queryAudit({ action: 'd2d_send' });
      expect(audits.length).toBeGreaterThan(0);
    });

    it('does not queue in outbox on success', async () => {
      await sendD2D(baseReq);
      expect(outboxSize()).toBe(0);
    });
  });

  describe('buffered send (recipient offline)', () => {
    beforeEach(() => {
      addContact(recipientDID);
      setDeliveryFetchFn(
        async () =>
          ({
            ok: true,
            json: async () => ({ status: 'buffered', msg_id: 'mx-2' }),
          }) as Response,
      );
    });

    it('returns buffered:true', async () => {
      const result = await sendD2D(baseReq);
      expect(result.sent).toBe(true);
      expect(result.buffered).toBe(true);
      expect(result.delivered).toBe(false);
    });
  });

  describe('delivery failure → outbox', () => {
    beforeEach(() => {
      addContact(recipientDID);
      setDeliveryFetchFn(async () => {
        throw new Error('ECONNREFUSED');
      });
    });

    it('queues in outbox on network failure', async () => {
      const result = await sendD2D(baseReq);
      expect(result.sent).toBe(true);
      expect(result.delivered).toBe(false);
      expect(result.queued).toBe(true);
      expect(outboxSize()).toBe(1);
    });

    it('records error in result', async () => {
      const result = await sendD2D(baseReq);
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('audit logs the queued message', async () => {
      await sendD2D(baseReq);
      const audits = queryAudit({ action: 'd2d_send_queued' });
      expect(audits.length).toBeGreaterThan(0);
    });
  });

  describe('never throws', () => {
    it('returns result even on total failure', async () => {
      addContact(recipientDID);
      setDeliveryFetchFn(async () => {
        throw new Error('catastrophic');
      });
      const result = await sendD2D(baseReq);
      expect(result).toBeDefined();
      expect(typeof result.sent).toBe('boolean');
    });
  });

  describe('V1 type enforcement', () => {
    it('accepts valid V1 message types', async () => {
      addContact(recipientDID);
      setDeliveryFetchFn(async () => new Response(JSON.stringify({ status: 'delivered' })));

      for (const type of [
        'social.update',
        'safety.alert',
        'presence.signal',
        'coordination.request',
      ]) {
        const result = await sendD2D({ ...baseReq, messageType: type });
        expect(result.deniedAt).toBeUndefined();
      }
    });

    it('rejects non-V1 message types', async () => {
      addContact(recipientDID);
      const result = await sendD2D({ ...baseReq, messageType: 'dina/query' });
      expect(result.sent).toBe(false);
      expect(result.deniedAt).toBe('type_enforcement');
      expect(result.error).toContain('Unknown message type');
    });

    it('rejects arbitrary strings as message types', async () => {
      addContact(recipientDID);
      const result = await sendD2D({ ...baseReq, messageType: 'totally.made.up' });
      expect(result.sent).toBe(false);
      expect(result.deniedAt).toBe('type_enforcement');
    });

    it('V1 check runs before egress gates (no contact needed)', async () => {
      // Don't add contact — V1 check should reject before gate 1
      const result = await sendD2D({ ...baseReq, messageType: 'invalid.type' });
      expect(result.deniedAt).toBe('type_enforcement');
    });
  });
});
