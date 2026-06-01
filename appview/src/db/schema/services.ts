import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, boolean, jsonb, numeric, index, check } from 'drizzle-orm/pg-core'

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
  // Per-capability concrete category/vertical (catalog §9.1), canonical-keyed.
  // Lets search filter/rank by vertical (e.g. appointment_availability where
  // category = healthcare). Null when the publisher carried no categories.
  capabilityCategoriesJson: jsonb('capability_categories_json'),
  isDiscoverable: boolean('is_discoverable').notNull().default(true),
  // Explicit catalog discoverability (§5.2). Only `public` records are indexed
  // for search (the ingester gates on `isDiscoverable`), so for an indexed row
  // this is effectively always `public`; stored for completeness + future use.
  discoverability: text('discoverability'),
  searchContent: text('search_content'),
  // Three timestamps with distinct semantics:
  //   - createdAt: first time AppView saw this profile URI. Never
  //     updated. Used for GDPR / audit / "service age" displays.
  //   - updatedAt: last time the operator changed the record content
  //     (cid changed). Updated on every operator-driven re-publish.
  //   - indexedAt: last time AppView wrote this row. Updated on every
  //     index rebuild (including pure re-ingest of unchanged content).
  // Operators investigating "what changed when" need all three.
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
  // ── Moderator takedown ───────────────────────────────────────────
  // Distinct from `isDiscoverable`, which the OPERATOR controls. A
  // moderator-set `tombstonedAt` keeps the row resolvable (for audit
  // trail + URL stability) but excludes it from active reads.
  tombstonedAt: timestamp('tombstoned_at'),
  tombstoneReason: text('tombstone_reason'),
}, (table) => [
  index('services_operator_did_idx').on(table.operatorDid),
  index('services_is_discoverable_idx').on(table.isDiscoverable),
  index('services_lat_lng_idx').on(table.lat, table.lng),
  index('services_capabilities_idx').using('gin', table.capabilitiesJson),
  // For ILIKE queries, a btree index on searchContent helps with prefix matching.
  // Full trigram (pg_trgm) requires extension — use basic btree for Phase 1.
  index('services_search_content_idx').on(table.searchContent),
  // Partial index — tombstoning is a rare operator action; partial
  // WHERE keeps the b-tree small while still serving operator queries.
  index('services_tombstoned_idx')
    .on(table.tombstonedAt)
    .where(sql`${table.tombstonedAt} IS NOT NULL`),
  // DB-level lat/lng range guards. Lexicon validates first; this
  // catches direct SQL writes (admin tooling, ops scripts).
  check('services_lat_range', sql`${table.lat} IS NULL OR (${table.lat} BETWEEN -90 AND 90)`),
  check('services_lng_range', sql`${table.lng} IS NULL OR (${table.lng} BETWEEN -180 AND 180)`),
])
