/**
 * The UCP profile host (docs/UCP_IMPLEMENTATION_PLAN.md §3.5): one row per
 * label, written only by the host's change path (`src/ucp/store.ts`), one
 * change per label at a time under a per-label advisory lock.
 *
 * The label → DID binding is part of the state and never changes once made.
 * Every change is also in the off-host log, so a restore from an older backup
 * is caught up from there before the label serves or changes again.
 *
 * Hand-written beside `drizzle/0027_ucp_profile_host.sql` and
 * `drizzle/0028_ucp_merchant_index.sql`; keep each equal to its file.
 */

import { sql } from 'drizzle-orm'
import { bigint, check, index, integer, pgTable, real, text, timestamp } from 'drizzle-orm/pg-core'

export const ucpProfileLabels = pgTable('ucp_profile_labels', {
  label: text('label').primaryKey(),
  did: text('did').notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull(),
  /**
   * The whole LabelState (@dina/ucp) as JSON text, served documents included.
   * Text, not jsonb: jsonb refuses `\u0000`, and the profile bytes inside must
   * come back exactly as uploaded.
   */
  stateJson: text('state_json').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * The merchant index (docs/UCP_IMPLEMENTATION_PLAN.md §3.15, U5): one row per
 * merchant origin that a PeerLens attestation names as an `organization`
 * subject (D4: never from anyone's purchases). The crawler
 * (`src/scorer/jobs/ucp-merchant-crawler.ts`) reads each origin's public
 * `/.well-known/ucp` at most once a day through the vetted socket, and keeps
 * what discovery found: usable (its version, transport, capabilities) or
 * not (the reason). Trust is PeerLens's, copied here on every run for the
 * ranking; the merchant's own words are never a ranking input.
 */
export const ucpMerchants = pgTable(
  'ucp_merchants',
  {
    /** `https://host[:port]`, as `merchantOrigin` (@dina/ucp) gives it. */
    origin: text('origin').primaryKey(),
    /** `pending` (not read yet), `usable`, or `unusable` (`reason` says why). */
    state: text('state').notNull().default('pending'),
    /** The discovery failure (@dina/ucp `DiscoveryFailure`), for an unusable merchant. */
    reason: text('reason'),
    /** The UCP version both speak, the transport Dina would use, and its endpoint. */
    version: text('version'),
    transport: text('transport'),
    endpoint: text('endpoint'),
    /** The capabilities both sides would use (`dev.ucp.shopping.*` names). */
    capabilities: text('capabilities').array().notNull().default(sql`'{}'::text[]`),
    /** PeerLens's name for the subject, and the categories it was reviewed under: the search text. */
    name: text('name'),
    searchText: text('search_text').notNull().default(''),
    /** PeerLens trust, copied for the ranking: null when PeerLens has no score (unrated). */
    trustScore: real('trust_score'),
    /** `resolve`'s recommendation (proceed, caution, verify, avoid). */
    recommendation: text('recommendation'),
    reviewCount: integer('review_count').notNull().default(0),
    /** When trust was last copied: each run refreshes the longest-unrefreshed first. */
    trustCheckedAt: timestamp('trust_checked_at', { withTimezone: true }),
    /** The root profile's ETag, for If-None-Match when no leaf profile was used. */
    etag: text('etag'),
    /** The rules the stored read was made under; a 304 is trusted only under the same. */
    rules: text('rules'),
    /** Reads in a row that could not reach the merchant (an earlier usable read stands a while). */
    failures: integer('failures').notNull().default(0),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    usableAt: timestamp('usable_at', { withTimezone: true }),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ucp_merchants_due_idx').on(table.nextCheckAt),
    index('ucp_merchants_capabilities_idx').using('gin', table.capabilities),
    index('ucp_merchants_search_idx').using('gin', sql`to_tsvector('simple', coalesce(${table.searchText}, ''))`),
    check('ucp_merchants_state_check', sql`${table.state} IN ('pending', 'usable', 'unusable')`),
    check('ucp_merchants_transport_check', sql`${table.transport} IS NULL OR ${table.transport} IN ('mcp', 'rest')`),
    check(
      'ucp_merchants_trust_score_check',
      sql`${table.trustScore} IS NULL OR (${table.trustScore} >= 0 AND ${table.trustScore} <= 1)`,
    ),
  ],
)
