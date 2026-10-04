/**
 * What a card event does to the directory row (design §8.3): pure, so the
 * processor's transaction only applies what this decides.
 *
 * The repository revision (`commit.rev`, a TID) is the one ordering token.
 * Jetstream's `time_us` is informal and a delete carries no CID, so neither
 * can order transitions. Against the row's revision an event is:
 *   - older: stale, a no-op (a delayed update, a replayed old record, a
 *     create racing the delete that followed it);
 *   - equal, with the same operation and event hash: a replay, a no-op;
 *   - equal, with anything else: a conflict. Arrival order must never pick
 *     a winner, so the row goes unavailable with both events as evidence;
 *   - newer: a delete tombstones the row (the row stays, so nothing older
 *     can bring the card back); a valid create or update replaces the card;
 *     an invalid one suppresses the row, so an older valid card is never
 *     left serving in place of the repository's current record.
 *
 * Gap generations: a valid transition proves the card's presence only when
 * the event was received under the current gap generation. One received
 * before a gap was declared still applies its transition, without proof.
 */

import { createHash } from 'node:crypto'

import { canonicalize, type JsonValue } from '@dina/a2a'

import type { A2ACardVerdict, VerifiedA2ACard } from './card-verify.js'

export type CardOperation = 'create' | 'update' | 'delete'

/** A repository revision: a TID (13 base32-sortable characters), compared as a string. */
const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/

export function isRepoRev(value: unknown): value is string {
  return typeof value === 'string' && TID_RE.test(value)
}

/**
 * The event's identity beyond its revision: sha256 over the operation, the
 * CID and the record (RFC 8785 when the record has a canonical form, its
 * JSON as received otherwise). Two deliveries of one commit hash equal; a
 * different operation or payload at one revision does not.
 */
export function a2aEventHash(operation: CardOperation, cid: string | null, record: unknown): string {
  let body = ''
  if (record !== undefined && record !== null) {
    try {
      body = canonicalize(record as JsonValue)
    } catch {
      body = JSON.stringify(record)
    }
  }
  return createHash('sha256').update(`${operation}\n${cid ?? ''}\n${body}`, 'utf8').digest('hex')
}

/** What the decision reads of the row. */
export interface CardRowState {
  presence: 'present' | 'deleted'
  repoRev: string
  lastOperation: CardOperation
  lastEventHash: string
  provedGeneration: number
}

export interface CardEvent {
  operation: CardOperation
  rev: string
  eventHash: string
  observedGapGeneration: number
}

export type EventOrder = 'newer' | 'stale' | 'replay' | 'conflict'

export function orderEvent(row: CardRowState | null, event: CardEvent): EventOrder {
  if (row === null || event.rev > row.repoRev) return 'newer'
  if (event.rev < row.repoRev) return 'stale'
  return event.operation === row.lastOperation && event.eventHash === row.lastEventHash ? 'replay' : 'conflict'
}

export type CardTransition =
  | { kind: 'none'; outcome: 'stale' | 'replay' }
  | { kind: 'conflict' }
  | { kind: 'tombstone' }
  | { kind: 'upsert'; card: VerifiedA2ACard; provedGeneration: number }
  | { kind: 'suppress'; reason: string; provedGeneration: number }

/**
 * A withheld record checked again once the DID document changed (design
 * §8.3: an identity event, or the daily check for missed ones, re-verifies
 * the stored card), which now verifies: it is served as it would have been
 * had the document named its keys when it arrived. Like any event, it proves
 * the current gap generation only if it was observed under it; otherwise the
 * row keeps the generation it was last proved under.
 */
export function decideReinstatement(
  row: CardRowState,
  event: CardEvent,
  card: VerifiedA2ACard,
  gapGeneration: number,
): Extract<CardTransition, { kind: 'upsert' }> {
  const proves = event.observedGapGeneration === gapGeneration
  return { kind: 'upsert', card, provedGeneration: proves ? gapGeneration : row.provedGeneration }
}

/**
 * The transition for an event already ordered. `verdict` is the record's
 * check (§8.3), needed only for a newer create or update; pass null for a
 * delete or for an event that is not newer.
 */
export function decideTransition(
  row: CardRowState | null,
  event: CardEvent,
  verdict: A2ACardVerdict | null,
  gapGeneration: number,
): CardTransition {
  const order = orderEvent(row, event)
  if (order === 'stale' || order === 'replay') return { kind: 'none', outcome: order }
  if (order === 'conflict') return { kind: 'conflict' }
  if (event.operation === 'delete') return { kind: 'tombstone' }
  // Without proof the row keeps the generation it was last proved under (a
  // new row, the one it was observed under): either lags the current one.
  const unproved = row?.provedGeneration ?? event.observedGapGeneration
  if (verdict === null) throw new Error('a2a: a newer create or update needs its verdict')
  if (!verdict.ok) return { kind: 'suppress', reason: verdict.reason, provedGeneration: unproved }
  const proves = event.observedGapGeneration === gapGeneration
  return { kind: 'upsert', card: verdict.card, provedGeneration: proves ? gapGeneration : unproved }
}
