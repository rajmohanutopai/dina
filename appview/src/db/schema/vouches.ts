import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core'

export const vouches = pgTable('vouches', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull(),
  cid: text('cid').notNull(),
  subjectDid: text('subject_did').notNull(),
  vouchType: text('vouch_type').notNull(),
  confidence: text('confidence').notNull(),
  relationship: text('relationship'),
  knownSince: text('known_since'),
  text: text('text'),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('vouches_author_idx').on(table.authorDid),
  index('vouches_subject_idx').on(table.subjectDid),
])
