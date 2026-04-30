import { and, eq, inArray } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import {
  attestations,
  reactions,
  revocations,
  reviewerNamespaceScores,
} from '@/db/schema/index.js'
import {
  computeReviewerQuality,
  type ReviewerQualityInput,
} from '../algorithms/reviewer-quality.js'
import { CONSTANTS } from '@/config/constants.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

/**
 * Per-namespace reviewer stats refresh (TN-SCORE-001).
 *
 * Drains rows from `reviewer_namespace_scores` where `needs_recalc = true`
 * and writes back the per-(did, namespace) reviewer-quality stats.
 *
 * **Why a separate job from `refresh-reviewer-stats.ts`**: that job
 * computes ROOT-IDENTITY-aggregated stats against `did_profiles`. This
 * job computes per-namespace stats — same arithmetic, namespace-filtered
 * source data, different target table. Mirroring the column names
 * (TN-DB-002) lets both jobs use the same `computeReviewerQuality`
 * algorithm without per-job formula drift.
 *
 * **Source data filters**:
 *   - Attestations: `WHERE author_did = ? AND namespace = ?` — direct
 *     (TN-DB-012 added the namespace column to `attestations`).
 *   - Revocations: JOIN through `attestations.uri` to filter by the
 *     target attestation's namespace. Revocations themselves don't
 *     carry a namespace — they're the author's act of retracting their
 *     own record, and the record's namespace is what should be charged.
 *   - Reactions: JOIN through `attestations.uri` for the same reason.
 *
 * **Deletion / tombstone counters intentionally LEFT AT ZERO for V1**:
 * `tombstones.namespace` doesn't exist yet — the deletion handler
 * preserves `category` / `subjectId` / `domain` etc. on the tombstone
 * row but not `namespace`. JOIN'ing back to `attestations` doesn't
 * work either (the source row is gone after deletion). For V1 we
 * leave `deletionCount` + `disputedThenDeletedCount` at 0 with this
 * documentation; V2 adds `tombstones.namespace` (a separate schema
 * change worth its own backlog item) and this job picks them up.
 *
 * **Hot-author bound**: not applicable here. The cascade fan-out cap
 * (TN-SCORE-004's `CASCADE_MAX_SUBJECTS = 1000`) bounds high-volume
 * reviewers' write amplification at the source; the per-namespace
 * refresh inherits that bound transitively (a row only lands in
 * `reviewer_namespace_scores.needs_recalc = true` when an event
 * actually mutates a namespace's stats).
 *
 * **`overall_trust_score`** is the `computeReviewerQuality.overallQuality`
 * value for V1 — same formula as the root-identity scorer, just over
 * the namespace-scoped counters. V2 may differentiate (e.g., factor
 * in cosignature density per namespace) but landing the formula
 * symmetric for V1 keeps the search xRPC's per-namespace ranking
 * consistent with its per-root-identity ranking until then.
 */

const BATCH_SIZE = CONSTANTS.SCORER_BATCH_SIZE

/**
 * Drain dirty `reviewer_namespace_scores` rows and refresh per-
 * (did, namespace) stats. Pure DB I/O — no LLM, no network calls.
 *
 * Failure mode per row: catch + log + continue. A poisoned row
 * (e.g. a malformed attestation that throws the corroborated-count
 * loop) doesn't block the rest of the batch from making progress.
 * Pinned by test.
 */
export async function refreshReviewerNamespaceStats(db: DrizzleDB): Promise<void> {
  const dirty = await db
    .select({
      did: reviewerNamespaceScores.did,
      namespace: reviewerNamespaceScores.namespace,
    })
    .from(reviewerNamespaceScores)
    .where(eq(reviewerNamespaceScores.needsRecalc, true))
    .limit(BATCH_SIZE)

  if (dirty.length === 0) {
    logger.debug('refresh-reviewer-namespace-stats: no dirty rows')
    return
  }

  logger.info(
    { count: dirty.length },
    'refresh-reviewer-namespace-stats: processing dirty namespace rows',
  )

  let updated = 0

  for (const row of dirty) {
    try {
      const stats = await computeNamespaceStats(db, row.did, row.namespace)
      const quality = computeReviewerQuality(stats)

      await db
        .update(reviewerNamespaceScores)
        .set({
          // TN-SCORE-002 forward-compat: explicit V1 stamp on every
          // UPDATE. The DEFAULT only fires on INSERT; once V2 has
          // run and left 'v2' on a row, a V1 UPDATE that doesn't
          // touch scoreVersion would leave the row mis-described.
          scoreVersion: 'v1',
          needsRecalc: false,
          totalAttestationsBy: stats.totalAttestationsBy,
          revocationCount: stats.revocationCount,
          // V1 deferred: deletionCount + disputedThenDeletedCount
          // require a `tombstones.namespace` schema change (V2).
          // We keep the defaults of 0 until V2 wires them.
          revocationRate: quality.revocationRate,
          deletionRate: quality.deletionRate,
          corroborationRate: quality.corroborationRate,
          evidenceRate: quality.evidenceRate,
          overallTrustScore: quality.overallQuality,
          computedAt: new Date(),
        })
        .where(
          and(
            eq(reviewerNamespaceScores.did, row.did),
            eq(reviewerNamespaceScores.namespace, row.namespace),
          ),
        )

      updated++
    } catch (err) {
      logger.error(
        { err, did: row.did, namespace: row.namespace },
        'refresh-reviewer-namespace-stats: failed to process (did, namespace)',
      )
    }
  }

  metrics.counter('scorer.refresh_reviewer_namespace_stats.updated', updated)
  logger.info(
    { updated, total: dirty.length },
    'refresh-reviewer-namespace-stats: batch complete',
  )
}

/**
 * Gather the per-(did, namespace) input counters that
 * `computeReviewerQuality` needs. Exported for testing — the unit
 * tests pin the SQL filter shape (namespace + author) without
 * needing a real Postgres.
 */
export async function computeNamespaceStats(
  db: DrizzleDB,
  did: string,
  namespace: string,
): Promise<ReviewerQualityInput> {
  // 1. Attestations authored by (did, namespace).
  const authoredAtts = await db
    .select({
      uri: attestations.uri,
      subjectId: attestations.subjectId,
      sentiment: attestations.sentiment,
      evidenceJson: attestations.evidenceJson,
      isAgentGenerated: attestations.isAgentGenerated,
    })
    .from(attestations)
    .where(
      and(
        eq(attestations.authorDid, did),
        eq(attestations.namespace, namespace),
      ),
    )

  const totalAttestationsBy = authoredAtts.length
  const withEvidenceCount = authoredAtts.filter(
    (a) =>
      a.evidenceJson != null &&
      Array.isArray(a.evidenceJson) &&
      (a.evidenceJson as unknown[]).length > 0,
  ).length
  const agentGeneratedCount = authoredAtts.filter((a) => a.isAgentGenerated === true).length
  const attUris = authoredAtts.map((a) => a.uri)

  // 2. Revocations BY this DID targeting attestations IN this
  // namespace. Revocations don't carry a namespace column; we
  // attribute them via the target attestation's namespace.
  let revocationCount = 0
  if (attUris.length > 0) {
    const revRows = await db
      .select({ uri: revocations.uri })
      .from(revocations)
      .where(
        and(
          eq(revocations.authorDid, did),
          inArray(revocations.targetUri, attUris),
        ),
      )
    revocationCount = revRows.length
  }

  // 3. Reactions on attestations in this namespace. Same reasoning
  // — reactions don't carry a namespace; the target attestation's
  // namespace is what we filter on (via the URI list).
  let helpfulReactions = 0
  let unhelpfulReactions = 0
  if (attUris.length > 0) {
    const reactionRows = await db
      .select({ reaction: reactions.reaction })
      .from(reactions)
      .where(inArray(reactions.targetUri, attUris))

    helpfulReactions = reactionRows.filter((r) => r.reaction === 'helpful').length
    unhelpfulReactions = reactionRows.filter((r) => r.reaction === 'unhelpful').length
  }

  // 4. Corroborated count: per-attestation, count how many OTHER
  // authors attested the same subject with the same sentiment.
  // The corroboration concept is independent of the corroborator's
  // namespace — strangers' independent agreement is the signal,
  // regardless of which namespace they're publishing under.
  let corroboratedCount = 0
  for (const att of authoredAtts) {
    if (!att.subjectId) continue

    const corroborating = await db
      .select({ uri: attestations.uri })
      .from(attestations)
      .where(
        and(
          eq(attestations.subjectId, att.subjectId),
          eq(attestations.sentiment, att.sentiment),
          eq(attestations.isRevoked, false),
        ),
      )
      .limit(2) // only need to know if > 1 exists

    if (corroborating.length > 1) {
      corroboratedCount++
    }
  }

  return {
    totalAttestationsBy,
    withEvidenceCount,
    helpfulReactions,
    unhelpfulReactions,
    revocationCount,
    // V1: tombstones don't carry namespace yet — deletion stats
    // deferred to V2. Pass 0 to `computeReviewerQuality` so the
    // formula treats the namespace as never-deleted (charitable
    // by default; V2 closes the gap).
    tombstoneCount: 0,
    corroboratedCount,
    agentGeneratedCount,
  }
}
