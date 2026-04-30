import { sql } from 'drizzle-orm'
import {
  pgTable,
  text,
  timestamp,
  integer,
  real,
  boolean,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core'

/**
 * `reviewer_namespace_scores` (TN-DB-002 / Plan §3.5 + §7).
 *
 * Per-namespace reviewer trust scoring. The base `did_profiles` table
 * stores ROOT-DID-aggregated stats; this table stores per-(did,
 * namespace) statistics for users who publish under one or more
 * pseudonymous namespaces (`m/9999'/4'/N'` derivation per
 * `packages/core/src/identity/plc_namespace_update.ts`).
 *
 * **Why a SEPARATE table** rather than adding `namespace` to
 * `did_profiles` and changing the PK to `(did, namespace)`:
 *   - Most users never use namespaces. A composite PK with a NULL-
 *     bearing `namespace` column would either bloat every row with
 *     a NULL OR require a sentinel value like `''` for the root
 *     identity — both lossy.
 *   - The existing `did_profiles.did` PK is referenced by 50+ code
 *     paths; changing the PK shape is invasive.
 *   - A dedicated table captures the "namespace-using subset" of
 *     reviewers without polluting the root-identity stats. The
 *     scorer reads `did_profiles` for un-namespaced records and
 *     `reviewer_namespace_scores` for namespace-stamped records;
 *     each surface stays clean.
 *
 * **PK = (did, namespace)**: composite. Same DID can have multiple
 * namespace entries (one user with `namespace_0`, `namespace_1`,
 * `namespace_2` gets three rows). The namespace column is NEVER
 * NULL in this table — if a record has no namespace, it goes to
 * `did_profiles` (root identity), not here.
 *
 * **Schema mirror with `did_profiles`**: the reviewer-stat columns
 * (`total_attestations_by`, `revocation_count`, `deletion_count`,
 * `evidence_rate`, etc.) are the same names as on `did_profiles`.
 * Pinned because TN-SCORE-001 (the per-namespace stats refresh job)
 * runs the same arithmetic against this table that
 * `refresh-reviewer-stats.ts` runs against `did_profiles`. Same
 * column names → same SQL — minimises drift between the two paths
 * when the formula evolves.
 *
 * **Why `score_version` here too**: same reason as `did_profiles`
 * (TN-SCORE-002) — every score row is self-describing. A future
 * V3 formula can run alongside V1/V2 and the row's `score_version`
 * tells the consumer which formula produced its `overall_trust_score`.
 *
 * **Index discipline**: the scorer drains dirty rows via
 * `WHERE needs_recalc = true`; pinned by partial index
 * `reviewer_namespace_scores_needs_recalc_idx`. Lookups by
 * `(did, namespace)` use the composite PK directly.
 *
 * **No `vouch_strength` / `endorsement_count` aggregates here**:
 * vouches and endorsements target the root DID, not namespaces — a
 * vouch for "did:plc:abc" applies to ALL namespaces under that DID.
 * Surfacing those aggregates per-namespace would be misleading. The
 * mobile reviewer-profile drill-down reads `did_profiles` for those
 * fields and `reviewer_namespace_scores` for namespace-scoped
 * attestation stats only.
 *
 * **Schema decision: V1 ships the table; V2 wires the writes**.
 * TN-SCORE-001 (per-namespace `refresh-reviewer-stats.ts` extension)
 * is a follow-up; landing the schema first lets the scorer change
 * land cleanly without bundling schema+logic.
 */
export const reviewerNamespaceScores = pgTable(
  'reviewer_namespace_scores',
  {
    did: text('did').notNull(),
    /**
     * Pseudonymous namespace fragment without leading `#` —
     * `'namespace_0'`, `'namespace_3'`, etc. Format pinned by the
     * record-validator at ingest time (`namespaceFragment` in
     * `record-validator.ts`); the schema column matches the
     * 1–255-char bound.
     */
    namespace: text('namespace').notNull(),
    scoreVersion: text('score_version').notNull().default('v1'),
    needsRecalc: boolean('needs_recalc').default(true).notNull(),
    /**
     * Records published BY this (did, namespace) tuple. Mirrors
     * `did_profiles.total_attestations_by` semantics — the counter
     * is for records authored, not records about.
     */
    totalAttestationsBy: integer('total_attestations_by').default(0),
    revocationCount: integer('revocation_count').default(0),
    deletionCount: integer('deletion_count').default(0),
    disputedThenDeletedCount: integer('disputed_then_deleted_count').default(0),
    revocationRate: real('revocation_rate').default(0),
    deletionRate: real('deletion_rate').default(0),
    corroborationRate: real('corroboration_rate').default(0),
    evidenceRate: real('evidence_rate').default(0),
    /**
     * Composite per-namespace trust score in [0, 1]. Computed by
     * TN-SCORE-001 (deferred). NULL means "never scored" (a
     * namespace that has only just been observed but not yet
     * processed by the scorer); the search ranker treats NULL as
     * `'unrated'` band.
     */
    overallTrustScore: real('overall_trust_score'),
    computedAt: timestamp('computed_at').notNull(),
    /**
     * First-seen timestamp for this (did, namespace). Independent of
     * `did_profiles.account_first_seen` because a namespace can be
     * activated long after the root identity (a user creating
     * `namespace_3` in 2027 on a 2025 root DID).
     */
    namespaceFirstSeen: timestamp('namespace_first_seen'),
    lastActive: timestamp('last_active'),
  },
  (table) => [
    primaryKey({ columns: [table.did, table.namespace] }),
    /**
     * Partial index for the scorer's drain query
     * (`SELECT … WHERE needs_recalc = true`). Same shape as
     * `did_profiles_needs_recalc_idx` (TN-SCORE-002).
     */
    index('reviewer_namespace_scores_needs_recalc_idx')
      .on(table.needsRecalc)
      .where(sql`${table.needsRecalc} = true`),
    /**
     * Lookup by DID alone (the mobile reviewer-profile drill-down
     * lists ALL namespaces for a DID). Without this index, that
     * query would full-scan the table.
     */
    index('reviewer_namespace_scores_did_idx').on(table.did),
  ],
)
