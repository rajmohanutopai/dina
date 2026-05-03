/**
 * Unit tests for `appview/src/api/middleware/graph-context-cache.ts`.
 *
 * The middleware wraps `computeGraphContext` with the existing
 * `network-cache` primitive (TN-SCORE-007). Tests pin the
 * load-bearing behaviour: cache hits avoid the underlying call,
 * different keys cache independently, the operator escape hatches
 * (clear / invalidateViewer) work as documented.
 *
 * Why these tests exist alongside `network_cache.test.ts`: that
 * file pins the cache PRIMITIVE; this file pins the WIRING — the
 * specific glue that lets `getCachedGraphContext` route through the
 * cache without leaking the underlying `computeGraphContext` call
 * on a hit. A regression that accidentally bypasses the cache
 * (e.g. a refactor that calls `computeGraphContext` directly) would
 * silently restore the per-request BFS cost; this test catches it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the underlying graph query so we can count calls. The
// middleware imports it through `@/db/queries/graph.js`, so the
// mock must shadow that exact specifier.
const computeGraphContextMock = vi.fn()
vi.mock('@/db/queries/graph.js', () => ({
  computeGraphContext: (...args: unknown[]) => computeGraphContextMock(...args),
}))

// Mock the metrics module so the hit/miss counter test can observe
// what the cache emits. `vi.hoisted` runs before `vi.mock` factories
// so both the mock factory AND the test scope share the same Mock
// instance — bare `const m = vi.fn()` would hit a hoisting TDZ
// because `vi.mock` is itself hoisted to the top of the file.
const { metricsIncrMock } = vi.hoisted(() => ({
  metricsIncrMock: vi.fn(),
}))
vi.mock('@/shared/utils/metrics.js', () => ({
  metrics: { incr: metricsIncrMock },
}))

import {
  getCachedGraphContext,
  clearGraphContextCache,
  invalidateGraphContextForViewer,
} from '@/api/middleware/graph-context-cache'
import type { DrizzleDB } from '@/db/connection'

const VIEWER = 'did:plc:viewer-cache-test'
const VIEWER_OTHER = 'did:plc:viewer-other'

const DUMMY_DB = {} as unknown as DrizzleDB

function makeContext(label: string) {
  return {
    rootDid: VIEWER,
    nodes: [{ did: label, depth: 1 }],
    edges: [],
    depth: 1,
  }
}

beforeEach(() => {
  computeGraphContextMock.mockReset()
  clearGraphContextCache()
})

describe('getCachedGraphContext — caching behaviour', () => {
  it('first call invokes computeGraphContext; second hits cache', async () => {
    computeGraphContextMock.mockResolvedValueOnce(makeContext('first'))

    const a = await getCachedGraphContext(DUMMY_DB, VIEWER, 1)
    const b = await getCachedGraphContext(DUMMY_DB, VIEWER, 1)

    // The mock is wired with `mockResolvedValueOnce` — a SECOND call
    // would yield `undefined` and the test below would catch it via
    // structural equality. Both reads must return the same object
    // because the cache returns the stored reference (no clone).
    expect(a).toBe(b)
    expect(a.nodes[0].did).toBe('first')
    expect(computeGraphContextMock).toHaveBeenCalledTimes(1)
    expect(computeGraphContextMock).toHaveBeenCalledWith(DUMMY_DB, VIEWER, 1, undefined)
  })

  it('different maxDepth caches independently', async () => {
    computeGraphContextMock.mockResolvedValueOnce(makeContext('depth-1'))
    computeGraphContextMock.mockResolvedValueOnce(makeContext('depth-2'))

    const d1 = await getCachedGraphContext(DUMMY_DB, VIEWER, 1)
    const d2 = await getCachedGraphContext(DUMMY_DB, VIEWER, 2)

    expect(d1.nodes[0].did).toBe('depth-1')
    expect(d2.nodes[0].did).toBe('depth-2')
    expect(computeGraphContextMock).toHaveBeenCalledTimes(2)
  })

  it('different viewers cache independently', async () => {
    computeGraphContextMock.mockResolvedValueOnce(makeContext('viewer-a'))
    computeGraphContextMock.mockResolvedValueOnce(makeContext('viewer-b'))

    await getCachedGraphContext(DUMMY_DB, VIEWER, 1)
    await getCachedGraphContext(DUMMY_DB, VIEWER_OTHER, 1)

    expect(computeGraphContextMock).toHaveBeenCalledTimes(2)
  })

  it('different domain caches independently', async () => {
    computeGraphContextMock.mockResolvedValueOnce(makeContext('no-domain'))
    computeGraphContextMock.mockResolvedValueOnce(makeContext('with-domain'))

    await getCachedGraphContext(DUMMY_DB, VIEWER, 1)
    await getCachedGraphContext(DUMMY_DB, VIEWER, 1, 'office_furniture')

    expect(computeGraphContextMock).toHaveBeenCalledTimes(2)
  })

  it('errors propagate and are NOT cached (so a transient DB failure does not poison the 60s window)', async () => {
    const err = new Error('transient db failure')
    computeGraphContextMock.mockRejectedValueOnce(err)
    computeGraphContextMock.mockResolvedValueOnce(makeContext('recovered'))

    await expect(getCachedGraphContext(DUMMY_DB, VIEWER, 1)).rejects.toThrow('transient db failure')

    // Second call should re-attempt, not return the (non-existent) cached error.
    const recovered = await getCachedGraphContext(DUMMY_DB, VIEWER, 1)
    expect(recovered.nodes[0].did).toBe('recovered')
    expect(computeGraphContextMock).toHaveBeenCalledTimes(2)
  })
})

describe('hit/miss metrics emission', () => {
  it('emits ingester.graph_cache.miss on cache miss; .hit on subsequent hit', async () => {
    metricsIncrMock.mockClear()
    clearGraphContextCache()
    computeGraphContextMock.mockResolvedValueOnce(makeContext('first'))

    await getCachedGraphContext(DUMMY_DB, VIEWER, 1)
    await getCachedGraphContext(DUMMY_DB, VIEWER, 1)

    const events = metricsIncrMock.mock.calls.map((args) => args[0])
    expect(events).toContain('ingester.graph_cache.miss')
    expect(events).toContain('ingester.graph_cache.hit')
    // Exactly one of each — first call missed, second hit.
    expect(events.filter((e) => e === 'ingester.graph_cache.miss')).toHaveLength(1)
    expect(events.filter((e) => e === 'ingester.graph_cache.hit')).toHaveLength(1)
  })

  it('emits .miss only when the underlying compute is invoked (errors do NOT poison hit-count)', async () => {
    metricsIncrMock.mockClear()
    clearGraphContextCache()
    computeGraphContextMock.mockRejectedValueOnce(new Error('boom'))
    computeGraphContextMock.mockResolvedValueOnce(makeContext('recovered'))

    await expect(getCachedGraphContext(DUMMY_DB, VIEWER, 1)).rejects.toThrow('boom')
    await getCachedGraphContext(DUMMY_DB, VIEWER, 1)

    const events = metricsIncrMock.mock.calls.map((args) => args[0])
    // Two misses: the failed first call AND the successful second.
    // No hits — the failed first didn't cache (errors aren't cached).
    expect(events.filter((e) => e === 'ingester.graph_cache.miss')).toHaveLength(2)
    expect(events.filter((e) => e === 'ingester.graph_cache.hit')).toHaveLength(0)
  })
})

describe('clearGraphContextCache — test escape hatch', () => {
  it('removes all entries; subsequent call hits compute again', async () => {
    computeGraphContextMock.mockResolvedValueOnce(makeContext('before-clear'))
    computeGraphContextMock.mockResolvedValueOnce(makeContext('after-clear'))

    const before = await getCachedGraphContext(DUMMY_DB, VIEWER, 1)
    clearGraphContextCache()
    const after = await getCachedGraphContext(DUMMY_DB, VIEWER, 1)

    expect(before.nodes[0].did).toBe('before-clear')
    expect(after.nodes[0].did).toBe('after-clear')
    expect(computeGraphContextMock).toHaveBeenCalledTimes(2)
  })
})

describe('invalidateGraphContextForViewer — operator escape hatch', () => {
  it('removes only the targeted viewer; others stay cached', async () => {
    computeGraphContextMock.mockResolvedValueOnce(makeContext('a-1'))
    computeGraphContextMock.mockResolvedValueOnce(makeContext('b-1'))
    computeGraphContextMock.mockResolvedValueOnce(makeContext('a-2'))

    await getCachedGraphContext(DUMMY_DB, VIEWER, 1)
    await getCachedGraphContext(DUMMY_DB, VIEWER_OTHER, 1)

    const removed = invalidateGraphContextForViewer(VIEWER)
    expect(removed).toBe(1)

    // VIEWER cache miss → 3rd call to compute.
    const refetchA = await getCachedGraphContext(DUMMY_DB, VIEWER, 1)
    expect(refetchA.nodes[0].did).toBe('a-2')

    // VIEWER_OTHER still cached.
    const cachedB = await getCachedGraphContext(DUMMY_DB, VIEWER_OTHER, 1)
    expect(cachedB.nodes[0].did).toBe('b-1')

    expect(computeGraphContextMock).toHaveBeenCalledTimes(3)
  })

  it('returns 0 when no entries match', () => {
    const removed = invalidateGraphContextForViewer('did:plc:nobody-here')
    expect(removed).toBe(0)
  })

  it('removes ALL depths + domains for a viewer in one call', async () => {
    computeGraphContextMock.mockResolvedValueOnce(makeContext('d1'))
    computeGraphContextMock.mockResolvedValueOnce(makeContext('d2'))
    computeGraphContextMock.mockResolvedValueOnce(makeContext('d1-domain'))

    await getCachedGraphContext(DUMMY_DB, VIEWER, 1)
    await getCachedGraphContext(DUMMY_DB, VIEWER, 2)
    await getCachedGraphContext(DUMMY_DB, VIEWER, 1, 'tech')

    const removed = invalidateGraphContextForViewer(VIEWER)
    expect(removed).toBe(3)
  })
})
