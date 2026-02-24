import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core'

export const revocations = pgTable('revocations', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull(),
  cid: text('cid').notNull(),
  targetUri: text('target_uri').notNull(),
  reason: text('reason').notNull(),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('revocations_author_idx').on(table.authorDid),
  index('revocations_target_uri_idx').on(table.targetUri),
])
