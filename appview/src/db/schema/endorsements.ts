import { sql } from 'drizzle-orm'
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
  // Pseudonymous namespace fragment (TN-DB-012 / Plan §3.5).
  // Symmetric with `attestations.namespace` — endorsements published
  // under a non-root namespace stay accountable to that compartment.
  // NULL = root identity.
  namespace: text('namespace'),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('endorsements_author_idx').on(table.authorDid),
  index('endorsements_subject_idx').on(table.subjectDid),
  index('endorsements_skill_idx').on(table.skill),
  // Author + namespace composite. Same partial-index rationale as
  // `attestations_author_namespace_idx` — root-identity rows go
  // through `endorsements_author_idx`, namespaced rows are smaller
  // and benefit from the targeted index.
  index('endorsements_author_namespace_idx')
    .on(table.authorDid, table.namespace)
    .where(sql`${table.namespace} IS NOT NULL`),
])
