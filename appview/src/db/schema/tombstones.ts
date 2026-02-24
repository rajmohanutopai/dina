import { pgTable, text, timestamp, boolean, jsonb, integer, index } from 'drizzle-orm/pg-core'
import { randomBytes } from 'crypto'

function ulid() {
  const ts = Date.now().toString(36).padStart(10, '0')
  const rand = randomBytes(10).toString('hex').slice(0, 16)
  return `${ts}${rand}`
}

export const tombstones = pgTable('tombstones', {
  id: text('id').primaryKey().$defaultFn(ulid),
  originalUri: text('original_uri').notNull().unique(),
  authorDid: text('author_did').notNull(),
  recordType: text('record_type').notNull(),
  subjectId: text('subject_id'),
  subjectRefRaw: jsonb('subject_ref_raw'),
  category: text('category'),
  sentiment: text('sentiment'),
  domain: text('domain'),
  originalCreatedAt: timestamp('original_created_at'),
  deletedAt: timestamp('deleted_at').notNull(),
  durationDays: integer('duration_days'),
  hadEvidence: boolean('had_evidence').default(false),
  hadCosignature: boolean('had_cosignature').default(false),
  reportCount: integer('report_count').default(0),
  disputeReplyCount: integer('dispute_reply_count').default(0),
  suspiciousReactionCount: integer('suspicious_reaction_count').default(0),
}, (table) => [
  index('tombstones_author_idx').on(table.authorDid),
  index('tombstones_subject_idx').on(table.subjectId),
  index('tombstones_deleted_idx').on(table.deletedAt),
])
