import { eq, sql, and, inArray, isNotNull } from 'drizzle-orm'
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
  subjectScores,
  verifications,
} from '@/db/schema/index.js'
import { computeTrustScore, type TrustScoreInput } from '../algorithms/trust-score.js'
import { CONSTANTS } from '@/config/constants.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

const BATCH_SIZE = CONSTANTS.SCORER_BATCH_SIZE

/**
 * TN-SCORE-004 — cascade enqueue threshold.
 *
 * When a reviewer's `overallTrustScore` moves by ≥ this much (in the
 * raw `[0, 1]` scale), enqueue a recompute of every subject they've
 * attested to. The threshold is "1 point on the public 0-100 display
 * scale" = 0.01 in the raw scale; smaller jitters from new attestations
 * landing or decay shouldn't ripple through to subjects, but a
 * meaningful change to a reviewer's credibility should refresh the
 * subjects whose scores depend on it.
 *
 * Tunable as a constant rather than a flag — operators almost never
 * need to change it, and a single source of truth makes the
 * "did this fire?" debugging trivial.
 */
const CASCADE_THRESHOLD = 0.01

/**
 * TN-SCORE-004 — per-reviewer cascade fan-out cap.
 *
 * High-volume reviewers (review_count > 1000) won't ripple their
 * full attestation set on every score nudge — that'd swamp the
 * scorer queue and starve the rest of the cron tick. Plan §13.7
 * notes that high-volume reviewers naturally rate-limit themselves
 * via this cap; the dirty rows still get picked up over multiple
 * scorer ticks.
 */
const CASCADE_MAX_SUBJECTS = 1000

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

  // TN-SCORE-004: snapshot the OLD overallTrustScore for every dirty
  // DID in one batch query before we start the loop. We need the old
  // value to detect material score changes and decide whether to
  // cascade — fetching it inline per-DID would double the per-tick
  // SELECT count for no gain. NULL old values (first-time profile)
  // are stored as null and treated as 0 when computing delta below
  // (a profile that goes from "no score" to "0.7" cascades; a
  // brand-new low-trust DID with score 0.0 doesn't).
  const oldScoreRows = await db
    .select({
      did: didProfiles.did,
      overallTrustScore: didProfiles.overallTrustScore,
    })
    .from(didProfiles)
    .where(inArray(didProfiles.did, dids))
  const oldScoreByDid = new Map(
    oldScoreRows.map((r) => [r.did, r.overallTrustScore]),
  )

  let updated = 0
  let cascaded = 0

  for (const did of dids) {
    try {
      const input = await gatherTrustScoreInputs(db, did)
      const result = computeTrustScore(input)

      await db
        .update(didProfiles)
        .set({
          // TN-SCORE-002: explicit V1 stamp on every reviewer score
          // refresh. See did-profiles.ts schema docstring for rationale.
          scoreVersion: 'v1',
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

      // TN-SCORE-004 — cascade to subjects this reviewer has attested
      // to when their score moved enough to be visible at the
      // 1-point-on-the-display-scale boundary.
      const oldScore = oldScoreByDid.get(did) ?? 0
      const newScore = result.overallScore ?? 0
      const delta = Math.abs(newScore - oldScore)
      if (delta >= CASCADE_THRESHOLD) {
        const cascadedSubjects = await cascadeReviewerScoreChange(db, did)
        cascaded += cascadedSubjects
      }
    } catch (err) {
      logger.error({ err, did }, 'refresh-profiles: failed to process DID')
    }
  }

  metrics.counter('scorer.refresh_profiles.updated', updated)
  if (cascaded > 0) {
    metrics.counter('scorer.cascade.enqueued', cascaded)
  }
  logger.info(
    { updated, total: dids.length, cascaded },
    'refresh-profiles: batch complete',
  )
}

/**
 * TN-SCORE-004 — when a reviewer's score moved materially, mark every
 * subject they've attested to as `needsRecalc=true` so the next
 * `refresh-subject-scores` tick picks them up. Returns the number of
 * subjects enqueued.
 *
 * **Why a separate function**: keeps the cascade logic isolated for
 * unit-testing and makes the call site in `refreshProfiles` read as
 * three lines instead of an inline subquery + update.
 *
 * **Cap at CASCADE_MAX_SUBJECTS (1000)**: bounds the per-reviewer
 * fan-out. The DB query uses `selectDistinct` + `LIMIT` so a reviewer
 * with 50k attestations still only enqueues 1000 subjects per cascade
 * trigger. Subsequent triggers (after subjects refresh and the
 * reviewer's score moves again) will pick up different subjects since
 * the marked rows already cleared their `needsRecalc` bit by then.
 *
 * **WHERE filter excludes already-dirty rows**: avoids redundant
 * `UPDATE … SET needs_recalc=true` work on rows that are already
 * dirty. Saves write amplification + lock pressure under cascade
 * storms (e.g. a pivotal reviewer's score moving daily during decay).
 *
 * **Counter accuracy via `.returning()`**: returns the count of rows
 * the UPDATE actually flipped, NOT the count of attested subjects.
 * Matters because under a cascade storm most candidate subjects may
 * already be dirty — the counter would otherwise drift away from
 * "queue work added" toward "queue work attempted".
 */
async function cascadeReviewerScoreChange(
  db: DrizzleDB,
  reviewerDid: string,
): Promise<number> {
  // Pick up to CASCADE_MAX_SUBJECTS distinct subjects this reviewer
  // has attested to. `selectDistinct` collapses duplicates (a reviewer
  // who attested to the same subject multiple times under different
  // dimension claims still only gets ONE recompute slot); the
  // `attestations_subject_idx` covers this query.
  const rows = await db
    .selectDistinct({ subjectId: attestations.subjectId })
    .from(attestations)
    .where(
      and(
        eq(attestations.authorDid, reviewerDid),
        eq(attestations.isRevoked, false),
        isNotNull(attestations.subjectId),
      ),
    )
    .limit(CASCADE_MAX_SUBJECTS)

  // `selectDistinct` returns the column type as `string | null` even
  // though `isNotNull` filtered nulls out — the type system can't see
  // through the WHERE. Filter at the JS level too for type safety.
  const subjectIds = rows
    .map((r) => r.subjectId)
    .filter((id): id is string => id !== null)

  if (subjectIds.length === 0) return 0

  const flipped = await db
    .update(subjectScores)
    .set({ needsRecalc: true })
    .where(
      and(
        inArray(subjectScores.subjectId, subjectIds),
        eq(subjectScores.needsRecalc, false),
      ),
    )
    .returning({ subjectId: subjectScores.subjectId })

  return flipped.length
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
        uri: attestations.uri,
        sentiment: attestations.sentiment,
        recordCreatedAt: attestations.recordCreatedAt,
        evidenceJson: attestations.evidenceJson,
        hasCosignature: attestations.hasCosignature,
        authorDid: attestations.authorDid,
        // TN-V2-RANK-006 — pulled so the scorer can pick the
        // per-category half-life for each attestation independently.
        category: attestations.category,
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

    // Check which attestations have been verified (confirmed by verifiers)
    const attUris = rawAtts.map(a => a.uri)
    const verifiedUriSet = new Set<string>()
    if (attUris.length > 0) {
      const verifiedRows = await db
        .select({ targetUri: verifications.targetUri })
        .from(verifications)
        .where(
          and(
            inArray(verifications.targetUri, attUris),
            eq(verifications.result, 'confirmed'),
          )
        )
      for (const row of verifiedRows) {
        verifiedUriSet.add(row.targetUri)
      }
    }

    attestationsAbout = rawAtts.map(a => ({
      sentiment: a.sentiment,
      recordCreatedAt: a.recordCreatedAt,
      evidenceJson: a.evidenceJson as unknown[] | null,
      hasCosignature: a.hasCosignature ?? false,
      isVerified: verifiedUriSet.has(a.uri),
      authorTrustScore: authorScoreMap.get(a.authorDid) ?? null,
      authorHasInboundVouch: (authorVouchMap.get(a.authorDid) ?? 0) > 0,
      category: a.category,
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
