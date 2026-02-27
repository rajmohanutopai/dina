import { createHash } from 'node:crypto'
import { eq, and, gt, inArray } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import {
  didProfiles,
  trustEdges,
  anomalyEvents,
  flags,
  subjects,
} from '@/db/schema/index.js'
import {
  detectSybilClusters,
  type SybilClusterInput,
} from '../algorithms/anomaly-detection.js'
import { CONSTANTS } from '@/config/constants.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

export async function detectSybilJob(db: DrizzleDB): Promise<void> {
  // Find quarantined DIDs: those with coordination flags or active critical/serious flags
  const flaggedDids = await db
    .select({ did: didProfiles.did })
    .from(didProfiles)
    .where(gt(didProfiles.coordinationFlagCount, 0))

  // MEDIUM-07: Join flags→subjects to resolve DIDs (subject IDs are hashed sub_... strings)
  const criticallyFlaggedDids = await db
    .select({ did: subjects.did })
    .from(flags)
    .innerJoin(subjects, eq(flags.subjectId, subjects.id))
    .where(
      and(
        eq(flags.isActive, true),
        inArray(flags.severity, ['critical', 'serious']),
      )
    )

  const quarantinedSet = new Set<string>(flaggedDids.map(d => d.did))
  for (const row of criticallyFlaggedDids) {
    if (row.did) {
      quarantinedSet.add(row.did)
    }
  }

  const quarantinedDids = [...quarantinedSet]

  if (quarantinedDids.length === 0) {
    logger.debug('detect-sybil: no quarantined DIDs found')
    return
  }

  logger.info({ quarantinedCount: quarantinedDids.length }, 'detect-sybil: analyzing quarantined DIDs')

  // Build edges between quarantined DIDs from trustEdges table
  const edges = quarantinedDids.length > 0
    ? await db
        .select({
          fromDid: trustEdges.fromDid,
          toDid: trustEdges.toDid,
        })
        .from(trustEdges)
        .where(
          inArray(trustEdges.fromDid, quarantinedDids)
        )
    : []

  const input: SybilClusterInput = {
    edges: edges.map(e => ({ fromDid: e.fromDid, toDid: e.toDid })),
    quarantinedDids,
  }

  const clusters = detectSybilClusters(input)

  let inserted = 0

  for (const cluster of clusters) {
    try {
      // LOW-02 fix: Generate dedupHash so the unique index prevents duplicate anomaly events
      const dedupHash = createHash('sha256')
        .update(`sybil-cluster:${cluster.clusterDids.sort().join(',')}`)
        .digest('hex')
        .slice(0, 64)

      await db
        .insert(anomalyEvents)
        .values({
          eventType: 'sybil-cluster',
          detectedAt: new Date(),
          involvedDids: cluster.clusterDids,
          severity: cluster.confidence >= 0.8 ? 'critical' : cluster.confidence >= 0.6 ? 'serious' : 'warning',
          details: {
            clusterSize: cluster.clusterDids.length,
            confidence: cluster.confidence,
            reason: cluster.reason,
          },
          resolved: false,
          dedupHash,
        })
        .onConflictDoNothing()

      inserted++
    } catch (err) {
      logger.error({ err }, 'detect-sybil: failed to insert anomaly event')
    }
  }

  metrics.counter('scorer.detect_sybil.clusters', inserted)
  logger.info({ clusters: clusters.length, inserted }, 'detect-sybil: complete')
}
