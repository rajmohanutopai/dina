import { eq, sql, and, lt } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import {
  delegations,
  reviewRequests,
  anomalyEvents,
  didProfiles,
} from '@/db/schema/index.js'
import { inArray } from 'drizzle-orm'
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

  // TS9: Before deleting resolved anomaly events, collect affected DIDs
  // and decrement their coordinationFlagCount. Without this, deleting the
  // source event leaves orphaned flags on profiles permanently.
  const anomalyRetentionCutoff = new Date(now.getTime() - RESOLVED_ANOMALY_RETENTION_DAYS * 24 * 60 * 60 * 1000)

  const toDelete = await db.select({ involvedDids: anomalyEvents.involvedDids })
    .from(anomalyEvents)
    .where(
      and(
        eq(anomalyEvents.resolved, true),
        lt(anomalyEvents.detectedAt, anomalyRetentionCutoff),
      )
    )

  // Collect all unique DIDs whose flags need decrementing.
  const affectedDids = new Set<string>()
  for (const row of toDelete) {
    if (row.involvedDids) {
      for (const did of row.involvedDids) affectedDids.add(did)
    }
  }

  // Decrement coordinationFlagCount (floor at 0) for affected profiles.
  if (affectedDids.size > 0) {
    await db.update(didProfiles)
      .set({
        coordinationFlagCount: sql`GREATEST(0, ${didProfiles.coordinationFlagCount} - 1)`,
      })
      .where(inArray(didProfiles.did, [...affectedDids]))
  }

  // Now delete the resolved anomaly events.
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
