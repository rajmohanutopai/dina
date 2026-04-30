import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, boolean, jsonb, real, integer, index } from 'drizzle-orm/pg-core'

/**
 * `score_version` (TN-SCORE-002 / Plan §13.7) — every reviewer score
 * row carries the version of the algorithm that produced it. V1 stamps
 * `'v1'`; V2's per-namespace scoring (TN-DB-002) will write `'v2'` rows
 * either alongside V1 (if the schema gains a composite key in V2) or
 * by replacing the V1 row.
 *
 * V1 stamps explicitly on every write — defense in depth against a
 * future where V2 has run and left `'v2'` behind, then a V1 process
 * catches up and updates the row. Without explicit stamping, the V1
 * UPDATE would leave `score_version='v2'` even though the row's
 * values are now V1-derived. With explicit stamping, the row is
 * always self-describing.
 *
 * Default `'v1'` so legacy code paths that insert without specifying
 * a version don't break and still produce version-stamped rows.
 *
 * Per-namespace scoring (the (did, namespace) PK or a separate
 * reviewer_namespace_scores table) is the larger TN-DB-002 work; this
 * column is the strictly-additive piece that TN-SCORE-002 needs.
 */
export const didProfiles = pgTable('did_profiles', {
  did: text('did').primaryKey(),
  scoreVersion: text('score_version').notNull().default('v1'),
  needsRecalc: boolean('needs_recalc').default(true).notNull(),
  totalAttestationsAbout: integer('total_attestations_about').default(0),
  positiveAbout: integer('positive_about').default(0),
  neutralAbout: integer('neutral_about').default(0),
  negativeAbout: integer('negative_about').default(0),
  vouchCount: integer('vouch_count').default(0),
  vouchStrength: text('vouch_strength').default('unvouched'),
  highConfidenceVouches: integer('high_confidence_vouches').default(0),
  endorsementCount: integer('endorsement_count').default(0),
  topSkillsJson: jsonb('top_skills_json'),
  activeFlagCount: integer('active_flag_count').default(0),
  totalAttestationsBy: integer('total_attestations_by').default(0),
  revocationCount: integer('revocation_count').default(0),
  deletionCount: integer('deletion_count').default(0),
  disputedThenDeletedCount: integer('disputed_then_deleted_count').default(0),
  revocationRate: real('revocation_rate').default(0),
  deletionRate: real('deletion_rate').default(0),
  corroborationRate: real('corroboration_rate').default(0),
  evidenceRate: real('evidence_rate').default(0),
  averageHelpfulRatio: real('average_helpful_ratio').default(0),
  activeDomains: text('active_domains').array(),
  isAgent: boolean('is_agent').default(false),
  accountFirstSeen: timestamp('account_first_seen'),
  lastActive: timestamp('last_active'),
  coordinationFlagCount: integer('coordination_flag_count').default(0),
  overallTrustScore: real('overall_trust_score'),
  computedAt: timestamp('computed_at').notNull(),
}, (table) => [
  index('did_profiles_needs_recalc_idx').on(table.needsRecalc).where(sql`${table.needsRecalc} = true`),
])
