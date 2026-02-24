import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'

export const comparisons = pgTable('comparisons', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull(),
  cid: text('cid').notNull(),
  subjectsJson: jsonb('subjects_json').notNull(),
  category: text('category').notNull(),
  dimensionsJson: jsonb('dimensions_json'),
  text: text('text'),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('comparisons_author_idx').on(table.authorDid),
  index('comparisons_category_idx').on(table.category),
])
