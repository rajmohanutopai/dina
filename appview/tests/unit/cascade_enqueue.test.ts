/**
 * Unit tests for `appview/src/scorer/jobs/refresh-profiles.ts`
 * cascade-enqueue logic (TN-SCORE-004 / Plan §13.7).
 *
 * Contract:
 *   - Old score snapshot taken in batch BEFORE the per-DID loop
 *   - Score change ≥ 0.01 (1 display point) triggers cascade
 *   - Score change < 0.01 does NOT cascade
 *   - Cascade picks up to 1000 distinct subject IDs the reviewer attested to
 *   - WHERE clause excludes already-dirty subject_scores rows (write
 *     amplification guard)
 *   - Revoked attestations excluded from cascade fan-out
 *   - NULL old score treated as 0 (new profile gets cascade if its
 *     first computed score lands ≥ 0.01)
 *   - Counter `scorer.cascade.enqueued` increments by the actual fan-out size
 */

import { describe, expect, it, vi } from 'vitest'

const mockMetricsCounter = vi.fn()
vi.mock('@/shared/utils/metrics.js', () => ({
  metrics: { counter: (...args: unknown[]) => mockMetricsCounter(...args) },
}))

const mockLoggerInfo = vi.fn()
const mockLoggerDebug = vi.fn()
const mockLoggerError = vi.fn()
vi.mock('@/shared/utils/logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    debug: (...a: unknown[]) => mockLoggerDebug(...a),
    warn: vi.fn(),
    error: (...a: unknown[]) => mockLoggerError(...a),
  },
}))

const mockComputeTrustScore = vi.fn()
vi.mock('@/scorer/algorithms/trust-score.js', () => ({
  computeTrustScore: (...a: unknown[]) => mockComputeTrustScore(...a),
}))

import { refreshProfiles } from '@/scorer/jobs/refresh-profiles'
import {
  attestations,
  didProfiles,
  subjectScores,
} from '@/db/schema/index'
import type { DrizzleDB } from '@/db/connection'

interface DirtyDid {
  did: string
  oldScore: number | null
  /** Attestation rows by this DID (subject_id, isRevoked). */
  attRows: Array<{ subjectId: string | null; isRevoked: boolean }>
}

interface CascadeCapture {
  subjectScoresUpdates: Array<{
    setValue: Record<string, unknown>
  }>
  didProfileUpdates: number
  /**
   * Captured `LIMIT` arg passed to the cascade's `selectDistinct`
   * chain — pins the per-reviewer fan-out cap (TN-SCORE-004 +
   * TN-TEST-002 / Plan §13.7 says cap=1000).
   */
  cascadeLimitArg?: number
}

/**
 * Stub matching the full chain refresh-profiles uses. We don't
 * exercise the entire `gatherTrustScoreInputs` (it's a long sequence
 * of un-cascade-related queries); instead we configure
 * `mockComputeTrustScore` per test and let `gatherTrustScoreInputs`
 * fall through with empty results.
 */
function stubDb(opts: {
  dirty: DirtyDid[]
  /** Already-dirty subject IDs to exclude from cascade UPDATE. */
  alreadyDirtySubjects?: string[]
}): { db: DrizzleDB; capture: CascadeCapture } {
  const capture: CascadeCapture = {
    subjectScoresUpdates: [],
    didProfileUpdates: 0,
  }
  const dirtyDidSet = opts.dirty.map((d) => d.did)
  const oldScores = new Map(opts.dirty.map((d) => [d.did, d.oldScore]))
  const attsByDid = new Map(opts.dirty.map((d) => [d.did, d.attRows]))

  let lastSelectTable: unknown = null
  let lastSelectDistinctTable: unknown = null
  let lastSelectColumns: string[] = []

  const db = {
    select: (selObj?: Record<string, unknown>) => {
      lastSelectColumns = selObj ? Object.keys(selObj) : []
      return {
        from: (table: unknown) => {
          lastSelectTable = table
          return {
            where: (..._args: unknown[]) => {
              // Different terminal shapes per call site.
              if (table === didProfiles) {
                // Two call sites: dirty enumeration + old-score snapshot.
                // Distinguish by columns selected:
                //   - dirty enumeration: { did }
                //   - old-score snapshot: { did, overallTrustScore }
                if (
                  lastSelectColumns.length === 2 &&
                  lastSelectColumns.includes('overallTrustScore')
                ) {
                  return Promise.resolve(
                    opts.dirty.map((d) => ({
                      did: d.did,
                      overallTrustScore: d.oldScore,
                    })),
                  )
                }
                // dirty enumeration ends with `.limit(...)`
                return {
                  limit: async () =>
                    opts.dirty.map((d) => ({ did: d.did })),
                }
              }
              if (table === attestations) {
                // gatherTrustScoreInputs hits attestations multiple
                // times. Return empty so computeTrustScore(input)
                // takes the shortest path.
                return Promise.resolve([])
              }
              // Other tables in gatherTrustScoreInputs all just
              // need to resolve with empty arrays.
              return Promise.resolve([])
            },
          }
        },
      }
    },
    selectDistinct: (_obj?: unknown) => ({
      from: (table: unknown) => {
        lastSelectDistinctTable = table
        return {
          where: (..._args: unknown[]) => ({
            limit: async () => {
              if (lastSelectDistinctTable === attestations) {
                // The cascade query: pick subjectIds for the current
                // reviewer DID. We can't easily know which DID
                // here without inspecting the SQL, so we route by
                // checking the captured DB state. Trick: the refresh
                // loop processes DIDs in order, so we track which
                // cascade-selectDistinct call this is via a counter.
                return cascadeRequests.shift() ?? []
              }
              return []
            },
          }),
        }
      },
    }),
    update: (table: unknown) => ({
      set: (value: Record<string, unknown>) => ({
        where: async () => {
          if (table === subjectScores) {
            capture.subjectScoresUpdates.push({ setValue: value })
          } else if (table === didProfiles) {
            capture.didProfileUpdates++
          }
        },
      }),
    }),
  } as unknown as DrizzleDB

  // Pre-compute cascade query results in DID-iteration order. The
  // refreshProfiles loop calls cascadeReviewerScoreChange once per DID
  // whose score moved enough; for DIDs that don't trigger cascade,
  // selectDistinct is never called for them. We can't predict which
  // DIDs cascade without invoking computeTrustScore — the test
  // configures mocks so trigger-vs-no-trigger is deterministic, then
  // pre-computes the cascade payloads in the right order.
  const cascadeRequests: Array<Array<{ subjectId: string | null }>> = []
  // The test uses `expectedCascadeOrder` (passed via opts) to populate.
  void dirtyDidSet
  void oldScores
  void attsByDid

  return { db, capture }
}

/**
 * Simpler stub specialized for cascade-only behaviour: stub returns
 * a single dirty DID, mocks computeTrustScore to return the desired
 * new score, and pre-seeds the cascade `selectDistinct` result with
 * the given subject IDs.
 */
function makeCascadeDb(opts: {
  did: string
  oldScore: number | null
  newScore: number | null
  cascadeSubjects: string[]
  /**
   * Optional: the count of rows the UPDATE actually flips (rows where
   * `needsRecalc` was previously `false`). Defaults to flipping every
   * cascade subject — i.e. the "no rows already dirty" case. Tests
   * that exercise the partial-flip path (write amplification guard)
   * pass a smaller number here.
   */
  flippedCount?: number
}): { db: DrizzleDB; capture: CascadeCapture } {
  const capture: CascadeCapture = {
    subjectScoresUpdates: [],
    didProfileUpdates: 0,
  }

  let lastSelectColumns: string[] = []
  const db = {
    select: (selObj?: Record<string, unknown>) => {
      lastSelectColumns = selObj ? Object.keys(selObj) : []
      return {
        from: (table: unknown) => ({
          where: () => {
            if (table === didProfiles) {
              if (
                lastSelectColumns.length === 2 &&
                lastSelectColumns.includes('overallTrustScore')
              ) {
                // Old-score snapshot
                return Promise.resolve([
                  { did: opts.did, overallTrustScore: opts.oldScore },
                ])
              }
              // Dirty enumeration
              return {
                limit: async () => [{ did: opts.did }],
              }
            }
            // Other gatherTrustScoreInputs queries: empty
            return Promise.resolve([])
          },
        }),
      }
    },
    selectDistinct: () => ({
      from: () => ({
        where: () => ({
          limit: async (n: number) => {
            capture.cascadeLimitArg = n
            return opts.cascadeSubjects.map((id) => ({ subjectId: id }))
          },
        }),
      }),
    }),
    // Drizzle UPDATE chain. The cascade path calls `.returning()` to
    // get the actual flipped-row count; didProfiles UPDATE just
    // awaits `.where(...)` directly. Make `where()` thenable AND
    // `.returning()`-callable to satisfy both shapes.
    update: (table: unknown) => ({
      set: (value: Record<string, unknown>) => ({
        where: () => {
          if (table === subjectScores) {
            capture.subjectScoresUpdates.push({ setValue: value })
          } else if (table === didProfiles) {
            capture.didProfileUpdates++
          }
          // For tests we treat "no rows already dirty" as the default —
          // every cascade subject flips to needsRecalc=true. Tests
          // that exercise the partial-flip path (write amplification
          // guard) pass `flippedCount` to model rows already dirty.
          const flippedN = opts.flippedCount ?? opts.cascadeSubjects.length
          const flipped = opts.cascadeSubjects
            .slice(0, flippedN)
            .map((id) => ({ subjectId: id }))
          return {
            returning: async () => flipped,
            then: (cb: (v: unknown) => unknown) => cb(undefined),
          }
        },
      }),
    }),
  } as unknown as DrizzleDB

  return { db, capture }
}

describe('refreshProfiles cascade — TN-SCORE-004', () => {
  it('score change ≥ 0.01 → cascade fires + counter increments', async () => {
    mockMetricsCounter.mockClear()
    mockComputeTrustScore.mockReturnValueOnce({ overallScore: 0.71 })
    const { db, capture } = makeCascadeDb({
      did: 'did:plc:r1',
      oldScore: 0.5, // delta = 0.21 → above threshold
      newScore: 0.71,
      cascadeSubjects: ['sub_a', 'sub_b', 'sub_c'],
    })
    await refreshProfiles(db)
    // cascade UPDATE was issued against subject_scores
    expect(capture.subjectScoresUpdates).toHaveLength(1)
    expect(capture.subjectScoresUpdates[0].setValue).toEqual({
      needsRecalc: true,
    })
    // counter incremented by the cascade size (3 subjects)
    expect(mockMetricsCounter).toHaveBeenCalledWith(
      'scorer.cascade.enqueued',
      3,
    )
  })

  it('score change < 0.01 → cascade does NOT fire', async () => {
    mockMetricsCounter.mockClear()
    mockComputeTrustScore.mockReturnValueOnce({ overallScore: 0.504 })
    const { db, capture } = makeCascadeDb({
      did: 'did:plc:r1',
      oldScore: 0.5, // delta = 0.004 → below threshold
      newScore: 0.504,
      cascadeSubjects: ['sub_a'],
    })
    await refreshProfiles(db)
    expect(capture.subjectScoresUpdates).toHaveLength(0)
    // No cascade counter call (counter is only called when fan-out > 0)
    expect(mockMetricsCounter).not.toHaveBeenCalledWith(
      'scorer.cascade.enqueued',
      expect.anything(),
    )
  })

  it('score change exactly 0.01 → cascade fires (boundary inclusive)', async () => {
    mockMetricsCounter.mockClear()
    mockComputeTrustScore.mockReturnValueOnce({ overallScore: 0.51 })
    const { db, capture } = makeCascadeDb({
      did: 'did:plc:r1',
      oldScore: 0.5, // delta = 0.01 → at threshold, inclusive
      newScore: 0.51,
      cascadeSubjects: ['sub_a'],
    })
    await refreshProfiles(db)
    expect(capture.subjectScoresUpdates).toHaveLength(1)
  })

  it('NULL old score treated as 0 → cascade if new ≥ 0.01', async () => {
    // First-time profile: no row existed yet, so oldScore is null.
    // Plan: a profile that goes from "no score" to "0.7" should
    // cascade — those subjects depend on this reviewer's credibility.
    mockMetricsCounter.mockClear()
    mockComputeTrustScore.mockReturnValueOnce({ overallScore: 0.7 })
    const { db, capture } = makeCascadeDb({
      did: 'did:plc:r1',
      oldScore: null,
      newScore: 0.7,
      cascadeSubjects: ['sub_a'],
    })
    await refreshProfiles(db)
    expect(capture.subjectScoresUpdates).toHaveLength(1)
  })

  it('symmetric delta (drop) also triggers cascade', async () => {
    // Score drop (e.g. revocations rolled in) should ripple just
    // like a score rise — subjects depending on this reviewer need
    // recompute.
    mockMetricsCounter.mockClear()
    mockComputeTrustScore.mockReturnValueOnce({ overallScore: 0.4 })
    const { db, capture } = makeCascadeDb({
      did: 'did:plc:r1',
      oldScore: 0.7, // delta = 0.3, drop direction
      newScore: 0.4,
      cascadeSubjects: ['sub_a'],
    })
    await refreshProfiles(db)
    expect(capture.subjectScoresUpdates).toHaveLength(1)
  })

  it('reviewer with no attested subjects → no cascade UPDATE', async () => {
    // Edge case: the reviewer's score moved, but they haven't
    // attested to anything yet (e.g. only received attestations).
    // The cascade query returns empty → no UPDATE issued.
    mockMetricsCounter.mockClear()
    mockComputeTrustScore.mockReturnValueOnce({ overallScore: 0.7 })
    const { db, capture } = makeCascadeDb({
      did: 'did:plc:r1',
      oldScore: 0.5,
      newScore: 0.7,
      cascadeSubjects: [], // no subjects to cascade to
    })
    await refreshProfiles(db)
    expect(capture.subjectScoresUpdates).toHaveLength(0)
  })

  it('counter reflects rows ACTUALLY flipped, not subjects considered', async () => {
    // Write-amplification guard contract: when some candidate
    // subjects are already dirty (needsRecalc=true), the UPDATE
    // skips them — and the counter must reflect the smaller
    // "actually queued" count, not the candidate count. Otherwise
    // the metric drifts away from reality under cascade storms.
    mockMetricsCounter.mockClear()
    mockComputeTrustScore.mockReturnValueOnce({ overallScore: 0.7 })
    const { db } = makeCascadeDb({
      did: 'did:plc:r1',
      oldScore: 0.5,
      newScore: 0.7,
      cascadeSubjects: ['sub_a', 'sub_b', 'sub_c', 'sub_d'],
      flippedCount: 2, // sub_c + sub_d were already dirty
    })
    await refreshProfiles(db)
    expect(mockMetricsCounter).toHaveBeenCalledWith(
      'scorer.cascade.enqueued',
      2, // not 4
    )
  })

  it('cascade selectDistinct passes LIMIT = 1000 (TN-SCORE-004 + TN-TEST-002 cap)', async () => {
    // Plan §13.7 explicitly bounds per-reviewer fan-out at 1000
    // subjects per cascade trigger to prevent a single popular
    // reviewer from swamping the scorer queue. Pinned here as a
    // regression test against accidentally raising the limit (e.g.
    // a refactor that drops the `.limit()` call entirely would
    // result in the full attestation set being marked dirty —
    // potentially 50k rows for a hot reviewer).
    mockComputeTrustScore.mockReturnValueOnce({ overallScore: 0.7 })
    const { db, capture } = makeCascadeDb({
      did: 'did:plc:r1',
      oldScore: 0.5,
      newScore: 0.7,
      cascadeSubjects: ['sub_a'],
    })
    await refreshProfiles(db)
    expect(capture.cascadeLimitArg).toBe(1000)
  })

  it('cascade UPDATE sets needsRecalc=true (single field)', async () => {
    // The SET payload should be MINIMAL — only the dirty bit. We
    // don't bump computedAt or anything else; the next refresh-
    // subject-scores tick will do the actual computation.
    mockComputeTrustScore.mockReturnValueOnce({ overallScore: 0.7 })
    const { db, capture } = makeCascadeDb({
      did: 'did:plc:r1',
      oldScore: 0.5,
      newScore: 0.7,
      cascadeSubjects: ['sub_a', 'sub_b'],
    })
    await refreshProfiles(db)
    expect(capture.subjectScoresUpdates[0].setValue).toEqual({
      needsRecalc: true,
    })
    // Specifically NOT bumping scoreVersion / computedAt — those
    // are the next refresh-subject-scores tick's job.
    expect('scoreVersion' in capture.subjectScoresUpdates[0].setValue).toBe(
      false,
    )
  })
})
