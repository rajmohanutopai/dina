import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, boolean, jsonb, index } from 'drizzle-orm/pg-core'

export const subjects = pgTable('subjects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  subjectType: text('subject_type').notNull(),
  did: text('did'),
  identifiersJson: jsonb('identifiers_json').default(sql`'[]'::jsonb`).notNull(),
  authorScopedDid: text('author_scoped_did'),
  canonicalSubjectId: text('canonical_subject_id'),
  needsRecalc: boolean('needs_recalc').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('subjects_did_idx').on(table.did),
  index('subjects_identifiers_idx').using('gin', table.identifiersJson),
  index('subjects_author_scoped_idx').on(table.authorScopedDid).where(sql`${table.authorScopedDid} IS NOT NULL`),
  index('subjects_canonical_idx').on(table.canonicalSubjectId).where(sql`${table.canonicalSubjectId} IS NOT NULL`),
])
