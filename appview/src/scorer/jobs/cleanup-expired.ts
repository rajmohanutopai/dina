import { eq, sql, and, lt } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import {
  delegations,
  reviewRequests,
  anomalyEvents,
} from '@/db/schema/index.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

const RESOLVED_ANOMALY_RETENTION_DAYS = 30

export async function cleanupExpired(db: DrizzleDB): Promise<void> {
  const now = new Date()

  // Delete expired delegations
  const expiredDelegations = await db
    .delete(delegations)
    .where(
      and(
        lt(delegations.expiresAt, now),
        sql`${delegations.expiresAt} IS NOT NULL`,
      )
    )

  // Delete expired review requests
  const expiredReviewRequests = await db
    .delete(reviewRequests)
    .where(
      and(
        lt(reviewRequests.expiresAt, now),
        sql`${reviewRequests.expiresAt} IS NOT NULL`,
      )
    )

  // Delete resolved anomaly events older than retention period
  const anomalyRetentionCutoff = new Date(now.getTime() - RESOLVED_ANOMALY_RETENTION_DAYS * 24 * 60 * 60 * 1000)

  const oldResolvedAnomalies = await db
    .delete(anomalyEvents)
    .where(
      and(
        eq(anomalyEvents.resolved, true),
        lt(anomalyEvents.detectedAt, anomalyRetentionCutoff),
      )
    )

  logger.info(
    'cleanup-expired: removed expired delegations, review requests, and old resolved anomaly events'
  )
  metrics.counter('scorer.cleanup_expired.executed', 1)
}
