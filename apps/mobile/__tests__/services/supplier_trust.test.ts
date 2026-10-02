/**
 * Which suppliers PeerLens sets aside before a tender is sent: the owner's
 * own newest review decides alone (one review is enough); otherwise a low
 * score counts only over three or more reviews.
 */

import {
  loadOwnSupplierReviews,
  ownReviewsBySupplier,
  setAsideFor,
} from '../../src/services/supplier_trust';

import type { SearchAttestationHit } from '../../src/peerlens/appview_runtime';

const SUPPLIER = 'did:plc:crumbandcoo';

function hit(over: Partial<SearchAttestationHit>): SearchAttestationHit {
  return {
    uri: 'at://did:plc:owner/com.dinakernel.peerlens.attestation/1',
    authorDid: 'did:plc:owner',
    authorHandle: null,
    cid: 'cid',
    subjectId: 'subj',
    subjectRefRaw: { type: 'did', did: SUPPLIER },
    category: 'commerce',
    sentiment: 'negative',
    text: 'Stale bread',
    recordCreatedAt: '2026-09-29T10:00:00Z',
    ...over,
  };
}

describe('setAsideFor', () => {
  it("the owner's own negative review sets aside, with their words", () => {
    expect(
      setAsideFor({
        ownReview: { sentiment: 'negative', text: ' Stale bread ', createdAt: '' },
        trustScore: 0.9,
        reviewCount: 40,
      }),
    ).toEqual({
      reason: 'own_poor_review',
      words: 'You rated them poorly on PeerLens',
      note: 'Stale bread',
    });
  });

  it("the owner's own positive or neutral review is never overruled by the network", () => {
    for (const sentiment of ['positive', 'neutral'] as const) {
      expect(
        setAsideFor({
          ownReview: { sentiment, text: null, createdAt: '' },
          trustScore: 0.05,
          reviewCount: 30,
        }),
      ).toBeNull();
    }
  });

  it('a low network score needs three reviews; no score is not low trust', () => {
    expect(setAsideFor({ trustScore: 0.39, reviewCount: 3 })?.reason).toBe('low_peerlens_trust');
    expect(setAsideFor({ trustScore: 0.39, reviewCount: 2 })).toBeNull();
    expect(setAsideFor({ trustScore: 0.4, reviewCount: 50 })).toBeNull();
    expect(setAsideFor({ trustScore: null, reviewCount: 50 })).toBeNull();
    expect(setAsideFor({ trustScore: 0.1, reviewCount: null })).toBeNull();
  });
});

describe('ownReviewsBySupplier', () => {
  it('keeps the newest review per supplier DID and skips subjects without one', () => {
    const reviews = ownReviewsBySupplier([
      hit({ sentiment: 'negative', recordCreatedAt: '2026-09-01T00:00:00Z' }),
      hit({ sentiment: 'positive', text: 'Better now', recordCreatedAt: '2026-09-20T00:00:00Z' }),
      hit({ subjectRefRaw: { type: 'product', name: 'Sourdough' } }),
    ]);
    expect([...reviews.entries()]).toEqual([
      [SUPPLIER, { sentiment: 'positive', text: 'Better now', createdAt: '2026-09-20T00:00:00Z' }],
    ]);
  });
});

describe('loadOwnSupplierReviews', () => {
  it("reads the owner's reviews by author", async () => {
    const read = jest.fn(async () => ({ results: [hit({})], totalEstimate: 1 }));
    const reviews = await loadOwnSupplierReviews('did:plc:owner', read);
    expect(read).toHaveBeenCalledWith('did:plc:owner', 100);
    expect(reviews.get(SUPPLIER)?.sentiment).toBe('negative');
  });

  it('is empty with no owner DID (the browser) or when the AppView fails', async () => {
    const read = jest.fn(async () => {
      throw new Error('offline');
    });
    expect((await loadOwnSupplierReviews(null, read)).size).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect((await loadOwnSupplierReviews('did:plc:owner', read)).size).toBe(0);
  });
});
