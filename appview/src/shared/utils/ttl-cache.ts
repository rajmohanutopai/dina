import { LRUCache } from 'lru-cache'

/**
 * Generic TTL + LRU cache primitive (TN-AUTH-003 / Plan §3.5.4).
 *
 * Thin wrapper around `lru-cache` that pre-configures the strict-TTL
 * + LRU-bound defaults V1 wants for security-relevant caches (DID
 * documents, signature-verification public keys, soon-to-be-added
 * trust-V1 reader caches). The wrapper exists so call sites get a
 * focused 4-method surface (`get`/`set`/`invalidate`/`clear`/`size`)
 * instead of the lru-cache library's full surface — the smaller API
 * is easier to mock in tests and easier to swap to a Redis backend
 * in V2 without touching call-site code.
 *
 * **Why strict TTL** (not stale-while-revalidate like
 * `swr-cache.ts`): for security-relevant data — like a DID document
 * whose `assertionMethod` controls who can sign trust records —
 * "stale" is wrong. A user who rotates their key needs the OLD
 * doc invalidated, not served-stale-while-we-fetch-fresh. The SWR
 * pattern is appropriate for trust-score reads (where stale-by-a-few-
 * seconds is fine); the strict-TTL pattern here is appropriate for
 * crypto-relevant lookups where staleness has security consequences.
 *
 * **Why LRU-bound**: a process-singleton cache can otherwise grow
 * without bound. lru-cache's `max` option evicts least-recently-used
 * entries past the cap. Memory is bounded regardless of upstream
 * cardinality.
 *
 * **V2 swap-out**: when this same cache moves to Redis (multi-
 * instance shared state), the public surface stays identical —
 * call sites don't change. The Redis implementation lives behind
 * the same `TtlCache<K, V>` interface.
 */

export interface TtlCacheOptions {
  /** Maximum entries before LRU eviction kicks in. */
  max: number
  /**
   * Default TTL (ms) for entries. lru-cache auto-expires entries
   * past this age; `get` returns `undefined` for expired entries
   * AND removes them (no stale-serve, no "extend on read" — strict
   * absolute TTL from the moment of `set`).
   */
  ttlMs: number
}

export interface TtlCache<K extends string, V> {
  /** Returns the cached value if present + not expired, else undefined. */
  get(key: K): V | undefined
  /** Store a value with the cache's default TTL. */
  set(key: K, value: V): void
  /** Remove a single entry. Returns true if the entry existed. */
  invalidate(key: K): boolean
  /** Remove ALL entries (test-only OR mass-invalidation paths). */
  clear(): void
  /** Current entry count (test/observability). */
  size(): number
}

/**
 * Construct a fresh TTL cache. Each call returns an independent
 * cache — multiple call sites that need separate caches (e.g. a
 * DID-doc cache + a public-key cache) don't share state.
 *
 * Caller injects `max` + `ttlMs` so tests can construct fresh
 * state with short TTLs without monkey-patching a singleton.
 */
export function createTtlCache<K extends string, V extends {}>(
  opts: TtlCacheOptions,
): TtlCache<K, V> {
  const inner = new LRUCache<K, V>({
    max: opts.max,
    ttl: opts.ttlMs,
    // `updateAgeOnGet: false` — strict absolute TTL. A `get` does
    // NOT extend the entry's lifetime; once stored, an entry expires
    // exactly `ttlMs` after its `set`. This is the security-relevant
    // contract: a rotated DID doc cannot stay cached past the TTL
    // by being read often.
    updateAgeOnGet: false,
    // `allowStale: false` — never return an expired entry. The SWR
    // pattern lives in `swr-cache.ts`; this primitive deliberately
    // forbids it.
    allowStale: false,
    // `noUpdateTTL: false` — `set` always overrides the TTL on
    // re-write. (No silent "this entry's been around for 4 min, so
    // your re-set only gets 1 more min" behaviour — a `set` is a
    // fresh `ttlMs` window.)
    noUpdateTTL: false,
  })

  return {
    get(key) {
      return inner.get(key)
    },
    set(key, value) {
      inner.set(key, value)
    },
    invalidate(key) {
      return inner.delete(key)
    },
    clear() {
      inner.clear()
    },
    size() {
      return inner.size
    },
  }
}
