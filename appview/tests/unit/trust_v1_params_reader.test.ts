/**
 * Unit tests for `appview/src/scorer/trust-v1-params-reader.ts` (TN-SCORE-009).
 *
 * Contract:
 *   - `readTrustV1Params(db)` returns a frozen typed snapshot
 *   - DB rows override seed defaults; missing rows fall through to seeds
 *   - NUMERIC values returned by pg as strings get coerced via parseFloat
 *   - Unknown-key rows in the DB are silently ignored (no crash on
 *     forward-compat additions)
 *   - `readCachedTrustV1Params(db)` adds 60s TTL caching
 *   - Cache TTL boundary respected (mocked Date.now)
 *   - DB errors fall back to last-known-good cached snapshot OR
 *     compiled-in seeds on first-call failure
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readTrustV1Params,
  readCachedTrustV1Params,
  clearParamsCache,
} from '@/scorer/trust-v1-params-reader'
import { TRUST_V1_PARAM_SEEDS } from '@/db/seeds/trust-v1-params'
import type { DrizzleDB } from '@/db/connection'

interface StubRow {
  key: string
  value: string | number
}

/** Minimal DrizzleDB stub matching `db.select(...).from(...)`. */
function stubDb(
  rowsRef: { value: StubRow[]; calls: number; throws?: Error },
): DrizzleDB {
  return {
    select: () => ({
      from: async () => {
        rowsRef.calls++
        if (rowsRef.throws) throw rowsRef.throws
        return rowsRef.value
      },
    }),
  } as unknown as DrizzleDB
}

describe('readTrustV1Params — TN-SCORE-009', () => {
  it('falls back to seed defaults when DB has no rows', async () => {
    const rows = { value: [] as StubRow[], calls: 0 }
    const params = await readTrustV1Params(stubDb(rows))
    // Cross-check against the seed list as the source of truth.
    const seedMap = new Map(TRUST_V1_PARAM_SEEDS.map((s) => [s.key, s.value]))
    expect(params.WEIGHT_VOLUME).toBe(seedMap.get('WEIGHT_VOLUME'))
    expect(params.WEIGHT_AGE).toBe(seedMap.get('WEIGHT_AGE'))
    expect(params.HOT_SUBJECT_THRESHOLD).toBe(seedMap.get('HOT_SUBJECT_THRESHOLD'))
  })

  it('DB row value overrides seed default', async () => {
    // Operator ran `dina-admin trust set-param WEIGHT_VOLUME 0.30`. The
    // DB row should win over the compiled-in seed of 0.25.
    const rows = { value: [{ key: 'WEIGHT_VOLUME', value: '0.30' }], calls: 0 }
    const params = await readTrustV1Params(stubDb(rows))
    expect(params.WEIGHT_VOLUME).toBe(0.30)
    // Other keys stay at seed defaults.
    const seedMap = new Map(TRUST_V1_PARAM_SEEDS.map((s) => [s.key, s.value]))
    expect(params.WEIGHT_AGE).toBe(seedMap.get('WEIGHT_AGE'))
  })

  it('coerces pg NUMERIC strings to JS numbers via parseFloat', async () => {
    // pg's default deserializer returns NUMERIC as string. The reader
    // must coerce, otherwise the typed snapshot would carry strings.
    const rows = {
      value: [
        { key: 'FRIEND_BOOST', value: '1.5000000000' as const },
        { key: 'HOT_SUBJECT_THRESHOLD', value: '10000' as const },
      ],
      calls: 0,
    }
    const params = await readTrustV1Params(stubDb(rows))
    expect(typeof params.FRIEND_BOOST).toBe('number')
    expect(params.FRIEND_BOOST).toBe(1.5)
    expect(typeof params.HOT_SUBJECT_THRESHOLD).toBe('number')
    expect(params.HOT_SUBJECT_THRESHOLD).toBe(10000)
  })

  it('silently ignores unknown DB keys (forward-compat with future params)', async () => {
    // A future param added to the table without a TS shape update should
    // not crash the scorer. The TS reader only sees keys it knows about.
    const rows = {
      value: [
        { key: 'WEIGHT_VOLUME', value: '0.30' },
        { key: 'FUTURE_V2_PARAM', value: '99.0' },
      ],
      calls: 0,
    }
    const params = await readTrustV1Params(stubDb(rows))
    expect(params.WEIGHT_VOLUME).toBe(0.30)
    // 'FUTURE_V2_PARAM' is dropped — TS shape doesn't include it. No throw.
  })

  it('rejects non-finite NUMERIC values (NaN/Infinity guard)', async () => {
    // Defense against a corrupt row writing 'NaN' or 'Infinity' as text —
    // those would be silently inherited by the scorer formula, producing
    // garbage scores. Filter at the boundary.
    const rows = {
      value: [
        { key: 'WEIGHT_VOLUME', value: 'NaN' },
        { key: 'FRIEND_BOOST', value: 'Infinity' },
      ],
      calls: 0,
    }
    const params = await readTrustV1Params(stubDb(rows))
    const seedMap = new Map(TRUST_V1_PARAM_SEEDS.map((s) => [s.key, s.value]))
    // Falls back to seed since the DB values were unusable.
    expect(params.WEIGHT_VOLUME).toBe(seedMap.get('WEIGHT_VOLUME'))
    expect(params.FRIEND_BOOST).toBe(seedMap.get('FRIEND_BOOST'))
  })

  it('returned snapshot is frozen', async () => {
    const rows = { value: [] as StubRow[], calls: 0 }
    const params = await readTrustV1Params(stubDb(rows))
    expect(Object.isFrozen(params)).toBe(true)
    expect(() => {
      // @ts-expect-error — runtime mutation guard
      params.WEIGHT_VOLUME = 99
    }).toThrow()
  })
})

describe('readCachedTrustV1Params — TN-SCORE-009', () => {
  beforeEach(() => {
    clearParamsCache()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-29T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    clearParamsCache()
  })

  it('first read hits the DB; second read within TTL returns cached snapshot', async () => {
    const rows = { value: [{ key: 'WEIGHT_VOLUME', value: '0.30' }], calls: 0 }
    const db = stubDb(rows)

    const first = await readCachedTrustV1Params(db)
    expect(first.WEIGHT_VOLUME).toBe(0.30)
    expect(rows.calls).toBe(1)

    vi.advanceTimersByTime(30_000)
    const second = await readCachedTrustV1Params(db)
    expect(second.WEIGHT_VOLUME).toBe(0.30)
    expect(rows.calls).toBe(1) // still cached
  })

  it('cache returns stale value within TTL even when DB row changed', async () => {
    // Tuning propagation latency is bounded by the TTL — that's the
    // intentional tradeoff. 60s is short enough for operator workflows.
    const rows = { value: [{ key: 'WEIGHT_VOLUME', value: '0.30' }], calls: 0 }
    const db = stubDb(rows)

    expect((await readCachedTrustV1Params(db)).WEIGHT_VOLUME).toBe(0.30)
    expect(rows.calls).toBe(1)

    rows.value = [{ key: 'WEIGHT_VOLUME', value: '0.40' }]
    vi.advanceTimersByTime(30_000)
    // Still cached.
    expect((await readCachedTrustV1Params(db)).WEIGHT_VOLUME).toBe(0.30)
    expect(rows.calls).toBe(1)
  })

  it('after 60s TTL expires, next read picks up new DB value', async () => {
    const rows = { value: [{ key: 'WEIGHT_VOLUME', value: '0.30' }], calls: 0 }
    const db = stubDb(rows)

    expect((await readCachedTrustV1Params(db)).WEIGHT_VOLUME).toBe(0.30)

    rows.value = [{ key: 'WEIGHT_VOLUME', value: '0.40' }]
    vi.advanceTimersByTime(60_001)
    expect((await readCachedTrustV1Params(db)).WEIGHT_VOLUME).toBe(0.40)
    expect(rows.calls).toBe(2)
  })

  it('DB error reuses last-known-good cached snapshot (correctness over freshness)', async () => {
    // Most important contract: a transient DB blip during the scorer's
    // tick should NOT cause the scorer to use seed defaults if it had a
    // tuned snapshot before. The last-known-good snapshot is correct;
    // operator-tuned values stay in effect across the blip.
    const rows: { value: StubRow[]; calls: number; throws?: Error } = {
      value: [{ key: 'WEIGHT_VOLUME', value: '0.30' }],
      calls: 0,
    }
    const db = stubDb(rows)

    // Prime the cache.
    expect((await readCachedTrustV1Params(db)).WEIGHT_VOLUME).toBe(0.30)

    // Now make the next read fail.
    rows.throws = new Error('connection refused')
    vi.advanceTimersByTime(60_001)
    const params = await readCachedTrustV1Params(db)
    // Reused last-known-good snapshot, NOT seed default.
    expect(params.WEIGHT_VOLUME).toBe(0.30)
  })

  it('first-call DB error falls back to compiled-in seed defaults (no prior cache)', async () => {
    // No cached snapshot yet + DB throws → fall back to seeds. The
    // scorer continues to produce correct V1 scores; operator-tuned
    // values won't appear until the DB recovers.
    const rows = {
      value: [] as StubRow[],
      calls: 0,
      throws: new Error('connection refused'),
    }
    const db = stubDb(rows)
    const params = await readCachedTrustV1Params(db)
    const seedMap = new Map(TRUST_V1_PARAM_SEEDS.map((s) => [s.key, s.value]))
    expect(params.WEIGHT_VOLUME).toBe(seedMap.get('WEIGHT_VOLUME'))
  })

  it('clearParamsCache forces next read to hit the DB', async () => {
    const rows = { value: [{ key: 'WEIGHT_VOLUME', value: '0.30' }], calls: 0 }
    const db = stubDb(rows)

    await readCachedTrustV1Params(db)
    expect(rows.calls).toBe(1)
    await readCachedTrustV1Params(db) // cached
    expect(rows.calls).toBe(1)

    clearParamsCache()
    await readCachedTrustV1Params(db)
    expect(rows.calls).toBe(2)
  })
})
