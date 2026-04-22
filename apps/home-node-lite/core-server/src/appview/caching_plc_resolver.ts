/**
 * Task 6.10 — CachingPLCResolver integration.
 *
 * Wraps `resolveDid` (task 6.6) with stale-while-revalidate caching
 * (`SwrCache` task 6.16) and Cache-Control-aware TTL (`resolveTtl`
 * task 6.9). Production Brain / Core calls `resolver.resolve(did)`
 * instead of `resolveDid(did, fetch)` directly — the cache handles
 * the rest.
 *
 * **Pattern** (pinned by tests):
 *
 *   1. First call → miss → fetch → store with TTL from header or
 *      default (1h per task spec).
 *   2. Call within TTL → fresh hit, no network.
 *   3. Call past TTL but within stale window → SWR: serve stale,
 *      refresh in background.
 *   4. Call past stale window → blocking refetch.
 *   5. Refetch fails with a stale entry → error-fallback (serve
 *      stale).
 *   6. `not_found` results are cached (with a short negative TTL
 *      by default) so every lookup of a bad DID doesn't hammer PLC.
 *
 * **Mid-level input**: the caller supplies a `fetchWithHeadersFn`
 * that returns both the body + the `Cache-Control` header value.
 * The resolver combines the body through `resolveDid` + feeds the
 * header to `resolveTtl` so per-response TTLs override the default
 * 1h.
 *
 * **Negative-cache TTL**: the default 60s for `not_found` lookups
 * balances "user mistyped their did" (short — they'll retype) vs.
 * "bot scanning nonexistent DIDs" (cache to absorb the pressure).
 *
 * **Errors** don't land in the cache — a network error always
 * blocks + returns the error to the caller (with fallback to a
 * stale entry when one exists). Bad-DID input rejects without
 * hitting the network.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6c task 6.10.
 */

import { resolveTtl, PLC_DEFAULT_TTL_MS } from './cache_ttl';
import {
  parsePlcDoc,
  validatePlcDid,
  type Did,
  type PlcDoc,
} from './plc_resolver';
import {
  SwrCache,
  type SwrCacheOptions,
  type SwrEvent,
} from './stale_while_revalidate';

/** One outcome stored in the cache — either a valid doc or a negative hit. */
export type PlcCacheEntry =
  | { kind: 'found'; doc: PlcDoc }
  | { kind: 'not_found' };

export interface FetchWithHeadersResult {
  /** Parsed JSON body, or null on 404. */
  body: Record<string, unknown> | null;
  /** Raw `Cache-Control` header value, if present. */
  cacheControl?: string | null;
}

export type FetchWithHeadersFn = (did: Did) => Promise<FetchWithHeadersResult>;

export interface CachingPlcResolverOptions {
  fetchFn: FetchWithHeadersFn;
  /** Default fresh TTL when header absent. Defaults to 1h (matches task 6.9). */
  defaultTtlMs?: number;
  /** Max TTL cap (the server can't pin us past this). Defaults to 24h. */
  maxTtlMs?: number;
  /**
   * Negative-cache TTL for `not_found`. Defaults to 60s.
   * Short because a 404 is likely transient-ish (DID being
   * provisioned, handle resolution race).
   */
  notFoundTtlMs?: number;
  /** Stale window past TTL. Defaults to 5× TTL. */
  staleTtlMs?: number;
  nowMsFn?: () => number;
  onEvent?: (event: CachingPlcResolverEvent) => void;
}

export type CachingPlcResolverEvent =
  | { kind: 'resolved'; did: Did; outcome: 'found' | 'not_found' | 'invalid_did' | 'network_error' }
  | SwrEvent;

export type CachingResolveOutcome =
  | { ok: true; doc: PlcDoc; source: PlcSourceTag; ageMs: number }
  | { ok: false; kind: 'invalid_did'; detail: string }
  | { ok: false; kind: 'not_found'; source: PlcSourceTag; ageMs: number }
  | { ok: false; kind: 'malformed_doc'; detail: string }
  | { ok: false; kind: 'network_error'; error: string };

export type PlcSourceTag =
  | 'fresh'
  | 'stale-while-revalidate'
  | 'network'
  | 'error-fallback';

export const DEFAULT_NOT_FOUND_TTL_MS = 60 * 1000;

/**
 * Caching PLC resolver. One instance per Brain process. Thread-safe
 * in the Node single-threaded sense — concurrent `resolve(did)` for
 * the same DID coalesces via `SwrCache`'s in-flight map.
 */
export class CachingPlcResolver {
  private readonly fetchFn: FetchWithHeadersFn;
  private readonly defaultTtlMs: number;
  private readonly maxTtlMs: number;
  private readonly notFoundTtlMs: number;
  private readonly onEvent?: (event: CachingPlcResolverEvent) => void;
  /** Stores per-entry TTL alongside the cache value for resolveTtl-based overrides. */
  private readonly cache: SwrCache<Did, CachedEntry>;

  constructor(opts: CachingPlcResolverOptions) {
    if (typeof opts?.fetchFn !== 'function') {
      throw new TypeError('CachingPlcResolver: fetchFn is required');
    }
    this.fetchFn = opts.fetchFn;
    this.defaultTtlMs = opts.defaultTtlMs ?? PLC_DEFAULT_TTL_MS;
    this.maxTtlMs = opts.maxTtlMs ?? 24 * 60 * 60 * 1000;
    this.notFoundTtlMs = opts.notFoundTtlMs ?? DEFAULT_NOT_FOUND_TTL_MS;
    this.onEvent = opts.onEvent;

    const swrOpts: SwrCacheOptions<Did, CachedEntry> = {
      fetchFn: (did) => this.fetchAndWrap(did),
      // Each cached entry remembers its own TTL — SwrCache's ttlMsFn
      // reads it back.
      ttlMsFn: (cached) => cached.ttlMs,
      nowMsFn: opts.nowMsFn ?? (() => Date.now()),
      onEvent: (e) => this.onEvent?.(e),
    };
    if (opts.staleTtlMs !== undefined) swrOpts.staleTtlMs = opts.staleTtlMs;
    this.cache = new SwrCache<Did, CachedEntry>(swrOpts);
  }

  /** Resolve a DID via the cache. Never throws. */
  async resolve(did: Did, opts: { mustRevalidate?: boolean } = {}): Promise<CachingResolveOutcome> {
    let normalised: Did;
    try {
      normalised = validatePlcDid(did);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onEvent?.({ kind: 'resolved', did: String(did ?? ''), outcome: 'invalid_did' });
      return { ok: false, kind: 'invalid_did', detail: msg };
    }

    let swrResult: Awaited<ReturnType<typeof this.cache.get>>;
    try {
      swrResult = await this.cache.get(normalised, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onEvent?.({ kind: 'resolved', did: normalised, outcome: 'network_error' });
      return { ok: false, kind: 'network_error', error: msg };
    }

    const source = mapSource(swrResult.source);
    const entry = swrResult.value.entry;
    if (entry.kind === 'found') {
      this.onEvent?.({ kind: 'resolved', did: normalised, outcome: 'found' });
      return { ok: true, doc: entry.doc, source, ageMs: swrResult.ageMs };
    }
    this.onEvent?.({ kind: 'resolved', did: normalised, outcome: 'not_found' });
    return { ok: false, kind: 'not_found', source, ageMs: swrResult.ageMs };
  }

  /** Drop a specific DID's cached entry. Returns `true` if present. */
  invalidate(did: Did): boolean {
    try {
      const normalised = validatePlcDid(did);
      return this.cache.invalidate(normalised);
    } catch {
      return false;
    }
  }

  /** Drop every cached entry. */
  clear(): void {
    this.cache.clear();
  }

  /** Number of cached entries. */
  size(): number {
    return this.cache.size();
  }

  // ── Internals ────────────────────────────────────────────────────────

  /**
   * Internal fetch wrapper used by SwrCache. Calls the caller's
   * fetcher, parses the doc, decides TTL from the response header,
   * and produces a `CachedEntry` with the right TTL baked in.
   */
  private async fetchAndWrap(did: Did): Promise<CachedEntry> {
    const raw = await this.fetchFn(did);
    if (raw.body === null) {
      return {
        entry: { kind: 'not_found' },
        ttlMs: this.notFoundTtlMs,
      };
    }
    const doc = parsePlcDoc(raw.body);
    if (doc === null || doc.did !== did) {
      // Malformed-looking responses are NOT cached — we want a fresh
      // try on the next call. Throw so SwrCache treats it as a fetch
      // failure; callers get `network_error`.
      throw new Error('malformed PLC doc');
    }
    const ttl = resolveTtl({
      cacheControl: raw.cacheControl ?? null,
      defaultTtlMs: this.defaultTtlMs,
      maxTtlMs: this.maxTtlMs,
    });
    // `no-store` → don't cache; we model this with a 0 TTL so SwrCache
    // treats it as immediately stale + never fresh. The caller sees
    // one extra fetch per request but no caching — correct per RFC.
    const effectiveTtl = ttl.storable ? ttl.ttlMs : 0;
    return {
      entry: { kind: 'found', doc },
      ttlMs: effectiveTtl,
    };
  }
}

// ── Internals ──────────────────────────────────────────────────────────

interface CachedEntry {
  entry: PlcCacheEntry;
  ttlMs: number;
}

function mapSource(
  s:
    | 'fresh-hit'
    | 'stale-while-revalidate'
    | 'revalidate-blocking'
    | 'miss'
    | 'error-fallback',
): PlcSourceTag {
  switch (s) {
    case 'fresh-hit':
      return 'fresh';
    case 'stale-while-revalidate':
      return 'stale-while-revalidate';
    case 'error-fallback':
      return 'error-fallback';
    case 'miss':
    case 'revalidate-blocking':
      return 'network';
  }
}
