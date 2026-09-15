/**
 * D4 — per-market review feeds, and the line they must never cross.
 *
 * The cold-start problem is real: a new market has an empty trust graph, so
 * "rank by trust, not by ad spend" has nothing to rank by. The fix that looks
 * obvious — import a corpus and let the scorer treat it as reviews — builds
 * the Dead Internet on purpose, so the rule is that an imported review moves
 * a RATING and never a TRUST RING.
 *
 * These pin both halves: who is allowed to publish an import at all, and what
 * an admitted one is and is not allowed to move.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { CONSTANTS } from '@/config/constants.js'
import {
  refuseImportedReview,
  registeredReviewFeeds,
  reviewFeed,
  setReviewFeedRegistry,
} from '@/config/review-feeds.js'
import { validateRecord } from '@/ingester/record-validator.js'
import {
  aggregateSubjectSentiment,
  type AttestationForAggregation,
} from '@/scorer/algorithms/sentiment-aggregation.js'

const FEED = {
  id: 'in.example-reviews',
  publisherDid: 'did:plc:feedpublisher',
  market: 'IN',
  name: 'Example Reviews India',
  licence: 'agreement-2026-04',
  homepage: 'https://reviews.example/in',
}

const SOURCE = {
  feed: FEED.id,
  market: 'IN',
  url: 'https://reviews.example/in/chairmaker/9912',
  observedAt: '2026-09-01T00:00:00.000Z',
}

beforeEach(() => {
  setReviewFeedRegistry([])
})

describe('the registry ships empty, and that is the correct posture', () => {
  it('admits nothing until an operator has read a feed’s terms', () => {
    expect(registeredReviewFeeds()).toEqual([])
    expect(reviewFeed(FEED.id)).toBeNull()
    expect(refuseImportedReview({ source: SOURCE, repoDid: FEED.publisherDid })).toBe(
      'feed_not_registered',
    )
  })

  it('a registered feed admits its own publisher', () => {
    setReviewFeedRegistry([FEED])
    expect(refuseImportedReview({ source: SOURCE, repoDid: FEED.publisherDid })).toBeNull()
  })
})

describe('who may say "imported from"', () => {
  beforeEach(() => setReviewFeedRegistry([FEED]))

  it('refuses a repo that is not the feed’s publisher — the lie this check exists for', () => {
    // Without it, any node could stamp a feed's name on its own opinion and
    // have Dina's own chrome credit the source for it.
    expect(refuseImportedReview({ source: SOURCE, repoDid: 'did:plc:someoneelse' })).toBe(
      'not_the_feed_publisher',
    )
  })

  it('refuses a market the feed does not serve', () => {
    expect(
      refuseImportedReview({
        source: { ...SOURCE, market: 'US' },
        repoDid: FEED.publisherDid,
      }),
    ).toBe('market_not_served')
  })

  it('refuses a deep link that is not https — the credit must be followable', () => {
    for (const url of ['http://reviews.example/x', 'javascript:alert(1)', 'reviews.example/x']) {
      expect(
        refuseImportedReview({ source: { ...SOURCE, url }, repoDid: FEED.publisherDid }),
      ).toBe('source_url_not_https')
    }
  })

  it('a feed removed from the registry stops admitting, immediately', () => {
    setReviewFeedRegistry([])
    expect(refuseImportedReview({ source: SOURCE, repoDid: FEED.publisherDid })).toBe(
      'feed_not_registered',
    )
  })
})

describe('the source block’s shape, before any question of agreements', () => {
  const record = {
    subject: { type: 'did', did: 'did:plc:chairmaker' },
    category: 'furniture',
    sentiment: 'positive',
    createdAt: '2026-09-01T00:00:00.000Z',
  }

  function validate(source: unknown) {
    return validateRecord('com.dinakernel.peerlens.attestation', { ...record, source })
  }

  it('accepts a well-formed one', () => {
    expect(validate(SOURCE).success).toBe(true)
  })

  it('a record with NO source is a peer’s own review and validates unchanged', () => {
    expect(validateRecord('com.dinakernel.peerlens.attestation', record).success).toBe(true)
  })

  it('refuses a deep link that is not https at the schema, before the gate ever sees it', () => {
    expect(validate({ ...SOURCE, url: 'http://reviews.example/x' }).success).toBe(false)
    expect(validate({ ...SOURCE, url: 'javascript:alert(1)' }).success).toBe(false)
  })

  it('refuses a market that is not an ISO-3166-1 alpha-2 code', () => {
    for (const market of ['india', 'in', 'IND', '']) {
      expect(validate({ ...SOURCE, market }).success).toBe(false)
    }
  })

  it('refuses a feed id outside the lowercase dotted vocabulary', () => {
    for (const feed of ['IN.Example', 'in example', '', '../etc', 'x'.repeat(65)]) {
      expect(validate({ ...SOURCE, feed }).success).toBe(false)
    }
  })

  it('refuses a source that is not an object of those four fields', () => {
    expect(validate('in.example-reviews').success).toBe(false)
    expect(validate({ feed: FEED.id }).success).toBe(false)
  })
})

describe('what an admitted import may move, and what it may not', () => {
  const base = {
    sentiment: 'positive',
    recordCreatedAt: new Date(),
    evidenceJson: null,
    hasCosignature: false,
    isVerified: false,
    authorTrustScore: null,
    authorHasInboundVouch: false,
    category: 'furniture',
  }

  function imported(over: Partial<AttestationForAggregation> = {}): AttestationForAggregation {
    return { ...base, sourceFeed: FEED.id, ...over }
  }

  function peer(over: Partial<AttestationForAggregation> = {}): AttestationForAggregation {
    return { ...base, sourceFeed: null, authorTrustScore: 0.8, authorHasInboundVouch: true, ...over }
  }

  it('counts imports apart from testimony', () => {
    const result = aggregateSubjectSentiment([imported(), imported(), peer()])
    expect(result.total).toBe(3)
    expect(result.importedCount).toBe(2)
    expect(result.peerCount).toBe(1)
  })

  it('moves the rating — a market with only imports is not unrated', () => {
    const result = aggregateSubjectSentiment([imported(), imported(), imported()])
    // Three positive imports read as positive, which is the cold start
    // working: something to rank by where there was nothing.
    expect(result.weightedScore).toBeGreaterThan(0.9)
  })

  it('does NOT move confidence — a rating with nobody behind it says so', () => {
    const manyImports = Array.from({ length: 120 }, () => imported())
    const result = aggregateSubjectSentiment(manyImports)
    // 120 reviews would be the top confidence band if they were testimony.
    expect(result.confidence).toBe(0.2)
    const withPeers = aggregateSubjectSentiment([...manyImports, peer(), peer(), peer()])
    expect(withPeers.confidence).toBe(0.4)
  })

  it('carries a FIXED weight, never the publisher’s trust', () => {
    // A feed publisher that got itself vouched must not thereby speak with a
    // peer's authority. Two imports whose publisher looks maximally trusted
    // weigh exactly as much as two whose publisher looks like nobody.
    const anonymous = aggregateSubjectSentiment([imported(), imported({ sentiment: 'negative' })])
    const vouched = aggregateSubjectSentiment([
      imported({ authorTrustScore: 1, authorHasInboundVouch: true }),
      imported({ sentiment: 'negative', authorTrustScore: 1, authorHasInboundVouch: true }),
    ])
    expect(vouched.weightedScore).toBeCloseTo(anonymous.weightedScore, 10)
    expect(CONSTANTS.IMPORTED_REVIEW_WEIGHT).toBeLessThan(1)
  })

  it('a CORPUS of imports cannot bury testimony — their combined mass is capped', () => {
    // Five hundred glowing imports against six people who actually dealt
    // with the supplier and were unhappy. Without the ceiling the corpus
    // wins by volume, and a rating nobody's testimony can move is the Dead
    // Internet with a citation attached.
    const corpus = Array.from({ length: 500 }, () => imported())
    const unhappy = Array.from({ length: 6 }, () => peer({ sentiment: 'negative' }))
    const result = aggregateSubjectSentiment([...corpus, ...unhappy])
    expect(result.weightedScore).toBeLessThan(0.5)
    // And the count still tells the truth about how many there were.
    expect(result.importedCount).toBe(500)
    expect(result.peerCount).toBe(6)
  })

  it('the cap SCALES rather than truncating, so row order never changes the answer', () => {
    const mixed = [
      ...Array.from({ length: 60 }, () => imported()),
      ...Array.from({ length: 40 }, () => imported({ sentiment: 'negative' })),
    ]
    const forward = aggregateSubjectSentiment(mixed)
    const reversed = aggregateSubjectSentiment([...mixed].reverse())
    expect(forward.weightedScore).toBeCloseTo(reversed.weightedScore, 10)
    // 60 positive of 100 survives the scaling as 0.6, not as whichever
    // twenty happened to come back first.
    expect(forward.weightedScore).toBeCloseTo(0.6, 2)
  })

  it('a handful of imports is under the ceiling and passes through untouched', () => {
    const few = aggregateSubjectSentiment([imported(), imported(), imported({ sentiment: 'negative' })])
    expect(few.weightedScore).toBeCloseTo(2 / 3, 2)
  })

  it('never collects the multipliers that measure testimony', () => {
    // A feed has no counterparty to cosign with and nobody can confirm
    // somebody else's star rating, so a row carrying those flags is either a
    // bug or an attempt; either way the weight does not change.
    const plain = aggregateSubjectSentiment([imported(), imported({ sentiment: 'negative' })])
    const dressedUp = aggregateSubjectSentiment([
      imported({ isVerified: true, hasCosignature: true }),
      imported({ sentiment: 'negative', isVerified: true, hasCosignature: true }),
    ])
    expect(dressedUp.weightedScore).toBeCloseTo(plain.weightedScore, 10)
    // And it never counts as a verified review on the surface.
    expect(dressedUp.verifiedCount).toBe(0)
  })

  it('a peer review still collects them', () => {
    const plain = aggregateSubjectSentiment([peer()])
    const verified = aggregateSubjectSentiment([peer({ isVerified: true })])
    expect(verified.verifiedCount).toBe(1)
    expect(plain.verifiedCount).toBe(0)
  })
})
