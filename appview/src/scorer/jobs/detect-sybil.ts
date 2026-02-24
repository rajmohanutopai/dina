import { eq, and, gt, inArray } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import {
  didProfiles,
  trustEdges,
  anomalyEvents,
  flags,
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

  const criticallyFlaggedSubjects = await db
    .select({ subjectId: flags.subjectId })
    .from(flags)
    .where(
      and(
        eq(flags.isActive, true),
        inArray(flags.severity, ['critical', 'serious']),
      )
    )

  // Flags reference subjects, but we need DIDs; extract unique subject IDs that look like DIDs
  const quarantinedSet = new Set<string>(flaggedDids.map(d => d.did))
  for (const row of criticallyFlaggedSubjects) {
    if (row.subjectId && row.subjectId.startsWith('did:')) {
      quarantinedSet.add(row.subjectId)
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
        })

      inserted++
    } catch (err) {
      logger.error({ err }, 'detect-sybil: failed to insert anomaly event')
    }
  }

  metrics.counter('scorer.detect_sybil.clusters', inserted)
  logger.info({ clusters: clusters.length, inserted }, 'detect-sybil: complete')
}
