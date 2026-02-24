import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'

export const reviewRequests = pgTable('review_requests', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull(),
  cid: text('cid').notNull(),
  subjectId: text('subject_id'),
  subjectRefRaw: jsonb('subject_ref_raw').notNull(),
  requestType: text('request_type').notNull(),
  text: text('text'),
  expiresAt: timestamp('expires_at'),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('review_requests_author_idx').on(table.authorDid),
  index('review_requests_subject_idx').on(table.subjectId),
])
