/**
 * RPC idempotency cache — dedup by (from_did, request_id).
 *
 * Stores recent RPC responses so duplicate requests return the cached
 * response instead of re-processing. This prevents double-execution
 * when a client retries after a timeout or network error.
 *
 * Cache entries expire after a configurable TTL (default: 5 minutes).
 * Maximum capacity prevents unbounded memory growth.
 *
 * Source: Gap Analysis A21 #4 — matches Go's RPC idempotency cache.
 */

export interface CachedResponse {
  requestId: string;
  fromDID: string;
  status: number;
  body: string;
  cachedAt: number;
}

/** Default TTL for cached responses: 5 minutes (matching Go). */
export const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

/** Maximum cache entries (prevents unbounded growth). */
export const IDEMPOTENCY_MAX_ENTRIES = 10_000;

/** Cache keyed by "fromDID|requestId". */
const cache = new Map<string, CachedResponse>();

/** Build cache key from DID and request ID. */
function cacheKey(fromDID: string, requestId: string): string {
  return `${fromDID}|${requestId}`;
}

/**
 * Check if a cached response exists for this (from_did, request_id) pair.
 *
 * Returns the cached response if found and not expired, null otherwise.
 * Expired entries are lazily purged on lookup.
 */
export function getCachedResponse(
  fromDID: string,
  requestId: string,
  now?: number,
): CachedResponse | null {
  const key = cacheKey(fromDID, requestId);
  const entry = cache.get(key);
  if (!entry) return null;

  const currentTime = now ?? Date.now();
  if (currentTime - entry.cachedAt > IDEMPOTENCY_TTL_MS) {
    cache.delete(key); // lazy expiry
    return null;
  }

  return entry;
}

/**
 * Store a response in the idempotency cache.
 *
 * If the cache is at capacity, purges expired entries first.
 * If still at capacity after purge, evicts the oldest entry.
 */
export function cacheResponse(
  fromDID: string,
  requestId: string,
  status: number,
  body: string,
  now?: number,
): void {
  const currentTime = now ?? Date.now();

  // Capacity management
  if (cache.size >= IDEMPOTENCY_MAX_ENTRIES) {
    purgeExpired(currentTime);
  }
  if (cache.size >= IDEMPOTENCY_MAX_ENTRIES) {
    // Still full — evict oldest entry
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }

  const key = cacheKey(fromDID, requestId);
  cache.set(key, {
    requestId,
    fromDID,
    status,
    body,
    cachedAt: currentTime,
  });
}

/**
 * Check if a request is a duplicate (has cached response).
 *
 * Convenience wrapper: returns true if getCachedResponse would return non-null.
 */
export function isDuplicateRequest(fromDID: string, requestId: string, now?: number): boolean {
  return getCachedResponse(fromDID, requestId, now) !== null;
}

/**
 * Purge expired entries from the cache.
 * Returns the count of entries removed.
 */
export function purgeExpired(now?: number): number {
  const currentTime = now ?? Date.now();
  let purged = 0;

  for (const [key, entry] of cache.entries()) {
    if (currentTime - entry.cachedAt > IDEMPOTENCY_TTL_MS) {
      cache.delete(key);
      purged++;
    }
  }

  return purged;
}

/** Get the current cache size (for monitoring). */
export function cacheSize(): number {
  return cache.size;
}

/** Reset the cache (for testing). */
export function resetIdempotencyCache(): void {
  cache.clear();
}
