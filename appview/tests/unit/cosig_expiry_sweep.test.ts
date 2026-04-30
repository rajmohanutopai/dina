/**
 * Unit tests for `appview/src/scorer/jobs/cosig-expiry-sweep.ts`
 * (TN-SCORE-006).
 *
 * Contract:
 *   - WHERE clause is `status = 'pending' AND expires_at < now()`
 *   - SET clause writes status='expired', reject_reason='expired',
 *     updated_at=now
 *   - Idempotent (already-expired rows excluded by WHERE)
 *   - Bulk UPDATE — single statement, no chunking
 *   - Logs + metric on every run, even when no rows expired
 */

import { describe, expect, it, vi } from 'vitest'

const mockMetricsCounter = vi.fn()
vi.mock('@/shared/utils/metrics.js', () => ({
  metrics: { counter: (...args: unknown[]) => mockMetricsCounter(...args) },
}))

const mockLoggerInfo = vi.fn()
const mockLoggerDebug = vi.fn()
vi.mock('@/shared/utils/logger.js', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    debug: (...args: unknown[]) => mockLoggerDebug(...args),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { cosigExpirySweep } from '@/scorer/jobs/cosig-expiry-sweep'
import type { DrizzleDB } from '@/db/connection'

interface CapturedUpdate {
  setCalled: boolean
  setValue: Record<string, unknown> | null
  whereCalled: boolean
  returningCalled: boolean
}

/**
 * DB stub matching `db.update(table).set(...).where(...).returning(...)`
 * — captures the SET payload + chain shape so tests can assert behaviour
 * without a real pg connection.
 */
function stubDb(returnedRows: { id: bigint }[]): {
  db: DrizzleDB
  capture: CapturedUpdate
} {
  const capture: CapturedUpdate = {
    setCalled: false,
    setValue: null,
    whereCalled: false,
    returningCalled: false,
  }
  const db = {
    update: () => ({
      set: (value: Record<string, unknown>) => {
        capture.setCalled = true
        capture.setValue = value
        return {
          where: () => {
            capture.whereCalled = true
            return {
              returning: async () => {
                capture.returningCalled = true
                return returnedRows
              },
            }
          },
        }
      },
    }),
  } as unknown as DrizzleDB
  return { db, capture }
}

describe('cosigExpirySweep — TN-SCORE-006', () => {
  it('SET clause writes status=expired + reject_reason=expired + updated_at', async () => {
    const { db, capture } = stubDb([{ id: 1n }, { id: 2n }])
    await cosigExpirySweep(db)

    expect(capture.setCalled).toBe(true)
    expect(capture.setValue).not.toBeNull()
    expect(capture.setValue!.status).toBe('expired')
    expect(capture.setValue!.rejectReason).toBe('expired')
    // updated_at must be a Date — the bridge from "wall clock now" to
    // the row's audit field is the whole point of the SET clause.
    expect(capture.setValue!.updatedAt).toBeInstanceOf(Date)
  })

  it('uses .returning() to count exactly what changed (driver-portable)', async () => {
    // node-postgres returns `{ rowCount }`; mysql / sqlite drivers
    // return different shapes. `.returning()` is the only portable
    // way to count rows actually mutated. Test pins the contract so a
    // future refactor doesn't silently regress to a non-portable count.
    const { db, capture } = stubDb([{ id: 7n }])
    await cosigExpirySweep(db)
    expect(capture.returningCalled).toBe(true)
  })

  it('logs + counter on positive count', async () => {
    const { db } = stubDb([{ id: 1n }, { id: 2n }, { id: 3n }])
    await cosigExpirySweep(db)
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      { count: 3 },
      'cosig-expiry-sweep: pending requests expired',
    )
    expect(mockMetricsCounter).toHaveBeenCalledWith(
      'scorer.cosig_expiry_sweep.expired',
      3,
    )
  })

  it('logs debug + zero counter when nothing expired', async () => {
    // Healthy steady state: most ticks find nothing. Don't spam INFO
    // logs at one per hour with an "expired 0" message — DEBUG is the
    // right level. Counter still increments (with zero) so dashboards
    // can show "job ran" cleanly.
    mockLoggerInfo.mockClear()
    mockMetricsCounter.mockClear()
    const { db } = stubDb([])
    await cosigExpirySweep(db)
    expect(mockLoggerInfo).not.toHaveBeenCalled()
    expect(mockLoggerDebug).toHaveBeenCalledWith(
      'cosig-expiry-sweep: no expired pending requests',
    )
    expect(mockMetricsCounter).toHaveBeenCalledWith(
      'scorer.cosig_expiry_sweep.expired',
      0,
    )
  })

  it('does not throw on empty result (smoke test for the no-op tick)', async () => {
    const { db } = stubDb([])
    await expect(cosigExpirySweep(db)).resolves.toBeUndefined()
  })

  it('runs the WHERE clause before .returning() (chain order)', async () => {
    // Belt-and-suspenders: defends against a future refactor that
    // accidentally drops .where(...) → would expire ALL cosig rows
    // (catastrophic). Explicit chain-order check.
    const { db, capture } = stubDb([{ id: 1n }])
    await cosigExpirySweep(db)
    expect(capture.whereCalled).toBe(true)
    expect(capture.returningCalled).toBe(true)
  })
})
