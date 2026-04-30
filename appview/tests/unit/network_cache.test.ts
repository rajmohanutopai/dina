/**
 * Unit tests for `appview/src/shared/utils/network-cache.ts`
 * (TN-TEST-003 / TN-SCORE-007 / Plan §7).
 *
 * Coverage strategy:
 *   - Hit / miss / TTL expiry / invalidate (parallels the DID-doc
 *     cache's contract — same underlying TtlCache).
 *   - Per-(viewer, depth, domain) cache key independence.
 *   - `invalidateViewer` clears ALL entries for a viewer across
 *     depths + domains (the operator escape hatch for graph
 *     mutations needing immediate propagation).
 *   - Defaults pinned (60-second TTL per Plan §7 line 891, 10k
 *     LRU bound).
 *
 * Real timers + short test TTLs — same rationale as `ttl_cache.test.ts`
 * (lru-cache 11.x captures `performance.now` at module-import time;
 * vitest's faker can't reach it).
 */

import { describe, expect, it, vi } from 'vitest'

import {
  createNetworkCache,
  DEFAULT_NETWORK_CACHE_MAX,
  GRAPH_CACHE_TTL_MS,
} from '@/shared/utils/network-cache'

const SHORT_TTL_MS = 30
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

interface FakeGraph {
  nodes: number
  rootDid: string
}

const sampleGraph = (rootDid: string, nodes = 10): FakeGraph => ({ nodes, rootDid })

// ── Basic getOrFetch ──────────────────────────────────────────

describe('createNetworkCache — getOrFetch', () => {
  it('on miss: calls fetcher, stores result, returns it', async () => {
    const c = createNetworkCache<FakeGraph>({ max: 100, ttlMs: SHORT_TTL_MS })
    const fetcher = vi.fn().mockResolvedValue(sampleGraph('did:plc:viewer'))
    const result = await c.getOrFetch('did:plc:viewer', 1, undefined, fetcher)
    expect(result).toEqual(sampleGraph('did:plc:viewer'))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('on hit: does NOT call fetcher, returns cached value', async () => {
    const c = createNetworkCache<FakeGraph>({ max: 100, ttlMs: SHORT_TTL_MS })
    const fetcher = vi.fn().mockResolvedValue(sampleGraph('did:plc:viewer'))
    await c.getOrFetch('did:plc:viewer', 1, undefined, fetcher)
    fetcher.mockClear()
    const second = await c.getOrFetch('did:plc:viewer', 1, undefined, fetcher)
    expect(second).toEqual(sampleGraph('did:plc:viewer'))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('after TTL expiry: re-fetches fresh', async () => {
    const c = createNetworkCache<FakeGraph>({ max: 100, ttlMs: SHORT_TTL_MS })
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(sampleGraph('did:plc:viewer', 10))
      .mockResolvedValueOnce(sampleGraph('did:plc:viewer', 12))
    await c.getOrFetch('did:plc:viewer', 1, undefined, fetcher)
    await sleep(SHORT_TTL_MS * 2)
    const second = await c.getOrFetch('did:plc:viewer', 1, undefined, fetcher)
    expect(second.nodes).toBe(12)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does NOT cache fetcher errors (no negative caching)', async () => {
    // Same posture as TN-AUTH-003: when the underlying graph query
    // fails (DB blip, statement timeout), the operator wants to see
    // the error, not silent stale-or-empty serving.
    const c = createNetworkCache<FakeGraph>({ max: 100, ttlMs: SHORT_TTL_MS })
    const failing = vi.fn().mockRejectedValue(new Error('DB unreachable'))
    await expect(
      c.getOrFetch('did:plc:viewer', 1, undefined, failing),
    ).rejects.toThrow('DB unreachable')
    failing.mockClear()
    failing.mockResolvedValueOnce(sampleGraph('did:plc:viewer'))
    await c.getOrFetch('did:plc:viewer', 1, undefined, failing)
    expect(failing).toHaveBeenCalledTimes(1)
  })
})

// ── Per-(viewer, depth, domain) key independence ──────────────

describe('createNetworkCache — cache-key independence', () => {
  it('different viewers have independent caches', async () => {
    const c = createNetworkCache<FakeGraph>({ max: 100, ttlMs: SHORT_TTL_MS })
    const fetcher = vi.fn().mockImplementation(async () => sampleGraph('any'))
    await c.getOrFetch('did:plc:alice', 1, undefined, fetcher)
    await c.getOrFetch('did:plc:bob', 1, undefined, fetcher)
    // Two viewers → two fetcher calls (no cross-talk).
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('different depths for the same viewer are independent', async () => {
    // networkFeed uses depth=1; subjectGet uses depth=2. Caching
    // them under the same key would let one query corrupt the other.
    const c = createNetworkCache<FakeGraph>({ max: 100, ttlMs: SHORT_TTL_MS })
    const fetcher = vi.fn().mockImplementation(async () => sampleGraph('any'))
    await c.getOrFetch('did:plc:viewer', 1, undefined, fetcher)
    await c.getOrFetch('did:plc:viewer', 2, undefined, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('different domain filters for the same viewer are independent', async () => {
    // A domain-filtered query (e.g. limited to `amazon.com`) caches
    // independently from the unfiltered query — otherwise the
    // filtered result would poison the unfiltered cache.
    const c = createNetworkCache<FakeGraph>({ max: 100, ttlMs: SHORT_TTL_MS })
    const fetcher = vi.fn().mockImplementation(async () => sampleGraph('any'))
    await c.getOrFetch('did:plc:viewer', 1, undefined, fetcher)
    await c.getOrFetch('did:plc:viewer', 1, 'amazon.com', fetcher)
    await c.getOrFetch('did:plc:viewer', 1, 'etsy.com', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('same (viewer, depth, domain) tuple is one cache hit', async () => {
    const c = createNetworkCache<FakeGraph>({ max: 100, ttlMs: SHORT_TTL_MS })
    const fetcher = vi.fn().mockResolvedValue(sampleGraph('did:plc:viewer'))
    await c.getOrFetch('did:plc:viewer', 1, 'amazon.com', fetcher)
    await c.getOrFetch('did:plc:viewer', 1, 'amazon.com', fetcher)
    await c.getOrFetch('did:plc:viewer', 1, 'amazon.com', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

// ── invalidateViewer ──────────────────────────────────────────

describe('createNetworkCache — invalidateViewer', () => {
  it('removes ALL entries for a viewer (across depths + domains)', async () => {
    // Operator escape hatch: a graph mutation (added contact,
    // blocked DID) needs immediate propagation. Calling
    // invalidateViewer flushes every depth/domain entry for that
    // viewer in one call — the next request re-fetches.
    const c = createNetworkCache<FakeGraph>({ max: 100, ttlMs: SHORT_TTL_MS })
    const fetcher = vi.fn().mockImplementation(async () => sampleGraph('any'))
    // Populate 4 entries: depth 1+2, domain undefined+'amazon.com'.
    await c.getOrFetch('did:plc:viewer', 1, undefined, fetcher)
    await c.getOrFetch('did:plc:viewer', 2, undefined, fetcher)
    await c.getOrFetch('did:plc:viewer', 1, 'amazon.com', fetcher)
    await c.getOrFetch('did:plc:viewer', 2, 'amazon.com', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(4)

    const removed = c.invalidateViewer('did:plc:viewer')
    expect(removed).toBe(4)

    // All 4 should re-fetch.
    fetcher.mockClear()
    await c.getOrFetch('did:plc:viewer', 1, undefined, fetcher)
    await c.getOrFetch('did:plc:viewer', 2, undefined, fetcher)
    await c.getOrFetch('did:plc:viewer', 1, 'amazon.com', fetcher)
    await c.getOrFetch('did:plc:viewer', 2, 'amazon.com', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('returns 0 when the viewer had no cached entries', async () => {
    const c = createNetworkCache<FakeGraph>({ max: 100, ttlMs: SHORT_TTL_MS })
    expect(c.invalidateViewer('did:plc:never-seen')).toBe(0)
  })

  it('does NOT touch other viewers entries', async () => {
    // Pinned because the operator invalidating one viewer's cache
    // shouldn't blow away the entire cache.
    const c = createNetworkCache<FakeGraph>({ max: 100, ttlMs: SHORT_TTL_MS })
    const fetcher = vi.fn().mockImplementation(async () => sampleGraph('any'))
    await c.getOrFetch('did:plc:alice', 1, undefined, fetcher)
    await c.getOrFetch('did:plc:bob', 1, undefined, fetcher)

    c.invalidateViewer('did:plc:alice')
    fetcher.mockClear()

    // Alice re-fetches; Bob does not.
    await c.getOrFetch('did:plc:alice', 1, undefined, fetcher)
    await c.getOrFetch('did:plc:bob', 1, undefined, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1) // only Alice
  })
})

// ── clear() ──────────────────────────────────────────────────

describe('createNetworkCache — clear', () => {
  it('removes all entries across all viewers', async () => {
    const c = createNetworkCache<FakeGraph>({ max: 100, ttlMs: SHORT_TTL_MS })
    const fetcher = vi.fn().mockImplementation(async () => sampleGraph('any'))
    await c.getOrFetch('did:plc:alice', 1, undefined, fetcher)
    await c.getOrFetch('did:plc:bob', 1, undefined, fetcher)
    expect(c.cache.size()).toBe(2)
    c.clear()
    expect(c.cache.size()).toBe(0)
  })
})

// ── Defaults ──────────────────────────────────────────────────

describe('createNetworkCache — defaults', () => {
  it('uses 60-second TTL by default (Plan §7 line 891)', () => {
    expect(GRAPH_CACHE_TTL_MS).toBe(60 * 1000)
  })

  it('uses 10,000-entry LRU bound by default', () => {
    expect(DEFAULT_NETWORK_CACHE_MAX).toBe(10_000)
  })

  it('the no-arg factory respects both defaults', async () => {
    const c = createNetworkCache<FakeGraph>()
    const fetcher = vi.fn().mockResolvedValue(sampleGraph('did:plc:viewer'))
    await c.getOrFetch('did:plc:viewer', 1, undefined, fetcher)
    // Within default TTL → hit.
    expect(await c.getOrFetch('did:plc:viewer', 1, undefined, fetcher)).toEqual(
      sampleGraph('did:plc:viewer'),
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

// ── TTL expiry ────────────────────────────────────────────────

describe('createNetworkCache — TTL expiry', () => {
  it('strict TTL — hot entries do NOT extend their lifetime via reads', async () => {
    // Pinned because the underlying TtlCache uses `updateAgeOnGet:
    // false`. A frequently-read graph must expire 60s after its
    // last `set`, not be kept alive by reads — so a graph mutation
    // propagates within the TTL window regardless of read pressure.
    const c = createNetworkCache<FakeGraph>({ max: 100, ttlMs: SHORT_TTL_MS })
    const fetcher = vi.fn().mockResolvedValueOnce(sampleGraph('did:plc:hot'))
    await c.getOrFetch('did:plc:hot', 1, undefined, fetcher)
    // Read several times within the TTL window.
    for (let i = 0; i < 3; i++) {
      await sleep(SHORT_TTL_MS / 4)
      await c.getOrFetch('did:plc:hot', 1, undefined, fetcher)
    }
    expect(fetcher).toHaveBeenCalledTimes(1)
    // Then push past TTL.
    await sleep(SHORT_TTL_MS)
    fetcher.mockResolvedValueOnce(sampleGraph('did:plc:hot', 99))
    await c.getOrFetch('did:plc:hot', 1, undefined, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2) // re-fetched
  })
})
