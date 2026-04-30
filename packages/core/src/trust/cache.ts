/**
 * Trust cache — trust score caching with 1-hour TTL + LRU eviction.
 *
 * Caches trust profiles fetched from the AppView xRPC endpoint.
 * Each entry has a 1-hour TTL. Background refresh updates stale entries
 * without blocking the caller (serve stale + refresh async).
 *
 * Backed by the KV store for persistence across app restarts.
 *
 * Eviction (TN-MOB-006): the in-memory `cacheTimestamps` map enforces
 * an LRU cap of `MAX_TRUST_CACHE_ENTRIES`. On insert, if size exceeds
 * the cap, the oldest entry is evicted from both memory AND the KV
 * backing store. Reads bump the accessed entry to "most-recent" via
 * Map's insertion-order semantics. On memory pressure (Mobile's
 * `AppState.memoryWarning`), callers invoke `evictTrustCacheTo()` to
 * drop the cache down to a smaller resident set.
 *
 * Source: ARCHITECTURE.md Task 9.2
 */

import { kvGet, kvSet, kvDelete } from '../kv/store';
import { TRUST_CACHE_TTL_MS } from '../constants';

const CACHE_NAMESPACE = 'trust_cache';
const DEFAULT_TTL_MS = TRUST_CACHE_TTL_MS;

/**
 * Max entries the in-memory tracker keeps. Picked to fit a realistic
 * mobile working set (≈ 200 trust profiles ≪ 50KB at JSON encoding).
 */
export const MAX_TRUST_CACHE_ENTRIES = 200;

/**
 * Memory-warning eviction target — when the OS signals pressure,
 * drop down to this size rather than fully clearing. Keeps the most
 * recently used profiles hot for the user's active session while
 * relieving pressure.
 */
export const MEMORY_WARNING_TARGET = 50;

/**
 * Slim cache projection of `TrustProfile`.
 *
 * `score` is on AppView's `[0, 1]` real scale (matching
 * `appview/src/scorer/algorithms/trust-score.ts`). `null` means the
 * DID is known but unscored — UI layers render this as "unrated"
 * rather than coercing to zero.
 *
 * `attestationCount` projects from `attestationSummary.total` of the
 * full profile.
 *
 * `lastUpdated` is the server-side `lastActive` ms timestamp when the
 * wire response carried one, or our local ingest time as a fallback.
 * It is purely informational on the cached entry — TTL freshness
 * tracking lives in the separate `cacheTimestamps` map.
 */
export interface TrustScore {
  did: string;
  score: number | null;
  attestationCount: number;
  lastUpdated: number;
}

/** In-memory TTL tracking: DID → timestamp when cached. */
const cacheTimestamps = new Map<string, number>();

/** Injectable trust score fetcher (for background refresh). */
let fetchTrustScore: ((did: string) => Promise<TrustScore | null>) | null = null;

/** Register a trust score fetcher. */
export function registerTrustFetcher(fetcher: (did: string) => Promise<TrustScore | null>): void {
  fetchTrustScore = fetcher;
}

/**
 * Get a cached trust score for a DID.
 *
 * Returns the cached score if fresh (< 1 hour old).
 * Returns null on cache miss or expired entry.
 *
 * As a side effect, a successful lookup BUMPS the entry to
 * most-recently-used position so subsequent eviction sees it as
 * fresh. JS Maps preserve insertion order; deleting + re-setting
 * is the canonical LRU bump.
 *
 * Async since Phase 2.3 — the underlying KV store is an async port.
 */
export async function getCachedTrust(did: string, now?: number): Promise<TrustScore | null> {
  const raw = await kvGet(did, CACHE_NAMESPACE);
  if (!raw) return null;

  const cachedAt = cacheTimestamps.get(did);
  if (cachedAt === undefined) return null;

  const currentTime = now ?? Date.now();
  if (currentTime - cachedAt > DEFAULT_TTL_MS) {
    // Expired — remove from cache
    await invalidateTrust(did);
    return null;
  }

  try {
    const score = JSON.parse(raw) as TrustScore;
    // LRU bump: re-insert at the end so this entry is now the most
    // recently used. Preserves cachedAt — bumping access does NOT
    // reset TTL freshness.
    cacheTimestamps.delete(did);
    cacheTimestamps.set(did, cachedAt);
    return score;
  } catch {
    await invalidateTrust(did);
    return null;
  }
}

/**
 * Cache a trust score.
 *
 * On insert, if the in-memory tracker exceeds `MAX_TRUST_CACHE_ENTRIES`,
 * the oldest entry is evicted from both memory AND the KV backing
 * store (otherwise persisted-but-untracked entries would leak after
 * the next app restart).
 *
 * Async since Phase 2.3 — KV store.
 */
export async function cacheTrustScore(score: TrustScore, now?: number): Promise<void> {
  const currentTime = now ?? Date.now();
  await kvSet(score.did, JSON.stringify(score), CACHE_NAMESPACE);
  // Re-insert (delete + set) so we control insertion order even on
  // overwrite — without the delete, an overwrite leaves the entry
  // in its original slot rather than promoting it.
  cacheTimestamps.delete(score.did);
  cacheTimestamps.set(score.did, currentTime);

  if (cacheTimestamps.size > MAX_TRUST_CACHE_ENTRIES) {
    await evictTrustCacheTo(MAX_TRUST_CACHE_ENTRIES);
  }
}

/**
 * Evict least-recently-used entries down to `targetSize`.
 *
 * Used by the memory-warning hook (mobile: `AppState.memoryWarning`
 * → `evictTrustCacheTo(MEMORY_WARNING_TARGET)`) and triggered
 * automatically by `cacheTrustScore` when the LRU cap is exceeded.
 *
 * Drops both memory tracking AND the KV backing rows so memory
 * pressure is genuinely relieved.
 *
 * `targetSize <= 0` is treated as "evict everything".
 */
export async function evictTrustCacheTo(targetSize: number): Promise<void> {
  if (targetSize < 0) targetSize = 0;
  // Map iteration is insertion-order, so the first keys are oldest.
  // Snapshot the keys we plan to drop before we mutate, since
  // kvDelete is async and we don't want to race against a concurrent
  // insert that the iterator sees.
  const toDrop: string[] = [];
  for (const did of cacheTimestamps.keys()) {
    if (cacheTimestamps.size - toDrop.length <= targetSize) break;
    toDrop.push(did);
  }
  for (const did of toDrop) {
    cacheTimestamps.delete(did);
    await kvDelete(did, CACHE_NAMESPACE);
  }
}

/**
 * Current resident-set size of the in-memory cache tracker.
 * Useful for instrumentation and memory-pressure decisions.
 */
export function trustCacheSize(): number {
  return cacheTimestamps.size;
}

/**
 * Invalidate a specific DID's cache entry.
 *
 * Async since Phase 2.3 — KV store.
 */
export async function invalidateTrust(did: string): Promise<void> {
  await kvDelete(did, CACHE_NAMESPACE);
  cacheTimestamps.delete(did);
}

/**
 * Check if a DID's cache entry is stale (expired but still present in KV).
 */
export function isStale(did: string, now?: number): boolean {
  const cachedAt = cacheTimestamps.get(did);
  if (cachedAt === undefined) return false; // not cached at all
  const currentTime = now ?? Date.now();
  return currentTime - cachedAt > DEFAULT_TTL_MS;
}

/**
 * Refresh a trust score in the background.
 *
 * If a fetcher is registered, calls it and updates the cache.
 * Returns the refreshed score, or null if no fetcher or fetch failed.
 */
export async function refreshTrust(did: string): Promise<TrustScore | null> {
  if (!fetchTrustScore) return null;

  try {
    const score = await fetchTrustScore(did);
    if (score) {
      await cacheTrustScore(score);
    }
    return score;
  } catch {
    return null;
  }
}

/**
 * Get trust score with auto-refresh: return cached if fresh,
 * otherwise fetch and cache.
 */
export async function getTrustWithRefresh(did: string): Promise<TrustScore | null> {
  const cached = await getCachedTrust(did);
  if (cached) return cached;

  return refreshTrust(did);
}

/** Reset all trust cache state (for testing). */
export function resetTrustCache(): void {
  cacheTimestamps.clear();
  // KV entries in the trust_cache namespace are managed by kvDelete
  // For full reset, caller should also call resetKVStore
  fetchTrustScore = null;
}
