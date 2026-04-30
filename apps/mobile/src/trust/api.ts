/**
 * Mobile trust API facade (TN-MOB-001).
 *
 * A thin pub/sub layer on top of `@dina/core/trust` that mobile screens
 * use to read trust scores + search results without each screen
 * re-implementing cache lookup + fetch + cache-key derivation.
 *
 * Surface:
 *   - `subscribeTrust(did, listener)` — listener fires with the
 *     current cached score immediately (after an async cache lookup),
 *     and re-fires on every later invalidate / refresh that changes
 *     the cached value.
 *   - `subscribeTrustSearch(query, listener)` — same pattern for
 *     trust-network search results.
 *   - `invalidateTrust(did)` — drops the cache entry and notifies all
 *     subscribers with the freshly-fetched value.
 *   - `invalidateTrustSearch(query)` — same for searches.
 *   - `invalidateAll()` — bulk invalidate (e.g. on persona switch or
 *     "pull to refresh" on the Trust tab).
 *
 * Design notes:
 *
 *   - Pub/sub state lives module-level. This matches `@dina/core/trust/cache`
 *     (also module-level) and avoids the "which instance is canonical?"
 *     ambiguity an instantiated store would introduce on a mobile app
 *     where the trust state is fundamentally a singleton anchored to
 *     the active persona.
 *   - Search subscribers are stored alongside the query object that
 *     produced their canonical key. This is what lets `invalidateAll`
 *     re-run live searches — the alternative (key-only storage) would
 *     either silently no-op or notify with `null`, both of which are
 *     wrong on a "pull to refresh" gesture.
 *   - The facade does NOT take a React dependency. React hooks
 *     (`useTrustScore`, `useTrustSearch`) are a separate file in the
 *     screens layer that wraps `subscribeTrust` in `useState` /
 *     `useEffect`. Keeping the facade React-free means it tests
 *     under plain Jest and the same primitives are reusable from
 *     non-React contexts (background workers, the briefing pipeline).
 *   - `subscribeTrust` returns an unsubscribe function. Callers MUST
 *     call it on unmount; leaking subscribers leaks the listener +
 *     keeps the entry "live" beyond its useful lifetime. Unsubscribe
 *     is idempotent — calling twice is a no-op.
 *
 * What's intentionally NOT here (and where it lives instead):
 *   - The wire-format types (`TrustProfile`, `TrustReview`, etc.) —
 *     re-exported from `@dina/core` via this file's surface.
 *   - The actual cache + KV machinery — `@dina/core/trust/cache`.
 *   - The xRPC client (`TrustQueryClient`) — `@dina/core/trust/query_client`.
 *   - Mobile-specific state tied to React lifecycle — those `useX`
 *     hooks belong in `apps/mobile/app/trust/_hooks.ts` or similar
 *     once the screens land (TN-MOB-011…017).
 */

import {
  getCachedTrust,
  refreshTrust,
  invalidateTrust as coreInvalidateTrust,
  searchTrustNetwork,
  dropSearchCache,
  type TrustScore,
  type TrustSearchQuery,
  type TrustSearchResult,
} from '@dina/core';

// Re-export the wire types so consumers don't need a parallel import.
export type {
  TrustScore,
  TrustProfile,
  TrustSearchQuery,
  TrustSearchResult,
  TrustSearchFilters,
  TrustReview,
} from '@dina/core';

type TrustListener = (score: TrustScore | null) => void;
type SearchListener = (result: TrustSearchResult | null) => void;

interface SearchEntry {
  /**
   * The query that produced this entry's canonical key. Stored so
   * `invalidateAll` can re-run live searches — the canonical key
   * alone is irreversible.
   */
  query: TrustSearchQuery;
  listeners: Set<SearchListener>;
}

// ─── Pub/sub state ────────────────────────────────────────────────────────

const trustSubscribers = new Map<string, Set<TrustListener>>();
const searchSubscribers = new Map<string, SearchEntry>();

/**
 * Reset all subscribers (test-only). Production callers should rely
 * on the unsubscribe functions returned by the `subscribe*` calls.
 */
export function resetTrustApiSubscribers(): void {
  trustSubscribers.clear();
  searchSubscribers.clear();
}

// ─── Trust score subscriptions ────────────────────────────────────────────

/**
 * Subscribe to trust-score updates for a single DID.
 *
 * Behaviour:
 *   1. The listener is added to the per-DID subscriber set.
 *   2. An initial cache lookup runs asynchronously. The listener fires
 *      once with whatever the cache holds (`null` on miss).
 *   3. The listener fires again on every subsequent `invalidateTrust(did)`
 *      or `invalidateAll()` that targets this DID, with the freshly-
 *      fetched value (or `null` if the fetch failed).
 *
 * Returns an idempotent unsubscribe function. Call it on unmount.
 */
export function subscribeTrust(did: string, listener: TrustListener): () => void {
  if (typeof did !== 'string' || did.length === 0) {
    throw new Error('subscribeTrust: did must be a non-empty string');
  }

  let set = trustSubscribers.get(did);
  if (!set) {
    set = new Set();
    trustSubscribers.set(did, set);
  }
  set.add(listener);

  // Fire-and-forget initial load. The listener gets `null` on miss; a
  // subsequent `invalidateTrust(did)` is what brings it up-to-date,
  // following the read-through cache pattern.
  void getCachedTrust(did)
    .then((score) => {
      // Guard against the listener having been removed before the
      // async lookup completed — calling a stale listener would be a
      // memory hazard on hot UIs that re-mount frequently.
      if (set.has(listener)) listener(score);
    })
    .catch(() => {
      // KV failure during initial read: deliver `null` so the UI
      // renders a consistent "unrated" state rather than hanging.
      if (set.has(listener)) listener(null);
    });

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const s = trustSubscribers.get(did);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) trustSubscribers.delete(did);
  };
}

/**
 * Drop a DID's cached trust entry, refetch from AppView, and notify
 * every active subscriber with the new value (or `null` on fetch
 * failure).
 *
 * Always drops the cache so a later subscribe sees fresh state — even
 * when there are no live subscribers right now.
 */
export async function invalidateTrust(did: string): Promise<void> {
  await coreInvalidateTrust(did);
  const fresh = await refreshTrust(did);
  notifyTrust(did, fresh);
}

function notifyTrust(did: string, score: TrustScore | null): void {
  const set = trustSubscribers.get(did);
  if (!set) return;
  // Snapshot so a listener that unsubscribes itself mid-iteration
  // doesn't mutate the live set we're walking.
  for (const l of [...set]) l(score);
}

// ─── Trust search subscriptions ───────────────────────────────────────────

/**
 * Build the canonical cache key for a `TrustSearchQuery`. Identical
 * queries produce identical keys regardless of object-property
 * ordering (alphabetised) so two screens issuing the same logical
 * search share state instead of fragmenting.
 *
 * Filter values are primitives (`TrustSearchFilters`), so a sorted
 * `Object.entries` -> `JSON.stringify` is canonical. If filters ever
 * grow nested objects, this needs a stable nested stringifier.
 */
function searchKey(query: TrustSearchQuery): string {
  const entries = Object.entries(query as unknown as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Subscribe to trust-network search results for a query. Same
 * lifecycle as `subscribeTrust`: initial async load, re-fire on
 * invalidate, idempotent unsubscribe.
 *
 * Note: `searchTrustNetwork` itself caches by its own key inside
 * `@dina/core/trust/network_search`. The facade's job is to bridge
 * that cache to listeners — the underlying cache stays the single
 * source of truth for the latest result.
 */
export function subscribeTrustSearch(
  query: TrustSearchQuery,
  listener: SearchListener,
): () => void {
  const key = searchKey(query);

  let entry = searchSubscribers.get(key);
  if (!entry) {
    entry = { query, listeners: new Set() };
    searchSubscribers.set(key, entry);
  }
  entry.listeners.add(listener);

  void searchTrustNetwork(query)
    .then((result) => {
      if (entry.listeners.has(listener)) listener(result);
    })
    .catch(() => {
      if (entry.listeners.has(listener)) listener(null);
    });

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const e = searchSubscribers.get(key);
    if (!e) return;
    e.listeners.delete(listener);
    if (e.listeners.size === 0) searchSubscribers.delete(key);
  };
}

/**
 * Drop the underlying search cache row, re-issue the search against
 * the network, and notify subscribers with the fresh result (or
 * `null` if the fetch fails).
 *
 * `dropSearchCache` is what makes this an actual invalidation rather
 * than a cache-replay — without it, the underlying TTL-bound cache
 * inside `@dina/core/trust/network_search` would return the same
 * stale value on the re-issue and subscribers would never see fresh
 * data within the TTL window.
 */
export async function invalidateTrustSearch(query: TrustSearchQuery): Promise<void> {
  const key = searchKey(query);
  dropSearchCache(query);
  const fresh = await safeSearch(query);
  notifySearch(key, fresh);
}

function notifySearch(key: string, result: TrustSearchResult | null): void {
  const entry = searchSubscribers.get(key);
  if (!entry) return;
  for (const l of [...entry.listeners]) l(result);
}

async function safeSearch(query: TrustSearchQuery): Promise<TrustSearchResult | null> {
  try {
    return await searchTrustNetwork(query);
  } catch {
    return null;
  }
}

// ─── Bulk invalidate ──────────────────────────────────────────────────────

/**
 * Invalidate every active subscription — both trust scores and
 * searches. Used on persona switch, "pull to refresh" on the Trust
 * tab, or when the user manually requests a full reload.
 *
 * Runs invalidations in parallel — there's no inter-dependency
 * between trust entries and the per-DID/per-query failures don't
 * cascade. We rely on the per-call `try/catch` (via `safeSearch`) and
 * `refreshTrust` returning `null` on error so one bad fetch can't
 * sink the rest.
 *
 * Snapshots both maps before iterating: subscribers may unsubscribe
 * synchronously inside their listener (e.g. on persona-switch the
 * UI tears down screens during the very pump that triggered this
 * call) and we don't want to skip entries because the live map shrunk
 * mid-walk.
 */
export async function invalidateAll(): Promise<void> {
  const trustDids = [...trustSubscribers.keys()];
  const searches = [...searchSubscribers.values()].map((e) => e.query);

  const trustOps = trustDids.map((did) => invalidateTrust(did));
  const searchOps = searches.map((q) => invalidateTrustSearch(q));

  await Promise.all([...trustOps, ...searchOps]);
}

// ─── Test-only introspection ──────────────────────────────────────────────

/**
 * Snapshot the current subscriber counts. Test-only — production
 * code should not depend on subscriber accounting.
 */
export function _trustApiSubscriberCounts(): {
  trustDids: number;
  searchKeys: number;
  trustListeners: number;
  searchListeners: number;
} {
  let trustListeners = 0;
  for (const set of trustSubscribers.values()) trustListeners += set.size;
  let searchListeners = 0;
  for (const entry of searchSubscribers.values()) searchListeners += entry.listeners.size;
  return {
    trustDids: trustSubscribers.size,
    searchKeys: searchSubscribers.size,
    trustListeners,
    searchListeners,
  };
}
