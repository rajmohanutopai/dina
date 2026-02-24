import { eq, and, inArray } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import {
  domainScores,
  didProfiles,
  attestations,
  trustEdges,
} from '@/db/schema/index.js'
import { CONSTANTS } from '@/config/constants.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'
import { clamp } from '../algorithms/trust-score.js'

const BATCH_SIZE = CONSTANTS.SCORER_BATCH_SIZE

export async function refreshDomainScores(db: DrizzleDB): Promise<void> {
  // Fetch dirty domain scores
  const dirtyDomainScores = await db
    .select({ id: domainScores.id, did: domainScores.did, domain: domainScores.domain })
    .from(domainScores)
    .where(eq(domainScores.needsRecalc, true))
    .limit(BATCH_SIZE)

  if (dirtyDomainScores.length === 0) {
    logger.debug('refresh-domain-scores: no dirty domain scores')
    return
  }

  logger.info({ count: dirtyDomainScores.length }, 'refresh-domain-scores: processing dirty domain scores')

  let updated = 0

  for (const ds of dirtyDomainScores) {
    try {
      // Count attestations by this DID in this domain
      const domainAtts = await db
        .select({
          sentiment: attestations.sentiment,
          evidenceJson: attestations.evidenceJson,
        })
        .from(attestations)
        .where(
          and(
            eq(attestations.authorDid, ds.did),
            eq(attestations.domain, ds.domain),
            eq(attestations.isRevoked, false),
          )
        )

      const attestationCount = domainAtts.length
      const withEvidence = domainAtts.filter(
        a => a.evidenceJson != null && Array.isArray(a.evidenceJson) && (a.evidenceJson as unknown[]).length > 0
      ).length

      // Compute domain-specific trust: weighted by evidence rate and attestation volume
      let score = 0.1 // base
      if (attestationCount > 0) {
        const evidenceRate = withEvidence / attestationCount
        const volumeSignal = Math.min(1.0, Math.log2(attestationCount + 1) / Math.log2(51))

        score = 0.3 * volumeSignal + 0.4 * evidenceRate + 0.3 * 0.5 // 0.5 base sentiment factor
      }

      // Boost from overall profile trust
      const profile = await db
        .select({ overallTrustScore: didProfiles.overallTrustScore })
        .from(didProfiles)
        .where(eq(didProfiles.did, ds.did))
        .limit(1)

      if (profile.length > 0 && profile[0].overallTrustScore != null) {
        score = (score + profile[0].overallTrustScore) / 2
      }

      // Boost from domain-specific inbound trust edges
      const domainEdges = await db
        .select({ weight: trustEdges.weight })
        .from(trustEdges)
        .where(
          and(
            eq(trustEdges.toDid, ds.did),
            eq(trustEdges.domain, ds.domain),
          )
        )

      if (domainEdges.length > 0) {
        const avgEdgeWeight = domainEdges.reduce((sum, e) => sum + e.weight, 0) / domainEdges.length
        score = score * 0.7 + avgEdgeWeight * 0.3
      }

      await db
        .update(domainScores)
        .set({
          trustScore: clamp(score, 0, 1),
          attestationCount,
          needsRecalc: false,
          computedAt: new Date(),
        })
        .where(eq(domainScores.id, ds.id))

      updated++
    } catch (err) {
      logger.error({ err, did: ds.did, domain: ds.domain }, 'refresh-domain-scores: failed to process')
    }
  }

  metrics.counter('scorer.refresh_domain_scores.updated', updated)
  logger.info({ updated, total: dirtyDomainScores.length }, 'refresh-domain-scores: batch complete')
}
