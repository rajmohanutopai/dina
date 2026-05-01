/**
 * Per-IP, per-method rate limiting for the xRPC surface (TN-API-007 /
 * Plan §6).
 *
 * Plan §6 specifies differentiated tiers — `attestationStatus` polls
 * every 5s from the mobile outbox watcher (12/min minimum), while
 * `search` is human-driven (well under 60/min for any sane UI).
 * A flat limit forces either:
 *   - Setting it high enough for `attestationStatus` (600+/min) →
 *     attackers can hammer expensive endpoints unconstrained
 *   - Setting it low enough for `search` (60/min) → legitimate
 *     outbox polling trips the limiter
 * The fix is per-(ip, method) buckets.
 *
 * **Bucket key = `${ip}:${methodId}`**: an IP's outbox polling and
 * its searches consume separate budgets. A malicious IP that
 * exhausts `search` cannot escape into `attestationStatus`. Per-IP
 * accounting still bounds overall abuse — an IP cannot make
 * arbitrarily many requests by hopping methods, since each bucket
 * has its own cap.
 *
 * **`RATE_LIMIT_RPM` env override**: legacy + test-mode escape hatch.
 * Tests run with `RATE_LIMIT_RPM=100000` to bypass; the override
 * raises every tier's ceiling to `max(env, tier)`. Setting it lower
 * than 600 would silently neuter the `attestationStatus` tier — by
 * design, the override cannot LOWER a tier (rate limits are a
 * security-relevant ceiling; ops emergencies that need lower limits
 * should patch the constant table, not flip a global env var).
 *
 * **LRU cache, not raw Map**: bounds memory for unbounded IP × method
 * combinations. A single attacker rotating IPs cannot OOM the
 * AppView by flooding the bucket map. Cache eviction = silent
 * "rate limit reset", which is fine — the eviction policy (LRU)
 * preferentially drops idle IPs, so an active attacker stays
 * tracked.
 */

import { LRUCache } from 'lru-cache'

/** Cap used when a method isn't in the tier table. */
export const DEFAULT_LIMIT_RPM = 60

/**
 * Per-method per-minute caps from Plan §6. Frozen — `getMethodLimit`
 * is the only sanctioned read path. Adding a new method = update
 * this table AND its corresponding handler in `web/server.ts`.
 *
 * Methods absent from this table fall back to `DEFAULT_LIMIT_RPM`.
 * That keeps the table honest: if a new method is added without
 * thinking about its rate cap, it gets the conservative default
 * rather than silently inheriting some unrelated higher tier.
 */
export const PER_METHOD_LIMITS_RPM: Readonly<Record<string, number>> = Object.freeze({
  // Per Plan §6:
  'com.dina.trust.search': 60,
  'com.dina.trust.resolve': 60,
  'com.dina.trust.subjectGet': 120,
  // TN-V2-RANK-009: detail-page strip — rendered alongside subjectGet
  // so the tier matches.
  'com.dina.trust.getAlternatives': 120,
  // TN-V2-RANK-010: negative-space surface — typically rendered once
  // per category browse, not per detail view, so a lower tier than
  // subjectGet is fine. Same tier as search since usage frequency is
  // similar.
  'com.dina.trust.getNegativeSpace': 60,
  'com.dina.trust.networkFeed': 60,
  'com.dina.trust.attestationStatus': 600, // outbox polls every 5s = 12/min minimum
  'com.dina.trust.cosigList': 60,
  // Legacy methods (pre-§6 spec) — same tier as their semantic siblings:
  'com.dina.trust.getProfile': 120,        // sibling of subjectGet
  'com.dina.trust.getAttestations': 120,   // sibling of subjectGet
  'com.dina.trust.getGraph': 60,           // legacy reach query
  // Service registry — separate surface, plain default:
  'com.dina.service.search': 60,
  'com.dina.service.isDiscoverable': 60,
})

/**
 * Resolve the effective per-minute cap for a given method, honouring
 * the `RATE_LIMIT_RPM` env override.
 *
 * @param methodId  Full xRPC method ID (e.g. `com.dina.trust.search`).
 *                  Methods absent from `PER_METHOD_LIMITS_RPM` fall back
 *                  to `DEFAULT_LIMIT_RPM`.
 * @param envOverride The numeric value of `process.env.RATE_LIMIT_RPM`,
 *                  parsed and passed by the caller. Pass `undefined` /
 *                  `0` to use only the static tier table.
 *                  When set, the effective cap is `max(envOverride, tier)`
 *                  — env raises ceilings (test-mode bypass) but cannot
 *                  lower them.
 */
export function getMethodLimit(
  methodId: string,
  envOverride?: number,
): number {
  const tier = PER_METHOD_LIMITS_RPM[methodId] ?? DEFAULT_LIMIT_RPM
  if (envOverride !== undefined && envOverride > 0) {
    return Math.max(envOverride, tier)
  }
  return tier
}

/** Per-(ip, method) bucket state held in the LRU cache. */
export interface RateLimitState {
  count: number
  /** Wall-clock time (ms) at which the bucket rolls over. */
  resetAt: number
}

export interface RateLimitDecision {
  /** True if the request is within the cap. */
  ok: boolean
  /** Effective cap that was applied (tier × env override). */
  limit: number
  /** Seconds until the bucket rolls over (clamped ≥ 1 for the Retry-After header). */
  retryAfterSec: number
}

const WINDOW_MS = 60_000

/**
 * Check + update the rate-limit bucket for `(ip, methodId)`. Pure
 * function (apart from cache mutation) — easy to unit-test.
 *
 * Algorithm:
 *   - If no entry or window has rolled over: start a fresh bucket
 *     with count=1, resetAt=now+60s. Always allowed.
 *   - Otherwise: increment count, allow if `count <= limit`.
 *
 * The `++` happens regardless of whether we're over the limit —
 * counting blocked requests too gives ops dashboards a true picture
 * of attack pressure (not just successful requests).
 */
export function checkPerMethodRateLimit(
  cache: LRUCache<string, RateLimitState>,
  ip: string,
  methodId: string,
  now: number,
  envOverride?: number,
): RateLimitDecision {
  const limit = getMethodLimit(methodId, envOverride)
  const key = `${ip}:${methodId}`
  const entry = cache.get(key)
  if (!entry || now > entry.resetAt) {
    cache.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return { ok: true, limit, retryAfterSec: 60 }
  }
  entry.count++
  const ok = entry.count <= limit
  const retryAfterSec = Math.max(Math.ceil((entry.resetAt - now) / 1000), 1)
  return { ok, limit, retryAfterSec }
}

/**
 * Build a rate-limit cache with the project's standard sizing.
 * Dependency-injected from `web/server.ts` (rather than a module-level
 * singleton) so tests can construct fresh state per case.
 */
export function createRateLimitCache(): LRUCache<string, RateLimitState> {
  return new LRUCache<string, RateLimitState>({
    max: 50_000,
    ttl: WINDOW_MS,
  })
}
