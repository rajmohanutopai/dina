/**
 * Unit tests for `appview/src/scorer/algorithms/friend-boost.ts`
 * (TN-SCORE-003 / Plan §7 line 885).
 *
 * Pure-function coverage: every documented contract gets at least
 * one positive + one negative case. The specific shape of `friend_
 * boost = FRIEND_BOOST if any 1-hop reviewer overlaps, else 1.0`
 * is pinned hard so a future refactor (e.g. switching to a per-
 * overlap multiplier or adding 2-hop weighting) can't silently
 * change the search ranking semantics.
 */

import { describe, expect, it } from 'vitest'

import { friendBoostFor } from '@/scorer/algorithms/friend-boost'

describe('friendBoostFor — TN-SCORE-003 / Plan §7', () => {
  it('returns FRIEND_BOOST when any reviewer is in the viewer\'s 1-hop graph', () => {
    const result = friendBoostFor({
      viewerOneHopDids: ['did:plc:friend_a', 'did:plc:friend_b'],
      subjectReviewerDids: ['did:plc:stranger', 'did:plc:friend_b'],
      friendBoost: 1.5,
    })
    expect(result).toBe(1.5)
  })

  it('returns 1.0 when no overlap', () => {
    const result = friendBoostFor({
      viewerOneHopDids: ['did:plc:friend_a', 'did:plc:friend_b'],
      subjectReviewerDids: ['did:plc:stranger_x', 'did:plc:stranger_y'],
      friendBoost: 1.5,
    })
    expect(result).toBe(1.0)
  })

  it('empty viewer graph → 1.0 (no possible overlap)', () => {
    // A new viewer with no contacts cannot have any friend-reviewers.
    // Critical edge case: must NOT return friendBoost — falsely
    // surfacing crowd-favoured subjects above relevance.
    const result = friendBoostFor({
      viewerOneHopDids: [],
      subjectReviewerDids: ['did:plc:r1', 'did:plc:r2'],
      friendBoost: 1.5,
    })
    expect(result).toBe(1.0)
  })

  it('empty reviewer set → 1.0 (no possible overlap)', () => {
    // A subject with no reviewers can't have any friends in its
    // reviewer set. The unboosted baseline is correct.
    const result = friendBoostFor({
      viewerOneHopDids: ['did:plc:friend_a'],
      subjectReviewerDids: [],
      friendBoost: 1.5,
    })
    expect(result).toBe(1.0)
  })

  it('both empty → 1.0', () => {
    const result = friendBoostFor({
      viewerOneHopDids: [],
      subjectReviewerDids: [],
      friendBoost: 1.5,
    })
    expect(result).toBe(1.0)
  })

  it('multiple friends in reviewer set → still single boost (flag, not multiplier)', () => {
    // Plan §7 wording: `= 1.5 if ANY 1-hop reviewer...` — this is
    // a flag, not a per-overlap multiplier. Stacking would let a
    // heavily-networked viewer push crowd-favoured subjects above
    // their actual ranking, defeating the sort-by-relevance
    // contract. Regression-pinned by this test.
    const result = friendBoostFor({
      viewerOneHopDids: [
        'did:plc:friend_a',
        'did:plc:friend_b',
        'did:plc:friend_c',
      ],
      subjectReviewerDids: [
        'did:plc:friend_a',
        'did:plc:friend_b',
        'did:plc:friend_c',
        'did:plc:friend_d', // also a friend (4 of 4 reviewers are friends)
      ],
      friendBoost: 1.5,
    })
    // Even when ALL reviewers are friends, boost is the single
    // value, not 1.5^4 or 4×1.5.
    expect(result).toBe(1.5)
  })

  it('respects operator-tuned FRIEND_BOOST (not hardcoded 1.5)', () => {
    // The boost value comes from `trust_v1_params.FRIEND_BOOST`
    // via TN-SCORE-009; an operator who lowered it to 1.2 (e.g.
    // soak-week tuning) must see that value reflected. Regression
    // guard against a future inlined `1.5` constant.
    const result = friendBoostFor({
      viewerOneHopDids: ['did:plc:friend'],
      subjectReviewerDids: ['did:plc:friend'],
      friendBoost: 1.2,
    })
    expect(result).toBe(1.2)
  })

  it('handles Set inputs (not just Array)', () => {
    // Documented contract: `Iterable<string>` accepts Sets too.
    // Real callers may pass Sets directly (e.g. cached graph
    // contexts) — pinning the iterable contract.
    const viewerSet = new Set(['did:plc:a', 'did:plc:b'])
    const reviewerSet = new Set(['did:plc:b', 'did:plc:c'])
    const result = friendBoostFor({
      viewerOneHopDids: viewerSet,
      subjectReviewerDids: reviewerSet,
      friendBoost: 1.5,
    })
    expect(result).toBe(1.5)
  })

  it('handles generator inputs (lazy iterable)', () => {
    // Some callers may stream DIDs lazily. The helper must
    // accept any Iterable.
    function* viewer() {
      yield 'did:plc:a'
      yield 'did:plc:b'
    }
    function* reviewers() {
      yield 'did:plc:c'
      yield 'did:plc:b' // overlap on second yield
      yield 'did:plc:d'
    }
    const result = friendBoostFor({
      viewerOneHopDids: viewer(),
      subjectReviewerDids: reviewers(),
      friendBoost: 1.5,
    })
    expect(result).toBe(1.5)
  })

  it('case-sensitive DID match (DIDs are case-sensitive per W3C)', () => {
    // DIDs use base58/base32 alphabets; case-folding would let a
    // DID `did:plc:Abc` falsely match `did:plc:abc`. The plan
    // implicitly requires exact-string match — pinned here.
    const result = friendBoostFor({
      viewerOneHopDids: ['did:plc:abc'],
      subjectReviewerDids: ['did:plc:ABC'],
      friendBoost: 1.5,
    })
    expect(result).toBe(1.0)
  })

  it('deterministic: same input → same output', () => {
    // The helper's purity is the whole point — the search ranker
    // calls it once per subject in a result page, hundreds of
    // times per request. Same inputs must always yield same
    // outputs (no global state, no Math.random, etc.).
    const inputs = {
      viewerOneHopDids: ['did:plc:a'],
      subjectReviewerDids: ['did:plc:a'],
      friendBoost: 1.5,
    }
    expect(friendBoostFor(inputs)).toBe(1.5)
    expect(friendBoostFor(inputs)).toBe(1.5)
    expect(friendBoostFor(inputs)).toBe(1.5)
  })

  it('does not mutate input iterables', () => {
    // Set / Array inputs must survive the call unchanged.
    const viewer = ['did:plc:a', 'did:plc:b']
    const reviewers = ['did:plc:b']
    const viewerCopy = [...viewer]
    const reviewersCopy = [...reviewers]
    friendBoostFor({
      viewerOneHopDids: viewer,
      subjectReviewerDids: reviewers,
      friendBoost: 1.5,
    })
    expect(viewer).toEqual(viewerCopy)
    expect(reviewers).toEqual(reviewersCopy)
  })

  it('large-input correctness (1000-element overlap)', () => {
    // Stress: typical hot-subject reviewer set is ~hundreds; well-
    // connected viewer ~tens. Pin correctness at 1000+ to ensure
    // the Set-based lookup actually finds the overlap (not just
    // that a small-input test passes by coincidence).
    const viewer = Array.from({ length: 50 }, (_, i) => `did:plc:friend_${i}`)
    const reviewers = Array.from(
      { length: 1000 },
      (_, i) => `did:plc:reviewer_${i}`,
    )
    // No overlap → 1.0
    expect(
      friendBoostFor({
        viewerOneHopDids: viewer,
        subjectReviewerDids: reviewers,
        friendBoost: 1.5,
      }),
    ).toBe(1.0)
    // Inject one match → 1.5
    reviewers[500] = 'did:plc:friend_25'
    expect(
      friendBoostFor({
        viewerOneHopDids: viewer,
        subjectReviewerDids: reviewers,
        friendBoost: 1.5,
      }),
    ).toBe(1.5)
  })
})
