import { eq, and, inArray } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import {
  didProfiles,
  attestations,
  revocations,
  tombstones,
  reactions,
} from '@/db/schema/index.js'
import {
  computeReviewerQuality,
  type ReviewerQualityInput,
} from '../algorithms/reviewer-quality.js'
import { CONSTANTS } from '@/config/constants.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

const BATCH_SIZE = CONSTANTS.SCORER_BATCH_SIZE

export async function refreshReviewerStats(db: DrizzleDB): Promise<void> {
  // Fetch dirty profiles that need reviewer stats refresh
  const dirtyProfiles = await db
    .select({ did: didProfiles.did })
    .from(didProfiles)
    .where(eq(didProfiles.needsRecalc, true))
    .limit(BATCH_SIZE)

  if (dirtyProfiles.length === 0) {
    logger.debug('refresh-reviewer-stats: no dirty profiles')
    return
  }

  const dids = dirtyProfiles.map(p => p.did)
  logger.info({ count: dids.length }, 'refresh-reviewer-stats: processing dirty profiles')

  let updated = 0

  for (const did of dids) {
    try {
      // Attestations authored by this DID
      const authoredAtts = await db
        .select({
          uri: attestations.uri,
          evidenceJson: attestations.evidenceJson,
          isAgentGenerated: attestations.isAgentGenerated,
        })
        .from(attestations)
        .where(eq(attestations.authorDid, did))

      const totalAttestationsBy = authoredAtts.length
      const withEvidenceCount = authoredAtts.filter(
        a => a.evidenceJson != null && Array.isArray(a.evidenceJson) && (a.evidenceJson as unknown[]).length > 0
      ).length
      const agentGeneratedCount = authoredAtts.filter(a => a.isAgentGenerated === true).length

      // Revocations by this DID
      const revocationRows = await db
        .select({ uri: revocations.uri })
        .from(revocations)
        .where(eq(revocations.authorDid, did))

      const revocationCount = revocationRows.length

      // Tombstones by this DID
      const tombstoneRows = await db
        .select({ id: tombstones.id })
        .from(tombstones)
        .where(eq(tombstones.authorDid, did))

      const tombstoneCount = tombstoneRows.length

      // Reactions on attestations by this DID
      const attUris = authoredAtts.map(a => a.uri)
      let helpfulReactions = 0
      let unhelpfulReactions = 0

      if (attUris.length > 0) {
        const reactionRows = await db
          .select({ reaction: reactions.reaction })
          .from(reactions)
          .where(inArray(reactions.targetUri, attUris))

        helpfulReactions = reactionRows.filter(r => r.reaction === 'helpful').length
        unhelpfulReactions = reactionRows.filter(r => r.reaction === 'unhelpful').length
      }

      // Corroborated count: attestations by this DID where at least one other
      // author attested the same subject with the same sentiment
      let corroboratedCount = 0
      if (totalAttestationsBy > 0) {
        const authoredWithSubject = await db
          .select({
            uri: attestations.uri,
            subjectId: attestations.subjectId,
            sentiment: attestations.sentiment,
          })
          .from(attestations)
          .where(eq(attestations.authorDid, did))

        for (const att of authoredWithSubject) {
          if (!att.subjectId) continue

          const corroborating = await db
            .select({ uri: attestations.uri })
            .from(attestations)
            .where(
              and(
                eq(attestations.subjectId, att.subjectId),
                eq(attestations.sentiment, att.sentiment),
                eq(attestations.isRevoked, false),
              )
            )
            .limit(2) // only need to know if > 1 exists

          // More than just this author's own attestation
          if (corroborating.length > 1) {
            corroboratedCount++
          }
        }
      }

      const input: ReviewerQualityInput = {
        totalAttestationsBy,
        withEvidenceCount,
        helpfulReactions,
        unhelpfulReactions,
        revocationCount,
        tombstoneCount,
        corroboratedCount,
        agentGeneratedCount,
      }

      const quality = computeReviewerQuality(input)

      await db
        .update(didProfiles)
        .set({
          // TN-SCORE-002: explicit V1 stamp.
          scoreVersion: 'v1',
          totalAttestationsBy,
          revocationCount,
          deletionCount: tombstoneCount,
          revocationRate: quality.revocationRate,
          deletionRate: quality.deletionRate,
          corroborationRate: quality.corroborationRate,
          evidenceRate: quality.evidenceRate,
          averageHelpfulRatio: quality.helpfulRatio,
          computedAt: new Date(),
        })
        .where(eq(didProfiles.did, did))

      updated++
    } catch (err) {
      logger.error({ err, did }, 'refresh-reviewer-stats: failed to process DID')
    }
  }

  metrics.counter('scorer.refresh_reviewer_stats.updated', updated)
  logger.info({ updated, total: dids.length }, 'refresh-reviewer-stats: batch complete')
}
