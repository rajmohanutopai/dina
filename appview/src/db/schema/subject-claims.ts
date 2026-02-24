import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'

export const subjectClaims = pgTable('subject_claims', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull(),
  cid: text('cid').notNull(),
  sourceSubjectId: text('source_subject_id').notNull(),
  targetSubjectId: text('target_subject_id').notNull(),
  claimType: text('claim_type').notNull(),
  evidenceJson: jsonb('evidence_json'),
  text: text('text'),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('subject_claims_source_idx').on(table.sourceSubjectId),
  index('subject_claims_target_idx').on(table.targetSubjectId),
])
