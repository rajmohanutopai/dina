/**
 * Unit tests for `appview/src/ingester/feature-flag-cache.ts` (TN-ING-004).
 *
 * Contract:
 *   - First read for a key hits the DB
 *   - Subsequent reads within 5s return the cached value
 *   - After 5s (mocked Date.now), reads hit the DB again
 *   - DB throws propagate (closed-default — flag of unknown state must
 *     not silently default to "enabled")
 *   - `clearFlagCache()` resets to first-read state
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readCachedBoolFlag, clearFlagCache } from '@/ingester/feature-flag-cache'
import type { DrizzleDB } from '@/db/connection'

interface StubRow {
  boolValue: boolean | null
}

/**
 * Minimal DB stub matching `db.select(...).from(...).where(...).limit(...)`.
 * The `rowsRef` is mutable so a single test can change the underlying value
 * between reads to verify cache vs miss behavior.
 */
function stubDb(rowsRef: { value: StubRow[]; calls: number }): DrizzleDB {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => {
      rowsRef.calls++
      return rowsRef.value
    },
  }
  return { select: () => chain } as unknown as DrizzleDB
}

describe('readCachedBoolFlag — TN-ING-004', () => {
  beforeEach(() => {
    clearFlagCache()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-29T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    clearFlagCache()
  })

  it('first read hits the DB; second read within TTL returns cached value', async () => {
    const rows = { value: [{ boolValue: true }] as StubRow[], calls: 0 }
    const db = stubDb(rows)

    const first = await readCachedBoolFlag(db, 'trust_v1_enabled')
    expect(first).toBe(true)
    expect(rows.calls).toBe(1)

    // Within TTL — same call should not re-hit the DB.
    vi.advanceTimersByTime(1000)
    const second = await readCachedBoolFlag(db, 'trust_v1_enabled')
    expect(second).toBe(true)
    expect(rows.calls).toBe(1)
  })

  it('cache returns stale-but-fresh value even when DB row changed (within TTL)', async () => {
    // Demonstrates the propagation-latency tradeoff: when the operator flips
    // the flag, callers see the old value until the TTL expires. 5s is the
    // documented compromise — fast enough for incident response, slow enough
    // that high-traffic event reads aren't slamming the DB.
    const rows = { value: [{ boolValue: true }] as StubRow[], calls: 0 }
    const db = stubDb(rows)

    expect(await readCachedBoolFlag(db, 'trust_v1_enabled')).toBe(true)
    expect(rows.calls).toBe(1)

    // Operator flips the flag — but cache hasn't expired yet.
    rows.value = [{ boolValue: false }]
    vi.advanceTimersByTime(2000)
    expect(await readCachedBoolFlag(db, 'trust_v1_enabled')).toBe(true) // still cached
    expect(rows.calls).toBe(1)
  })

  it('after 5s TTL expires, next read hits the DB and picks up new value', async () => {
    const rows = { value: [{ boolValue: true }] as StubRow[], calls: 0 }
    const db = stubDb(rows)

    expect(await readCachedBoolFlag(db, 'trust_v1_enabled')).toBe(true)
    expect(rows.calls).toBe(1)

    rows.value = [{ boolValue: false }]
    // Just past the 5000 ms TTL.
    vi.advanceTimersByTime(5001)
    expect(await readCachedBoolFlag(db, 'trust_v1_enabled')).toBe(false)
    expect(rows.calls).toBe(2)
  })

  it('falls back to FLAG_DEFAULTS when no row exists (delegates to readBoolFlag)', async () => {
    // Module's job is caching, not default lookup — but the fallback semantics
    // must compose correctly. With no row, the underlying readBoolFlag returns
    // FLAG_DEFAULTS.trust_v1_enabled = true.
    const rows = { value: [] as StubRow[], calls: 0 }
    const db = stubDb(rows)
    expect(await readCachedBoolFlag(db, 'trust_v1_enabled')).toBe(true)
    expect(rows.calls).toBe(1)
  })

  it('clearFlagCache forces next read to hit the DB', async () => {
    const rows = { value: [{ boolValue: true }] as StubRow[], calls: 0 }
    const db = stubDb(rows)

    await readCachedBoolFlag(db, 'trust_v1_enabled')
    await readCachedBoolFlag(db, 'trust_v1_enabled') // cached
    expect(rows.calls).toBe(1)

    clearFlagCache()
    await readCachedBoolFlag(db, 'trust_v1_enabled')
    expect(rows.calls).toBe(2)
  })

  it('DB error propagates (closed-default — flag of unknown state must not silently enable)', async () => {
    // If a transient pg error happens during the read, we DO propagate the throw —
    // a flag of unknown state should not default to "enabled" because that risks
    // shipping records the operator wanted blocked. The caller decides what to do.
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => { throw new Error('connection refused') },
          }),
        }),
      }),
    } as unknown as DrizzleDB

    await expect(readCachedBoolFlag(db, 'trust_v1_enabled')).rejects.toThrow('connection refused')
  })

  // ── Outage / TTL-boundary contracts ───────────────────────────────
  // The docstring documents two related invariants:
  //   1. "Closed-default on read failure: ... we DO propagate the throw — a
  //      flag of unknown state should not silently default to 'enabled'."
  //   2. (Implicit from the above) Once the cache entry is stale, it is NOT
  //      a fallback during outages — every call hits the DB until DB recovery.
  //
  // Both invariants matter because they're load-bearing for incident response:
  // a future refactor adding stale-while-revalidate or last-known-good fallback
  // semantics would silently change the kill-switch behavior. These tests pin
  // the current semantics so the change becomes deliberate.

  it('within TTL, DB outage does NOT throw — cached value is served from memory', async () => {
    // First read populates cache successfully. Then DB starts throwing;
    // within the 5s TTL, subsequent reads MUST NOT touch the DB and
    // MUST return the cached value. The cache is the rate-limit
    // mechanism; outages within TTL are invisible to callers.
    let stateThrows = false
    let calls = 0
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              calls++
              if (stateThrows) throw new Error('connection refused')
              return [{ boolValue: true }]
            },
          }),
        }),
      }),
    } as unknown as DrizzleDB

    expect(await readCachedBoolFlag(db, 'trust_v1_enabled')).toBe(true)
    expect(calls).toBe(1)

    // DB starts failing within the TTL window.
    stateThrows = true
    vi.advanceTimersByTime(2_000)
    expect(await readCachedBoolFlag(db, 'trust_v1_enabled')).toBe(true)
    expect(calls).toBe(1) // still cached — no DB call
  })

  it('after TTL expires, DB outage throws — does NOT silently fall back to stale cache', async () => {
    // The closed-default invariant: once the cached entry is stale, it
    // is NOT served as a fallback. Subsequent calls go to DB; if DB
    // throws, the throw propagates so the caller knows it's running on
    // unknown state. A refactor adding stale-while-revalidate semantics
    // would silently flip this.
    let stateThrows = false
    let calls = 0
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              calls++
              if (stateThrows) throw new Error('connection refused')
              return [{ boolValue: true }]
            },
          }),
        }),
      }),
    } as unknown as DrizzleDB

    // Successful first read populates cache with `true`.
    expect(await readCachedBoolFlag(db, 'trust_v1_enabled')).toBe(true)
    expect(calls).toBe(1)

    // Operator-perspective fault: DB starts failing AND TTL expires.
    stateThrows = true
    vi.advanceTimersByTime(5_001)

    // Even though we have a cached `true` from before, the stale entry
    // is NOT a fallback. The DB read attempt throws, and the throw
    // propagates rather than silently returning the stale cached value.
    await expect(readCachedBoolFlag(db, 'trust_v1_enabled')).rejects.toThrow(
      'connection refused',
    )
    expect(calls).toBe(2) // proves we DID try the DB; didn't shortcut to stale
  })

  it('after a transient throw + recovery, the next successful read repopulates the cache', async () => {
    // Recovery semantic: once DB is healthy again, the next successful
    // read writes a fresh cache entry. Subsequent reads within the new
    // TTL window are served from cache (proven by zero additional DB
    // calls). Pins that the throw path doesn't poison the cache or
    // cause permanent DB hammering.
    let stateThrows = true
    let calls = 0
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              calls++
              if (stateThrows) throw new Error('connection refused')
              return [{ boolValue: false }]
            },
          }),
        }),
      }),
    } as unknown as DrizzleDB

    // First call during outage → throws.
    await expect(readCachedBoolFlag(db, 'trust_v1_enabled')).rejects.toThrow(
      'connection refused',
    )
    expect(calls).toBe(1)

    // DB recovers. Operator has flipped the flag during the outage.
    stateThrows = false
    expect(await readCachedBoolFlag(db, 'trust_v1_enabled')).toBe(false)
    expect(calls).toBe(2) // recovery read

    // Subsequent read within TTL is cached — no third DB call.
    vi.advanceTimersByTime(1_000)
    expect(await readCachedBoolFlag(db, 'trust_v1_enabled')).toBe(false)
    expect(calls).toBe(2) // proves cache repopulated correctly
  })
})
