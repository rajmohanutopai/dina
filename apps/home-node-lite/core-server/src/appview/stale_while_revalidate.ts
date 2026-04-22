/**
 * Task 6.16 — cached-fallback + stale-while-revalidate.
 *
 * AppView xRPC calls + PLC resolves both benefit from
 * stale-while-revalidate semantics:
 *
 *   1. **Fresh hit**: entry is within TTL → serve immediately, don't
 *      touch the network.
 *   2. **Stale hit (revalidate in background)**: entry is past TTL
 *      but within `staleTtlMs` → serve the stale value NOW, kick off
 *      an async refresh, replace the cache entry on success.
 *   3. **Stale hit (forced revalidate)**: entry is past TTL +
 *      `mustRevalidate` was set → block until fresh.
 *   4. **Miss**: no entry (or past `staleTtlMs`) → block fetch.
 *   5. **Error fallback**: network fetch throws + a stale entry
 *      exists → serve the stale entry (graceful degradation).
 *   6. **Coalesced in-flight fetches**: two concurrent gets for the
 *      same key share a single underlying fetch.
 *
 * **Why a new primitive?** Raw `fetch` doesn't give us:
 *   - Determinism for tests (inject a clock).
 *   - The 5-branch state machine as a single function — each caller
 *     would otherwise roll its own half-working version.
 *   - Coalescing — two calls from different code paths in the same
 *     tick would otherwise hit the network twice.
 *   - A clean seam between TTL policy (task 6.9) + cache storage.
 *
 * **Pluggable TTL**: caller passes `ttlMsFor(value, key)` so the
 * cache knows how long each entry is fresh. Typical wiring reads
 * the `Cache-Control` from the fetch response via
 * `resolveTtl({cacheControl: resp.headers.get('cache-control'),
 * defaultTtlMs: ...})` (task 6.9). A fixed-TTL cache just returns
 * the same number for every key.
 *
 * **Event stream** exposes every branch so admin-UI can render "N
 * hits (M stale), P misses, Q errors recovered".
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6d task 6.16.
 */

export type SwrSource =
  | 'fresh-hit'
  | 'stale-while-revalidate'
  | 'revalidate-blocking'
  | 'miss'
  | 'error-fallback';

export interface SwrResult<V> {
  value: V;
  source: SwrSource;
  /** Age of the served value in ms. 0 for a freshly-fetched value. */
  ageMs: number;
}

export type SwrFetchFn<K, V> = (key: K) => Promise<V>;

/**
 * Decide TTL for a given value. Can read headers off the value if the
 * fetch returns a structured response, or use a fixed default. Must
 * return a non-negative millisecond number.
 */
export type TtlPolicyFn<K, V> = (value: V, key: K) => number;

export interface SwrCacheOptions<K, V> {
  /** Network fetch — MUST NOT return undefined. Throwing is fine. */
  fetchFn: SwrFetchFn<K, V>;
  /** Per-value TTL policy (see typedoc on `TtlPolicyFn`). */
  ttlMsFn: TtlPolicyFn<K, V>;
  /**
   * How long past TTL the entry can still be served while a
   * background refresh runs. Defaults to `5 * ttl` at the time the
   * entry was written — so a 1-minute-fresh entry can be served
   * stale for up to 5 more minutes.
   *
   * Pass `0` to disable SWR (behave like a plain TTL cache).
   */
  staleTtlMs?: number;
  /**
   * Map the key to a string so the internal Map can use it as an
   * index. Defaults to `String(key)` which works for primitives.
   * Custom key types should pass their own serialiser.
   */
  keyFn?: (key: K) => string;
  /** Injectable clock. Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /** Diagnostic hook. */
  onEvent?: (event: SwrEvent) => void;
}

export type SwrEvent =
  | { kind: 'fresh_hit'; key: string; ageMs: number }
  | { kind: 'stale_served'; key: string; ageMs: number }
  | { kind: 'revalidate_blocking'; key: string }
  | { kind: 'miss'; key: string }
  | { kind: 'revalidate_succeeded'; key: string; durationMs: number }
  | { kind: 'revalidate_failed'; key: string; error: string }
  | { kind: 'coalesced'; key: string }
  | { kind: 'error_fallback'; key: string; error: string; ageMs: number };

interface CacheEntry<V> {
  value: V;
  writtenAtMs: number;
  ttlMs: number;
}

/**
 * Stale-while-revalidate cache. Call `get(key)` — it returns the
 * value as fast as policy allows and handles background refresh
 * transparently.
 *
 * Not thread-safe in the Worker sense, but safe under Node's
 * event-loop concurrency: `get()` returns a cached promise so two
 * synchronous calls in the same tick share one fetch.
 */
export class SwrCache<K, V> {
  private readonly fetchFn: SwrFetchFn<K, V>;
  private readonly ttlMsFn: TtlPolicyFn<K, V>;
  private readonly staleTtlMsDefault: number | null;
  private readonly keyFn: (key: K) => string;
  private readonly nowMsFn: () => number;
  private readonly onEvent?: (event: SwrEvent) => void;
  private readonly entries: Map<string, CacheEntry<V>> = new Map();
  private readonly inFlight: Map<string, Promise<V>> = new Map();

  constructor(opts: SwrCacheOptions<K, V>) {
    if (typeof opts.fetchFn !== 'function') {
      throw new TypeError('SwrCache: fetchFn is required');
    }
    if (typeof opts.ttlMsFn !== 'function') {
      throw new TypeError('SwrCache: ttlMsFn is required');
    }
    this.fetchFn = opts.fetchFn;
    this.ttlMsFn = opts.ttlMsFn;
    this.staleTtlMsDefault = opts.staleTtlMs ?? null;
    this.keyFn = opts.keyFn ?? ((k: K) => String(k));
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    this.onEvent = opts.onEvent;
  }

  /**
   * Fetch-or-return-cached. The main entry point. Each branch
   * corresponds to one `SwrSource` — tests pin the state machine by
   * exercising all five.
   */
  async get(
    key: K,
    opts: { mustRevalidate?: boolean } = {},
  ): Promise<SwrResult<V>> {
    const keyStr = this.keyFn(key);
    const now = this.nowMsFn();
    const entry = this.entries.get(keyStr);

    if (entry) {
      const ageMs = now - entry.writtenAtMs;
      const isFresh = ageMs < entry.ttlMs;
      const staleTtlMs = this.staleTtlMsDefault ?? entry.ttlMs * 5;
      const isWithinStaleWindow = ageMs < entry.ttlMs + staleTtlMs;

      if (isFresh && !opts.mustRevalidate) {
        this.emit({ kind: 'fresh_hit', key: keyStr, ageMs });
        return { value: entry.value, source: 'fresh-hit', ageMs };
      }
      if (!opts.mustRevalidate && isWithinStaleWindow) {
        // Serve stale, start background refresh (coalesced). Attach
        // a terminal no-op catch so a failing background refresh
        // doesn't become an unhandled rejection — the failure is
        // already surfaced via the `revalidate_failed` event + a
        // later blocking get() will retry.
        this.emit({ kind: 'stale_served', key: keyStr, ageMs });
        void this.startRefresh(key, keyStr).catch(() => {});
        return { value: entry.value, source: 'stale-while-revalidate', ageMs };
      }
      // Forced revalidate OR past stale window: block on fresh fetch.
      // If fetch fails, we can still fall back to the (very stale) entry.
      this.emit({ kind: 'revalidate_blocking', key: keyStr });
      try {
        const value = await this.startRefresh(key, keyStr);
        return { value, source: 'revalidate-blocking', ageMs: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit({
          kind: 'error_fallback',
          key: keyStr,
          error: msg,
          ageMs,
        });
        return { value: entry.value, source: 'error-fallback', ageMs };
      }
    }

    // Miss — block on fetch. No fallback available.
    this.emit({ kind: 'miss', key: keyStr });
    const value = await this.startRefresh(key, keyStr);
    return { value, source: 'miss', ageMs: 0 };
  }

  /** Current count of cached entries (fresh + stale). */
  size(): number {
    return this.entries.size;
  }

  /** Remove a specific entry. Returns true if the entry existed. */
  invalidate(key: K): boolean {
    return this.entries.delete(this.keyFn(key));
  }

  /** Remove every entry. Useful for test teardown + admin "purge cache". */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Peek at the stored entry without touching TTL logic or refreshing.
   * Returns null for unknown keys. Intended for admin UI + tests.
   */
  peek(key: K): { value: V; writtenAtMs: number; ttlMs: number } | null {
    const entry = this.entries.get(this.keyFn(key));
    return entry
      ? {
          value: entry.value,
          writtenAtMs: entry.writtenAtMs,
          ttlMs: entry.ttlMs,
        }
      : null;
  }

  // ── Internals ────────────────────────────────────────────────────────

  /**
   * Start (or join) a refresh for `key`. Multiple concurrent calls
   * coalesce to one underlying fetch. Writes the entry on success;
   * re-throws on failure (caller decides whether to fall back).
   */
  private startRefresh(key: K, keyStr: string): Promise<V> {
    const existing = this.inFlight.get(keyStr);
    if (existing) {
      this.emit({ kind: 'coalesced', key: keyStr });
      return existing;
    }
    const startMs = this.nowMsFn();
    const promise = this.fetchFn(key)
      .then((value) => {
        const ttlMs = this.ttlMsFn(value, key);
        if (!Number.isFinite(ttlMs) || ttlMs < 0) {
          throw new RangeError(
            `SwrCache: ttlMsFn returned non-finite / negative value: ${ttlMs}`,
          );
        }
        this.entries.set(keyStr, {
          value,
          writtenAtMs: this.nowMsFn(),
          ttlMs,
        });
        this.emit({
          kind: 'revalidate_succeeded',
          key: keyStr,
          durationMs: this.nowMsFn() - startMs,
        });
        return value;
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit({ kind: 'revalidate_failed', key: keyStr, error: msg });
        throw err;
      })
      .finally(() => {
        this.inFlight.delete(keyStr);
      });
    this.inFlight.set(keyStr, promise);
    return promise;
  }

  private emit(event: SwrEvent): void {
    this.onEvent?.(event);
  }
}
