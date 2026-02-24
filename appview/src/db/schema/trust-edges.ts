import { pgTable, text, timestamp, real, index } from 'drizzle-orm/pg-core'
import { randomBytes } from 'crypto'

function ulid() {
  const ts = Date.now().toString(36).padStart(10, '0')
  const rand = randomBytes(10).toString('hex').slice(0, 16)
  return `${ts}${rand}`
}

export const trustEdges = pgTable('trust_edges', {
  id: text('id').primaryKey().$defaultFn(ulid),
  fromDid: text('from_did').notNull(),
  toDid: text('to_did').notNull(),
  edgeType: text('edge_type').notNull(),
  domain: text('domain'),
  weight: real('weight').notNull(),
  sourceUri: text('source_uri').notNull().unique(),
  createdAt: timestamp('created_at').notNull(),
}, (table) => [
  index('trust_edges_from_idx').on(table.fromDid),
  index('trust_edges_to_idx').on(table.toDid),
  index('trust_edges_from_to_idx').on(table.fromDid, table.toDid),
  index('trust_edges_type_idx').on(table.edgeType),
])
