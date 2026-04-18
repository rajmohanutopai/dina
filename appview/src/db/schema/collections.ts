import { pgTable, text, timestamp, boolean, jsonb, index } from 'drizzle-orm/pg-core'

export const collections = pgTable('collections', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull(),
  cid: text('cid').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  itemsJson: jsonb('items_json').notNull(),
  isDiscoverable: boolean('is_discoverable').default(true),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('collections_author_idx').on(table.authorDid),
])
