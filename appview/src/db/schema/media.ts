import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core'

export const media = pgTable('media', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull(),
  cid: text('cid').notNull(),
  parentUri: text('parent_uri').notNull(),
  mediaType: text('media_type').notNull(),
  url: text('url').notNull(),
  alt: text('alt'),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('media_parent_uri_idx').on(table.parentUri),
])
