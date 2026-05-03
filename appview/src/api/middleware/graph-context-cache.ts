/**
 * Graph-context middleware (TN-SCORE-007 wiring layer).
 *
 * Wraps `computeGraphContext` with the existing `network-cache`
 * primitive so the four xRPC consumers — `networkFeed`, `subjectGet`,
 * `getNegativeSpace`, and `search`'s friend-boost branch — share a
 * single in-process cache rather than each rebuilding the BFS
 * per request.
 *
 * **Why a separate middleware module rather than wiring the cache
 * directly into `computeGraphContext`**: the underlying
 * `db/queries/graph.ts` query is also used by the scorer jobs
 * (refresh-profiles fan-out, edge-sync incremental updates) where
 * cached state is the WRONG answer — those run as part of the
 * write-side pipeline and need authoritative reads. Keeping the
 * cache at the API-middleware layer means xRPC handlers benefit
 * without scorer correctness regressing.
 *
 * **Cache keying** mirrors `network-cache.ts`: `(viewerDid, maxDepth,
 * domain)` triple. Different depths cache independently — depth=1
 * (networkFeed / getNegativeSpace / search) and depth=2 (subjectGet)
 * resolve to separate entries; one warming the other would silently
 * truncate the depth=2 graph. Tests for that behaviour live in
 * `tests/unit/network_cache.test.ts`.
 *
 * **TTL**: 60s (Plan §7 line 891). Trades read amplification
 * against contact-graph staleness — long enough that a viewer
 * tapping refresh doesn't pay the BFS cost on every tap, short
 * enough that adding a contact propagates within a minute.
 *
 * **Strict TTL (no SWR)**: graph state is security-relevant — the
 * friend-boost ranker depends on the 1-hop graph being accurate.
 * Stale-while-revalidate would let a malicious actor stay in the
 * graph past the moment a user blocks them. Mirrors `swr-cache`'s
 * choice for `resolve` (which IS SWR — different semantic surface,
 * different staleness budget) explicitly NOT to do here.
 *
 * **Test isolation**: `clearGraphContextCache()` is exported and
 * called from the same `beforeEach` blocks that already invoke
 * `clearCache()` on `swr-cache`. The two caches are independent —
 * clearing one doesn't clear the other — so both calls are required
 * for clean test isolation. The convention is to call both in any
 * test that exercises a cached xRPC.
 *
 * **Operator escape hatch**: `invalidateGraphContextForViewer(did)`
 * removes ALL cached entries for that viewer (across all depths +
 * domains). The use case is a graph mutation that needs to
 * propagate immediately — e.g. the user just blocked someone and
 * the next feed refresh must reflect that. The CLI / admin route
 * that handles graph mutations should call this synchronously
 * after the mutation lands.
 *
 * **Single shared instance**: module-level singleton because
 * Node-side AppView is single-process; the cache lives in V8
 * memory. Multi-process / multi-pod deployments need a Redis-backed
 * variant — same posture as `did-doc-cache` and the swr-cache.
 * The public surface here doesn't change when the underlying
 * primitive swaps.
 */

import { computeGraphContext, type GraphContext } from '@/db/queries/graph.js'
import type { DrizzleDB } from '@/db/connection.js'
import { createNetworkCache } from '@/shared/utils/network-cache.js'
import { metrics } from '@/shared/utils/metrics.js'

// Module-level singleton. `GraphContext` is a structurally-typed
// object; satisfies the `V extends {}` bound on `createNetworkCache`.
//
// Hit/miss counters fire on every `getOrFetch`. The shared-utils
// `network-cache` primitive stays domain-agnostic (no metrics
// imports there); the consumer (this module) namespaces the metric.
// Operators chart `ingester.graph_cache.hit` / `.miss` against
// `ingester.events.received` to read effective cache hit rate +
// catch a regression that accidentally bypasses the cache (which
// would zero out `.hit` while `.miss` ramps with traffic).
const cache = createNetworkCache<GraphContext>({
  onHit: () => metrics.incr('ingester.graph_cache.hit'),
  onMiss: () => metrics.incr('ingester.graph_cache.miss'),
})

/**
 * Cache-aware lookup. Returns the cached graph context for the
 * `(viewerDid, maxDepth, domain)` triple if fresh; otherwise calls
 * `computeGraphContext` and stores the result. Errors propagate —
 * no negative caching (a transient DB error shouldn't poison the
 * 60s window).
 *
 * `maxDepth` is required (not defaulted) because the BFS depth is
 * the load-bearing input — a caller passing `undefined` thinking
 * they'd get the default would silently get a different cache
 * entry than the one their tests expect. Force the explicit value
 * at every call site; if a caller wants the default, they pass
 * `CONSTANTS.MAX_GRAPH_DEPTH` themselves.
 */
export function getCachedGraphContext(
  db: DrizzleDB,
  viewerDid: string,
  maxDepth: number,
  domain?: string,
): Promise<GraphContext> {
  return cache.getOrFetch(viewerDid, maxDepth, domain, () =>
    computeGraphContext(db, viewerDid, maxDepth, domain),
  )
}

/**
 * Test helper: clear the entire cache. Called from `beforeEach` in
 * any integration test that exercises a graph-cached xRPC. Mirrors
 * `clearCache()` from swr-cache — same usage pattern, separate
 * cache.
 */
export function clearGraphContextCache(): void {
  cache.clear()
}

/**
 * Operator helper: invalidate all entries for a single viewer
 * across depths + domains. Called when a graph mutation lands
 * (block, vouch revoke, etc.) and the next read must reflect it.
 * Returns the count of entries removed for telemetry.
 */
export function invalidateGraphContextForViewer(viewerDid: string): number {
  return cache.invalidateViewer(viewerDid)
}
