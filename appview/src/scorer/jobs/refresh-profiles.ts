import { eq, sql, and, inArray } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import {
  didProfiles,
  attestations,
  vouches,
  endorsements,
  flags,
  reactions,
  trustEdges,
  revocations,
  tombstones,
  delegations,
  subjects,
} from '@/db/schema/index.js'
import { computeTrustScore, type TrustScoreInput } from '../algorithms/trust-score.js'
import { CONSTANTS } from '@/config/constants.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

const BATCH_SIZE = CONSTANTS.SCORER_BATCH_SIZE

export async function refreshProfiles(db: DrizzleDB): Promise<void> {
  // Fetch dirty profiles
  const dirtyProfiles = await db
    .select({ did: didProfiles.did })
    .from(didProfiles)
    .where(eq(didProfiles.needsRecalc, true))
    .limit(BATCH_SIZE)

  if (dirtyProfiles.length === 0) {
    logger.debug('refresh-profiles: no dirty profiles')
    return
  }

  const dids = dirtyProfiles.map(p => p.did)
  logger.info({ count: dids.length }, 'refresh-profiles: processing dirty profiles')

  let updated = 0

  for (const did of dids) {
    try {
      const input = await gatherTrustScoreInputs(db, did)
      const result = computeTrustScore(input)

      await db
        .update(didProfiles)
        .set({
          overallTrustScore: result.overallScore,
          totalAttestationsAbout: input.attestationsAbout.length,
          positiveAbout: input.attestationsAbout.filter(a => a.sentiment === 'positive').length,
          neutralAbout: input.attestationsAbout.filter(a => a.sentiment === 'neutral').length,
          negativeAbout: input.attestationsAbout.filter(a => a.sentiment === 'negative').length,
          vouchCount: input.vouchCount,
          highConfidenceVouches: input.highConfidenceVouches,
          endorsementCount: input.endorsementCount,
          activeFlagCount: input.activeFlagCount,
          totalAttestationsBy: input.totalAttestationsBy,
          revocationCount: input.revocationCount,
          needsRecalc: false,
          computedAt: new Date(),
        })
        .where(eq(didProfiles.did, did))

      updated++
    } catch (err) {
      logger.error({ err, did }, 'refresh-profiles: failed to process DID')
    }
  }

  metrics.counter('scorer.refresh_profiles.updated', updated)
  logger.info({ updated, total: dids.length }, 'refresh-profiles: batch complete')
}

async function gatherTrustScoreInputs(db: DrizzleDB, did: string): Promise<TrustScoreInput> {
  // Attestations about this DID (where the DID is the subject)
  // Subjects that reference this DID
  const didSubjects = await db
    .select({ id: subjects.id })
    .from(subjects)
    .where(eq(subjects.did, did))

  const subjectIds = didSubjects.map(s => s.id)

  let attestationsAbout: TrustScoreInput['attestationsAbout'] = []

  if (subjectIds.length > 0) {
    const rawAtts = await db
      .select({
        sentiment: attestations.sentiment,
        recordCreatedAt: attestations.recordCreatedAt,
        evidenceJson: attestations.evidenceJson,
        hasCosignature: attestations.hasCosignature,
        authorDid: attestations.authorDid,
      })
      .from(attestations)
      .where(
        and(
          inArray(attestations.subjectId, subjectIds),
          eq(attestations.isRevoked, false),
        )
      )

    // Gather author trust scores for weighting
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

    // Check which authors have inbound vouches
    const authorVouchCounts = authorDids.length > 0
      ? await db
          .select({
            subjectDid: vouches.subjectDid,
            count: sql<number>`count(*)`.as('count'),
          })
          .from(vouches)
          .where(inArray(vouches.subjectDid, authorDids))
          .groupBy(vouches.subjectDid)
      : []
    const authorVouchMap = new Map(authorVouchCounts.map(v => [v.subjectDid, v.count]))

    // Check which attestations are verified
    const attUris = rawAtts.map(() => '').length > 0 ? [] : [] // placeholder
    // We consider an attestation verified if its author has a verification record
    // For simplicity, we mark all as unverified unless verified separately

    attestationsAbout = rawAtts.map(a => ({
      sentiment: a.sentiment,
      recordCreatedAt: a.recordCreatedAt,
      evidenceJson: a.evidenceJson as unknown[] | null,
      hasCosignature: a.hasCosignature ?? false,
      isVerified: false, // verification is checked separately if needed
      authorTrustScore: authorScoreMap.get(a.authorDid) ?? null,
      authorHasInboundVouch: (authorVouchMap.get(a.authorDid) ?? 0) > 0,
    }))
  }

  // Vouches where this DID is the subject
  const vouchRows = await db
    .select({
      confidence: vouches.confidence,
    })
    .from(vouches)
    .where(eq(vouches.subjectDid, did))

  const vouchCount = vouchRows.length
  const highConfidenceVouches = vouchRows.filter(v => v.confidence === 'high').length

  // Endorsements where this DID is the subject
  const endorsementRows = await db
    .select({ uri: endorsements.uri })
    .from(endorsements)
    .where(eq(endorsements.subjectDid, did))

  const endorsementCount = endorsementRows.length

  // Active flags where this DID is the subject
  const flagRows = subjectIds.length > 0
    ? await db
        .select({ severity: flags.severity })
        .from(flags)
        .where(
          and(
            inArray(flags.subjectId, subjectIds),
            eq(flags.isActive, true),
          )
        )
    : []

  const activeFlagCount = flagRows.length
  const flagSeverities = flagRows.map(f => f.severity)

  // Attestations BY this DID (as author)
  const attestationsByRows = await db
    .select({ uri: attestations.uri, evidenceJson: attestations.evidenceJson })
    .from(attestations)
    .where(eq(attestations.authorDid, did))

  const totalAttestationsBy = attestationsByRows.length
  const withEvidenceCount = attestationsByRows.filter(
    a => a.evidenceJson != null && Array.isArray(a.evidenceJson) && (a.evidenceJson as unknown[]).length > 0
  ).length

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
  // Get all attestation URIs by this DID, then count reactions
  const attUrisByDid = attestationsByRows.map(a => a.uri)
  let helpfulReactions = 0
  let unhelpfulReactions = 0

  if (attUrisByDid.length > 0) {
    const reactionRows = await db
      .select({ reaction: reactions.reaction })
      .from(reactions)
      .where(inArray(reactions.targetUri, attUrisByDid))

    helpfulReactions = reactionRows.filter(r => r.reaction === 'helpful').length
    unhelpfulReactions = reactionRows.filter(r => r.reaction === 'unhelpful').length
  }

  // Inbound trust edges
  const inboundEdges = await db
    .select({ id: trustEdges.id })
    .from(trustEdges)
    .where(eq(trustEdges.toDid, did))

  const inboundEdgeCount = inboundEdges.length

  // Inbound delegations
  const inboundDelegations = await db
    .select({ uri: delegations.uri })
    .from(delegations)
    .where(eq(delegations.subjectDid, did))

  const delegationInboundCount = inboundDelegations.length

  return {
    attestationsAbout,
    vouchCount,
    highConfidenceVouches,
    endorsementCount,
    activeFlagCount,
    flagSeverities,
    totalAttestationsBy,
    revocationCount,
    tombstoneCount,
    helpfulReactions,
    unhelpfulReactions,
    withEvidenceCount,
    inboundEdgeCount,
    delegationInboundCount,
  }
}
