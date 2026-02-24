import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'

export const reactions = pgTable('reactions', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull(),
  cid: text('cid').notNull(),
  targetUri: text('target_uri').notNull(),
  reaction: text('reaction').notNull(),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('reactions_author_idx').on(table.authorDid),
  index('reactions_target_uri_idx').on(table.targetUri),
  index('reactions_reaction_idx').on(table.reaction),
  uniqueIndex('reactions_author_reaction_idx').on(table.authorDid, table.targetUri),
])
