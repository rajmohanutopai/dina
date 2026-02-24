import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'

export const delegations = pgTable('delegations', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull(),
  cid: text('cid').notNull(),
  subjectDid: text('subject_did').notNull(),
  scope: text('scope').notNull(),
  permissionsJson: jsonb('permissions_json').notNull(),
  expiresAt: timestamp('expires_at'),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('delegations_author_idx').on(table.authorDid),
  index('delegations_subject_idx').on(table.subjectDid),
])
