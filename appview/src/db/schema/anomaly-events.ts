import { pgTable, text, timestamp, boolean, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { randomBytes } from 'crypto'

function ulid() {
  const ts = Date.now().toString(36).padStart(10, '0')
  const rand = randomBytes(10).toString('hex').slice(0, 16)
  return `${ts}${rand}`
}

export const anomalyEvents = pgTable('anomaly_events', {
  id: text('id').primaryKey().$defaultFn(ulid),
  eventType: text('event_type').notNull(),
  detectedAt: timestamp('detected_at').notNull().defaultNow(),
  involvedDids: text('involved_dids').array().notNull(),
  details: jsonb('details'),
  severity: text('severity').notNull(),
  resolved: boolean('resolved').default(false),
  dedupHash: text('dedup_hash'),
}, (table) => [
  index('anomaly_events_type_idx').on(table.eventType),
  index('anomaly_events_detected_idx').on(table.detectedAt),
  uniqueIndex('anomaly_dedup_idx').on(table.dedupHash),
])
