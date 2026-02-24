import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core'

export const endorsements = pgTable('endorsements', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull(),
  cid: text('cid').notNull(),
  subjectDid: text('subject_did').notNull(),
  skill: text('skill').notNull(),
  endorsementType: text('endorsement_type').notNull(),
  relationship: text('relationship'),
  text: text('text'),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('endorsements_author_idx').on(table.authorDid),
  index('endorsements_subject_idx').on(table.subjectDid),
  index('endorsements_skill_idx').on(table.skill),
])
