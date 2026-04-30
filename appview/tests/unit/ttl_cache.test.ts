/**
 * Unit tests for `appview/src/shared/utils/ttl-cache.ts` +
 * `did-doc-cache.ts` (TN-AUTH-003 / Plan §3.5.4).
 *
 * Coverage strategy:
 *   - Generic `TtlCache` primitive: hit/miss/expiry/invalidation,
 *     LRU bound, strict-TTL semantics (no extend-on-read), set-after-
 *     set-replaces-TTL contract.
 *   - DID-doc-specific wrapper: getOrFetch hit (no fetcher call),
 *     miss (fetcher called once + result cached), TTL expiry triggers
 *     re-fetch, fetcher errors propagate (no negative caching),
 *     invalidate forces re-fetch.
 *
 * Time control via `vi.useFakeTimers()` so TTL boundaries are
 * deterministic — never use a real `setTimeout(...)` for TTL tests
 * (flaky on slow CI).
 */

import { describe, expect, it, vi } from 'vitest'

import {
  createDidDocCache,
  DEFAULT_DID_DOC_CACHE_MAX,
  DID_DOC_CACHE_TTL_MS,
  type DIDDocument,
} from '@/shared/utils/did-doc-cache'
import { createTtlCache } from '@/shared/utils/ttl-cache'

/**
 * Why real timers + short TTLs (instead of `vi.useFakeTimers`):
 * lru-cache 11.x captures `performance.now` at module-import time,
 * so vitest's runtime monkey-patching can't reach it after import.
 * Real timers with 30ms/60ms test TTLs keep tests deterministic
 * enough (test runtime is ~250ms total) without the flakiness of
 * post-hoc time mocking.
 */
const SHORT_TTL_MS = 30

/** Helper: real-timer await for the TTL-boundary tests. */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Generic TtlCache primitive ────────────────────────────────

describe('createTtlCache — basic get/set/invalidate', () => {
  it('returns undefined for unset keys', () => {
    const c = createTtlCache<string, string>({ max: 100, ttlMs: 1000 })
    expect(c.get('missing')).toBeUndefined()
  })

  it('returns the stored value for set keys', () => {
    const c = createTtlCache<string, string>({ max: 100, ttlMs: 1000 })
    c.set('k1', 'v1')
    expect(c.get('k1')).toBe('v1')
  })

  it('invalidate(key) returns true when key existed + removes it', () => {
    const c = createTtlCache<string, string>({ max: 100, ttlMs: 1000 })
    c.set('k1', 'v1')
    expect(c.invalidate('k1')).toBe(true)
    expect(c.get('k1')).toBeUndefined()
  })

  it('invalidate(key) returns false when key did not exist', () => {
    const c = createTtlCache<string, string>({ max: 100, ttlMs: 1000 })
    expect(c.invalidate('never-set')).toBe(false)
  })

  it('clear() removes all entries', () => {
    const c = createTtlCache<string, string>({ max: 100, ttlMs: 1000 })
    c.set('a', '1')
    c.set('b', '2')
    c.set('c', '3')
    c.clear()
    expect(c.size()).toBe(0)
    expect(c.get('a')).toBeUndefined()
  })

  it('size() reports the current entry count', () => {
    const c = createTtlCache<string, string>({ max: 100, ttlMs: 1000 })
    expect(c.size()).toBe(0)
    c.set('a', '1')
    expect(c.size()).toBe(1)
    c.set('b', '2')
    expect(c.size()).toBe(2)
    c.invalidate('a')
    expect(c.size()).toBe(1)
  })
})

// ── TTL semantics ─────────────────────────────────────────────

describe('createTtlCache — TTL semantics', () => {
  it('returns the value before TTL expires', async () => {
    const c = createTtlCache<string, string>({ max: 100, ttlMs: SHORT_TTL_MS })
    c.set('k1', 'v1')
    await sleep(SHORT_TTL_MS / 2)
    expect(c.get('k1')).toBe('v1')
  })

  it('returns undefined after TTL elapses', async () => {
    // Pinned because an off-by-one in lru-cache's TTL semantics would
    // let stale crypto material through past the documented window.
    const c = createTtlCache<string, string>({ max: 100, ttlMs: SHORT_TTL_MS })
    c.set('k1', 'v1')
    await sleep(SHORT_TTL_MS * 2)
    expect(c.get('k1')).toBeUndefined()
  })

  it('does NOT extend TTL on get (strict absolute TTL — security contract)', async () => {
    // The security-relevant invariant. A frequently-read DID doc must
    // expire exactly `ttlMs` after `set`, not be kept fresh by reads.
    // Otherwise a popular DID's cached entry could outlive a key
    // rotation indefinitely.
    const c = createTtlCache<string, string>({ max: 100, ttlMs: SHORT_TTL_MS })
    c.set('hot-key', 'v1')
    // Read several times within the TTL window — entry should NOT
    // have its lifetime extended.
    for (let i = 0; i < 3; i++) {
      await sleep(SHORT_TTL_MS / 4)
      expect(c.get('hot-key')).toBe('v1') // 3 × 7.5ms ≈ 22.5ms — still fresh
    }
    await sleep(SHORT_TTL_MS) // total elapsed: ~22.5 + 30 = 52.5ms > 30
    expect(c.get('hot-key')).toBeUndefined()
  })

  it('set() on an existing key resets the TTL window (no silent partial-TTL)', async () => {
    // A re-write should give the value a fresh ttlMs, not an extension
    // of the remaining time. Pinned because lru-cache's `noUpdateTTL`
    // option defaults differ across versions.
    const c = createTtlCache<string, string>({ max: 100, ttlMs: SHORT_TTL_MS })
    c.set('k1', 'v1')
    await sleep(SHORT_TTL_MS * 0.7) // ~70% of TTL elapsed
    c.set('k1', 'v2') // re-write should give a FULL fresh TTL window
    await sleep(SHORT_TTL_MS * 0.7) // would have expired the original
    expect(c.get('k1')).toBe('v2') // but 'v2' is still within fresh window
  })
})

// ── LRU bound ─────────────────────────────────────────────────

describe('createTtlCache — LRU bound', () => {
  it('evicts least-recently-used entries past `max`', () => {
    const c = createTtlCache<string, string>({ max: 3, ttlMs: 60_000 })
    c.set('a', '1')
    c.set('b', '2')
    c.set('c', '3')
    // Touch 'a' so 'b' becomes the LRU
    c.get('a')
    c.set('d', '4') // evicts 'b' (the LRU)
    expect(c.get('a')).toBe('1')
    expect(c.get('b')).toBeUndefined()
    expect(c.get('c')).toBe('3')
    expect(c.get('d')).toBe('4')
    expect(c.size()).toBe(3)
  })
})

// ── Type-level contract ───────────────────────────────────────

describe('createTtlCache — type genericity', () => {
  it('supports object value types (not just primitives)', () => {
    interface Doc {
      id: string
      payload: number
    }
    const c = createTtlCache<string, Doc>({ max: 10, ttlMs: 1000 })
    c.set('k', { id: 'x', payload: 42 })
    const got = c.get('k')
    expect(got).toEqual({ id: 'x', payload: 42 })
  })
})

// ── DID-doc cache wrapper ─────────────────────────────────────

const sampleDoc: DIDDocument = {
  id: 'did:plc:abcdefghijklmnopqrstuvwx',
  verificationMethod: [],
  assertionMethod: [],
}

describe('createDidDocCache — getOrFetch', () => {
  it('on miss: calls fetcher, stores result, returns it', async () => {
    const dc = createDidDocCache({ max: 10, ttlMs: 5000 })
    const fetcher = vi.fn().mockResolvedValue(sampleDoc)
    const result = await dc.getOrFetch('did:plc:test', fetcher)
    expect(result).toEqual(sampleDoc)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('did:plc:test')
  })

  it('on hit: does NOT call fetcher, returns cached value', async () => {
    // The fundamental performance contract — every call after the
    // first within the TTL window must be a cache hit.
    const dc = createDidDocCache({ max: 10, ttlMs: 5000 })
    const fetcher = vi.fn().mockResolvedValue(sampleDoc)
    await dc.getOrFetch('did:plc:test', fetcher)
    fetcher.mockClear()
    const second = await dc.getOrFetch('did:plc:test', fetcher)
    expect(second).toEqual(sampleDoc)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('after TTL expiry: re-fetches and stores fresh', async () => {
    const dc = createDidDocCache({ max: 10, ttlMs: SHORT_TTL_MS })
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(sampleDoc)
      .mockResolvedValueOnce({ ...sampleDoc, id: 'rotated' })
    await dc.getOrFetch('did:plc:test', fetcher)
    await sleep(SHORT_TTL_MS * 2)
    const second = await dc.getOrFetch('did:plc:test', fetcher)
    expect(second.id).toBe('rotated')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does NOT cache fetcher errors (no negative caching in V1)', async () => {
    // V1 stance: if PLC's down, we fail loudly rather than serve
    // cached `null`s for an hour. Subsequent calls retry.
    const dc = createDidDocCache({ max: 10, ttlMs: 5000 })
    const failingFetcher = vi.fn().mockRejectedValue(new Error('PLC unreachable'))
    await expect(dc.getOrFetch('did:plc:test', failingFetcher)).rejects.toThrow(
      'PLC unreachable',
    )
    // Subsequent call retries (NO cached error response).
    failingFetcher.mockClear()
    failingFetcher.mockResolvedValueOnce(sampleDoc)
    const result = await dc.getOrFetch('did:plc:test', failingFetcher)
    expect(result).toEqual(sampleDoc)
    expect(failingFetcher).toHaveBeenCalledTimes(1)
  })

  it('invalidate(did) forces re-fetch on the next get', async () => {
    // Operator escape hatch — when a DID compromise is reported, the
    // operator force-flushes the cache for that DID without waiting
    // for the 5-minute TTL.
    const dc = createDidDocCache({ max: 10, ttlMs: 5000 })
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(sampleDoc)
      .mockResolvedValueOnce({ ...sampleDoc, id: 'rotated' })
    await dc.getOrFetch('did:plc:test', fetcher)
    expect(dc.invalidate('did:plc:test')).toBe(true)
    const second = await dc.getOrFetch('did:plc:test', fetcher)
    expect(second.id).toBe('rotated')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('invalidate(did) returns false when the DID was not cached', async () => {
    const dc = createDidDocCache({ max: 10, ttlMs: 5000 })
    expect(dc.invalidate('did:plc:never-cached')).toBe(false)
  })
})

describe('createDidDocCache — defaults', () => {
  it('uses 5-minute TTL by default (Plan §3.5.4)', () => {
    expect(DID_DOC_CACHE_TTL_MS).toBe(5 * 60 * 1000)
  })

  it('uses 50,000-entry LRU bound by default', () => {
    // Pinned because shrinking it without thought could OOM under
    // larger cohort sizes; growing it without thought blows out
    // memory. Either change is a deliberate decision.
    expect(DEFAULT_DID_DOC_CACHE_MAX).toBe(50_000)
  })

  it('the default factory call respects both defaults', async () => {
    // Smoke test that the no-arg factory works end-to-end.
    const dc = createDidDocCache()
    const fetcher = vi.fn().mockResolvedValue(sampleDoc)
    await dc.getOrFetch('did:plc:default', fetcher)
    // Within default TTL → hit
    expect(await dc.getOrFetch('did:plc:default', fetcher)).toEqual(sampleDoc)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('createDidDocCache — independent caches', () => {
  it('two cache instances do not share state', async () => {
    // Each call to `createDidDocCache` returns an independent cache.
    // Pinned because if the factory accidentally returned a singleton,
    // tests would leak state between cases AND multi-resolver
    // deployments would have unexpected cross-talk.
    const a = createDidDocCache({ max: 10, ttlMs: 5000 })
    const b = createDidDocCache({ max: 10, ttlMs: 5000 })
    const fa = vi.fn().mockResolvedValue(sampleDoc)
    const fb = vi.fn().mockResolvedValue(sampleDoc)
    await a.getOrFetch('did:plc:test', fa)
    expect(b.cache.size()).toBe(0)
    await b.getOrFetch('did:plc:test', fb)
    expect(a.cache.size()).toBe(1)
    expect(b.cache.size()).toBe(1)
  })
})
