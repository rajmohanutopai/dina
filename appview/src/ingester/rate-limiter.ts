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
}
