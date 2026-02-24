import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { randomBytes } from 'crypto'

function ulid() {
  const ts = Date.now().toString(36).padStart(10, '0')
  const rand = randomBytes(10).toString('hex').slice(0, 16)
  return `${ts}${rand}`
}

export const mentionEdges = pgTable('mention_edges', {
  id: text('id').primaryKey().$defaultFn(ulid),
  sourceUri: text('source_uri').notNull(),
  sourceDid: text('source_did').notNull(),
  targetDid: text('target_did').notNull(),
  role: text('role'),
  recordType: text('record_type').notNull(),
  createdAt: timestamp('created_at').notNull(),
}, (table) => [
  index('mention_edges_source_uri_idx').on(table.sourceUri),
  index('mention_edges_source_did_idx').on(table.sourceDid),
  index('mention_edges_target_did_idx').on(table.targetDid),
  uniqueIndex('mention_edges_source_target_idx').on(table.sourceUri, table.targetDid),
])
