import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, boolean, jsonb, real, integer, index } from 'drizzle-orm/pg-core'
import { subjects } from './subjects'

export const subjectScores = pgTable('subject_scores', {
  subjectId: text('subject_id').primaryKey().references(() => subjects.id),
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
