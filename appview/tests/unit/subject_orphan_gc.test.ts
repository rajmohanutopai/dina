/**
 * Unit tests for `appview/src/scorer/jobs/subject-orphan-gc.ts`
 * (TN-SCORE-005).
 *
 * Contract:
 *   - Two-phase delete: subject_scores first (FK), then subjects
 *   - Wrapped in a transaction (atomic — partial reaps are not allowed)
 *   - Per-run cap surfaces a warning + cap-hit metric
 *   - Empty candidate result short-circuits with zero counter
 *   - Logs + metric on every run
 */

import { describe, expect, it, vi } from 'vitest'

const mockMetricsCounter = vi.fn()
vi.mock('@/shared/utils/metrics.js', () => ({
  metrics: { counter: (...args: unknown[]) => mockMetricsCounter(...args) },
}))

const mockLoggerInfo = vi.fn()
const mockLoggerDebug = vi.fn()
const mockLoggerWarn = vi.fn()
vi.mock('@/shared/utils/logger.js', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    debug: (...args: unknown[]) => mockLoggerDebug(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
  },
}))

import { subjectOrphanGc } from '@/scorer/jobs/subject-orphan-gc'
import { subjects, subjectScores } from '@/db/schema/index'
import type { DrizzleDB } from '@/db/connection'

interface CapturedDeletes {
  /** Names of tables passed to `db.delete(...)` — order matters. */
  deleteOrder: string[]
  txStarted: boolean
}

/**
 * DB stub matching the shape that `subjectOrphanGc` exercises:
 *   db.select().from(subjects).where(...).limit(...) → [{id}, ...]
 *   db.transaction(fn) → wraps tx that does delete(subjectScores) then delete(subjects)
 */
function stubDb(
  candidateIds: string[],
): { db: DrizzleDB; captured: CapturedDeletes } {
  const captured: CapturedDeletes = { deleteOrder: [], txStarted: false }

  // Identify tables by object identity against the actual schema
  // imports — same table reference the production code uses, so the
  // assertion is exact (no string-name guesswork).
  const tableName = (table: unknown): string => {
    if (table === subjectScores) return 'subject_scores'
    if (table === subjects) return 'subjects'
    return 'unknown'
  }

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => candidateIds.map((id) => ({ id })),
        }),
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      captured.txStarted = true
      const tx = {
        delete: (table: unknown) => {
          captured.deleteOrder.push(tableName(table))
          return {
            where: async () => undefined,
          }
        },
      }
      await fn(tx)
    },
  } as unknown as DrizzleDB
  return { db, captured }
}

describe('subjectOrphanGc — TN-SCORE-005', () => {
  it('no candidates → debug log, zero counter, no transaction', async () => {
    mockLoggerInfo.mockClear()
    mockLoggerDebug.mockClear()
    mockMetricsCounter.mockClear()
    const { db, captured } = stubDb([])
    await subjectOrphanGc(db)
    expect(captured.txStarted).toBe(false)
    expect(captured.deleteOrder).toEqual([])
    expect(mockLoggerInfo).not.toHaveBeenCalled()
    expect(mockLoggerDebug).toHaveBeenCalledWith(
      'subject-orphan-gc: no orphan subjects to reap',
    )
    expect(mockMetricsCounter).toHaveBeenCalledWith(
      'scorer.subject_orphan_gc.deleted',
      0,
    )
  })

  it('deletes dependents BEFORE parents (FK constraint order)', async () => {
    // The whole reason the job needs a two-phase delete: subject_scores
    // has a FK to subjects.id. Reversing the order would fail with a
    // FK violation. Pin the contract so a refactor doesn't accidentally
    // collapse the two deletes (e.g., to a single ON DELETE CASCADE
    // change in the schema — that needs an explicit migration, not a
    // silent reorder here).
    mockMetricsCounter.mockClear()
    const { db, captured } = stubDb(['subj-1', 'subj-2'])
    await subjectOrphanGc(db)
    expect(captured.txStarted).toBe(true)
    expect(captured.deleteOrder).toEqual(['subject_scores', 'subjects'])
  })

  it('deletes are wrapped in a transaction (atomicity)', async () => {
    // Without the transaction, a crash between the two deletes would
    // leave subjects rows whose subject_scores were nuked → broken
    // referential expectations downstream. The tx must wrap both.
    const { db, captured } = stubDb(['subj-1'])
    await subjectOrphanGc(db)
    expect(captured.txStarted).toBe(true)
  })

  it('logs INFO + counter with reaped count', async () => {
    mockLoggerInfo.mockClear()
    mockMetricsCounter.mockClear()
    const { db } = stubDb(['s1', 's2', 's3'])
    await subjectOrphanGc(db)
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      { count: 3 },
      'subject-orphan-gc: orphan subjects reaped',
    )
    expect(mockMetricsCounter).toHaveBeenCalledWith(
      'scorer.subject_orphan_gc.deleted',
      3,
    )
  })

  it('per-run cap → warns + cap-hit metric (5000-row ceiling)', async () => {
    // Surface that there's still a backlog. The cap-hit metric lets
    // ops alert on it; the warn log gives them the constant value
    // without grepping the source.
    mockLoggerWarn.mockClear()
    mockMetricsCounter.mockClear()
    const fiveThousand = Array.from({ length: 5000 }, (_, i) => `s-${i}`)
    const { db } = stubDb(fiveThousand)
    await subjectOrphanGc(db)
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { cap: 5000 },
      'subject-orphan-gc: hit per-run cap, more orphans likely pending',
    )
    expect(mockMetricsCounter).toHaveBeenCalledWith(
      'scorer.subject_orphan_gc.cap_hit',
      1,
    )
  })

  it('below cap → no cap-hit warning', async () => {
    // Defensive — the warn must NOT fire on healthy small reaps,
    // otherwise it becomes log noise and operators ignore it.
    mockLoggerWarn.mockClear()
    mockMetricsCounter.mockClear()
    const { db } = stubDb(Array.from({ length: 100 }, (_, i) => `s-${i}`))
    await subjectOrphanGc(db)
    expect(mockLoggerWarn).not.toHaveBeenCalled()
    expect(mockMetricsCounter).not.toHaveBeenCalledWith(
      'scorer.subject_orphan_gc.cap_hit',
      expect.anything(),
    )
  })
})
