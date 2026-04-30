import type { DrizzleDB } from '@/db/connection.js'
import { readBoolFlag, type AppviewFlagKey } from '@/db/queries/appview-config.js'

/**
 * Cached flag reader for hot ingester / scorer paths (TN-ING-004).
 *
 * The xRPC layer reads `readBoolFlag(db, key)` directly per request
 * (~0.1 ms PK lookup, kill-switch propagation must be near-instant).
 * The ingester sees up to 100+ events/sec under load; reading the DB
 * on every event would burn 100× more queries than the operator
 * cadence cares about. This module sits between them: a 5-second TTL
 * cache that batches reads into ≤ 12 queries/minute regardless of
 * traffic.
 *
 * **Why 5 seconds**: balances kill-switch responsiveness against DB
 * load. An operator-initiated `dina-admin trust disable` propagates
 * within 5s — fast enough for incident response, slow enough that
 * 99% of high-traffic event reads hit cache. The window is much
 * shorter than the scorer's per-cycle (60s) cache; ingester rejects
 * faster than scorer recomputes.
 *
 * **Module-level singleton**: the ingester is a single Node process,
 * one cache. Tests use `clearFlagCache()` to reset state between
 * suites; production never calls it.
 *
 * **Closed-default on read failure**: if the DB read throws (transient
 * pg error, connection blip), we DO propagate the throw — a flag of
 * unknown state should not silently default to "enabled" because
 * that risks shipping records the operator wanted blocked. The
 * caller (jetstream consumer) decides what to do — current policy
 * is "log + skip the event", same as other transient failures.
 */

const FLAG_CACHE_TTL_MS = 5_000

interface CachedFlag {
  readonly value: boolean
  readonly loadedAt: number
}

const cache = new Map<AppviewFlagKey, CachedFlag>()

/**
 * Read a boolean flag with TTL caching. Returns the cached value if
 * fresh; otherwise reads from `appview_config` via `readBoolFlag` and
 * refreshes the cache.
 */
export async function readCachedBoolFlag(
  db: DrizzleDB,
  key: AppviewFlagKey,
): Promise<boolean> {
  const now = Date.now()
  const cached = cache.get(key)
  if (cached !== undefined && now - cached.loadedAt < FLAG_CACHE_TTL_MS) {
    return cached.value
  }
  const value = await readBoolFlag(db, key)
  cache.set(key, { value, loadedAt: now })
  return value
}

/**
 * Clear the cache. Tests use this between suites to ensure
 * deterministic startup state. Production should not call this —
 * the TTL is the natural eviction.
 */
export function clearFlagCache(): void {
  cache.clear()
}
