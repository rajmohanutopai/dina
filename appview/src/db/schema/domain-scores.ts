import { pgTable, text, timestamp, boolean, real, integer, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { randomBytes } from 'crypto'

function ulid() {
  const ts = Date.now().toString(36).padStart(10, '0')
  const rand = randomBytes(10).toString('hex').slice(0, 16)
  return `${ts}${rand}`
}

export const domainScores = pgTable('domain_scores', {
  id: text('id').primaryKey().$defaultFn(ulid),
  did: text('did').notNull(),
  domain: text('domain').notNull(),
  trustScore: real('trust_score'),
  attestationCount: integer('attestation_count').default(0),
  needsRecalc: boolean('needs_recalc').default(true).notNull(),
  computedAt: timestamp('computed_at').notNull(),
}, (table) => [
  index('domain_scores_did_idx').on(table.did),
  index('domain_scores_domain_idx').on(table.domain),
  uniqueIndex('domain_scores_did_domain_idx').on(table.did, table.domain),
])
