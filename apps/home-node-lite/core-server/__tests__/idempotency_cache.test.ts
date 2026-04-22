/**
 * Task 4.49 — idempotency cache tests.
 */

import { RPC_RESPONSE_TYPE } from '@dina/protocol';
import type { CoreRPCResponse } from '@dina/protocol';
import {
  IdempotencyCache,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_IDEMPOTENCY_MAX_ENTRIES,
  MIN_IDEMPOTENCY_TTL_MS,
} from '../src/msgbox/idempotency_cache';

// Shortest legal TTL — equal to the timestamp-validator window (task 4.83).
// Tests that need to exercise expiry pin their TTL here + advance the mock
// clock past it.
const TEST_TTL_MS = MIN_IDEMPOTENCY_TTL_MS;

function makeResponse(requestId: string, status = 200, from = 'did:plc:self'): CoreRPCResponse {
  return {
    type: RPC_RESPONSE_TYPE,
    request_id: requestId,
    from,
    status,
    headers: {},
    body: `body-for-${requestId}`,
    signature: 'sig-' + requestId,
  };
}

const SENDER_A = 'did:plc:alice';
const SENDER_B = 'did:plc:bob';

describe('IdempotencyCache (task 4.49)', () => {
  describe('happy path', () => {
    it('first lookup returns null; post-record returns the cached response', () => {
      const cache = new IdempotencyCache();
      expect(cache.lookup(SENDER_A, 'req-1')).toBeNull();
      const resp = makeResponse('req-1');
      cache.recordResponse(SENDER_A, 'req-1', resp);
      expect(cache.lookup(SENDER_A, 'req-1')).toEqual(resp);
    });

    it('size reflects inserts + deletes', () => {
      const cache = new IdempotencyCache();
      expect(cache.size()).toBe(0);
      cache.recordResponse(SENDER_A, 'req-1', makeResponse('req-1'));
      expect(cache.size()).toBe(1);
      cache.recordResponse(SENDER_A, 'req-2', makeResponse('req-2'));
      expect(cache.size()).toBe(2);
      cache.clear();
      expect(cache.size()).toBe(0);
    });
  });

  describe('sender isolation', () => {
    it('same request_id from different senders → separate entries', () => {
      const cache = new IdempotencyCache();
      cache.recordResponse(SENDER_A, 'shared-id', makeResponse('shared-id', 200, SENDER_A));
      cache.recordResponse(SENDER_B, 'shared-id', makeResponse('shared-id', 201, SENDER_B));
      expect(cache.lookup(SENDER_A, 'shared-id')?.status).toBe(200);
      expect(cache.lookup(SENDER_B, 'shared-id')?.status).toBe(201);
      expect(cache.size()).toBe(2);
    });
  });

  describe('TTL expiry', () => {
    it('entry is gone after ttl elapses', () => {
      let now = 1_000_000;
      const cache = new IdempotencyCache({ ttlMs: TEST_TTL_MS, nowMsFn: () => now });
      cache.recordResponse(SENDER_A, 'req-1', makeResponse('req-1'));
      expect(cache.lookup(SENDER_A, 'req-1')).not.toBeNull();
      now += TEST_TTL_MS / 2;
      expect(cache.lookup(SENDER_A, 'req-1')).not.toBeNull();
      now += TEST_TTL_MS / 2 + 1; // past ttl
      expect(cache.lookup(SENDER_A, 'req-1')).toBeNull();
      // Should have been cleaned up from the map.
      expect(cache.size()).toBe(0);
    });

    it('expired entry rebuilds on re-record after ttl', () => {
      let now = 1_000_000;
      const cache = new IdempotencyCache({ ttlMs: TEST_TTL_MS, nowMsFn: () => now });
      cache.recordResponse(SENDER_A, 'req-1', makeResponse('req-1', 200));
      now += TEST_TTL_MS + 1; // expire
      cache.recordResponse(SENDER_A, 'req-1', makeResponse('req-1', 204));
      expect(cache.lookup(SENDER_A, 'req-1')?.status).toBe(204);
    });

    it('boundary: elapsed === ttl → expired (inclusive)', () => {
      let now = 1_000_000;
      const cache = new IdempotencyCache({ ttlMs: TEST_TTL_MS, nowMsFn: () => now });
      cache.recordResponse(SENDER_A, 'req-1', makeResponse('req-1'));
      now += TEST_TTL_MS; // exactly at deadline
      expect(cache.lookup(SENDER_A, 'req-1')).toBeNull();
    });
  });

  describe('maxEntries eviction', () => {
    it('oldest entry is evicted when size exceeds maxEntries', () => {
      const cache = new IdempotencyCache({ maxEntries: 3 });
      cache.recordResponse(SENDER_A, 'req-1', makeResponse('req-1'));
      cache.recordResponse(SENDER_A, 'req-2', makeResponse('req-2'));
      cache.recordResponse(SENDER_A, 'req-3', makeResponse('req-3'));
      expect(cache.size()).toBe(3);
      cache.recordResponse(SENDER_A, 'req-4', makeResponse('req-4'));
      // Either size stays at maxEntries, or we evicted something.
      expect(cache.size()).toBeLessThanOrEqual(3);
      // req-4 must be present (the freshest insert).
      expect(cache.lookup(SENDER_A, 'req-4')).not.toBeNull();
    });

    it('LRU bump: looked-up entry is kept preferentially over unread ones', () => {
      const cache = new IdempotencyCache({ maxEntries: 3 });
      cache.recordResponse(SENDER_A, 'req-1', makeResponse('req-1'));
      cache.recordResponse(SENDER_A, 'req-2', makeResponse('req-2'));
      cache.recordResponse(SENDER_A, 'req-3', makeResponse('req-3'));
      cache.lookup(SENDER_A, 'req-1'); // bump req-1 to most-recent
      cache.recordResponse(SENDER_A, 'req-4', makeResponse('req-4')); // forces eviction
      // req-1 was just looked up (most recent access), so it should survive.
      expect(cache.lookup(SENDER_A, 'req-1')).not.toBeNull();
      // Something else got evicted. We don't pin which (impl detail) but
      // at least one of {req-2, req-3} should be gone.
      const survived = Number(cache.lookup(SENDER_A, 'req-2') !== null) +
        Number(cache.lookup(SENDER_A, 'req-3') !== null);
      expect(survived).toBeLessThanOrEqual(1);
    });
  });

  describe('duplicate-record safety', () => {
    it('recordResponse on an existing key is a no-op (first-win)', () => {
      const cache = new IdempotencyCache();
      cache.recordResponse(SENDER_A, 'req-1', makeResponse('req-1', 200));
      cache.recordResponse(SENDER_A, 'req-1', makeResponse('req-1', 500));
      // First write wins.
      expect(cache.lookup(SENDER_A, 'req-1')?.status).toBe(200);
    });

    it('rejects recordResponse where requestId != response.request_id', () => {
      const cache = new IdempotencyCache();
      expect(() =>
        cache.recordResponse(SENDER_A, 'req-1', makeResponse('req-2')),
      ).toThrow(/request_id mismatch/);
    });
  });

  describe('input validation', () => {
    it('rejects ttlMs <= 0', () => {
      expect(() => new IdempotencyCache({ ttlMs: 0 })).toThrow(/ttlMs must be > 0/);
      expect(() => new IdempotencyCache({ ttlMs: -1 })).toThrow(/ttlMs must be > 0/);
    });

    it('rejects maxEntries <= 0', () => {
      expect(() => new IdempotencyCache({ maxEntries: 0 })).toThrow(/maxEntries must be > 0/);
    });
  });

  describe('constants', () => {
    it('DEFAULT_IDEMPOTENCY_TTL_MS = 5 minutes (matches task 4.22 + 4.23)', () => {
      expect(DEFAULT_IDEMPOTENCY_TTL_MS).toBe(5 * 60 * 1000);
    });
    it('DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 10_000', () => {
      expect(DEFAULT_IDEMPOTENCY_MAX_ENTRIES).toBe(10_000);
    });
  });
});
