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
import type { DrizzleDB } from '@/db/connection.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

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
]

export function startScheduler(db: DrizzleDB): void {
  for (const job of jobs) {
    cron.schedule(job.schedule, async () => {
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
      }
    })
    logger.info({ job: job.name, schedule: job.schedule }, 'Scorer job registered')
  }
}
