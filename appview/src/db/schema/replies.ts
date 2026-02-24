import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'

export const replies = pgTable('replies', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull(),
  cid: text('cid').notNull(),
  rootUri: text('root_uri').notNull(),
  parentUri: text('parent_uri').notNull(),
  intent: text('intent').notNull(),
  text: text('text').notNull(),
  evidenceJson: jsonb('evidence_json'),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('replies_author_idx').on(table.authorDid),
  index('replies_root_uri_idx').on(table.rootUri),
  index('replies_parent_uri_idx').on(table.parentUri),
])
