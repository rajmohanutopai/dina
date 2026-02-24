import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'

export const verifications = pgTable('verifications', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull(),
  cid: text('cid').notNull(),
  targetUri: text('target_uri').notNull(),
  verificationType: text('verification_type').notNull(),
  evidenceJson: jsonb('evidence_json'),
  result: text('result').notNull(),
  text: text('text'),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('verifications_author_idx').on(table.authorDid),
  index('verifications_target_uri_idx').on(table.targetUri),
])
