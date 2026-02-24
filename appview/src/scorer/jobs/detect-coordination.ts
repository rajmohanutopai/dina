import { eq, and, gt } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import {
  attestations,
  anomalyEvents,
} from '@/db/schema/index.js'
import {
  detectCoordination,
  type CoordinationInput,
} from '../algorithms/anomaly-detection.js'
import { CONSTANTS } from '@/config/constants.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

export async function detectCoordinationJob(db: DrizzleDB): Promise<void> {
  const windowHours = CONSTANTS.COORDINATION_WINDOW_HOURS
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000)

  // Query recent attestations within the sliding window
  const recentAtts = await db
    .select({
      authorDid: attestations.authorDid,
      subjectId: attestations.subjectId,
      recordCreatedAt: attestations.recordCreatedAt,
      sentiment: attestations.sentiment,
    })
    .from(attestations)
    .where(
      and(
        gt(attestations.recordCreatedAt, cutoff),
        eq(attestations.isRevoked, false),
      )
    )

  // Filter out attestations without a subjectId
  const validAtts = recentAtts.filter(a => a.subjectId != null).map(a => ({
    authorDid: a.authorDid,
    subjectId: a.subjectId!,
    recordCreatedAt: a.recordCreatedAt,
    sentiment: a.sentiment,
  }))

  if (validAtts.length === 0) {
    logger.debug('detect-coordination: no recent attestations to analyze')
    return
  }

  logger.info({ attestationCount: validAtts.length }, 'detect-coordination: analyzing recent attestations')

  const input: CoordinationInput = {
    attestations: validAtts,
    windowHours,
  }

  const results = detectCoordination(input)

  let inserted = 0

  for (const result of results) {
    if (!result.isCoordinated) continue

    try {
      await db
        .insert(anomalyEvents)
        .values({
          eventType: 'coordination',
          detectedAt: new Date(),
          involvedDids: result.involvedDids,
          severity: result.clusterSize >= 10 ? 'critical' : result.clusterSize >= 5 ? 'serious' : 'warning',
          details: {
            subjectId: result.subjectId,
            clusterSize: result.clusterSize,
            windowStart: result.windowStart.toISOString(),
            windowEnd: result.windowEnd.toISOString(),
          },
          resolved: false,
        })

      inserted++
    } catch (err) {
      logger.error({ err, subjectId: result.subjectId }, 'detect-coordination: failed to insert anomaly event')
    }
  }

  metrics.counter('scorer.detect_coordination.events', inserted)
  logger.info({ detected: results.length, inserted }, 'detect-coordination: complete')
}
