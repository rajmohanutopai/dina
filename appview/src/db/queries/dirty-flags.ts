import { sql } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { didProfiles, reviewerNamespaceScores, subjectScores } from '@/db/schema/index.js'

/**
 * Incremental dirty flag marking (Fix 9 + TN-SCORE-008 / Plan §13.7).
 *
 * When a record is created or deleted, mark all affected entities
 * (subjects and DID profiles) for score recalculation. The scorer
 * daemon picks up dirty entities in batches instead of recomputing
 * everything.
 *
 * **Hot-subject bound (TN-SCORE-008)**: when a subject already has
 * `total_attestations > HOT_SUBJECT_THRESHOLD` (default 10,000 — read
 * from `trust_v1_params` via `readCachedTrustV1Params`; caller passes
 * a fresh snapshot in), the per-attestation dirty flag is skipped so
 * the firehose ingester isn't blocked reading 10k+ reviewer-trust
 * rows on every new write. Those subjects rely on the nightly batch
 * (`refresh-subject-scores`) instead — the operator-tunable trade-off
 * is "near-realtime updates for normal subjects, daily updates for
 * viral ones". The DID-side dirty flagging is unaffected: reviewer
 * scores still update incrementally because their fan-in is bounded
 * by the per-DID per-day quota gate (TN-ING-002), not by subject
 * popularity.
 *
 * **Atomic gate via `setWhere`**: the hot-subject filter is enforced
 * by an `ON CONFLICT (subject_id) DO UPDATE … WHERE total_attestations
 * <= $threshold` clause. No pre-read needed — the filter runs inside
 * the UPSERT atomically. First-time rows (no conflict) always INSERT
 * because a subject with zero observed attestations cannot yet be hot;
 * the threshold only matters once the row exists with a counter value.
 *
 * **NULL `total_attestations` falls through to "not hot"**: a row
 * created by `markDirty` with an explicit zero count, or by an early
 * insert that hasn't yet been refreshed, is treated as cold so the
 * dirty bit lands. Callers must not see the hot-subject bound mask
 * cold subjects whose `total_attestations` defaulted to NULL because
 * a migration hadn't run.
 */

interface DirtyMarkParams {
  /** Subject that was referenced in the record */
  subjectId: string | null
  /** DID of the record author */
  authorDid: string
  /** DIDs mentioned in the record */
  mentionedDids?: { did: string }[]
  /** DID of the subject (if the subject is a DID-type entity) */
  subjectDid?: string | null
  /** DID of a co-signer (if attestation has a co-signature) */
  cosignerDid?: string | null
  /**
   * Pseudonymous namespace fragment under which this record was
   * authored (TN-DB-012 / TN-SCORE-001). When present + non-null,
   * the per-namespace reviewer-stats row gets dirty-flagged in
   * addition to the root-identity row. Leave undefined / null for
   * root-identity records (= the V1 majority path).
   */
  authorNamespace?: string | null
  /**
   * Hot-subject threshold (TN-SCORE-008 / Plan §13.7). When the
   * existing subject row's `total_attestations` exceeds this, the
   * subject's dirty bit is NOT flipped — the nightly batch handles
   * recomputation. DIDs are still flagged regardless.
   *
   * Omitted = no gate at all (the UPSERT emits the pre-TN-SCORE-008
   * SQL byte-for-byte, so mid-migration callers continue working
   * unchanged). Production callers should pass
   * `readCachedTrustV1Params(db).HOT_SUBJECT_THRESHOLD`.
   */
  hotSubjectThreshold?: number
}

/**
 * Mark affected subjects and DID profiles as needing recalculation.
 * Uses upsert (INSERT ... ON CONFLICT DO UPDATE) so rows are created
 * if they don't exist yet.
 */
export async function markDirty(db: DrizzleDB, params: DirtyMarkParams): Promise<void> {
  // Mark subject for score recalculation. TN-SCORE-002: explicit
  // `scoreVersion: 'v1'` on insert (defense in depth — column has
  // a default, but explicit stamping makes intent clear and survives
  // a future schema change that drops the default).
  //
  // TN-SCORE-008: `setWhere` atomically gates the UPDATE branch on
  // the hot-subject threshold. Skipping is silent (no error, no log
  // — the gate is hot path, ~per-attestation; observability lives in
  // the nightly batch's "subjects refreshed" counter).
  if (params.subjectId) {
    // Build the conflict config conditionally so the pre-TN-SCORE-008
    // call shape (no threshold passed) emits the original UPSERT
    // unchanged — no `setWhere` clause at all. This preserves byte-
    // for-byte backward compat with mid-migration callers.
    const threshold = params.hotSubjectThreshold
    const conflictConfig = threshold === undefined
      ? {
          target: subjectScores.subjectId,
          set: { needsRecalc: true },
        }
      : {
          target: subjectScores.subjectId,
          set: { needsRecalc: true },
          setWhere: sql`${subjectScores.totalAttestations} IS NULL OR ${subjectScores.totalAttestations} <= ${threshold}`,
        }
    await db.insert(subjectScores).values({
      subjectId: params.subjectId,
      scoreVersion: 'v1',
      needsRecalc: true,
      computedAt: new Date(0),
    }).onConflictDoUpdate(conflictConfig)
  }

  // Collect all affected DIDs
  const affectedDids = new Set<string>()
  affectedDids.add(params.authorDid)
  if (params.subjectDid) affectedDids.add(params.subjectDid)
  if (params.cosignerDid) affectedDids.add(params.cosignerDid)
  if (params.mentionedDids) {
    for (const m of params.mentionedDids) affectedDids.add(m.did)
  }

  // DB2: Batch upsert all affected DIDs in a single statement
  // instead of one INSERT per DID (was N+1).
  //
  // TN-SCORE-008 audit: DID-side dirty flagging is NOT gated on
  // hot-reviewer status. Per Plan §13.7 the hot-reviewer bound is
  // satisfied by the cascade fan-out cap (TN-SCORE-004's
  // CASCADE_MAX_SUBJECTS=1000) — high-volume reviewers naturally
  // rate-limit themselves there. No per-write skip needed.
  const dids = [...affectedDids]
  if (dids.length > 0) {
    await db.insert(didProfiles).values(
      dids.map(did => ({
        did,
        scoreVersion: 'v1',
        needsRecalc: true,
        computedAt: new Date(0),
      }))
    ).onConflictDoUpdate({
      target: didProfiles.did,
      set: { needsRecalc: true },
    })
  }

  // TN-SCORE-001: when the record was authored under a pseudonymous
  // namespace, also flag the per-(did, namespace) row in
  // `reviewer_namespace_scores`. This is the WRITE PATH that creates
  // those rows in the first place — without it, the dedicated
  // refresh job (`refresh-reviewer-namespace-stats.ts`) would never
  // see anything to drain. Only the AUTHOR's namespace is flagged
  // here: a mention / cosigner doesn't belong to a specific
  // namespace from the AUTHOR's record's perspective.
  if (params.authorNamespace) {
    await db
      .insert(reviewerNamespaceScores)
      .values({
        did: params.authorDid,
        namespace: params.authorNamespace,
        scoreVersion: 'v1',
        needsRecalc: true,
        computedAt: new Date(0),
      })
      .onConflictDoUpdate({
        target: [reviewerNamespaceScores.did, reviewerNamespaceScores.namespace],
        set: { needsRecalc: true },
      })
  }
}
