/**
 * The A2A directory (Lane 3, docs/A2A_GATEWAY_ARCHITECTURE.md §8.3): Dina
 * nodes' published Agent Cards, indexed for trust-ranked search.
 *
 * Five tables, each with one writer:
 *   - `a2a_cards`: one row per publisher DID, written only by the
 *     ingester's processor, every transition conditioned on the
 *     repository revision (`repo_rev`). A deleted card keeps its row (a
 *     tombstone), so a delayed older event can never bring it back.
 *   - `a2a_card_takedowns`: the moderator's gate, written only by the
 *     moderation CLI. Nothing the owner publishes clears it, and lifting it
 *     never brings back a card the owner deleted.
 *   - `a2a_account_status`: what account events said about a known DID,
 *     written only by the ingester's consumer path.
 *   - `a2a_event_spool`: every card event, recorded before the consumer
 *     acknowledges it, then processed in revision order. Never dropped.
 *   - `a2a_directory_state`: one row, the phase serving reads (only
 *     `ready` serves) and the gap generation a card must be proved under.
 *
 * Hand-written beside `drizzle/0025_a2a_directory.sql`; keep the two equal.
 */

import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

import { adminAuditLog } from './admin-audit-log'

export const a2aCards = pgTable(
  'a2a_cards',
  {
    did: text('did').primaryKey(),
    /** Repository presence, ordered by `repo_rev`. */
    presence: text('presence').notNull(),
    /** The revision of the last transition applied: the token every transition is conditioned on. */
    repoRev: text('repo_rev').notNull(),
    lastOperation: text('last_operation').notNull(),
    lastEventHash: text('last_event_hash').notNull(),
    /** The spool row and Jetstream time of the last transition applied. */
    lastSpoolId: bigint('last_spool_id', { mode: 'number' }),
    lastEventTimeUs: bigint('last_event_time_us', { mode: 'number' }),
    /** Content identity, for audit only (a delete carries none). */
    cid: text('cid'),
    /**
     * The whole record as published (its JSON), kept so the card can be checked
     * again after a key change. Text, not jsonb: jsonb refuses `\u0000`.
     */
    recordJson: text('record_json'),
    /** The card string, verbatim: the bytes `getCard` serves and `card_hash` covers. */
    cardJson: text('card_json'),
    cardHash: text('card_hash'),
    signatureState: text('signature_state').notNull(),
    endpoint: text('endpoint'),
    protocolVersion: text('protocol_version'),
    /** The exact skill identifiers (`capability` or `capability@rkey`). */
    skillIds: text('skill_ids').array().notNull().default(sql`'{}'::text[]`),
    /** Their canonical capability names: the search key. */
    skillKeys: text('skill_keys').array().notNull().default(sql`'{}'::text[]`),
    displayName: text('display_name'),
    description: text('description'),
    /** Name, description and skills, for text relevance. */
    searchText: text('search_text'),
    freshnessEpoch: bigint('freshness_epoch', { mode: 'number' }),
    publisherEpoch: bigint('publisher_epoch', { mode: 'number' }),
    publisherInstance: text('publisher_instance'),
    /** When the current card was indexed: staleness counts from here. */
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    /** When the card's signatures last verified against the publisher's DID document. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** A newer record failed validation, or two events claimed one revision: not served. */
    unavailable: boolean('unavailable').notNull().default(false),
    unavailableReason: text('unavailable_reason'),
    evidenceJson: jsonb('evidence_json'),
    /** The account's repository is active (account events). */
    accountActive: boolean('account_active').notNull().default(true),
    /** The gap generation this card's presence was last proved under. */
    provedGeneration: integer('proved_generation').notNull(),
    /** The DID document changed (or the periodic check is due): verify the card again. */
    needsRevalidation: boolean('needs_revalidation').notNull().default(false),
    /** Not before this (the PLC directory did not answer the last try). */
    revalidateAfter: timestamp('revalidate_after', { withTimezone: true }),
    /**
     * An identity event marked the card: the key that verified it may be
     * gone, so it is withheld until a check against the new document lands
     * a verdict (design §8.3). The routine daily recheck never sets it.
     */
    identityCheckPending: boolean('identity_check_pending').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('a2a_cards_presence_check', sql`${table.presence} IN ('present', 'deleted')`),
    check('a2a_cards_operation_check', sql`${table.lastOperation} IN ('create', 'update', 'delete')`),
    check('a2a_cards_signature_check', sql`${table.signatureState} IN ('verified', 'invalid', 'none')`),
    index('a2a_cards_skill_keys_idx').using('gin', table.skillKeys),
    index('a2a_cards_skill_ids_idx').using('gin', table.skillIds),
    index('a2a_cards_revalidation_idx').on(table.did).where(sql`${table.needsRevalidation}`),
  ],
)

/**
 * Account status of DIDs the directory knows (a card or spool row), from
 * account events, ordered by Jetstream time. A card is withheld while its
 * account's latest status after the card's commit is inactive.
 */
export const a2aAccountStatus = pgTable('a2a_account_status', {
  did: text('did').primaryKey(),
  active: boolean('active').notNull(),
  timeUs: bigint('time_us', { mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const a2aCardTakedowns = pgTable('a2a_card_takedowns', {
  did: text('did').primaryKey(),
  takenDownAt: timestamp('taken_down_at', { withTimezone: true }).notNull().defaultNow(),
  reason: text('reason').notNull(),
  auditLogId: bigint('audit_log_id', { mode: 'bigint' }).references(() => adminAuditLog.id),
})

export const a2aEventSpool = pgTable(
  'a2a_event_spool',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    did: text('did').notNull(),
    collection: text('collection').notNull(),
    rkey: text('rkey').notNull(),
    repoRev: text('repo_rev').notNull(),
    operation: text('operation').notNull(),
    /** sha256 of the operation, CID and record: equal-revision events are told apart by it. */
    eventHash: text('event_hash').notNull(),
    /**
     * The commit as received, as JSON text. Not jsonb: jsonb refuses `\u0000`,
     * and a payload the spool cannot store would stall the consumer for every
     * repository, since a card event is never dropped.
     */
    payload: text('payload').notNull(),
    timeUs: bigint('time_us', { mode: 'number' }).notNull(),
    /** The gap generation current when the event was received (never when processed). */
    observedGapGeneration: integer('observed_gap_generation').notNull(),
    status: text('status').notNull().default('pending'),
    /** What processing decided: applied, stale, replay, conflict, suppressed, deleted. */
    outcome: text('outcome'),
    attempts: integer('attempts').notNull().default(0),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    notBefore: timestamp('not_before', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    check('a2a_event_spool_operation_check', sql`${table.operation} IN ('create', 'update', 'delete')`),
    check('a2a_event_spool_status_check', sql`${table.status} IN ('pending', 'done')`),
    uniqueIndex('a2a_event_spool_identity_idx').on(
      table.did,
      table.collection,
      table.rkey,
      table.repoRev,
      table.operation,
      table.eventHash,
    ),
    index('a2a_event_spool_pending_idx').on(table.did, table.repoRev, table.id).where(sql`${table.status} = 'pending'`),
  ],
)

export const a2aDirectoryState = pgTable(
  'a2a_directory_state',
  {
    id: integer('id').primaryKey(),
    phase: text('phase').notNull(),
    /** Moves at every phase change, so a transition is conditioned on the state it read. */
    generation: integer('generation').notNull().default(0),
    /** Moves when the ingester finds a gap it cannot replay; cards must be proved again under it. */
    gapGeneration: integer('gap_generation').notNull().default(0),
    /** The last spool row a drain must reach before the directory opens. */
    drainWatermark: bigint('drain_watermark', { mode: 'number' }),
    /** When the consumer was last connected with nothing waiting (µs): gaps are measured from here. */
    lastLiveUs: bigint('last_live_us', { mode: 'number' }),
    /** The flag could not be read: the directory closed until it can. */
    reconciliationRequired: boolean('reconciliation_required').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('a2a_directory_state_singleton', sql`${table.id} = 1`),
    check('a2a_directory_state_phase_check', sql`${table.phase} IN ('disabled', 'draining', 'ready')`),
  ],
)
