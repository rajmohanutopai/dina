/**
 * What a card event does to the directory row (design §8.3): the revision
 * is the one ordering token; equal revisions replay or conflict, never race;
 * a newer invalid record suppresses an older valid one; proof of presence
 * needs the current gap generation at receipt.
 */

import { describe, expect, it } from 'vitest'

import type { A2ACardVerdict, VerifiedA2ACard } from '@/shared/a2a/card-verify.js'
import {
  a2aEventHash,
  decideReinstatement,
  decideTransition,
  isRepoRev,
  orderEvent,
  type CardEvent,
  type CardRowState,
} from '@/shared/a2a/directory-decide.js'

import { revOf } from '../a2a-fixture.js'

const CARD = { cardHash: 'h' } as unknown as VerifiedA2ACard
const VALID: A2ACardVerdict = { ok: true, card: CARD }
const INVALID: A2ACardVerdict = { ok: false, reason: 'card_signature' }

const row = (over: Partial<CardRowState> = {}): CardRowState => ({
  presence: 'present',
  repoRev: revOf(10),
  lastOperation: 'create',
  lastEventHash: 'e10',
  provedGeneration: 0,
  ...over,
})
const ev = (over: Partial<CardEvent> = {}): CardEvent => ({
  operation: 'update',
  rev: revOf(11),
  eventHash: 'e11',
  observedGapGeneration: 0,
  ...over,
})

describe('the revision orders everything', () => {
  it('older is stale, newer is newer, and no row means newer', () => {
    expect(orderEvent(row(), ev({ rev: revOf(9) }))).toBe('stale')
    expect(orderEvent(row(), ev({ rev: revOf(11) }))).toBe('newer')
    expect(orderEvent(null, ev({ rev: revOf(1) }))).toBe('newer')
  })

  it('equal: the same operation and hash replay; anything else conflicts', () => {
    expect(orderEvent(row(), ev({ rev: revOf(10), operation: 'create', eventHash: 'e10' }))).toBe('replay')
    expect(orderEvent(row(), ev({ rev: revOf(10), operation: 'update', eventHash: 'e10' }))).toBe('conflict')
    expect(orderEvent(row(), ev({ rev: revOf(10), operation: 'create', eventHash: 'other' }))).toBe('conflict')
    expect(orderEvent(row(), ev({ rev: revOf(10), operation: 'delete', eventHash: 'd' }))).toBe('conflict')
  })

  it('revisions compare as TIDs: their string order is their time order', () => {
    for (let i = 0; i < 2000; i += 37) expect(revOf(i) < revOf(i + 1)).toBe(true)
    expect(isRepoRev(revOf(5))).toBe(true)
    for (const bad of ['', 'abc', `${revOf(5)}x`, '1aaaaaaaaaaaa', 'zzzzzzzzzzzzz', 3]) expect(isRepoRev(bad)).toBe(false)
  })
})

describe('transitions', () => {
  it('stale and replayed events change nothing (a delayed update, a tombstone resurrection attempt)', () => {
    expect(decideTransition(row(), ev({ rev: revOf(9) }), null, 0)).toEqual({ kind: 'none', outcome: 'stale' })
    // A create older than the delete that tombstoned the row.
    const tomb = row({ presence: 'deleted', lastOperation: 'delete', lastEventHash: 'd' })
    expect(decideTransition(tomb, ev({ operation: 'create', rev: revOf(9) }), null, 0)).toEqual({ kind: 'none', outcome: 'stale' })
    expect(decideTransition(row(), ev({ rev: revOf(10), operation: 'create', eventHash: 'e10' }), null, 0)).toEqual({
      kind: 'none',
      outcome: 'replay',
    })
  })

  it('an equal-revision conflict, whatever arrives first', () => {
    expect(decideTransition(row(), ev({ rev: revOf(10), operation: 'delete', eventHash: 'd' }), null, 0)).toEqual({ kind: 'conflict' })
    const deleted = row({ lastOperation: 'delete', lastEventHash: 'd', presence: 'deleted' })
    expect(decideTransition(deleted, ev({ rev: revOf(10), operation: 'update', eventHash: 'e10' }), null, 0)).toEqual({ kind: 'conflict' })
  })

  it('a newer delete tombstones, with no verdict needed (a delete carries no CID)', () => {
    expect(decideTransition(row(), ev({ operation: 'delete' }), null, 0)).toEqual({ kind: 'tombstone' })
    expect(decideTransition(null, ev({ operation: 'delete' }), null, 0)).toEqual({ kind: 'tombstone' })
  })

  it('a newer valid record replaces; a newer invalid one suppresses', () => {
    expect(decideTransition(row(), ev(), VALID, 0)).toEqual({ kind: 'upsert', card: CARD, provedGeneration: 0 })
    expect(decideTransition(row(), ev(), INVALID, 0)).toEqual({ kind: 'suppress', reason: 'card_signature', provedGeneration: 0 })
    expect(() => decideTransition(row(), ev(), null, 0)).toThrow()
  })

  it('proof needs the current generation at receipt; without it the row keeps the proof it had', () => {
    // Received under the current generation: proves.
    expect(decideTransition(row({ provedGeneration: 1 }), ev({ observedGapGeneration: 2 }), VALID, 2)).toEqual(
      expect.objectContaining({ kind: 'upsert', provedGeneration: 2 }),
    )
    // Received before the gap was declared, processed after: applies, proves nothing.
    expect(decideTransition(row({ provedGeneration: 1 }), ev({ observedGapGeneration: 1 }), VALID, 2)).toEqual(
      expect.objectContaining({ kind: 'upsert', provedGeneration: 1 }),
    )
    // A new row from a pre-gap event lags at the generation it was observed under.
    expect(decideTransition(null, ev({ observedGapGeneration: 1 }), VALID, 2)).toEqual(
      expect.objectContaining({ kind: 'upsert', provedGeneration: 1 }),
    )
  })
})

describe('a2aEventHash', () => {
  it('equal for two deliveries of one commit, different for another operation, CID or record', () => {
    const record = { b: 2, a: 1 }
    const h = a2aEventHash('update', 'bafy1', record)
    expect(a2aEventHash('update', 'bafy1', { a: 1, b: 2 })).toBe(h)
    expect(a2aEventHash('create', 'bafy1', record)).not.toBe(h)
    expect(a2aEventHash('update', 'bafy2', record)).not.toBe(h)
    expect(a2aEventHash('update', 'bafy1', { a: 1, b: 3 })).not.toBe(h)
    expect(a2aEventHash('delete', null, null)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashes a record with no canonical form too (a __proto__ member), without throwing', () => {
    const record = JSON.parse('{"__proto__": {"x": 1}}') as unknown
    expect(a2aEventHash('update', 'bafy1', record)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('reinstatement: a withheld record that verifies once the document names its keys', () => {
  it('is served, proving the current gap generation only if it was observed under it', () => {
    const withheld = row({ repoRev: revOf(11), lastEventHash: 'e11', provedGeneration: 2 })
    expect(decideReinstatement(withheld, ev({ observedGapGeneration: 5 }), CARD, 5)).toEqual({ kind: 'upsert', card: CARD, provedGeneration: 5 })
    // Observed before a gap the directory has seen since: it keeps the generation the row had.
    expect(decideReinstatement(withheld, ev({ observedGapGeneration: 4 }), CARD, 5)).toEqual({ kind: 'upsert', card: CARD, provedGeneration: 2 })
  })
})

