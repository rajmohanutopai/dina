/**
 * Term listings (docs/SHELF_SPACE_NEGOTIATION.md §6.1): the public record a
 * store publishes for an open resource — a shelf slot — in its own repo.
 *
 * The record is a CLOSED vocabulary with no money field and no free text;
 * the protocol validator that admits it refuses any other field. This table
 * keeps the record whole (`record_json`, which a brand's node re-validates
 * and binds its request to by digest) and projects the fields search filters
 * on. Nothing here is a price: there is none to project.
 */

import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const termListings = pgTable('term_listings', {
  /** at://<seller>/com.dinakernel.commerce.termListing/<listing_id> */
  uri: text('uri').primaryKey(),
  sellerDid: text('seller_did').notNull(),
  listingId: text('listing_id').notNull(),
  cid: text('cid'),
  listingDigest: text('listing_digest').notNull(),
  packId: text('pack_id').notNull(),
  schemaMajor: integer('schema_major').notNull(),
  resourceRef: text('resource_ref').notNull(),
  kind: text('kind').notNull(),
  regionScheme: text('region_scheme').notNull(),
  regionValue: text('region_value').notNull(),
  availableFrom: timestamp('available_from', { withTimezone: true }).notNull(),
  availableTo: timestamp('available_to', { withTimezone: true }).notNull(),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  /** The record as published, exactly — the bytes its digest covers. */
  recordJson: jsonb('record_json').notNull(),
  /** Repository revision of the event applied; an older one never replaces it. */
  repoRev: text('repo_rev'),
  indexedAt: timestamp('indexed_at').notNull().defaultNow(),
}, (table) => [
  index('term_listings_seller_idx').on(table.sellerDid),
  index('term_listings_region_idx').on(table.regionScheme, table.regionValue),
  index('term_listings_available_idx').on(table.availableFrom, table.availableTo),
  index('term_listings_tags_idx').using('gin', table.tags),
])
