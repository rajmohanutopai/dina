/**
 * Unit tests for `appview/src/api/middleware/rate-limit.ts`
 * (TN-API-007 / Plan §6).
 *
 * Contract:
 *   - Per-(ip, method) buckets — methods have separate budgets
 *   - Plan §6 tier table is the source of truth (60/120/600 split)
 *   - Default cap (60) applies to unmapped methods
 *   - RATE_LIMIT_RPM env override raises the floor (test bypass)
 *   - LRU cache bounds memory under attack
 *   - Retry-After header reflects the bucket's true reset time
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIMIT_RPM,
  PER_METHOD_LIMITS_RPM,
  checkPerMethodRateLimit,
  createRateLimitCache,
  getMethodLimit,
} from '@/api/middleware/rate-limit'

describe('PER_METHOD_LIMITS_RPM — Plan §6 tier table', () => {
  it('matches Plan §6: search/resolve/networkFeed/cosigList = 60', () => {
    expect(PER_METHOD_LIMITS_RPM['com.dina.trust.search']).toBe(60)
    expect(PER_METHOD_LIMITS_RPM['com.dina.trust.resolve']).toBe(60)
    expect(PER_METHOD_LIMITS_RPM['com.dina.trust.networkFeed']).toBe(60)
    expect(PER_METHOD_LIMITS_RPM['com.dina.trust.cosigList']).toBe(60)
  })

  it('matches Plan §6: subjectGet = 120 (richer payload tier)', () => {
    expect(PER_METHOD_LIMITS_RPM['com.dina.trust.subjectGet']).toBe(120)
  })

  it('matches Plan §6: attestationStatus = 600 (outbox polling tier)', () => {
    // Mobile outbox watcher polls every 5s = 12 reqs/min minimum at idle;
    // a user with multiple pending attestations multiplies that. 600
    // gives 50× headroom for legitimate polling traffic.
    expect(PER_METHOD_LIMITS_RPM['com.dina.trust.attestationStatus']).toBe(600)
  })

  it('table is frozen — runtime mutation throws', () => {
    expect(Object.isFrozen(PER_METHOD_LIMITS_RPM)).toBe(true)
    expect(() => {
      // @ts-expect-error — runtime mutation guard
      PER_METHOD_LIMITS_RPM['com.dina.trust.search'] = 9999
    }).toThrow()
  })

  it('DEFAULT_LIMIT_RPM is 60 (conservative — unmapped methods get the strict tier)', () => {
    expect(DEFAULT_LIMIT_RPM).toBe(60)
  })
})

describe('getMethodLimit — TN-API-007', () => {
  it('returns the tier value for mapped methods', () => {
    expect(getMethodLimit('com.dina.trust.search')).toBe(60)
    expect(getMethodLimit('com.dina.trust.subjectGet')).toBe(120)
    expect(getMethodLimit('com.dina.trust.attestationStatus')).toBe(600)
  })

  it('falls back to DEFAULT_LIMIT_RPM for unmapped methods', () => {
    // Defends against a forgotten table entry: a new method that's
    // routed without being added to PER_METHOD_LIMITS_RPM gets the
    // conservative default rather than silently inheriting some
    // unrelated higher tier.
    expect(getMethodLimit('com.dina.trust.somethingNew')).toBe(60)
    expect(getMethodLimit('app.bsky.feed.getTimeline')).toBe(60)
  })

  it('env override raises ceiling (test bypass)', () => {
    // RATE_LIMIT_RPM=100000 is the standard test-mode setting (see
    // CLAUDE.md). It must not silently neuter strict tiers; instead,
    // it raises every tier's ceiling, so all buckets become
    // effectively unbounded.
    expect(getMethodLimit('com.dina.trust.search', 100_000)).toBe(100_000)
    expect(getMethodLimit('com.dina.trust.attestationStatus', 100_000)).toBe(100_000)
  })

  it('env override below tier does NOT lower the cap', () => {
    // Rate limits are a security ceiling. An env var set to 30 must
    // not drop attestationStatus from 600 to 30 — that would break
    // the outbox polling contract. Ops emergencies that need lower
    // limits should patch the constant table, not flip an env var.
    expect(getMethodLimit('com.dina.trust.attestationStatus', 30)).toBe(600)
    expect(getMethodLimit('com.dina.trust.search', 30)).toBe(60)
  })

  it('env override of 0 / undefined ignored (legacy default)', () => {
    expect(getMethodLimit('com.dina.trust.search', 0)).toBe(60)
    expect(getMethodLimit('com.dina.trust.search', undefined)).toBe(60)
  })
})

describe('checkPerMethodRateLimit — TN-API-007', () => {
  it('first request creates a bucket and is allowed', () => {
    const cache = createRateLimitCache()
    const result = checkPerMethodRateLimit(
      cache,
      '203.0.113.1',
      'com.dina.trust.search',
      1_000_000,
    )
    expect(result.ok).toBe(true)
    expect(result.limit).toBe(60)
    expect(result.retryAfterSec).toBe(60)
  })

  it('within-cap requests stay allowed', () => {
    const cache = createRateLimitCache()
    const ip = '203.0.113.2'
    const method = 'com.dina.trust.search'
    let allowed = 0
    for (let i = 0; i < 60; i++) {
      const r = checkPerMethodRateLimit(cache, ip, method, 1_000_000)
      if (r.ok) allowed++
    }
    expect(allowed).toBe(60)
  })

  it('over-cap requests are denied', () => {
    const cache = createRateLimitCache()
    const ip = '203.0.113.3'
    const method = 'com.dina.trust.search'
    for (let i = 0; i < 60; i++) {
      checkPerMethodRateLimit(cache, ip, method, 1_000_000)
    }
    const r = checkPerMethodRateLimit(cache, ip, method, 1_000_000)
    expect(r.ok).toBe(false)
    expect(r.limit).toBe(60)
  })

  it('per-method buckets are independent', () => {
    // The whole point of TN-API-007: an IP that's exhausted its
    // search budget can still hit attestationStatus, and vice versa.
    const cache = createRateLimitCache()
    const ip = '203.0.113.4'
    for (let i = 0; i < 60; i++) {
      checkPerMethodRateLimit(cache, ip, 'com.dina.trust.search', 1_000_000)
    }
    // search exhausted; attestationStatus must still allow.
    const r = checkPerMethodRateLimit(
      cache,
      ip,
      'com.dina.trust.attestationStatus',
      1_000_000,
    )
    expect(r.ok).toBe(true)
    expect(r.limit).toBe(600)
  })

  it('per-IP buckets are independent', () => {
    const cache = createRateLimitCache()
    const method = 'com.dina.trust.search'
    for (let i = 0; i < 60; i++) {
      checkPerMethodRateLimit(cache, '203.0.113.5', method, 1_000_000)
    }
    // IP .5 exhausted; .6 must still allow.
    const r = checkPerMethodRateLimit(cache, '203.0.113.6', method, 1_000_000)
    expect(r.ok).toBe(true)
  })

  it('window rolls over after 60 seconds', () => {
    const cache = createRateLimitCache()
    const ip = '203.0.113.7'
    const method = 'com.dina.trust.search'
    for (let i = 0; i < 60; i++) {
      checkPerMethodRateLimit(cache, ip, method, 1_000_000)
    }
    const denied = checkPerMethodRateLimit(cache, ip, method, 1_030_000)
    expect(denied.ok).toBe(false)
    // Past the window — fresh bucket, fresh count
    const fresh = checkPerMethodRateLimit(cache, ip, method, 1_061_000)
    expect(fresh.ok).toBe(true)
  })

  it('env override bypasses limits when set high (test mode)', () => {
    const cache = createRateLimitCache()
    const ip = '203.0.113.8'
    const method = 'com.dina.trust.search'
    let allowed = 0
    for (let i = 0; i < 100_000; i++) {
      const r = checkPerMethodRateLimit(cache, ip, method, 1_000_000, 100_000)
      if (r.ok) allowed++
    }
    expect(allowed).toBe(100_000)
  })

  it('Retry-After is at least 1 second (header contract)', () => {
    // HTTP 429 Retry-After must be a positive integer; emitting 0
    // would let clients hammer instantly. The middleware clamps to ≥1.
    const cache = createRateLimitCache()
    const ip = '203.0.113.9'
    const method = 'com.dina.trust.search'
    for (let i = 0; i < 60; i++) {
      checkPerMethodRateLimit(cache, ip, method, 1_000_000)
    }
    // Just before the window rolls — should still emit ≥1.
    const r = checkPerMethodRateLimit(cache, ip, method, 1_059_500)
    expect(r.ok).toBe(false)
    expect(r.retryAfterSec).toBeGreaterThanOrEqual(1)
  })

  it('counts blocked requests too (visibility into attack pressure)', () => {
    // The bucket increments even when over-cap, so ops dashboards see
    // the true attack volume, not just the successful requests.
    const cache = createRateLimitCache()
    const ip = '203.0.113.10'
    const method = 'com.dina.trust.search'
    for (let i = 0; i < 200; i++) {
      checkPerMethodRateLimit(cache, ip, method, 1_000_000)
    }
    const entry = cache.get(`${ip}:${method}`)
    expect(entry?.count).toBe(200)
  })
})
