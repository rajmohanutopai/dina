/**
 * RPC idempotency cache — dedup by (from_did, request_id).
 *
 * Source: Gap Analysis A21 #4
 */

import {
  getCachedResponse,
  cacheResponse,
  isDuplicateRequest,
  purgeExpired,
  cacheSize,
  resetIdempotencyCache,
  IDEMPOTENCY_TTL_MS,
  IDEMPOTENCY_MAX_ENTRIES,
} from '../../src/relay/idempotency';

describe('RPC Idempotency Cache', () => {
  beforeEach(() => resetIdempotencyCache());

  describe('cacheResponse + getCachedResponse', () => {
    it('stores and retrieves a response', () => {
      cacheResponse('did:key:z6MkAlice', 'rpc-001', 200, '{"ok":true}');
      const cached = getCachedResponse('did:key:z6MkAlice', 'rpc-001');
      expect(cached).not.toBeNull();
      expect(cached!.status).toBe(200);
      expect(cached!.body).toBe('{"ok":true}');
      expect(cached!.requestId).toBe('rpc-001');
      expect(cached!.fromDID).toBe('did:key:z6MkAlice');
    });

    it('returns null for unknown request', () => {
      expect(getCachedResponse('did:key:z6MkAlice', 'rpc-unknown')).toBeNull();
    });

    it('distinguishes different DIDs with same request_id', () => {
      cacheResponse('did:key:z6MkAlice', 'rpc-001', 200, 'alice-result');
      cacheResponse('did:key:z6MkBob', 'rpc-001', 200, 'bob-result');

      expect(getCachedResponse('did:key:z6MkAlice', 'rpc-001')!.body).toBe('alice-result');
      expect(getCachedResponse('did:key:z6MkBob', 'rpc-001')!.body).toBe('bob-result');
    });

    it('distinguishes different request_ids from same DID', () => {
      cacheResponse('did:key:z6MkAlice', 'rpc-001', 200, 'first');
      cacheResponse('did:key:z6MkAlice', 'rpc-002', 201, 'second');

      expect(getCachedResponse('did:key:z6MkAlice', 'rpc-001')!.body).toBe('first');
      expect(getCachedResponse('did:key:z6MkAlice', 'rpc-002')!.body).toBe('second');
    });
  });

  describe('TTL expiry', () => {
    it('returns null for expired entries', () => {
      const past = Date.now() - IDEMPOTENCY_TTL_MS - 1000;
      cacheResponse('did:key:z6MkAlice', 'rpc-old', 200, 'old', past);

      // Lookup at "now" should find it expired
      expect(getCachedResponse('did:key:z6MkAlice', 'rpc-old')).toBeNull();
    });

    it('returns entry within TTL window', () => {
      const recent = Date.now() - 1000; // 1 second ago
      cacheResponse('did:key:z6MkAlice', 'rpc-fresh', 200, 'fresh', recent);
      expect(getCachedResponse('did:key:z6MkAlice', 'rpc-fresh')).not.toBeNull();
    });

    it('TTL is 5 minutes', () => {
      expect(IDEMPOTENCY_TTL_MS).toBe(5 * 60 * 1000);
    });
  });

  describe('isDuplicateRequest', () => {
    it('returns false for new request', () => {
      expect(isDuplicateRequest('did:key:z6MkAlice', 'rpc-new')).toBe(false);
    });

    it('returns true for cached request', () => {
      cacheResponse('did:key:z6MkAlice', 'rpc-001', 200, 'result');
      expect(isDuplicateRequest('did:key:z6MkAlice', 'rpc-001')).toBe(true);
    });

    it('returns false after TTL expires', () => {
      const past = Date.now() - IDEMPOTENCY_TTL_MS - 1000;
      cacheResponse('did:key:z6MkAlice', 'rpc-expired', 200, 'old', past);
      expect(isDuplicateRequest('did:key:z6MkAlice', 'rpc-expired')).toBe(false);
    });
  });

  describe('purgeExpired', () => {
    it('removes expired entries', () => {
      const past = Date.now() - IDEMPOTENCY_TTL_MS - 1000;
      cacheResponse('did:a', 'r1', 200, 'old', past);
      cacheResponse('did:b', 'r2', 200, 'fresh'); // current time

      expect(cacheSize()).toBe(2);
      const purged = purgeExpired();
      expect(purged).toBe(1);
      expect(cacheSize()).toBe(1);
    });

    it('returns 0 when nothing to purge', () => {
      cacheResponse('did:a', 'r1', 200, 'fresh');
      expect(purgeExpired()).toBe(0);
    });
  });

  describe('capacity management', () => {
    it('evicts oldest when at capacity', () => {
      // Fill to capacity
      for (let i = 0; i < IDEMPOTENCY_MAX_ENTRIES; i++) {
        cacheResponse('did:x', `rpc-${i}`, 200, `body-${i}`);
      }
      expect(cacheSize()).toBe(IDEMPOTENCY_MAX_ENTRIES);

      // Adding one more evicts the oldest
      cacheResponse('did:x', 'rpc-new', 200, 'new');
      expect(cacheSize()).toBe(IDEMPOTENCY_MAX_ENTRIES);

      // The new entry is present
      expect(getCachedResponse('did:x', 'rpc-new')).not.toBeNull();
    });

    it('MAX_ENTRIES is 10000', () => {
      expect(IDEMPOTENCY_MAX_ENTRIES).toBe(10_000);
    });
  });

  describe('cacheSize + reset', () => {
    it('starts at 0', () => {
      expect(cacheSize()).toBe(0);
    });

    it('grows with each cached response', () => {
      cacheResponse('did:a', 'r1', 200, '');
      cacheResponse('did:b', 'r2', 200, '');
      expect(cacheSize()).toBe(2);
    });

    it('reset clears all entries', () => {
      cacheResponse('did:a', 'r1', 200, '');
      resetIdempotencyCache();
      expect(cacheSize()).toBe(0);
    });
  });
});
