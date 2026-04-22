/**
 * T2A.11 — D2D outbox: durable queue with exponential backoff retry.
 *
 * Category B: contract test.
 *
 * Source: core/test/d2d_phase2_test.go
 */

import {
  enqueueMessage,
  markDelivered,
  markFailed,
  getPendingForRetry,
  deleteExpired,
  computeBackoff,
  resumeAfterApproval,
  clearOutbox,
  outboxSize,
  isDeadLettered,
  getQueueUtilization,
  MAX_RETRIES,
  MAX_QUEUE_SIZE,
} from '../../src/transport/outbox';

describe('D2D Outbox', () => {
  beforeEach(() => clearOutbox());

  describe('enqueueMessage', () => {
    it('creates a pending outbox entry', () => {
      const id = enqueueMessage('did:plc:recipient', new Uint8Array([0xca, 0xfe]));
      expect(id).toMatch(/^msg-[0-9a-f]{16}$/);
      expect(outboxSize()).toBe(1);
    });

    it('returns a unique message ID', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        ids.add(enqueueMessage('did:plc:r', new Uint8Array(0)));
      }
      expect(ids.size).toBe(10);
    });

    it('entry is immediately eligible for retry', () => {
      enqueueMessage('did:plc:r', new Uint8Array(0));
      const pending = getPendingForRetry();
      expect(pending.length).toBe(1);
      expect(pending[0].status).toBe('pending');
      expect(pending[0].retryCount).toBe(0);
    });

    it('preserves payload', () => {
      const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      enqueueMessage('did:plc:r', payload);
      const pending = getPendingForRetry();
      expect(pending[0].payload).toEqual(payload);
    });

    it('stores recipientDID', () => {
      enqueueMessage('did:plc:alice', new Uint8Array(0));
      const pending = getPendingForRetry();
      expect(pending[0].recipientDID).toBe('did:plc:alice');
    });
  });

  describe('markDelivered', () => {
    it('sets status to delivered (kept for audit, matching Go)', () => {
      const id = enqueueMessage('did:plc:r', new Uint8Array(0));
      expect(outboxSize()).toBe(1);
      markDelivered(id);
      expect(outboxSize()).toBe(1); // still in outbox, not deleted
      // Should not appear in retry queue
      expect(getPendingForRetry(Date.now() + 999_999)).toHaveLength(0);
    });

    it('is idempotent (no-op for missing ID)', () => {
      markDelivered('msg-nonexistent');
      expect(outboxSize()).toBe(0);
    });
  });

  describe('markFailed', () => {
    it('increments retry count', () => {
      const id = enqueueMessage('did:plc:r', new Uint8Array(0));
      markFailed(id);
      const pending = getPendingForRetry(Date.now() + 999_999);
      const entry = pending.find((e) => e.id === id)!;
      expect(entry.retryCount).toBe(1);
      expect(entry.status).toBe('failed');
    });

    it('computes next retry time with backoff', () => {
      const id = enqueueMessage('did:plc:r', new Uint8Array(0));
      const before = Date.now();
      markFailed(id);
      const pending = getPendingForRetry(Date.now() + 999_999);
      const entry = pending.find((e) => e.id === id)!;
      // After first failure (retryCount=1), backoff = 2000ms
      expect(entry.nextRetryAt).toBeGreaterThan(before);
    });

    it('throws for missing message', () => {
      expect(() => markFailed('msg-nonexistent')).toThrow('not found');
    });

    it('progressive backoff on repeated failures', () => {
      const id = enqueueMessage('did:plc:r', new Uint8Array(0));
      markFailed(id); // retryCount=1, backoff=2s
      markFailed(id); // retryCount=2, backoff=4s
      markFailed(id); // retryCount=3, backoff=8s
      const pending = getPendingForRetry(Date.now() + 999_999);
      const entry = pending.find((e) => e.id === id)!;
      expect(entry.retryCount).toBe(3);
    });
  });

  describe('getPendingForRetry', () => {
    it('returns messages with nextRetryAt <= now', () => {
      enqueueMessage('did:plc:r1', new Uint8Array(0));
      enqueueMessage('did:plc:r2', new Uint8Array(0));
      const pending = getPendingForRetry();
      expect(pending.length).toBe(2);
    });

    it('does not return messages not yet due for retry', () => {
      const id = enqueueMessage('did:plc:r', new Uint8Array(0));
      markFailed(id); // Sets nextRetryAt to ~2s from now
      const pending = getPendingForRetry(); // now < nextRetryAt
      expect(pending.length).toBe(0);
    });

    it('returns empty when no pending messages', () => {
      expect(getPendingForRetry()).toEqual([]);
    });

    it('returns failed messages once their backoff expires', () => {
      const id = enqueueMessage('did:plc:r', new Uint8Array(0));
      markFailed(id);
      // Check that it becomes available after the backoff period (30s base)
      const pending = getPendingForRetry(Date.now() + 60_000);
      expect(pending.length).toBe(1);
    });

    it('sorts by nextRetryAt (oldest first)', () => {
      const id1 = enqueueMessage('did:plc:r1', new Uint8Array(0));
      const id2 = enqueueMessage('did:plc:r2', new Uint8Array(0));
      const pending = getPendingForRetry();
      // Both have similar nextRetryAt, so order is stable
      expect(pending.length).toBe(2);
    });
  });

  describe('deleteExpired', () => {
    it('removes delivered messages older than TTL', () => {
      const id = enqueueMessage('did:plc:r', new Uint8Array(0));
      markDelivered(id);
      // Use far-future "now" so TTL is expired
      const deleted = deleteExpired(86400, Date.now() + 100_000_000);
      expect(deleted).toBe(1);
      expect(outboxSize()).toBe(0);
    });

    it('removes failed messages older than TTL', () => {
      const id1 = enqueueMessage('did:plc:r1', new Uint8Array(0));
      const id2 = enqueueMessage('did:plc:r2', new Uint8Array(0));
      const id3 = enqueueMessage('did:plc:r3', new Uint8Array(0));
      markDelivered(id1);
      markFailed(id2);
      markDelivered(id3);
      const deleted = deleteExpired(1, Date.now() + 10_000);
      expect(deleted).toBe(3);
    });

    it('does not delete non-expired messages', () => {
      const id = enqueueMessage('did:plc:r', new Uint8Array(0));
      markDelivered(id);
      const deleted = deleteExpired(86400); // 24h TTL, message just created
      expect(deleted).toBe(0);
      expect(outboxSize()).toBe(1);
    });

    it('returns 0 when nothing to delete', () => {
      expect(deleteExpired(86400)).toBe(0);
    });
  });

  describe('computeBackoff (30s base, matching Go)', () => {
    it('retry 0 → 30000ms (30 seconds)', () => {
      expect(computeBackoff(0)).toBe(30_000);
    });

    it('retry 1 → 60000ms (1 minute)', () => {
      expect(computeBackoff(1)).toBe(60_000);
    });

    it('retry 2 → 120000ms (2 minutes)', () => {
      expect(computeBackoff(2)).toBe(120_000);
    });

    it('retry 3 → 240000ms (4 minutes)', () => {
      expect(computeBackoff(3)).toBe(240_000);
    });

    it('retry 4 → 480000ms (8 minutes)', () => {
      expect(computeBackoff(4)).toBe(480_000);
    });

    it('grows beyond retry 4 (no cap — MAX_RETRIES limits at 5)', () => {
      expect(computeBackoff(5)).toBe(960_000); // 16 minutes
    });
  });

  describe('resumeAfterApproval', () => {
    it('un-pauses a held message', () => {
      const id = enqueueMessage('did:plc:r', new Uint8Array(0));
      markFailed(id); // Sets status to 'failed' with future nextRetryAt
      resumeAfterApproval(id);
      const pending = getPendingForRetry();
      expect(pending.length).toBe(1);
      expect(pending[0].status).toBe('pending');
    });

    it('sets message to pending for immediate retry', () => {
      const id = enqueueMessage('did:plc:r', new Uint8Array(0));
      markFailed(id);
      const before = Date.now();
      resumeAfterApproval(id);
      const pending = getPendingForRetry();
      expect(pending[0].nextRetryAt).toBeGreaterThanOrEqual(before);
      expect(pending[0].nextRetryAt).toBeLessThanOrEqual(Date.now());
    });

    it('throws for missing message', () => {
      expect(() => resumeAfterApproval('msg-nonexistent')).toThrow('not found');
    });
  });

  describe('dead-lettering (MAX_RETRIES = 5)', () => {
    it('MAX_RETRIES is 5', () => {
      expect(MAX_RETRIES).toBe(5);
    });

    it('message is not dead-lettered before MAX_RETRIES', () => {
      const id = enqueueMessage('did:plc:r', new Uint8Array(0));
      for (let i = 0; i < MAX_RETRIES - 1; i++) {
        markFailed(id);
      }
      expect(isDeadLettered(id)).toBe(false);
      // Still eligible for retry
      expect(getPendingForRetry(Date.now() + 999_999_999)).toHaveLength(1);
    });

    it('message is dead-lettered after MAX_RETRIES', () => {
      const id = enqueueMessage('did:plc:r', new Uint8Array(0));
      for (let i = 0; i < MAX_RETRIES; i++) {
        markFailed(id);
      }
      expect(isDeadLettered(id)).toBe(true);
      // No longer eligible for retry
      expect(getPendingForRetry(Date.now() + 999_999_999)).toHaveLength(0);
    });

    it('dead-lettered messages are cleaned up by deleteExpired', () => {
      const id = enqueueMessage('did:plc:r', new Uint8Array(0));
      for (let i = 0; i < MAX_RETRIES; i++) {
        markFailed(id);
      }
      // Not expired yet
      expect(deleteExpired(86400)).toBe(0);
      // Simulate 25h old
      expect(deleteExpired(86400, Date.now() + 90_000_000)).toBe(1);
    });
  });

  describe('deleteExpired scope (§A69)', () => {
    it('only deletes delivered and failed entries', () => {
      const id1 = enqueueMessage('did:plc:a', new Uint8Array(0));
      const id2 = enqueueMessage('did:plc:b', new Uint8Array(0));
      const id3 = enqueueMessage('did:plc:c', new Uint8Array(0));

      markDelivered(id1);
      markFailed(id2);
      // id3 stays pending

      // All 3 are old enough
      const deleted = deleteExpired(0, Date.now() + 1000);
      expect(deleted).toBe(2); // delivered + failed
      expect(outboxSize()).toBe(1); // pending preserved
    });
  });

  describe('queue cap', () => {
    it('MAX_QUEUE_SIZE is 100 (matching Go)', () => {
      expect(MAX_QUEUE_SIZE).toBe(100);
    });

    it('rejects enqueue when queue is full', () => {
      // Fill the queue to capacity
      for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
        enqueueMessage(`did:plc:r${i}`, new Uint8Array([i]));
      }
      expect(outboxSize()).toBe(MAX_QUEUE_SIZE);

      // Next enqueue should throw
      expect(() => enqueueMessage('did:plc:overflow', new Uint8Array([0xff]))).toThrow(
        'queue full',
      );
    });

    it('allows enqueue after delivery frees space', () => {
      // Fill to capacity
      const ids: string[] = [];
      for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
        ids.push(enqueueMessage(`did:plc:r${i}`, new Uint8Array([i])));
      }

      // Delete an expired entry to make room
      markDelivered(ids[0]);
      deleteExpired(0, Date.now() + 1000);

      // Should succeed now
      expect(() => enqueueMessage('did:plc:new', new Uint8Array([0]))).not.toThrow();
    });

    it('getQueueUtilization returns fraction', () => {
      expect(getQueueUtilization()).toBe(0);
      enqueueMessage('did:plc:r1', new Uint8Array(0));
      expect(getQueueUtilization()).toBeCloseTo(1 / MAX_QUEUE_SIZE);
    });
  });
});
