import { eq, sql, and } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import {
  tombstones,
  didProfiles,
} from '@/db/schema/index.js'
import { CONSTANTS } from '@/config/constants.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

const COORDINATION_TOMBSTONE_THRESHOLD = CONSTANTS.COORDINATION_TOMBSTONE_THRESHOLD

export async function processTombstones(db: DrizzleDB): Promise<void> {
  // Count tombstones grouped by authorDid, looking for disputed deletions
  // A "disputed" deletion is one where the tombstone has dispute replies or reports
  const tombstoneStats = await db
    .select({
      authorDid: tombstones.authorDid,
      totalTombstones: sql<number>`count(*)`.as('total_tombstones'),
      disputedCount: sql<number>`count(*) filter (where ${tombstones.disputeReplyCount} > 0 or ${tombstones.reportCount} > 0)`.as('disputed_count'),
    })
    .from(tombstones)
    .groupBy(tombstones.authorDid)

  if (tombstoneStats.length === 0) {
    logger.debug('process-tombstones: no tombstones to process')
    return
  }

  logger.info({ authorCount: tombstoneStats.length }, 'process-tombstones: analyzing tombstone patterns')

  let flagged = 0
  let profilesUpdated = 0

  for (const stat of tombstoneStats) {
    try {
      // Update the tombstone count on the profile
      await db
        .update(didProfiles)
        .set({
          deletionCount: Number(stat.totalTombstones),
          disputedThenDeletedCount: Number(stat.disputedCount),
          computedAt: new Date(),
        })
        .where(eq(didProfiles.did, stat.authorDid))

      profilesUpdated++

      // If the author has >= threshold disputed deletions, flag for coordination
      if (Number(stat.disputedCount) >= COORDINATION_TOMBSTONE_THRESHOLD) {
        await db
          .update(didProfiles)
          .set({
            coordinationFlagCount: sql`${didProfiles.coordinationFlagCount} + 1`,
            needsRecalc: true,
            computedAt: new Date(),
          })
          .where(
            and(
              eq(didProfiles.did, stat.authorDid),
              // Only increment if not already flagged above threshold
              sql`${didProfiles.coordinationFlagCount} < ${COORDINATION_TOMBSTONE_THRESHOLD}`,
            )
          )

        flagged++
      }
    } catch (err) {
      logger.error({ err, authorDid: stat.authorDid }, 'process-tombstones: failed to process author')
    }
  }

  metrics.counter('scorer.process_tombstones.profiles_updated', profilesUpdated)
  metrics.counter('scorer.process_tombstones.flagged', flagged)
  logger.info({ profilesUpdated, flagged }, 'process-tombstones: complete')
}
