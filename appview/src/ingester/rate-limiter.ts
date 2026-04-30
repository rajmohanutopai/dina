import { LRUCache } from 'lru-cache'
import { CONSTANTS } from '@/config/constants.js'
import { logger } from '@/shared/utils/logger.js'

/**
 * Per-DID write rate limiting (Fix 11).
 *
 * Tracks writes per DID using an LRU cache with sliding-window counters.
 * When a DID exceeds MAX_RECORDS_PER_HOUR, it is quarantined — all further
 * writes are rejected until the window rolls over.
 *
 * The LRU evicts the least-recently-seen DIDs when MAX_TRACKED_DIDS is reached,
 * so memory usage stays bounded even with millions of unique authors.
 *
 * LIMITATION: This rate limiter is in-memory only. In multi-instance deployments,
 * each instance maintains its own independent rate limit state. A DID could
 * effectively get N × MAX_RECORDS_PER_HOUR writes through if N instances are
 * running. For shared rate limiting, use Redis-backed counters
 * (e.g. sliding-window via REDIS INCR + EXPIRE).
 * Rate limit state is also lost on process restart.
 */

// Warn if running multiple instances with in-memory rate limiting
const instanceCount = Number(process.env.INSTANCE_COUNT ?? 1)
if (instanceCount > 1) {
  logger.warn(
    { instanceCount },
    '[RateLimiter] Running in-memory rate limiter with multiple instances — rate limits are NOT shared across instances',
  )
}

interface RateLimitEntry {
  /** Timestamps of writes within the current window */
  timestamps: number[]
}

const rateLimitCache = new LRUCache<string, RateLimitEntry>({
  max: CONSTANTS.MAX_TRACKED_DIDS,
})

/** Set of DIDs currently quarantined (exceeded rate limit) */
const quarantinedDids = new Set<string>()

const WINDOW_MS = 60 * 60 * 1000 // 1 hour

// MED-03: Global throughput limiter (across all DIDs)
const MAX_GLOBAL_PER_MIN = parseInt(process.env.MAX_GLOBAL_RPM ?? '10000', 10)
let globalCounter = 0
let globalResetAt = Date.now() + 60_000

/**
 * Check if a DID is rate-limited. If not, record the write.
 * Returns true if the DID should be rejected.
 */
export function isRateLimited(did: string): boolean {
  const now = Date.now()

  // MED-03: Check global throughput limit first
  if (now > globalResetAt) {
    globalCounter = 0
    globalResetAt = now + 60_000
  }
  if (globalCounter >= MAX_GLOBAL_PER_MIN) {
    return true
  }
  globalCounter++

  let entry = rateLimitCache.get(did)
  if (!entry) {
    entry = { timestamps: [] }
    rateLimitCache.set(did, entry)
  }

  // Prune timestamps outside the sliding window
  entry.timestamps = entry.timestamps.filter((t) => now - t < WINDOW_MS)

  if (entry.timestamps.length >= CONSTANTS.MAX_RECORDS_PER_HOUR) {
    if (!quarantinedDids.has(did)) {
      quarantinedDids.add(did)
      logger.warn({ did, count: entry.timestamps.length }, '[RateLimiter] DID quarantined')
    }
    return true
  }

  // Record this write
  entry.timestamps.push(now)

  // Remove from quarantine if they were previously quarantined but window rolled
  if (quarantinedDids.has(did)) {
    quarantinedDids.delete(did)
    logger.info({ did }, '[RateLimiter] DID released from quarantine')
  }

  return false
}

/**
 * Get the set of currently quarantined DIDs.
 * Useful for monitoring and admin dashboards.
 */
export function getQuarantinedDids(): ReadonlySet<string> {
  return quarantinedDids
}

/**
 * Get the current write count for a DID within the sliding window.
 * Returns 0 if the DID is not tracked.
 */
export function getWriteCount(did: string): number {
  const now = Date.now()
  const entry = rateLimitCache.get(did)
  if (!entry) return 0
  return entry.timestamps.filter((t) => now - t < WINDOW_MS).length
}

/**
 * Reset rate limit state. Primarily for testing.
 */
export function resetRateLimiter(): void {
  rateLimitCache.clear()
  quarantinedDids.clear()
  collectionRateLimitCache.clear()
}

// ─── Per-collection per-day quotas (TN-ING-002 / Plan §3.5 + §6.1) ──────
//
// On top of the per-DID hourly limit above, attestations / endorsements /
// flags get tighter per-author per-day caps. This isn't a duplicate gate;
// the daily caps are far stricter than the hourly limit allows in
// aggregate, and they're per-collection (an author saturating their
// attestation cap can still post endorsements). Both gates run in the
// dispatcher; either firing rejects the record.
//
// **Sliding 24h window**: timestamps pruned on every check, like the
// hourly limit. Same memory bound (`MAX_TRACKED_DIDS`) — the cache key
// becomes `<did>::<collection>` so the LRU evicts (DID, collection)
// pairs least-recently-seen.
//
// **Caps from Plan §3.5**: 60 attestations / 30 endorsements / 10 flags
// per author per day. Other trust-collection records (vouches, replies,
// reactions, etc.) use only the hourly per-DID gate above.
//
// **In-memory only — same multi-instance caveat as the hourly gate**:
// each AppView instance maintains its own counter; production with
// multiple replicas can effectively allow N×cap. For shared limiting,
// move to Redis-backed counters (sliding-window via INCR + EXPIRE).

const COLLECTION_DAILY_CAPS: ReadonlyMap<string, number> = new Map([
  ['com.dina.trust.attestation', 60],
  ['com.dina.trust.endorsement', 30],
  ['com.dina.trust.flag', 10],
])

const COLLECTION_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 hours

const collectionRateLimitCache = new LRUCache<string, RateLimitEntry>({
  max: CONSTANTS.MAX_TRACKED_DIDS,
})

/** Cache key that pairs a DID with the collection NSID. */
function collectionCacheKey(did: string, collection: string): string {
  return `${did}::${collection}`
}

/**
 * Check the per-collection per-day quota (TN-ING-002). Returns true if
 * the record should be rejected — the author has met or exceeded the
 * documented cap for this collection within the trailing 24 hours.
 *
 * Records the write on success (matching `isRateLimited`'s
 * "check-and-record" semantics so callers don't need a separate
 * commit step).
 *
 * Collections without a cap (vouches, replies, reactions, etc.) return
 * false unconditionally — the per-DID hourly limit still applies via
 * `isRateLimited`.
 */
export function isCollectionRateLimited(did: string, collection: string): boolean {
  const cap = COLLECTION_DAILY_CAPS.get(collection)
  if (cap === undefined) return false

  const now = Date.now()
  const key = collectionCacheKey(did, collection)
  let entry = collectionRateLimitCache.get(key)
  if (!entry) {
    entry = { timestamps: [] }
    collectionRateLimitCache.set(key, entry)
  }

  // Prune timestamps outside the 24h sliding window.
  entry.timestamps = entry.timestamps.filter((t) => now - t < COLLECTION_WINDOW_MS)

  if (entry.timestamps.length >= cap) {
    return true
  }
  entry.timestamps.push(now)
  return false
}

/**
 * Get the current write count for a (DID, collection) pair within the
 * 24h sliding window. Returns 0 if the pair isn't tracked.
 *
 * Useful for `dina-admin trust quota-status <did>` and observability.
 */
export function getCollectionWriteCount(did: string, collection: string): number {
  const cap = COLLECTION_DAILY_CAPS.get(collection)
  if (cap === undefined) return 0
  const now = Date.now()
  const entry = collectionRateLimitCache.get(collectionCacheKey(did, collection))
  if (!entry) return 0
  return entry.timestamps.filter((t) => now - t < COLLECTION_WINDOW_MS).length
}

/**
 * Read-only view of the daily caps. Tests + the admin CLI use this
 * for assertions and pretty-printing without reaching into the module
 * internals.
 */
export function getCollectionDailyCap(collection: string): number | null {
  return COLLECTION_DAILY_CAPS.get(collection) ?? null
}
