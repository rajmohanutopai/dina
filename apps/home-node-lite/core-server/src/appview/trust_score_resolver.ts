/**
 * Task 6.21 — `getTrustScore(did)` + cache.
 *
 * Brain calls AppView's `com.dina.trust.resolve` to get a subject's
 * trust score before:
 *   - Sending a `service.query` to a newly-discovered provider.
 *   - Ranking candidate contacts for a nudge.
 *   - Surfacing a review in the admin UI.
 *
 * Hitting AppView on every call is wasteful — trust scores move on
 * the scale of hours, not milliseconds. This resolver wraps the
 * `SwrCache` (task 6.16) with a purpose-built API: `getTrustScore(did)`
 * returns a `{score, confidence, ring, flagCount, source}` tuple
 * immediately from cache, kicking off a background refresh if the
 * entry is stale.
 *
 * **Integration points**:
 *   - Input to `decideTrust()` (task 6.23) — the action router
 *     consumes the resolved score + ring.
 *   - Companion to `CachingPLCResolver` (task 6.10) — same SWR
 *     pattern, different source.
 *
 * **TTL policy**: configurable at construction. Default 10 minutes
 * fresh + 60 minutes stale window. The fresh TTL is short enough
 * that a new attestation propagates within an hour; the stale
 * window keeps us functional during AppView outages.
 *
 * **Cache invalidation**: `invalidate(did)` for manual refresh (e.g.
 * admin UI "re-fetch trust"). `clear()` empties the cache (e.g.
 * on identity rotation).
 *
 * **Unknown-subject handling**: when AppView reports no data for a
 * DID (404-equivalent), the resolver returns a structured `null`
 * score + `null` confidence with `source: 'unknown'`. Callers
 * translate that to `decideTrust`'s "unknown" branch.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6f task 6.21.
 */

import { SwrCache, type SwrEvent } from './stale_while_revalidate';

export type Did = string;

/**
 * Outcome of an AppView trust lookup. `found` is the typical path;
 * `unknown` covers the "no data available" case AppView can legitimately
 * return for a brand-new DID or one flagged out of the graph.
 */
export type TrustLookupOutcome =
  | {
      kind: 'found';
      score: number;
      confidence: number;
      /** Optional social-graph ring (1/2/3). Not always available. */
      ring?: 1 | 2 | 3;
      /** Count of open flags against the subject. */
      flagCount: number;
    }
  | { kind: 'unknown' };

/**
 * Fetcher the resolver calls to refresh. Production wires this to
 * `AppViewClient.trustResolve(did)`; tests pass scripted stubs.
 * Throw on network / HTTP errors — the cache will fall back to
 * stale.
 */
export type TrustFetchFn = (did: Did) => Promise<TrustLookupOutcome>;

/** Answer returned from the resolver — enriched with SWR provenance. */
export interface TrustScore {
  did: Did;
  score: number | null;
  confidence: number | null;
  ring: 1 | 2 | 3 | null;
  flagCount: number;
  /**
   * Where this answer came from.
   *   - `fresh` → cache hit within TTL.
   *   - `stale-while-revalidate` → served stale while a background
   *     refresh runs.
   *   - `network` → freshly fetched (miss or explicit revalidate).
   *   - `error-fallback` → network failed + we served the last-known
   *     value past its stale window.
   *   - `unknown` → AppView reports no data for this DID.
   */
  source:
    | 'fresh'
    | 'stale-while-revalidate'
    | 'network'
    | 'error-fallback'
    | 'unknown';
  /** Age of the served score in ms. 0 for a freshly-fetched value. */
  ageMs: number;
}

export interface TrustScoreResolverOptions {
  fetchFn: TrustFetchFn;
  /** Fresh window — default 10 min. */
  ttlMs?: number;
  /**
   * How long past `ttlMs` the entry is served stale while
   * background-refreshing. Default 60 min.
   */
  staleTtlMs?: number;
  nowMsFn?: () => number;
  onEvent?: (event: TrustResolverEvent) => void;
}

export type TrustResolverEvent =
  | { kind: 'resolved'; did: Did; source: TrustScore['source']; score: number | null }
  | SwrEvent;

export const DEFAULT_TRUST_TTL_MS = 10 * 60 * 1000; // 10 min fresh
export const DEFAULT_TRUST_STALE_TTL_MS = 60 * 60 * 1000; // 60 min stale window

export class TrustScoreResolver {
  private readonly cache: SwrCache<Did, TrustLookupOutcome>;
  private readonly onEvent?: (event: TrustResolverEvent) => void;
  private readonly nowMsFn: () => number;

  constructor(opts: TrustScoreResolverOptions) {
    if (typeof opts?.fetchFn !== 'function') {
      throw new TypeError('TrustScoreResolver: fetchFn is required');
    }
    this.onEvent = opts.onEvent;
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    const ttlMs = opts.ttlMs ?? DEFAULT_TRUST_TTL_MS;
    const staleTtlMs = opts.staleTtlMs ?? DEFAULT_TRUST_STALE_TTL_MS;
    this.cache = new SwrCache<Did, TrustLookupOutcome>({
      fetchFn: (did) => opts.fetchFn(did),
      ttlMsFn: () => ttlMs,
      staleTtlMs,
      nowMsFn: this.nowMsFn,
      // Forward SWR internals to callers who want them — admin UI
      // renders "fresh hit / stale served / revalidate failed"
      // counts.
      onEvent: (e) => this.onEvent?.(e),
    });
  }

  /**
   * Fetch-or-return-cached trust score for `did`. Always resolves —
   * network errors with no stale entry throw, but callers typically
   * wrap this in a `decideTrust()` call that treats throws as
   * "unknown". Passing `{mustRevalidate: true}` forces a blocking
   * refresh.
   */
  async getTrustScore(
    did: Did,
    opts: { mustRevalidate?: boolean } = {},
  ): Promise<TrustScore> {
    if (typeof did !== 'string' || did === '') {
      throw new TypeError('TrustScoreResolver.getTrustScore: did is required');
    }
    const result = await this.cache.get(did, opts);
    const score = toTrustScore(did, result.value, result.source, result.ageMs);
    this.onEvent?.({
      kind: 'resolved',
      did,
      source: score.source,
      score: score.score,
    });
    return score;
  }

  /**
   * Drop the cached entry for `did`. Next `getTrustScore` will miss
   * and refetch. Returns `true` if an entry was present.
   */
  invalidate(did: Did): boolean {
    return this.cache.invalidate(did);
  }

  /** Drop every cached entry. */
  clear(): void {
    this.cache.clear();
  }

  /** Count of cached entries. */
  size(): number {
    return this.cache.size();
  }
}

// ── Internals ──────────────────────────────────────────────────────────

/**
 * Map an SWR cache result + lookup outcome to the enriched
 * `TrustScore` view. `source` is normalised: SWR's `miss` /
 * `revalidate-blocking` both collapse to `'network'` since the
 * caller doesn't need to distinguish (both are a fresh fetch).
 */
function toTrustScore(
  did: Did,
  outcome: TrustLookupOutcome,
  swrSource:
    | 'fresh-hit'
    | 'stale-while-revalidate'
    | 'revalidate-blocking'
    | 'miss'
    | 'error-fallback',
  ageMs: number,
): TrustScore {
  if (outcome.kind === 'unknown') {
    return {
      did,
      score: null,
      confidence: null,
      ring: null,
      flagCount: 0,
      source: 'unknown',
      ageMs,
    };
  }
  let source: TrustScore['source'];
  switch (swrSource) {
    case 'fresh-hit':
      source = 'fresh';
      break;
    case 'stale-while-revalidate':
      source = 'stale-while-revalidate';
      break;
    case 'error-fallback':
      source = 'error-fallback';
      break;
    case 'miss':
    case 'revalidate-blocking':
      source = 'network';
      break;
  }
  return {
    did,
    score: outcome.score,
    confidence: outcome.confidence,
    ring: outcome.ring ?? null,
    flagCount: outcome.flagCount,
    source,
    ageMs,
  };
}
