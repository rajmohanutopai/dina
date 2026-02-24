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
 */

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

/**
 * Check if a DID is rate-limited. If not, record the write.
 * Returns true if the DID should be rejected.
 */
export function isRateLimited(did: string): boolean {
  const now = Date.now()

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
