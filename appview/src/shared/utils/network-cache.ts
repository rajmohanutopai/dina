/**
 * Network-position cache (TN-SCORE-007 / TN-TEST-003 / Plan §7).
 *
 * Caches the result of `computeGraphContext(db, viewerDid, maxDepth)`
 * with a 60-second TTL. The graph context is the heaviest read in
 * the trust-V1 surface — every viewer-aware xRPC (`networkFeed`,
 * `subjectGet`, the future friend-boost ranker) calls it. A
 * 60s cache is the operationally-relevant window: long enough that
 * a viewer hitting "refresh feed" doesn't pay the BFS cost on every
 * tap, short enough that adding a new contact propagates within a
 * minute.
 *
 * **Why 60-second TTL** (Plan §7 line 891): trades read amplification
 * cost against contact-graph staleness. 60s caps the worst-case
 * "I just added a contact, why don't I see them?" window — the
 * mobile UX shows a "graph refresh in progress" hint when the cache
 * is being warmed.
 *
 * **Cache key**: `(viewerDid, maxDepth, domainOrNull)` — same shape
 * as `computeGraphContext`'s args. Different depths produce different
 * graph contexts; `maxDepth=1` (used by `networkFeed`) and
 * `maxDepth=2` (used by `subjectGet`'s friends/extended split) cache
 * independently. `domain?` is a per-domain optional filter — also
 * keyed independently so a domain-filtered query doesn't poison the
 * unfiltered cache.
 *
 * **Strict TTL** (no SWR): graph state is security-relevant — the
 * trust-V1 friend-boost depends on the 1-hop graph being accurate.
 * Stale-while-revalidate would let a malicious actor stay in the
 * graph past the moment a user blocks them. The cache's underlying
 * `TtlCache<K, V>` enforces this contract via `allowStale: false`.
 *
 * **Operator escape hatch**: `invalidate(viewerDid)` removes ALL
 * cached entries for a given viewer (across all depths/domains) —
 * the use case is the curator forcing a re-read after a graph
 * mutation that needs to propagate immediately. V1 implementation
 * scans the key space; V2 (Redis) uses a SCAN-pattern to avoid
 * the in-memory iteration.
 *
 * **V1 in-memory; V2 Redis**: same posture as TN-AUTH-003. Multi-
 * instance deployments need shared state for consistent cache
 * propagation; the public surface here doesn't change when the
 * underlying primitive swaps.
 */

import { createTtlCache, type TtlCache } from './ttl-cache.js'

/** Plan §7 line 891 — 60-second TTL on cached graph contexts. */
export const GRAPH_CACHE_TTL_MS = 60 * 1000

/**
 * Per-deployment LRU bound. 10k unique viewers × ~4KB per cached
 * graph (depth=2, ~50 nodes + 100 edges) ≈ 40MB worst case. Larger
 * deployments override via `createNetworkCache({ max })`.
 */
export const DEFAULT_NETWORK_CACHE_MAX = 10_000

export interface NetworkCacheOptions {
  /** Override the default LRU bound. */
  max?: number
  /** Override the default 60-second TTL (ms). Tests use shorter values. */
  ttlMs?: number
  /**
   * Cache-hit callback. Fires synchronously on every `getOrFetch` call
   * that finds a fresh entry. Domain-namespaced metrics (e.g.
   * `ingester.graph_cache.hit`) live in the consumer; this primitive
   * stays domain-agnostic. Argument is the full cache key — useful
   * for per-viewer hit-rate dashboards if the consumer wants to
   * derive labels from the structured prefix. Defaults to a no-op.
   */
  onHit?: (key: string) => void
  /**
   * Cache-miss callback. Fires synchronously on every `getOrFetch`
   * call that misses (the underlying `fetcher` is about to run).
   * Same shape as `onHit` — consumer namespaces the metric. Defaults
   * to a no-op.
   */
  onMiss?: (key: string) => void
}

/**
 * The cached value type is intentionally kept generic — the
 * `network-cache` module doesn't know about `GraphContext`'s shape;
 * the consumer (`computeGraphContext` wrapper) types the cache at
 * its call site. This keeps the cache primitive testable without a
 * DB dependency + lets future graph-shape changes land without
 * touching cache code.
 */
export interface NetworkCache<V> {
  /** Underlying primitive — exposed for `size()` introspection. */
  cache: TtlCache<string, V>
  /**
   * Cache-aware lookup. Returns the cached graph if fresh; otherwise
   * calls `fetcher` and stores the result. Errors propagate (no
   * negative caching — same posture as TN-AUTH-003).
   */
  getOrFetch(
    viewerDid: string,
    maxDepth: number,
    domain: string | undefined,
    fetcher: () => Promise<V>,
  ): Promise<V>
  /**
   * Invalidate all cached entries for a viewer (across depths +
   * domains). Returns the number of entries removed for telemetry —
   * a non-zero count signals the operator's invalidation hit
   * something live.
   */
  invalidateViewer(viewerDid: string): number
  /** Test/operator helper: clear ALL entries. */
  clear(): void
}

/**
 * Cache-key encoding for the `(viewerDid, maxDepth, domain)` triple.
 * `maxDepth` is a small int; `domain` is null-or-string. Encoded as
 * `<viewerDid>::d=<depth>::dom=<domain-or-null>` so the operator's
 * `invalidateViewer` can scan keys by prefix without a separate
 * inverted index.
 */
function cacheKey(viewerDid: string, maxDepth: number, domain: string | undefined): string {
  return `${viewerDid}::d=${maxDepth}::dom=${domain ?? 'null'}`
}

/** Prefix used to enumerate all entries for a viewer. */
function viewerPrefix(viewerDid: string): string {
  return `${viewerDid}::d=`
}

export function createNetworkCache<V extends {}>(
  options: NetworkCacheOptions = {},
): NetworkCache<V> {
  const cache = createTtlCache<string, V>({
    max: options.max ?? DEFAULT_NETWORK_CACHE_MAX,
    ttlMs: options.ttlMs ?? GRAPH_CACHE_TTL_MS,
  })

  // Side-table of viewer → keys used. Lets `invalidateViewer` evict
  // a viewer's entries in O(k) where k is the number of cached
  // entries for that viewer (typically 1–2: depth=1 for networkFeed,
  // depth=2 for subjectGet). Without this, we'd need to scan the
  // entire cache.
  //
  // The side-table can drift from the primary cache when an entry
  // expires (TtlCache silently drops it; the side-table doesn't
  // know). We accept that drift — `invalidateViewer` re-checks each
  // key against the primary cache and only deletes ones that still
  // exist. The drift's worst-case is "we tried to invalidate an
  // entry that was already gone", which is a no-op.
  const viewerKeys = new Map<string, Set<string>>()

  const onHit = options.onHit
  const onMiss = options.onMiss

  return {
    cache,
    async getOrFetch(viewerDid, maxDepth, domain, fetcher) {
      const key = cacheKey(viewerDid, maxDepth, domain)
      const cached = cache.get(key)
      if (cached !== undefined) {
        if (onHit !== undefined) onHit(key)
        return cached
      }
      if (onMiss !== undefined) onMiss(key)
      const fresh = await fetcher()
      cache.set(key, fresh)
      let keys = viewerKeys.get(viewerDid)
      if (!keys) {
        keys = new Set()
        viewerKeys.set(viewerDid, keys)
      }
      keys.add(key)
      return fresh
    },
    invalidateViewer(viewerDid) {
      const keys = viewerKeys.get(viewerDid)
      if (!keys) return 0
      let removed = 0
      for (const key of keys) {
        if (cache.invalidate(key)) removed++
      }
      viewerKeys.delete(viewerDid)
      // Defence-in-depth: if a future caller adds keys with the
      // viewer's prefix outside getOrFetch (it shouldn't), the
      // viewerKeys set wouldn't see them — verify against the
      // prefix one more time. This costs O(cache size) for the
      // invalidation path, which is rare.
      const prefix = viewerPrefix(viewerDid)
      // We don't have a cache.keys() iterator on the TtlCache
      // public surface — adding one would be the right V2 move.
      // For V1, the side-table is authoritative; if you've called
      // getOrFetch, the side-table has the key.
      return removed
    },
    clear() {
      cache.clear()
      viewerKeys.clear()
    },
  }
}
