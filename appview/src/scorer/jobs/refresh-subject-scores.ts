import { eq, and, inArray } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import {
  subjectScores,
  attestations,
  vouches,
  didProfiles,
} from '@/db/schema/index.js'
import {
  aggregateSubjectSentiment,
  type AttestationForAggregation,
} from '../algorithms/sentiment-aggregation.js'
import { CONSTANTS } from '@/config/constants.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

const BATCH_SIZE = CONSTANTS.SCORER_BATCH_SIZE

export async function refreshSubjectScores(db: DrizzleDB): Promise<void> {
  // Fetch dirty subject scores
  const dirtySubjects = await db
    .select({ subjectId: subjectScores.subjectId })
    .from(subjectScores)
    .where(eq(subjectScores.needsRecalc, true))
    .limit(BATCH_SIZE)

  if (dirtySubjects.length === 0) {
    logger.debug('refresh-subject-scores: no dirty subjects')
    return
  }

  const subjectIds = dirtySubjects.map(s => s.subjectId)
  logger.info({ count: subjectIds.length }, 'refresh-subject-scores: processing dirty subjects')

  let updated = 0

  for (const subjectId of subjectIds) {
    try {
      // Fetch all non-revoked attestations for this subject
      const rawAtts = await db
        .select({
          sentiment: attestations.sentiment,
          recordCreatedAt: attestations.recordCreatedAt,
          evidenceJson: attestations.evidenceJson,
          hasCosignature: attestations.hasCosignature,
          authorDid: attestations.authorDid,
          dimensionsJson: attestations.dimensionsJson,
          domain: attestations.domain,
        })
        .from(attestations)
        .where(
          and(
            eq(attestations.subjectId, subjectId),
            eq(attestations.isRevoked, false),
          )
        )

      // Gather author trust scores and vouch status
      const authorDids = [...new Set(rawAtts.map(a => a.authorDid))]

      const authorProfiles = authorDids.length > 0
        ? await db
            .select({
              did: didProfiles.did,
              overallTrustScore: didProfiles.overallTrustScore,
            })
            .from(didProfiles)
            .where(inArray(didProfiles.did, authorDids))
        : []
      const authorScoreMap = new Map(authorProfiles.map(p => [p.did, p.overallTrustScore]))

      const authorVouchRows = authorDids.length > 0
        ? await db
            .select({ subjectDid: vouches.subjectDid })
            .from(vouches)
            .where(inArray(vouches.subjectDid, authorDids))
        : []
      const vouchedAuthors = new Set(authorVouchRows.map(v => v.subjectDid))

      // Map to aggregation input
      const aggregationInput: AttestationForAggregation[] = rawAtts.map(a => ({
        sentiment: a.sentiment,
        recordCreatedAt: a.recordCreatedAt,
        evidenceJson: a.evidenceJson as unknown[] | null,
        hasCosignature: a.hasCosignature ?? false,
        isVerified: false,
        authorTrustScore: authorScoreMap.get(a.authorDid) ?? null,
        authorHasInboundVouch: vouchedAuthors.has(a.authorDid),
        dimensionsJson: a.dimensionsJson as unknown[] | undefined,
        domain: a.domain,
      }))

      const result = aggregateSubjectSentiment(aggregationInput)

      await db
        .update(subjectScores)
        .set({
          totalAttestations: result.total,
          positive: result.positive,
          neutral: result.neutral,
          negative: result.negative,
          weightedScore: result.weightedScore,
          confidence: result.confidence,
          dimensionSummaryJson: result.dimensionSummary,
          authenticityConsensus: result.authenticityConsensus,
          authenticityConfidence: result.authenticityConfidence,
          wouldRecommendRate: result.wouldRecommendRate,
          verifiedAttestationCount: result.verifiedCount,
          lastAttestationAt: result.lastAttestationAt,
          attestationVelocity: result.velocity,
          needsRecalc: false,
          computedAt: new Date(),
        })
        .where(eq(subjectScores.subjectId, subjectId))

      updated++
    } catch (err) {
      logger.error({ err, subjectId }, 'refresh-subject-scores: failed to process subject')
    }
  }

  metrics.counter('scorer.refresh_subject_scores.updated', updated)
  logger.info({ updated, total: subjectIds.length }, 'refresh-subject-scores: batch complete')
}
