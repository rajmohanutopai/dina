import { pgTable, text, timestamp, boolean, jsonb, numeric, index } from 'drizzle-orm/pg-core'

export const services = pgTable('services', {
  uri: text('uri').primaryKey(),
  operatorDid: text('operator_did').notNull(),
  cid: text('cid').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  capabilitiesJson: jsonb('capabilities_json').notNull(),
  lat: numeric('lat'),
  lng: numeric('lng'),
  radiusKm: numeric('radius_km'),
  hoursJson: jsonb('hours_json'),
  responsePolicyJson: jsonb('response_policy_json'),
  capabilitySchemasJson: jsonb('capability_schemas_json'),  // WS2: per-capability JSON schemas; each entry holds its own schema_hash
  isPublic: boolean('is_public').notNull().default(true),
  searchContent: text('search_content'),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('services_operator_did_idx').on(table.operatorDid),
  index('services_is_public_idx').on(table.isPublic),
  index('services_lat_lng_idx').on(table.lat, table.lng),
  index('services_capabilities_idx').using('gin', table.capabilitiesJson),
  // For ILIKE queries, a btree index on searchContent helps with prefix matching.
  // Full trigram (pg_trgm) requires extension — use basic btree for Phase 1.
  index('services_search_content_idx').on(table.searchContent),
])
