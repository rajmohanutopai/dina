import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'

export const amendments = pgTable('amendments', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull(),
  cid: text('cid').notNull(),
  targetUri: text('target_uri').notNull(),
  amendmentType: text('amendment_type').notNull(),
  text: text('text'),
  newValuesJson: jsonb('new_values_json'),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('amendments_author_idx').on(table.authorDid),
  index('amendments_target_uri_idx').on(table.targetUri),
])
