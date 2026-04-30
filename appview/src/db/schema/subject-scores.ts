import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, boolean, jsonb, real, integer, index } from 'drizzle-orm/pg-core'
import { subjects } from './subjects'

/**
 * `score_version` (TN-DB-001 / Plan §4.1) — every score row carries the
 * version of the algorithm that produced it. V1 stamps `'v1'`; V2's sybil
 * clustering will write `'v2'` rows alongside V1 (the xRPC layer reads the
 * freshest by `computed_at`). Default `'v1'` so legacy code paths that
 * insert without specifying a version don't break and still produce
 * version-stamped rows.
 *
 * The plan §4.1 long-form design has `UNIQUE (subject_id, score_version)`
 * with `id BIGSERIAL` PK; the existing AppView shape pre-dates that and
 * keeps `subjectId` as the PK — V1 leaves that surface unchanged (one row
 * per subject for now), with multi-version coexistence deferred to V2.
 * The column is here so V2 can roll forward without a second migration.
 */
export const subjectScores = pgTable('subject_scores', {
  subjectId: text('subject_id').primaryKey().references(() => subjects.id),
  scoreVersion: text('score_version').notNull().default('v1'),
  needsRecalc: boolean('needs_recalc').default(true).notNull(),
  totalAttestations: integer('total_attestations').default(0),
  positive: integer('positive').default(0),
  neutral: integer('neutral').default(0),
  negative: integer('negative').default(0),
  weightedScore: real('weighted_score'),
  confidence: real('confidence'),
  dimensionSummaryJson: jsonb('dimension_summary_json'),
  authenticityConsensus: text('authenticity_consensus'),
  authenticityConfidence: real('authenticity_confidence'),
  wouldRecommendRate: real('would_recommend_rate'),
  verifiedAttestationCount: integer('verified_attestation_count').default(0),
  lastAttestationAt: timestamp('last_attestation_at'),
  attestationVelocity: real('attestation_velocity'),
  computedAt: timestamp('computed_at').notNull(),
}, (table) => [
  index('subject_scores_needs_recalc_idx').on(table.needsRecalc).where(sql`${table.needsRecalc} = true`),
])
