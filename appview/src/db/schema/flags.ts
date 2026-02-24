import { pgTable, text, timestamp, boolean, jsonb, index } from 'drizzle-orm/pg-core'

export const flags = pgTable('flags', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull(),
  cid: text('cid').notNull(),
  subjectId: text('subject_id'),
  subjectRefRaw: jsonb('subject_ref_raw').notNull(),
  flagType: text('flag_type').notNull(),
  severity: text('severity').notNull(),
  text: text('text'),
  evidenceJson: jsonb('evidence_json'),
  isActive: boolean('is_active').default(true),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('flags_author_idx').on(table.authorDid),
  index('flags_subject_idx').on(table.subjectId),
  index('flags_severity_idx').on(table.severity),
])
