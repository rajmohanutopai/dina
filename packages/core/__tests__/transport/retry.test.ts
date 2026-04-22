/**
 * T6.14 — Outbox retry orchestrator: background retry of failed deliveries.
 *
 * Source: ARCHITECTURE.md Task 6.14
 */

import {
  retryPendingOutbox,
  getRetryStatus,
  setRetryDeliveryFn,
  resetRetryState,
} from '../../src/transport/retry';
import {
  enqueueMessage,
  markFailed,
  markDelivered,
  clearOutbox,
  outboxSize,
  getPendingForRetry,
} from '../../src/transport/outbox';

describe('Outbox Retry Orchestrator', () => {
  beforeEach(() => {
    clearOutbox();
    resetRetryState();
  });

  describe('retryPendingOutbox', () => {
    it('delivers pending messages', async () => {
      enqueueMessage('did:plc:alice', new Uint8Array([0xca, 0xfe]));
      setRetryDeliveryFn(async () => true);
      const result = await retryPendingOutbox();
      expect(result.attempted).toBe(1);
      expect(result.delivered).toBe(1);
      expect(result.failed).toBe(0);
      expect(outboxSize()).toBe(1); // delivered → kept for audit (matching Go)
    });

    it('marks failed on delivery failure', async () => {
      enqueueMessage('did:plc:alice', new Uint8Array(0));
      setRetryDeliveryFn(async () => false);
      const result = await retryPendingOutbox();
      expect(result.failed).toBe(1);
      expect(outboxSize()).toBe(1); // still in outbox
    });

    it('marks failed on delivery throw', async () => {
      enqueueMessage('did:plc:alice', new Uint8Array(0));
      setRetryDeliveryFn(async () => {
        throw new Error('network error');
      });
      const result = await retryPendingOutbox();
      expect(result.failed).toBe(1);
    });

    it('retries multiple messages independently', async () => {
      enqueueMessage('did:plc:alice', new Uint8Array([1]));
      enqueueMessage('did:plc:bob', new Uint8Array([2]));
      let callCount = 0;
      setRetryDeliveryFn(async () => {
        callCount++;
        return callCount === 1; // first succeeds, second fails
      });
      const result = await retryPendingOutbox();
      expect(result.attempted).toBe(2);
      expect(result.delivered).toBe(1);
      expect(result.failed).toBe(1);
    });

    it('returns zero counts when outbox is empty', async () => {
      const result = await retryPendingOutbox();
      expect(result.attempted).toBe(0);
      expect(result.delivered).toBe(0);
    });

    it('sweeps expired delivered/failed messages', async () => {
      const id = enqueueMessage('did:plc:old', new Uint8Array(0));
      markDelivered(id); // must be delivered/failed for deleteExpired
      // Expire: now + 25 hours (outbox TTL is 24h)
      const farFuture = Date.now() + 25 * 60 * 60 * 1000;
      const result = await retryPendingOutbox(farFuture);
      expect(result.expired).toBe(1);
    });

    it('does not retry messages still in backoff window', async () => {
      const id = enqueueMessage('did:plc:alice', new Uint8Array(0));
      // Fail it → sets nextRetryAt to future
      markFailed(id);
      setRetryDeliveryFn(async () => true);
      const result = await retryPendingOutbox();
      // Message is in backoff, so not attempted
      expect(result.attempted).toBe(0);
    });
  });

  describe('getRetryStatus', () => {
    it('returns pending count', () => {
      enqueueMessage('did:plc:a', new Uint8Array(0));
      enqueueMessage('did:plc:b', new Uint8Array(0));
      expect(getRetryStatus().pending).toBe(2);
    });

    it('returns 0 when empty', () => {
      expect(getRetryStatus().pending).toBe(0);
    });
  });
});
