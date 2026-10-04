/**
 * Gap recovery in the pure decision (design §8.3): "neither a replayed
 * pre-gap event nor a queued pre-gap event can clear the suppression".
 * A late replay of an old event arrives after the gap with the current
 * stamp; being no newer than the row, it must prove nothing.
 */

import { describe, expect, it } from 'vitest'

import type { A2ACardVerdict, VerifiedA2ACard } from '@/shared/a2a/card-verify.js'
import { decideTransition, type CardEvent, type CardRowState } from '@/shared/a2a/directory-decide.js'

import { revOf } from '../a2a-fixture.js'

const VALID: A2ACardVerdict = { ok: true, card: { cardHash: 'h' } as unknown as VerifiedA2ACard }
const GAP = 3
/** A row last proved before the gap (generation 2), so it lags the current one. */
const lagging: CardRowState = { presence: 'present', repoRev: revOf(10), lastOperation: 'update', lastEventHash: 'e10', provedGeneration: 2 }
const ev = (over: Partial<CardEvent>): CardEvent => ({ operation: 'update', rev: revOf(10), eventHash: 'e10', observedGapGeneration: GAP, ...over })

describe('a late pre-gap replay never proves a card', () => {
  // Plan F97
  it('a replay of the applied event, received after the gap, changes nothing', () => {
    expect(decideTransition(lagging, ev({}), null, GAP)).toEqual({ kind: 'none', outcome: 'replay' })
  })

  // Plan F97
  it('an older event, received after the gap, changes nothing', () => {
    expect(decideTransition(lagging, ev({ rev: revOf(9), eventHash: 'e9' }), null, GAP)).toEqual({ kind: 'none', outcome: 'stale' })
    // The verdict is not even read for it: a valid old record proves nothing either.
    expect(decideTransition(lagging, ev({ rev: revOf(9), eventHash: 'e9' }), VALID, GAP)).toEqual({ kind: 'none', outcome: 'stale' })
  })

  // Plan F97
  it('only a strictly newer valid event received under the current generation proves; one queued from before the gap does not', () => {
    expect(decideTransition(lagging, ev({ rev: revOf(11), eventHash: 'e11' }), VALID, GAP)).toEqual(
      expect.objectContaining({ kind: 'upsert', provedGeneration: GAP }),
    )
    expect(decideTransition(lagging, ev({ rev: revOf(11), eventHash: 'e11', observedGapGeneration: GAP - 1 }), VALID, GAP)).toEqual(
      expect.objectContaining({ kind: 'upsert', provedGeneration: 2 }),
    )
  })
})
