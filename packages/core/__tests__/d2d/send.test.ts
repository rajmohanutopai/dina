/**
 * T6.3–6.7 — D2D send pipeline: build → gate → sign → seal → deliver → audit.
 *
 * Source: ARCHITECTURE.md Tasks 6.3–6.7
 */

import { TEST_ED25519_SEED } from '@dina/test-harness';

import { resetAuditState, queryAudit } from '../../src/audit/service';
import { getPublicKey } from '../../src/crypto/ed25519';
import { addContact, clearGatesState } from '../../src/d2d/gates';
import { sendD2D } from '../../src/d2d/send';
import { setDeliveryFetchFn, resetDeliveryDeps } from '../../src/transport/delivery';
import { clearOutbox, outboxCount } from '../../src/transport/outbox';
import {
  InMemoryD2DOutboxRepository,
  setD2DOutboxRepository,
  type D2DOutboxInsert,
  type D2DOutboxRepository,
  type D2DOutboxRow,
} from '../../src/transport/outbox_repository';

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
      expect(outboxCount()).toBe(0);
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
      expect(outboxCount()).toBe(1);
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

  // issues.txt §1 — durability guarantees on the failure path.
  describe('durable outbox on failure', () => {
    beforeEach(() => {
      addContact(recipientDID);
      setDeliveryFetchFn(async () => {
        throw new Error('ECONNREFUSED');
      });
    });
    afterEach(() => setD2DOutboxRepository(null));

    it('routes the queued message through the INSTALLED durable repo (not just memory)', async () => {
      const repo = new InMemoryD2DOutboxRepository();
      setD2DOutboxRepository(repo);
      const result = await sendD2D(baseReq);
      expect(result.queued).toBe(true);
      // The row landed in the installed repo with the SEMANTIC body, not
      // sealed bytes — so a later drainer can re-resolve + re-seal.
      const rows = repo.listAll();
      expect(rows).toHaveLength(1);
      expect(rows[0].targetDID).toBe(recipientDID);
      expect(rows[0].bodyJson).toBe(baseReq.body);
      expect(rows[0].state).toBe('pending');
    });

    it('NEVER reports queued:true when the durable write fails', async () => {
      // A repo whose insert throws models a full disk / SQL error.
      const failing: D2DOutboxRepository = new InMemoryD2DOutboxRepository();
      failing.insert = (_row: D2DOutboxInsert): D2DOutboxRow => {
        throw new Error('disk full');
      };
      setD2DOutboxRepository(failing);
      const result = await sendD2D(baseReq);
      expect(result.queued).toBe(false);
      expect(result.error).toContain('queue_failed');
      // And the failure-to-queue is audited so the loss is visible.
      const queuedAudits = queryAudit({ action: 'd2d_send_queued' });
      expect(queuedAudits.some((a) => a.detail?.includes('queued=false'))).toBe(true);
    });

    it('service.query uses the same durable outbox path on failure', async () => {
      const repo = new InMemoryD2DOutboxRepository();
      setD2DOutboxRepository(repo);
      // No providerServiceResolver → the normal contact gate applies, and
      // the contact is allow-listed above, so the send reaches delivery
      // (which throws) and falls into the durable queue path.
      const result = await sendD2D({
        ...baseReq,
        messageType: 'service.query',
        body: '{"query_id":"q-1","capability":"eta_query","ttl_seconds":60}',
      });
      expect(result.queued).toBe(true);
      const rows = repo.listAll();
      expect(rows).toHaveLength(1);
      expect(rows[0].messageType).toBe('service.query');
      // Keyed on type:targetDID:query_id:bodyHash (P1.4) — targetDID + body
      // hash so fan-out / different bodies don't collapse on a shared query_id.
      expect(rows[0].idempotencyKey).toMatch(/^service\.query:did:plc:recipient:q-1:[0-9a-f]{16}$/);
    });
  });
});
