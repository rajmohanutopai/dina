/**
 * Unit tests for `appview/src/db/queries/appview-config.ts` (TN-FLAG-001).
 *
 * The reader's contract:
 *   - Row present → return `bool_value` from row
 *   - Row absent → return `FLAG_DEFAULTS[key]`
 *   - Row present but `bool_value` IS NULL → return `FLAG_DEFAULTS[key]`
 *
 * The third case guards against a half-applied `dina-admin trust set-param`
 * that wrote `text_value` for what should be a bool — application falls
 * through gracefully instead of crashing on a `bool_value === null`
 * truthy/falsy check.
 *
 * Tests use a hand-rolled minimal DB stub since vitest's mocking is
 * lighter than Jest's, and the reader's surface is tiny (one query).
 */

import { describe, it, expect } from 'vitest'
import { readBoolFlag, FLAG_DEFAULTS } from '@/db/queries/appview-config'
import type { DrizzleDB } from '@/db/connection'

interface StubRow {
  boolValue: boolean | null
}

/**
 * Minimal DB stub matching the surface used by `readBoolFlag`:
 * `db.select(...).from(...).where(...).limit(...)` returns
 * `Promise<StubRow[]>`.
 */
function stubDb(rows: StubRow[]): DrizzleDB {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => rows,
  }
  return {
    select: () => chain,
  } as unknown as DrizzleDB
}

describe('readBoolFlag — TN-FLAG-001', () => {
  it('returns the application default when no row exists', async () => {
    const db = stubDb([])
    const result = await readBoolFlag(db, 'trust_v1_enabled')
    expect(result).toBe(FLAG_DEFAULTS.trust_v1_enabled)
  })

  it('returns the row value when bool_value is true', async () => {
    const db = stubDb([{ boolValue: true }])
    const result = await readBoolFlag(db, 'trust_v1_enabled')
    expect(result).toBe(true)
  })

  it('returns the row value when bool_value is false (operator kill-switch)', async () => {
    // The reason the table exists — operator flips trust_v1_enabled false to disable the V1
    // surface without a redeploy. If this returned the default instead, the kill-switch wouldn't.
    const db = stubDb([{ boolValue: false }])
    const result = await readBoolFlag(db, 'trust_v1_enabled')
    expect(result).toBe(false)
  })

  it('returns the application default when row exists but bool_value is NULL', async () => {
    // Mis-seeded row guard — a row written with text_value but no bool_value (e.g. a future
    // string-typed flag accidentally tagged with this key) shouldn't crash the bool reader.
    const db = stubDb([{ boolValue: null }])
    const result = await readBoolFlag(db, 'trust_v1_enabled')
    expect(result).toBe(FLAG_DEFAULTS.trust_v1_enabled)
  })

  it('FLAG_DEFAULTS.trust_v1_enabled defaults to true (Plan §13.10 cutover stance)', () => {
    // V1 ships with the trust feature ON. Operators flip to OFF only to roll back. If a typo
    // ever changed this default to false, every fresh deployment would silently start with the
    // surface disabled — pinned by this test so the regression surfaces immediately.
    expect(FLAG_DEFAULTS.trust_v1_enabled).toBe(true)
  })

  it('FLAG_DEFAULTS is frozen (caller cannot mutate the defaults table at runtime)', () => {
    expect(Object.isFrozen(FLAG_DEFAULTS)).toBe(true)
    expect(() => {
      // @ts-expect-error — runtime mutation guard
      FLAG_DEFAULTS.trust_v1_enabled = false
    }).toThrow()
  })
})
