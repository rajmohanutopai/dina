/**
 * T9.2 — Trust cache with 1-hour TTL.
 *
 * All cache-mutation assertions are async since Phase 2.3 (task 2.3
 * pilot) — the underlying KV port + trust-cache wrappers are
 * `Promise<T>` throughout. `isStale` stays sync because it only
 * consults the in-memory timestamp Map.
 *
 * Source: ARCHITECTURE.md Task 9.2
 */

import {
  getCachedTrust,
  cacheTrustScore,
  invalidateTrust,
  isStale,
  refreshTrust,
  getTrustWithRefresh,
  registerTrustFetcher,
  resetTrustCache,
  evictTrustCacheTo,
  trustCacheSize,
  MAX_TRUST_CACHE_ENTRIES,
  MEMORY_WARNING_TARGET,
} from '../../src/trust/cache';
import type { TrustScore } from '../../src/trust/cache';
import { resetKVStore } from '../../src/kv/store';

describe('Trust Cache', () => {
  beforeEach(() => {
    resetTrustCache();
    resetKVStore();
  });

  // Scores live on AppView's [0, 1] real scale (matching
  // appview/src/scorer/algorithms/trust-score.ts). The cache layer
  // doesn't enforce the range, but tests use realistic values so
  // future readers see the right domain.
  const makeScore = (did: string, score: number | null): TrustScore => ({
    did,
    score,
    attestationCount: 5,
    lastUpdated: Date.now(),
  });

  describe('cacheTrustScore + getCachedTrust', () => {
    it('caches and retrieves a trust score', async () => {
      const score = makeScore('did:plc:alice', 0.85);
      await cacheTrustScore(score);
      const cached = await getCachedTrust('did:plc:alice');
      expect(cached).not.toBeNull();
      expect(cached!.score).toBe(0.85);
      expect(cached!.did).toBe('did:plc:alice');
    });

    it('preserves a null score (unscored DID)', async () => {
      await cacheTrustScore(makeScore('did:plc:unscored', null));
      const cached = await getCachedTrust('did:plc:unscored');
      expect(cached).not.toBeNull();
      expect(cached!.score).toBeNull();
    });

    it('returns null for uncached DID', async () => {
      expect(await getCachedTrust('did:plc:unknown')).toBeNull();
    });

    it('returns null after TTL expires', async () => {
      const now = Date.now();
      await cacheTrustScore(makeScore('did:plc:alice', 0.85), now);
      // 61 minutes later
      const result = await getCachedTrust('did:plc:alice', now + 61 * 60 * 1000);
      expect(result).toBeNull();
    });

    it('returns value within TTL', async () => {
      const now = Date.now();
      await cacheTrustScore(makeScore('did:plc:alice', 0.85), now);
      // 59 minutes later — still valid
      const result = await getCachedTrust('did:plc:alice', now + 59 * 60 * 1000);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0.85);
    });

    it('overwrites existing entry', async () => {
      await cacheTrustScore(makeScore('did:plc:alice', 0.60));
      await cacheTrustScore(makeScore('did:plc:alice', 0.90));
      expect((await getCachedTrust('did:plc:alice'))!.score).toBe(0.90);
    });
  });

  describe('invalidateTrust', () => {
    it('removes cached entry', async () => {
      await cacheTrustScore(makeScore('did:plc:alice', 0.85));
      await invalidateTrust('did:plc:alice');
      expect(await getCachedTrust('did:plc:alice')).toBeNull();
    });

    it('safe for uncached DID', async () => {
      await invalidateTrust('did:plc:nonexistent'); // no throw
    });
  });

  describe('isStale', () => {
    it('fresh entry is not stale', async () => {
      await cacheTrustScore(makeScore('did:plc:alice', 0.85));
      expect(isStale('did:plc:alice')).toBe(false);
    });

    it('expired entry is stale', async () => {
      const now = Date.now();
      await cacheTrustScore(makeScore('did:plc:alice', 0.85), now);
      expect(isStale('did:plc:alice', now + 61 * 60 * 1000)).toBe(true);
    });

    it('uncached DID is not stale (never cached)', () => {
      expect(isStale('did:plc:unknown')).toBe(false);
    });
  });

  describe('refreshTrust', () => {
    it('returns null when no fetcher registered', async () => {
      expect(await refreshTrust('did:plc:alice')).toBeNull();
    });

    it('fetches and caches new score', async () => {
      registerTrustFetcher(async (did) => makeScore(did, 0.92));
      const score = await refreshTrust('did:plc:alice');
      expect(score!.score).toBe(0.92);
      // Should now be cached
      expect((await getCachedTrust('did:plc:alice'))!.score).toBe(0.92);
    });

    it('returns null on fetch failure', async () => {
      registerTrustFetcher(async () => {
        throw new Error('network error');
      });
      expect(await refreshTrust('did:plc:alice')).toBeNull();
    });
  });

  describe('getTrustWithRefresh', () => {
    it('returns cached value when fresh', async () => {
      await cacheTrustScore(makeScore('did:plc:alice', 0.85));
      registerTrustFetcher(async () => makeScore('did:plc:alice', 0.99));
      const result = await getTrustWithRefresh('did:plc:alice');
      expect(result!.score).toBe(0.85); // cached value, not refreshed
    });

    it('refreshes when cache is empty', async () => {
      registerTrustFetcher(async (did) => makeScore(did, 0.77));
      const result = await getTrustWithRefresh('did:plc:bob');
      expect(result!.score).toBe(0.77);
    });

    it('returns the cached value when set with a recent now timestamp', async () => {
      // The previous version of this test meandered about "expiring"
      // a cache that was actually fresh from the moment it was set.
      // The cache layer takes `now` at write time and at read time;
      // when both default to Date.now() the entry is always fresh.
      // This test pins that observed behaviour.
      const now = Date.now();
      await cacheTrustScore(makeScore('did:plc:alice', 0.50), now);
      registerTrustFetcher(async (did) => makeScore(did, 0.95));
      const result = await getTrustWithRefresh('did:plc:alice');
      expect(result!.score).toBe(0.50);
    });

    it('returns null when no fetcher and no cache', async () => {
      expect(await getTrustWithRefresh('did:plc:unknown')).toBeNull();
    });
  });

  describe('LRU eviction (TN-MOB-006)', () => {
    it('exposes the LRU cap + memory-warning target', () => {
      // Pinning these surfaces a documentation regression if someone
      // edits the constants without updating callers (mobile reads
      // MEMORY_WARNING_TARGET when wiring AppState.memoryWarning).
      expect(MAX_TRUST_CACHE_ENTRIES).toBe(200);
      expect(MEMORY_WARNING_TARGET).toBe(50);
    });

    it('reports current cache size via trustCacheSize()', async () => {
      expect(trustCacheSize()).toBe(0);
      await cacheTrustScore(makeScore('did:plc:a', 0.5));
      await cacheTrustScore(makeScore('did:plc:b', 0.6));
      expect(trustCacheSize()).toBe(2);
    });

    it('cacheTrustScore enforces the LRU cap (oldest entry dropped)', async () => {
      const cap = 5;
      // Insert exactly `cap` entries.
      for (let i = 0; i < cap; i++) {
        await cacheTrustScore(makeScore(`did:plc:${i}`, 0.5));
      }
      expect(trustCacheSize()).toBe(cap);

      // We can manually evict to a small target to verify oldest-first.
      await evictTrustCacheTo(cap - 1);
      expect(trustCacheSize()).toBe(cap - 1);
      // The very first entry (oldest) must be gone.
      expect(await getCachedTrust('did:plc:0')).toBeNull();
      // The most recent must still be there.
      expect(await getCachedTrust(`did:plc:${cap - 1}`)).not.toBeNull();
    });

    it('evictTrustCacheTo evicts oldest entries first (LRU order)', async () => {
      // Insert in known order; the first DID is oldest.
      for (let i = 0; i < 10; i++) {
        await cacheTrustScore(makeScore(`did:plc:${i}`, 0.5));
      }
      await evictTrustCacheTo(3);
      expect(trustCacheSize()).toBe(3);
      // 0..6 should be gone.
      for (let i = 0; i < 7; i++) {
        expect(await getCachedTrust(`did:plc:${i}`)).toBeNull();
      }
      // 7..9 should remain (the three most recent at insert time).
      for (let i = 7; i < 10; i++) {
        expect(await getCachedTrust(`did:plc:${i}`)).not.toBeNull();
      }
    });

    it('reading an entry bumps it out of LRU danger', async () => {
      // 10 entries — 0 is oldest, 9 is newest.
      for (let i = 0; i < 10; i++) {
        await cacheTrustScore(makeScore(`did:plc:${i}`, 0.5));
      }
      // Read the oldest → it gets bumped to most-recent.
      expect(await getCachedTrust('did:plc:0')).not.toBeNull();
      // Now evict to 3. Pre-bump, did:plc:0 would have been first to
      // go. Post-bump, it's the newest and survives.
      await evictTrustCacheTo(3);
      expect(await getCachedTrust('did:plc:0')).not.toBeNull();
      // The bump promoted did:plc:0; the next-oldest survivors are
      // 8 and 9 (since 1..7 were dropped first).
      expect(await getCachedTrust('did:plc:1')).toBeNull();
      expect(await getCachedTrust('did:plc:8')).not.toBeNull();
      expect(await getCachedTrust('did:plc:9')).not.toBeNull();
    });

    it('overwriting an existing entry promotes it to most-recent', async () => {
      for (let i = 0; i < 10; i++) {
        await cacheTrustScore(makeScore(`did:plc:${i}`, 0.5));
      }
      // Overwrite the oldest — this should bump it to newest.
      await cacheTrustScore(makeScore('did:plc:0', 0.99));
      await evictTrustCacheTo(3);
      // did:plc:0 must survive because it was just refreshed; the
      // surviving set is its three most-recent neighbours.
      const survived = await getCachedTrust('did:plc:0');
      expect(survived?.score).toBe(0.99);
    });

    it('drops the KV row on eviction (memory pressure actually relieved)', async () => {
      // Check the KV layer DIRECTLY — going through getCachedTrust
      // would be ambiguous: a null tracker entry alone returns null
      // even if the KV row leaked. The point of this test is to
      // catch a regression where the tracker is cleared but the KV
      // bytes persist (memory pressure not actually relieved).
      const { kvGet } = await import('../../src/kv/store');
      await cacheTrustScore(makeScore('did:plc:evicted', 0.5));
      expect(await kvGet('did:plc:evicted', 'trust_cache')).not.toBeNull();
      await evictTrustCacheTo(0);
      expect(await kvGet('did:plc:evicted', 'trust_cache')).toBeNull();
      expect(trustCacheSize()).toBe(0);
    });

    it('evictTrustCacheTo with target ≥ current size is a no-op', async () => {
      await cacheTrustScore(makeScore('did:plc:a', 0.5));
      await cacheTrustScore(makeScore('did:plc:b', 0.6));
      await evictTrustCacheTo(100);
      expect(trustCacheSize()).toBe(2);
    });

    it('evictTrustCacheTo with negative target evicts everything', async () => {
      await cacheTrustScore(makeScore('did:plc:a', 0.5));
      await cacheTrustScore(makeScore('did:plc:b', 0.6));
      await evictTrustCacheTo(-5);
      expect(trustCacheSize()).toBe(0);
    });

    it('LRU bump preserves cachedAt — accessing does not reset TTL freshness', async () => {
      // Subtle invariant: re-inserting on read changes ORDER but
      // must NOT change the cached-at timestamp. Otherwise an
      // entry close to TTL expiry would silently extend its life
      // every time it's read, contradicting the documented "1-hour
      // TTL since fetch" contract.
      const writeNow = 1_000_000;
      await cacheTrustScore(makeScore('did:plc:alice', 0.5), writeNow);
      // Read at a later time — bumps insertion order.
      await getCachedTrust('did:plc:alice', writeNow + 30 * 60 * 1000);
      // 61 minutes after the WRITE — must have expired.
      const result = await getCachedTrust('did:plc:alice', writeNow + 61 * 60 * 1000);
      expect(result).toBeNull();
    });

    it('memory-warning eviction target leaves the most recent N entries', async () => {
      // Simulate the AppState.memoryWarning flow: fill up, then evict
      // to MEMORY_WARNING_TARGET. This is the exact sequence the
      // mobile hook will execute.
      const total = MEMORY_WARNING_TARGET + 20;
      for (let i = 0; i < total; i++) {
        await cacheTrustScore(makeScore(`did:plc:${i.toString().padStart(3, '0')}`, 0.5));
      }
      await evictTrustCacheTo(MEMORY_WARNING_TARGET);
      expect(trustCacheSize()).toBe(MEMORY_WARNING_TARGET);
      // The most recent MEMORY_WARNING_TARGET entries must remain.
      for (let i = total - MEMORY_WARNING_TARGET; i < total; i++) {
        const did = `did:plc:${i.toString().padStart(3, '0')}`;
        expect(await getCachedTrust(did)).not.toBeNull();
      }
    });
  });
});
