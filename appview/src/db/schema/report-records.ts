import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'

export const reportRecords = pgTable('report_records', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull(),
  cid: text('cid').notNull(),
  targetUri: text('target_uri').notNull(),
  reportType: text('report_type').notNull(),
  text: text('text'),
  evidenceJson: jsonb('evidence_json'),
  relatedRecordsJson: jsonb('related_records_json'),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('report_records_author_idx').on(table.authorDid),
  index('report_records_target_uri_idx').on(table.targetUri),
])
