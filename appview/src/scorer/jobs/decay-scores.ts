import { eq, sql, and, lt, gt, isNotNull } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import {
  didProfiles,
  subjectScores,
} from '@/db/schema/index.js'
import { CONSTANTS } from '@/config/constants.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

// Daily decay factor: scores decay slightly toward the base score
// when there has been no recent activity
const DECAY_RATE = 0.995 // 0.5% daily decay
const INACTIVITY_THRESHOLD_DAYS = 30

export async function decayScores(db: DrizzleDB): Promise<void> {
  const cutoff = new Date(Date.now() - INACTIVITY_THRESHOLD_DAYS * 24 * 60 * 60 * 1000)
  const now = new Date()

  // Decay DID profile scores for inactive profiles
  // Only decay profiles that haven't been computed recently and have a score above base
  const profileResult = await db
    .update(didProfiles)
    .set({
      overallTrustScore: sql`${didProfiles.overallTrustScore} * ${DECAY_RATE}`,
      computedAt: now,
    })
    .where(
      and(
        lt(didProfiles.computedAt, cutoff),
        isNotNull(didProfiles.overallTrustScore),
        gt(didProfiles.overallTrustScore, CONSTANTS.BASE_SCORE),
      )
    )

  // Decay subject scores for subjects with no recent attestations
  const subjectResult = await db
    .update(subjectScores)
    .set({
      weightedScore: sql`${subjectScores.weightedScore} * ${DECAY_RATE}`,
      confidence: sql`GREATEST(${subjectScores.confidence} * ${DECAY_RATE}, 0.1)`,
      computedAt: now,
    })
    .where(
      and(
        lt(subjectScores.computedAt, cutoff),
        isNotNull(subjectScores.weightedScore),
        gt(subjectScores.weightedScore, 0),
      )
    )

  logger.info('decay-scores: applied daily decay to inactive profiles and subjects')
  metrics.counter('scorer.decay_scores.executed', 1)
}
