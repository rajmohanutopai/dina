/**
 * Live listings (docs/REAL_LIFE_FIXES.md §14): which service operators are
 * still alive, so search stops returning listings their node left behind.
 *
 * Tables:
 *   - `service_operator_presence`: per operator DID, when AppView last saw
 *     it renew (`last_seen_us`, AppView's observation time, never a time the
 *     record claims) and the listing set its latest presence record names.
 *   - `service_deletions`: a deleted listing's revision, kept 30 days, so a
 *     replayed older create cannot bring it back.
 *   - `service_account_status`: the latest `#account` status per DID, as the
 *     A2A directory keeps for cards; an inactive account's listings are
 *     withheld from every read.
 *   - `service_blind_intervals`: spans when AppView may have missed renewals
 *     (an ingest gap, the time before tracking began, a health drop). Ageing
 *     pauses inside them; `last_seen_us` never moves.
 *   - `service_reconcile_jobs`: DIDs whose listings AppView must re-check
 *     against their repository (a CID it does not hold, an event dropped by
 *     a limit or the kill switch).
 */

import { sql } from 'drizzle-orm'
import { bigint, boolean, index, integer, jsonb, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

export const serviceOperatorPresence = pgTable('service_operator_presence', {
  did: text('did').primaryKey(),
  /** AppView's observation time of the last counted renewal (µs); null = never seen. */
  lastSeenUs: bigint('last_seen_us', { mode: 'number' }),
  /** When freshness was last credited (µs); bounds credit to once per 10 minutes. */
  creditedUs: bigint('credited_us', { mode: 'number' }),
  /** The DID has written presence at least once (a release that renews). */
  presenceCapable: boolean('presence_capable').notNull().default(false),
  /** The DID's presence record exists (false after a presence delete). */
  presencePresent: boolean('presence_present').notNull().default(false),
  /** The latest presence names every published listing. */
  presenceComplete: boolean('presence_complete').notNull().default(false),
  /** `[{rkey, cid}]` from the latest presence record. */
  listingsJson: jsonb('listings_json').notNull().default(sql`'[]'::jsonb`),
  /** Repository revision of the latest presence event applied. */
  presenceRev: text('presence_rev'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('service_operator_presence_last_seen_idx').on(table.lastSeenUs),
])

export const serviceDeletions = pgTable('service_deletions', {
  uri: text('uri').primaryKey(),
  did: text('did').notNull(),
  deletedRev: text('deleted_rev').notNull(),
  at: timestamp('at').notNull().defaultNow(),
}, (table) => [
  index('service_deletions_at_idx').on(table.at),
])

export const serviceAccountStatus = pgTable('service_account_status', {
  did: text('did').primaryKey(),
  active: boolean('active').notNull(),
  status: text('status'),
  timeUs: bigint('time_us', { mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const serviceBlindIntervals = pgTable('service_blind_intervals', {
  id: serial('id').primaryKey(),
  startUs: bigint('start_us', { mode: 'number' }).notNull(),
  /** Null while open. */
  endUs: bigint('end_us', { mode: 'number' }),
  reason: text('reason').notNull(),
}, (table) => [
  index('service_blind_intervals_open_idx').on(table.endUs),
])

export const serviceReconcileJobs = pgTable('service_reconcile_jobs', {
  did: text('did').primaryKey(),
  reason: text('reason').notNull(),
  /** The DID's `presence_rev` when queued; a change means redo. */
  presenceRevAtQueue: text('presence_rev_at_queue'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at').notNull().defaultNow(),
  queuedAt: timestamp('queued_at').notNull().defaultNow(),
}, (table) => [
  index('service_reconcile_jobs_due_idx').on(table.nextAttemptAt),
])

/**
 * Events received per hour across every subscribed collection: the upstream
 * signal that must agree before a health drop opens a blind interval. A
 * quiet socket that answers pings looks live even when the relay behind
 * Jetstream has stalled; the event rate does not.
 */
export const ingestHourlyEvents = pgTable('ingest_hourly_events', {
  hourStartUs: bigint('hour_start_us', { mode: 'number' }).primaryKey(),
  events: bigint('events', { mode: 'number' }).notNull().default(0),
})

