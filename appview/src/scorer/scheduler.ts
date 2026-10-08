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
import { backfillHandles } from './jobs/backfill-handles.js'
import { ucpMerchantCrawler } from './jobs/ucp-merchant-crawler.js'
import type { DrizzleDB } from '@/db/connection.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'
import { readBoolFlag, type AppviewFlagKey } from '@/db/queries/appview-config.js'
import { serviceReconcile } from './jobs/service-reconcile.js'
import { serviceLivenessGc, servicePresenceHealth } from './jobs/service-liveness-jobs.js'

interface ScorerJob {
  name: string
  schedule: string
  handler: (db: DrizzleDB) => Promise<void>
  /** The kill switch the job obeys. Default `trust_v1_enabled`. */
  flag?: AppviewFlagKey
}

/**
 * The scheduled jobs, EXPORTED so a test can count the real thing.
 *
 * An integration test asserted "the scheduler defines exactly 9 jobs" by
 * checking the length of its OWN fixture array, with a comment explaining
 * that the real list could not be imported. So the claim was never checked
 * against anything: the list grew to 13 and the assertion stayed green,
 * because it had only ever measured itself.
 */
export const SCORER_JOBS: ScorerJob[] = [
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
  // Backfills `did_profiles.handle` from PLC `alsoKnownAs[0]`.
  // Cosmetic / display-name surface — see `backfill-handles.ts`.
  // 10 minutes is fast enough that fresh profiles get a handle
  // within one or two ticks, slow enough not to hammer the PLC
  // directory.
  { name: 'backfill-handles', schedule: '*/10 * * * *', handler: backfillHandles },
  // UCP plan §3.15: the merchant index. Hourly at :20 (clear of the on-the-hour and :30
  // jobs); each origin is read at most once a day, so an hour only bounds how soon a
  // newly reviewed merchant is read.
  { name: 'ucp-merchant-crawler', schedule: '20 * * * *', handler: (db) => ucpMerchantCrawler(db) },
  // Live listings (docs/REAL_LIFE_FIXES.md §14): re-read listings AppView may
  // hold wrongly (every minute; one run per DID per hour), the health guard
  // that pauses ageing when AppView misses renewals (hourly at :40), and the
  // daily clean-up (04:30). They obey the services switch, not the trust one.
  { name: 'service-reconcile', schedule: '* * * * *', handler: (db) => serviceReconcile(db), flag: 'service_index_enabled' },
  { name: 'service-presence-health', schedule: '40 * * * *', handler: async (db) => void (await servicePresenceHealth(db)), flag: 'service_index_enabled' },
  { name: 'service-liveness-gc', schedule: '30 4 * * *', handler: (db) => serviceLivenessGc(db), flag: 'service_index_enabled' },
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

interface PoolClientLike {
  query(text: string, values: unknown[]): Promise<{ rows: { acquired?: boolean }[] }>
  release(): void
}

/**
 * Take a job's advisory lock on a connection of its own: `held` when another
 * instance holds it; otherwise a handle that releases it on that same
 * connection, then returns the connection. With no pool to draw from (a test
 * double), or a lock that cannot be asked for, the local guard alone runs it.
 */
export async function takeJobLock(
  db: DrizzleDB,
  lockId: number,
  jobName: string,
): Promise<'held' | { release: () => Promise<void> }> {
  const pool = (db as unknown as { $client?: { connect?: () => Promise<PoolClientLike> } }).$client
  const none = { release: async () => undefined }
  if (typeof pool?.connect !== 'function') return none
  let client: PoolClientLike
  try {
    client = await pool.connect()
  } catch (err) {
    logger.debug({ err, job: jobName }, 'Advisory lock unavailable, using local guard only')
    return none
  }
  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [lockId])
    if (result.rows[0]?.acquired === false) {
      client.release()
      return 'held'
    }
  } catch (err) {
    logger.debug({ err, job: jobName }, 'Advisory lock unavailable, using local guard only')
    client.release()
    return none
  }
  return {
    release: async () => {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [lockId])
      } catch {
        /* best-effort: the connection's end releases it too */
      } finally {
        client.release()
      }
    },
  }
}

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

  for (const job of SCORER_JOBS) {
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
        const flag = job.flag ?? 'trust_v1_enabled'
        const trustEnabled = await readBoolFlag(db, flag)
        if (!trustEnabled) {
          logger.debug(
            { job: job.name, flag },
            'Scorer job skipped — its flag is off',
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

      // Distributed overlap guard (multi-instance via pg advisory lock). A session lock
      // belongs to the connection that took it, so it is taken and released on ONE
      // connection held for the job: through the pool, the unlock could land on another
      // backend, fail, and leave the lock held until that connection closed.
      const lock = await takeJobLock(db, lockId, job.name)
      if (lock === 'held') {
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
        await lock.release()
      }
    })
    logger.info({ job: job.name, schedule: job.schedule }, 'Scorer job registered')
  }
}
