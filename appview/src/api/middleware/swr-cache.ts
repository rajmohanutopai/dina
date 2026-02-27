import { LRUCache } from 'lru-cache'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'
import { CONSTANTS } from '@/config/constants.js'

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

const cache = new LRUCache<string, CacheEntry<unknown>>({
  max: CONSTANTS.MAX_CACHE_SIZE,
})

const inFlight = new Map<string, Promise<unknown>>()

export async function withSWR<T>(
  key: string,
  ttlMs: number,
  fetchData: () => Promise<T>,
): Promise<T> {
  const now = Date.now()
  const cached = cache.get(key) as CacheEntry<T> | undefined

  if (cached && cached.expiresAt > now) {
    metrics.incr('api.cache.hit')
    return cached.data
  }

  // HIGH-09: For stale entries, always return cached data immediately.
  // Background refresh runs fire-and-forget — never return the bgFetch promise.
  if (cached) {
    metrics.incr('api.cache.stale')
    if (!inFlight.has(key)) {
      const bgFetch = fetchData()
        .then((data) => {
          cache.set(key, { data, expiresAt: Date.now() + ttlMs })
        })
        .catch((err) => {
          logger.error({ err, key }, 'SWR background refresh failed')
          metrics.incr('api.cache.bg_refresh_failed')
        })
        .finally(() => inFlight.delete(key))
      inFlight.set(key, bgFetch)
    }
    return cached.data
  }

  // Cache miss: coalesce concurrent requests for same key
  if (inFlight.has(key)) {
    metrics.incr('api.cache.coalesced')
    return inFlight.get(key) as Promise<T>
  }

  metrics.incr('api.cache.miss')
  const fetchPromise = fetchData()
    .then((data) => {
      cache.set(key, { data, expiresAt: Date.now() + ttlMs })
      inFlight.delete(key)
      return data
    })
    .catch((err) => {
      inFlight.delete(key)
      throw err
    })

  inFlight.set(key, fetchPromise)
  return fetchPromise
}

export function resolveKey(
  subjectJson: string,
  requesterDid?: string,
  domain?: string,
  context?: string,
): string {
  return `resolve:${subjectJson}:${requesterDid ?? ''}:${domain ?? ''}:${context ?? ''}`
}

export const CACHE_TTLS = {
  RESOLVE: CONSTANTS.CACHE_TTL_RESOLVE,
  GET_PROFILE: CONSTANTS.CACHE_TTL_GET_PROFILE,
  SEARCH: CONSTANTS.CACHE_TTL_SEARCH,
} as const

/** Clear cache — used in tests */
export function clearCache(): void {
  cache.clear()
  inFlight.clear()
}

/** Get cache stats — used in tests */
export function getCacheStats(): { size: number; inFlight: number } {
  return { size: cache.size, inFlight: inFlight.size }
}
