/**
 * DID-document cache (TN-AUTH-003 / Plan §3.5.4).
 *
 * Caches resolved DID documents (PLC directory or did:web) with a
 * 5-minute TTL. The cache sits in front of any HTTP-backed
 * `did_resolver`. The ingester's namespace-key signature gate
 * (TN-ING-003) routes every namespace-bearing record's lookup
 * through `getOrFetch(did, fetcher)`, hitting the cache for 99% of
 * requests and fetching fresh when missed / expired.
 *
 * **Why 5-minute TTL** (Plan §3.5.4 + threat-model §3.3): caps the
 * post-key-rotation frontrun window. A user who rotates their
 * signing key can keep the old key valid for at most 5 minutes
 * after publishing the rotation to PLC, then the AppView re-fetches
 * and starts rejecting signatures from the old key. Threat model
 * §3.3 explicitly accepts this trade-off — proactive rotation
 * (rotate BEFORE you suspect compromise) bypasses the window.
 *
 * **Why no stale-while-revalidate**: for security-relevant data,
 * stale is wrong. SWR is correct for trust-score reads; strict TTL
 * is correct for crypto-relevant lookups. See `ttl-cache.ts`'s
 * docstring for the full rationale.
 *
 * **`invalidate(did)` is the operator escape hatch**: when a DID
 * compromise is reported and the user rotates keys, the operator
 * can force a cache flush for that DID via the admin path (V1
 * implementation pending; the cache method exposes the surface
 * for the eventual CLI). Until that CLI lands, operators wait the
 * 5-minute TTL OR restart the Web process (which resets the
 * in-memory cache wholesale — see ops-runbook.md §3).
 *
 * **`getOrFetch(did, fetcher)` is the canonical use site**: the
 * caller passes a fetcher closure that performs the actual HTTP
 * resolution. Cache hits short-circuit the fetcher; cache misses
 * call it and store the result. This keeps the cache module
 * fetcher-agnostic — TN-ING-003 wires in the PLC client at boot
 * via `JetstreamConsumer.setNamespaceGate(...)` without changing
 * this file.
 *
 * **Negative-result caching**: a fetch that fails (DID not found
 * in PLC; network error) does NOT get cached. The fetcher's error
 * propagates to the caller; subsequent gets repeat the fetch.
 * Negative caching is V2 work — V1's posture is "if PLC's down, we
 * fail loudly rather than serve cached `null`s for an hour".
 *
 * **V2 Redis swap-out**: when the cache moves to Redis (multi-
 * instance deployments need shared state for consistent rotation
 * propagation), this file's exported surface stays identical —
 * just the underlying `TtlCache<K, V>` swaps. Call sites don't
 * change.
 */

import { createTtlCache, type TtlCache } from './ttl-cache.js'

/**
 * Locally-mirrored DIDDocument shape. AppView is not an npm
 * workspace member (see `subject-get.ts` MIRROR pattern), so it
 * can't `import '@dina/protocol'` — we redeclare just the fields
 * the cache layer cares about. The full schema lives in
 * `packages/protocol/src/types/plc_document.ts`; if the protocol
 * adds fields, this mirror only needs to follow when the AppView
 * actually starts reading them.
 *
 * V1 caches the resolved doc as an opaque object — the consumer
 * (TN-ING-003 namespace-key signature gate) does its own typed
 * extraction via `resolveAssertionMethod` before key extraction.
 * `Record<string, unknown>` as the value type keeps the cache
 * primitive resolver-agnostic; tighten the type when integration
 * decisions land.
 */
export interface DIDDocument {
  id: string
  verificationMethod?: ReadonlyArray<unknown>
  assertionMethod?: ReadonlyArray<unknown>
  [key: string]: unknown
}

/** Plan §3.5.4 — 5-minute TTL on cached DID documents. */
export const DID_DOC_CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Per-deployment LRU bound. 50k DIDs × ~2KB per resolved doc ≈ 100MB
 * worst case — generous for V1 cohort sizes (10–50 users in soak;
 * 100–1000 in Phase 2). Larger deployments override via
 * `createDidDocCache({ max: ... })`.
 */
export const DEFAULT_DID_DOC_CACHE_MAX = 50_000

export interface DidDocCacheOptions {
  /** Override the default LRU bound. */
  max?: number
  /** Override the default 5-minute TTL (ms). Tests use shorter values. */
  ttlMs?: number
}

export interface DidDocCache {
  /** Cache primitive surface — get / set / invalidate / clear / size. */
  cache: TtlCache<string, DIDDocument>
  /**
   * Cache-aware resolver. Returns the cached doc if fresh; otherwise
   * calls `fetcher`, stores the result, and returns it. Errors from
   * `fetcher` propagate (no negative caching in V1).
   */
  getOrFetch(
    did: string,
    fetcher: (did: string) => Promise<DIDDocument>,
  ): Promise<DIDDocument>
  /** Operator-facing forced invalidation (post-rotation incident). */
  invalidate(did: string): boolean
}

/**
 * Construct a fresh DID-doc cache. Each call returns an independent
 * cache. The process-singleton lives in `appview/src/index.ts`'s
 * boot sequence (when TN-ING-003 wires up); this factory keeps the
 * shape testable + dependency-injectable.
 */
export function createDidDocCache(options: DidDocCacheOptions = {}): DidDocCache {
  const cache = createTtlCache<string, DIDDocument>({
    max: options.max ?? DEFAULT_DID_DOC_CACHE_MAX,
    ttlMs: options.ttlMs ?? DID_DOC_CACHE_TTL_MS,
  })

  return {
    cache,
    async getOrFetch(did, fetcher) {
      const cached = cache.get(did)
      if (cached !== undefined) return cached
      // Fetcher errors propagate — no try/catch, no negative caching.
      // Operators want to know when PLC is unreachable, not silently
      // serve a stale-or-null doc.
      const fresh = await fetcher(did)
      cache.set(did, fresh)
      return fresh
    },
    invalidate(did) {
      return cache.invalidate(did)
    },
  }
}
