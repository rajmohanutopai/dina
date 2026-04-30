import { sql } from 'drizzle-orm'
import cron from 'node-cron'
import { refreshProfiles } from './jobs/refresh-profiles.js'
import { refreshSubjectScores } from './jobs/refresh-subject-scores.js'
import { refreshReviewerStats } from './jobs/refresh-reviewer-stats.js'
import { refreshDomainScores } from './jobs/refresh-domain-scores.js'
import { detectCoordinationJob } from './jobs/detect-coordination.js'
import { detectSybilJob } from './jobs/detect-sybil.js'
import { processTombstones } from './jobs/process-tombstones.js'
import { decayScores } from './jobs/decay-scores.js'
import { cleanupExpired } from './jobs/cleanup-expired.js'
import { cosigExpirySweep } from './jobs/cosig-expiry-sweep.js'
import { subjectOrphanGc } from './jobs/subject-orphan-gc.js'
import { subjectEnrichRecompute } from './jobs/subject-enrich-recompute.js'
import type { DrizzleDB } from '@/db/connection.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'
import { readBoolFlag } from '@/db/queries/appview-config.js'

interface ScorerJob {
  name: string
  schedule: string
  handler: (db: DrizzleDB) => Promise<void>
}

const jobs: ScorerJob[] = [
  { name: 'refresh-profiles', schedule: '*/5 * * * *', handler: refreshProfiles },
  { name: 'refresh-subject-scores', schedule: '*/5 * * * *', handler: refreshSubjectScores },
  { name: 'refresh-reviewer-stats', schedule: '*/15 * * * *', handler: refreshReviewerStats },
  { name: 'refresh-domain-scores', schedule: '0 * * * *', handler: refreshDomainScores },
  { name: 'detect-coordination', schedule: '*/30 * * * *', handler: detectCoordinationJob },
  { name: 'detect-sybil', schedule: '0 */6 * * *', handler: detectSybilJob },
  { name: 'process-tombstones', schedule: '*/10 * * * *', handler: processTombstones },
  { name: 'decay-scores', schedule: '0 3 * * *', handler: decayScores },
  { name: 'cleanup-expired', schedule: '0 4 * * *', handler: cleanupExpired },
  // TN-SCORE-006: hourly cosig pending → expired transition. Runs at
  // :30 to avoid colliding with the on-the-hour `refresh-domain-scores`.
  { name: 'cosig-expiry-sweep', schedule: '30 * * * *', handler: cosigExpirySweep },
  // TN-SCORE-005: weekly orphan-subject reap. Sunday 05:00 — off-peak,
  // after the daily decay (03:00) + cleanup (04:00) finish, so the GC
  // sees the freshest reference graph.
  { name: 'subject-orphan-gc', schedule: '0 5 * * 0', handler: subjectOrphanGc },
  // TN-ENRICH-006: weekly re-enrichment of stale subjects. Sunday 02:00 —
  // earliest off-peak slot, before decay (03:00), cleanup (04:00), and
  // orphan-gc (05:00) so heuristic-map updates propagate to all live
  // subjects before the day's other jobs see them.
  { name: 'subject-enrich-recompute', schedule: '0 2 * * 0', handler: subjectEnrichRecompute },
]

/**
 * MED-05: Per-job overlap guard with both local and distributed protection.
 *
 * Local guard: `runningJobs` Set prevents the same job from running
 * concurrently within a single process. This is sufficient for
 * single-instance deployments.
 *
 * Distributed guard: pg_try_advisory_lock is attempted before each job.
 * If another process holds the lock, the job is skipped. This prevents
 * concurrent runs across multiple scorer instances.
 *
 * Advisory lock IDs are derived from a stable hash of the job name.
 */

function jobLockId(jobName: string): number {
  let hash = 0x811c9dc5 // FNV-1a offset basis
  for (let i = 0; i < jobName.length; i++) {
    hash ^= jobName.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) // FNV prime
  }
  return hash >>> 0 // ensure positive 32-bit int
}

export function startScheduler(db: DrizzleDB): void {
  const runningJobs = new Set<string>()

  for (const job of jobs) {
    const lockId = jobLockId(job.name)

    cron.schedule(job.schedule, async () => {
      // Feature-flag gate (TN-SCORE-010 / Plan §13.10). Read FIRST so a
      // disabled trust feature short-circuits before any locking or job
      // work. Direct read (not the ingester's cached reader) — scorer
      // cron ticks are minutes apart, and the ingester-style 5s cache
      // is overkill at that frequency. Closed-default on DB error: if
      // the flag read throws, log + skip the tick rather than running
      // the scorer against an unknown-flag state. Same posture as the
      // local/distributed locks below — defer the run, don't crash.
      try {
        const trustEnabled = await readBoolFlag(db, 'trust_v1_enabled')
        if (!trustEnabled) {
          logger.debug(
            { job: job.name },
            'Scorer job skipped — trust_v1_enabled = false',
          )
          metrics.incr('scorer.job.skipped_disabled', { job: job.name })
          return
        }
      } catch (err) {
        logger.error(
          { err, job: job.name },
          'Scorer job skipped — flag read failed (closed-default)',
        )
        metrics.incr('scorer.job.skipped_flag_error', { job: job.name })
        return
      }

      // Local overlap guard (single-process)
      if (runningJobs.has(job.name)) {
        logger.warn({ job: job.name }, 'Scorer job skipped — previous run still active (local)')
        metrics.incr('scorer.job.skipped', { job: job.name })
        return
      }

      // Distributed overlap guard (multi-instance via pg advisory lock)
      let lockAcquired = true // default: proceed if lock check fails
      try {
        const lockResult = await db.execute(
          sql`SELECT pg_try_advisory_lock(${lockId}) AS acquired`
        )
        // Drizzle execute returns { rows: [...] } — match codebase convention (subjects.ts:82)
        const row = (lockResult as any)?.rows?.[0] ?? (lockResult as any)?.[0]
        const acquired = row?.acquired
        if (acquired === false) {
          lockAcquired = false
        }
      } catch (err) {
        // If advisory lock fails (e.g., in test), proceed with local guard only
        logger.debug({ err, job: job.name }, 'Advisory lock unavailable, using local guard only')
      }
      if (!lockAcquired) {
        logger.warn({ job: job.name, lockId }, 'Scorer job skipped — held by another instance')
        metrics.incr('scorer.job.skipped_distributed', { job: job.name })
        return
      }

      runningJobs.add(job.name)
      const start = Date.now()
      logger.info({ job: job.name }, 'Scorer job starting')
      try {
        await job.handler(db)
        const durationMs = Date.now() - start
        logger.info({ job: job.name, durationMs }, 'Scorer job completed')
        metrics.histogram('scorer.job.duration_ms', durationMs, { job: job.name })
      } catch (err) {
        logger.error({ err, job: job.name }, 'Scorer job failed')
        metrics.incr('scorer.job.errors', { job: job.name })
      } finally {
        runningJobs.delete(job.name)
        // Release distributed lock
        try {
          await db.execute(sql`SELECT pg_advisory_unlock(${lockId})`)
        } catch { /* best-effort unlock */ }
      }
    })
    logger.info({ job: job.name, schedule: job.schedule }, 'Scorer job registered')
  }
}
