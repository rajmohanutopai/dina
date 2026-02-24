import { pgTable, text, timestamp, boolean, jsonb, integer, uniqueIndex } from 'drizzle-orm/pg-core'

export const trustPolicies = pgTable('trust_policies', {
  uri: text('uri').primaryKey(),
  authorDid: text('author_did').notNull().unique(),
  cid: text('cid').notNull(),
  maxGraphDepth: integer('max_graph_depth'),
  trustedDomainsJson: jsonb('trusted_domains_json'),
  blockedDidsJson: jsonb('blocked_dids_json'),
  requireVouch: boolean('require_vouch').default(false),
  recordCreatedAt: timestamp('record_created_at').notNull(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('trust_policies_author_idx').on(table.authorDid),
])
