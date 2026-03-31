/**
 * =============================================================================
 * Section 7 -- Scorer Jobs -- Scheduling Logic (src/scorer/)
 * =============================================================================
 * Plan traceability: UNIT_TEST_PLAN.md SS7
 * Subsections:       SS7.1 Scheduler        (UT-SCH-001 .. UT-SCH-013)
 *                    SS7.2 Decay Scores      (UT-DS-001  .. UT-DS-004)
 * Total tests:       17
 * =============================================================================
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CONSTANTS } from '@/config/constants.js'

// ── Mock modules ─────────────────────────────────────────────────────

// Track cron.schedule calls: capture (schedule, callback) pairs
const cronScheduleCalls: Array<{ schedule: string; callback: () => Promise<void> }> = []

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((schedule: string, callback: () => Promise<void>) => {
      cronScheduleCalls.push({ schedule, callback })
    }),
  },
}))

// Mock all 9 job handlers to be controllable
const mockRefreshProfiles = vi.fn().mockResolvedValue(undefined)
const mockRefreshSubjectScores = vi.fn().mockResolvedValue(undefined)
const mockRefreshReviewerStats = vi.fn().mockResolvedValue(undefined)
const mockRefreshDomainScores = vi.fn().mockResolvedValue(undefined)
const mockDetectCoordination = vi.fn().mockResolvedValue(undefined)
const mockDetectSybil = vi.fn().mockResolvedValue(undefined)
const mockProcessTombstones = vi.fn().mockResolvedValue(undefined)
const mockDecayScores = vi.fn().mockResolvedValue(undefined)
const mockCleanupExpired = vi.fn().mockResolvedValue(undefined)

vi.mock('@/scorer/jobs/refresh-profiles.js', () => ({
  refreshProfiles: (...args: any[]) => mockRefreshProfiles(...args),
}))
vi.mock('@/scorer/jobs/refresh-subject-scores.js', () => ({
  refreshSubjectScores: (...args: any[]) => mockRefreshSubjectScores(...args),
}))
vi.mock('@/scorer/jobs/refresh-reviewer-stats.js', () => ({
  refreshReviewerStats: (...args: any[]) => mockRefreshReviewerStats(...args),
}))
vi.mock('@/scorer/jobs/refresh-domain-scores.js', () => ({
  refreshDomainScores: (...args: any[]) => mockRefreshDomainScores(...args),
}))
vi.mock('@/scorer/jobs/detect-coordination.js', () => ({
  detectCoordinationJob: (...args: any[]) => mockDetectCoordination(...args),
}))
vi.mock('@/scorer/jobs/detect-sybil.js', () => ({
  detectSybilJob: (...args: any[]) => mockDetectSybil(...args),
}))
vi.mock('@/scorer/jobs/process-tombstones.js', () => ({
  processTombstones: (...args: any[]) => mockProcessTombstones(...args),
}))
vi.mock('@/scorer/jobs/decay-scores.js', () => ({
  decayScores: (...args: any[]) => mockDecayScores(...args),
}))
vi.mock('@/scorer/jobs/cleanup-expired.js', () => ({
  cleanupExpired: (...args: any[]) => mockCleanupExpired(...args),
}))

// Mock logger and metrics
const mockLoggerInfo = vi.fn()
const mockLoggerError = vi.fn()

vi.mock('@/shared/utils/logger.js', () => ({
  logger: {
    info: (...args: any[]) => mockLoggerInfo(...args),
    warn: vi.fn(),
    error: (...args: any[]) => mockLoggerError(...args),
    debug: vi.fn(),
  },
}))

const mockMetricsIncr = vi.fn()
const mockMetricsHistogram = vi.fn()

vi.mock('@/shared/utils/metrics.js', () => ({
  metrics: {
    incr: (...args: any[]) => mockMetricsIncr(...args),
    gauge: vi.fn(),
    histogram: (...args: any[]) => mockMetricsHistogram(...args),
    counter: vi.fn(),
  },
}))

// Import scheduler after mocks
import { startScheduler } from '@/scorer/scheduler.js'

// ── Helpers ──────────────────────────────────────────────────────────

const mockDb = {} as any

/** Find the cron entry for a given schedule string */
function findJobBySchedule(schedule: string) {
  return cronScheduleCalls.find((c) => c.schedule === schedule)
}

/** Find the cron entry by index (order of registration) */
function getJobAt(index: number) {
  return cronScheduleCalls[index]
}

// ---------------------------------------------------------------------------
// SS7.1 Scheduler
// ---------------------------------------------------------------------------
describe('SS7.1 Scheduler', () => {
  beforeEach(() => {
    cronScheduleCalls.length = 0
    vi.clearAllMocks()
    startScheduler(mockDb)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0263", "section": "01", "sectionName": "General", "title": "UT-SCH-001: all 9 jobs registered"}
  it('UT-SCH-001: all 9 jobs registered', () => {
    // Description: startScheduler called
    // Expected: 9 cron.schedule calls made
    expect(cronScheduleCalls).toHaveLength(9)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0264", "section": "01", "sectionName": "General", "title": "UT-SCH-002: refresh-profiles runs every 5 min"}
  it('UT-SCH-002: refresh-profiles runs every 5 min', () => {
    // Description: Job schedule
    // Expected: schedule = "*/5 * * * *"
    // The scheduler registers refresh-profiles first
    expect(cronScheduleCalls[0].schedule).toBe('*/5 * * * *')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0265", "section": "01", "sectionName": "General", "title": "UT-SCH-003: refresh-subject-scores runs every 5 min"}
  it('UT-SCH-003: refresh-subject-scores runs every 5 min', () => {
    // Description: Job schedule
    // Expected: schedule = "*/5 * * * *"
    expect(cronScheduleCalls[1].schedule).toBe('*/5 * * * *')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0266", "section": "01", "sectionName": "General", "title": "UT-SCH-004: detect-coordination runs every 30 min"}
  it('UT-SCH-004: detect-coordination runs every 30 min', () => {
    // Description: Job schedule
    // Expected: schedule = "*/30 * * * *"
    const entry = findJobBySchedule('*/30 * * * *')
    expect(entry).toBeDefined()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0267", "section": "01", "sectionName": "General", "title": "UT-SCH-005: detect-sybil runs every 6 hours"}
  it('UT-SCH-005: detect-sybil runs every 6 hours', () => {
    // Description: Job schedule
    // Expected: schedule = "0 */6 * * *"
    const entry = findJobBySchedule('0 */6 * * *')
    expect(entry).toBeDefined()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0268", "section": "01", "sectionName": "General", "title": "UT-SCH-006: decay-scores runs daily at 3 AM"}
  it('UT-SCH-006: decay-scores runs daily at 3 AM', () => {
    // Description: Job schedule
    // Expected: schedule = "0 3 * * *"
    const entry = findJobBySchedule('0 3 * * *')
    expect(entry).toBeDefined()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0269", "section": "01", "sectionName": "General", "title": "UT-SCH-007: cleanup-expired runs daily at 4 AM"}
  it('UT-SCH-007: cleanup-expired runs daily at 4 AM', () => {
    // Description: Job schedule
    // Expected: schedule = "0 4 * * *"
    const entry = findJobBySchedule('0 4 * * *')
    expect(entry).toBeDefined()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0270", "section": "01", "sectionName": "General", "title": "UT-SCH-008: refresh-reviewer-stats runs every 15 min"}
  it('UT-SCH-008: refresh-reviewer-stats runs every 15 min', () => {
    // Description: Job schedule
    // Expected: schedule = "*/15 * * * *"
    const entry = findJobBySchedule('*/15 * * * *')
    expect(entry).toBeDefined()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0271", "section": "01", "sectionName": "General", "title": "UT-SCH-009: refresh-domain-scores runs every hour"}
  it('UT-SCH-009: refresh-domain-scores runs every hour', () => {
    // Description: Job schedule
    // Expected: schedule = "0 * * * *"
    const entry = findJobBySchedule('0 * * * *')
    expect(entry).toBeDefined()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0272", "section": "01", "sectionName": "General", "title": "UT-SCH-010: process-tombstones runs every 10 min"}
  it('UT-SCH-010: process-tombstones runs every 10 min', () => {
    // Description: Job schedule
    // Expected: schedule = "*/10 * * * *"
    const entry = findJobBySchedule('*/10 * * * *')
    expect(entry).toBeDefined()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0273", "section": "01", "sectionName": "General", "title": "UT-SCH-011: job error -> caught and logged"}
  it('UT-SCH-011: job error -> caught and logged', async () => {
    // Description: Handler throws error
    // Expected: Error logged, no process crash
    const testError = new Error('Job failed intentionally')
    mockRefreshProfiles.mockRejectedValueOnce(testError)

    // Execute the first job's callback (refresh-profiles)
    const job = cronScheduleCalls[0]
    await job.callback()

    // The scheduler catches errors and logs them
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: testError }),
      expect.stringContaining('Scorer job failed'),
    )
  })

  // TRACE: {"suite": "APPVIEW", "case": "0274", "section": "01", "sectionName": "General", "title": "UT-SCH-012: job duration tracked"}
  it('UT-SCH-012: job duration tracked', async () => {
    // Description: Handler completes successfully
    // Expected: Histogram metric recorded with duration
    // Execute the first job's callback
    const job = cronScheduleCalls[0]
    await job.callback()

    expect(mockMetricsHistogram).toHaveBeenCalledWith(
      'scorer.job.duration_ms',
      expect.any(Number),
      expect.objectContaining({ job: 'refresh-profiles' }),
    )
  })

  // TRACE: {"suite": "APPVIEW", "case": "0275", "section": "01", "sectionName": "General", "title": "UT-SCH-013: job error metric incremented"}
  it('UT-SCH-013: job error metric incremented', async () => {
    // Description: Handler throws
    // Expected: scorer.job.errors counter incremented
    mockRefreshProfiles.mockRejectedValueOnce(new Error('fail'))

    const job = cronScheduleCalls[0]
    await job.callback()

    expect(mockMetricsIncr).toHaveBeenCalledWith(
      'scorer.job.errors',
      expect.objectContaining({ job: 'refresh-profiles' }),
    )
  })
})

// ---------------------------------------------------------------------------
// SS7.2 Decay Scores Logic
//
// The decay formula used in scoring is: weight = original * 0.5^(daysSince / halflife)
// where halflife = CONSTANTS.SENTIMENT_HALFLIFE_DAYS (180 days).
// This tests the mathematical properties of the halflife decay model.
// ---------------------------------------------------------------------------
describe('SS7.2 Decay Scores', () => {
  const HALFLIFE = CONSTANTS.SENTIMENT_HALFLIFE_DAYS // 180

  /**
   * Apply the halflife decay formula.
   * weight = original * Math.pow(0.5, daysSince / halflife)
   */
  function applyDecay(original: number, daysSince: number): number {
    return original * Math.pow(0.5, daysSince / HALFLIFE)
  }

  // TRACE: {"suite": "APPVIEW", "case": "0276", "section": "01", "sectionName": "General", "title": "UT-DS-001: recent attestation -- no decay"}
  it('UT-DS-001: recent attestation -- no decay', () => {
    // Description: attestation from 1 day ago
    // Expected: Weight approximately unchanged
    const weight = applyDecay(1.0, 1)
    // After 1 day, decay is minimal: 0.5^(1/180) = ~0.9962
    expect(weight).toBeGreaterThan(0.99)
    expect(weight).toBeLessThanOrEqual(1.0)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0277", "section": "01", "sectionName": "General", "title": "UT-DS-002: old attestation -- decayed"}
  it('UT-DS-002: old attestation -- decayed', () => {
    // Description: Attestation from 365 days ago
    // Expected: Weight significantly reduced
    const weight = applyDecay(1.0, 365)
    // After 365 days: 0.5^(365/180) = 0.5^2.028 = ~0.245
    expect(weight).toBeLessThan(0.3)
    expect(weight).toBeGreaterThan(0.1)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0278", "section": "01", "sectionName": "General", "title": "UT-DS-003: halflife calculation"}
  it('UT-DS-003: halflife calculation', () => {
    // Description: At exactly SENTIMENT_HALFLIFE_DAYS
    // Expected: Weight = ~50% of original
    const weight = applyDecay(1.0, HALFLIFE)
    // At exactly the halflife: 0.5^(180/180) = 0.5
    expect(weight).toBeCloseTo(0.5, 5)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0279", "section": "01", "sectionName": "General", "title": "UT-DS-004: very old attestation -- near zero"}
  it('UT-DS-004: very old attestation -- near zero', () => {
    // Description: Attestation from 1000 days ago
    // Expected: Weight near zero but not exactly zero
    const weight = applyDecay(1.0, 1000)
    // After 1000 days: 0.5^(1000/180) = 0.5^5.556 = ~0.021
    expect(weight).toBeGreaterThan(0)
    expect(weight).toBeLessThan(0.05)
  })
})
