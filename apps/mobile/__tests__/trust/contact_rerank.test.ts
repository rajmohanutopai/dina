/**
 * Unit tests for `apps/mobile/src/trust/contact_rerank.ts`
 * (mobile-side complement to TN-TEST-080's server-side friend-boost).
 *
 * Pure-function coverage. Pins:
 *   - `annotateReviewRing` flips stranger → contact when DID matches,
 *     leaves self / fof unchanged regardless of the contact set.
 *   - `compareCards` buckets any-contact above no-contact; within
 *     each bucket the V1 review-count / title tiebreak is preserved.
 *
 * The full integration with the search runner (`use_trust_search.ts`)
 * is implicitly covered by `subject_card`'s existing `friendsPill`
 * derivation — flipping a review's ring to `'contact'` makes the pill
 * surface; this file pins the upstream flip + sort logic in isolation.
 */

import { describe, expect, it } from '@jest/globals';

import {
  annotateReviewRing,
  compareCards,
  rerankByContacts,
  type RerankableCard,
} from '../../src/trust/contact_rerank';
import type { SubjectCardDisplay } from '../../src/trust/subject_card';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a minimal `SubjectCardDisplay` for sort-comparator tests.
 * Only the fields `compareCards` reads (friendsPill, reviewCount,
 * title) are populated; the rest take harmless defaults that match
 * the existing display shape so a future refactor surfacing them
 * doesn't have to touch this file.
 */
function makeCard(
  subjectId: string,
  opts: {
    title?: string;
    reviewCount?: number;
    friendsCount?: number;
  } = {},
): RerankableCard {
  const title = opts.title ?? `Subject ${subjectId}`;
  const reviewCount = opts.reviewCount ?? 1;
  const friendsCount = opts.friendsCount ?? 0;
  const display: SubjectCardDisplay = {
    title,
    subtitle: null,
    score: { score: null, band: 'unrated', label: '—' },
    showNumericScore: false,
    reviewCount,
    friendsPill:
      friendsCount > 0
        ? { friendsCount, strangersCount: Math.max(0, reviewCount - friendsCount) }
        : null,
    topReviewer: null,
    host: null,
    language: null,
    location: null,
    priceTier: null,
    recency: null,
    regionPill: null,
  };
  return { subjectId, display };
}

// ─── annotateReviewRing ────────────────────────────────────────────────────
describe('annotateReviewRing', () => {
  it('flips stranger → contact when reviewerDid is in the contact set', () => {
    const contacts = new Set(['did:plc:alonso', 'did:plc:sancho']);
    const ring = annotateReviewRing('did:plc:alonso', contacts, 'stranger');
    expect(ring).toBe('contact');
  });

  it('keeps stranger when reviewerDid is NOT in the contact set', () => {
    const contacts = new Set(['did:plc:alonso']);
    const ring = annotateReviewRing('did:plc:nobody', contacts, 'stranger');
    expect(ring).toBe('stranger');
  });

  it('keeps stranger when contact set is empty', () => {
    const ring = annotateReviewRing('did:plc:anyone', new Set<string>(), 'stranger');
    expect(ring).toBe('stranger');
  });

  it('keeps stranger when reviewerDid is null (anonymous review)', () => {
    const contacts = new Set(['did:plc:alonso']);
    const ring = annotateReviewRing(null, contacts, 'stranger');
    expect(ring).toBe('stranger');
  });

  it('does NOT downgrade self → contact even when self DID is in the set', () => {
    // Belt-and-braces: the runner is supposed to exclude the viewer's
    // own DID from `contactDids`, but if a future regression seeds
    // it accidentally, the self ring must survive — Dina never
    // simulates intimacy by labelling the user as their own friend.
    const contacts = new Set(['did:plc:viewer']);
    const ring = annotateReviewRing('did:plc:viewer', contacts, 'self');
    expect(ring).toBe('self');
  });

  it('does NOT downgrade fof → contact even when fof DID is in the set', () => {
    // The fof ring carries 2-hop semantics the contact directory
    // can't override — fof is a stronger signal than "stranger" but
    // weaker than "contact". Keep it as-is.
    const contacts = new Set(['did:plc:friend-of-friend']);
    const ring = annotateReviewRing('did:plc:friend-of-friend', contacts, 'fof');
    expect(ring).toBe('fof');
  });

  it('is case-sensitive on DID match (DIDs are byte-exact identifiers)', () => {
    const contacts = new Set(['did:plc:Alonso']);
    const ring = annotateReviewRing('did:plc:alonso', contacts, 'stranger');
    expect(ring).toBe('stranger');
  });
});

// ─── compareCards ──────────────────────────────────────────────────────────
describe('compareCards', () => {
  it('any-contact card sorts BEFORE no-contact card (boost is a flag)', () => {
    const withContact = makeCard('s1', { reviewCount: 1, friendsCount: 1 });
    const withoutContact = makeCard('s2', { reviewCount: 5, friendsCount: 0 });
    // Contact card has FEWER reviews — but the friend signal still
    // wins. Pin against a regression that orders by review count
    // first (the V1 baseline before this work).
    expect(compareCards(withContact, withoutContact)).toBeLessThan(0);
    expect(compareCards(withoutContact, withContact)).toBeGreaterThan(0);
  });

  it('within the contact bucket, falls back to review-count DESC', () => {
    const fewReviews = makeCard('s1', { reviewCount: 2, friendsCount: 1 });
    const manyReviews = makeCard('s2', { reviewCount: 10, friendsCount: 1 });
    expect(compareCards(manyReviews, fewReviews)).toBeLessThan(0);
  });

  it('within the stranger bucket, falls back to review-count DESC', () => {
    const fewReviews = makeCard('s1', { reviewCount: 2, friendsCount: 0 });
    const manyReviews = makeCard('s2', { reviewCount: 10, friendsCount: 0 });
    expect(compareCards(manyReviews, fewReviews)).toBeLessThan(0);
  });

  it('within a bucket on review-count tie, sorts alphabetically by title (asc)', () => {
    const apple = makeCard('s1', { title: 'Apple', reviewCount: 3, friendsCount: 0 });
    const banana = makeCard('s2', { title: 'Banana', reviewCount: 3, friendsCount: 0 });
    expect(compareCards(apple, banana)).toBeLessThan(0);
  });

  it('flag is binary: 1 contact == many contacts at the bucket level', () => {
    const oneContact = makeCard('s1', { reviewCount: 1, friendsCount: 1 });
    const manyContacts = makeCard('s2', { reviewCount: 1, friendsCount: 5 });
    // Both are in the SAME bucket. The tiebreak then drops to review
    // count (tied) → title (alphabetical). Pin against a regression
    // that introduces a per-overlap multiplier where 5 contacts
    // beats 1 — would let well-networked viewers push crowd-favoured
    // subjects above relevance.
    expect(compareCards(oneContact, manyContacts)).toBeLessThan(0); // s1 < s2 by title
  });

  it('handles a card with friendsCount=0 explicitly null pill same as no pill', () => {
    // Defensive: `friendsPill: null` and `friendsPill: { friendsCount: 0 }`
    // should be equivalent. The helper drops to the `?? 0` branch.
    const noFriendField = makeCard('s1', { reviewCount: 1, friendsCount: 0 });
    expect(noFriendField.display.friendsPill).toBeNull();
    const withFriend = makeCard('s2', { reviewCount: 1, friendsCount: 1 });
    expect(compareCards(withFriend, noFriendField)).toBeLessThan(0);
  });
});

// ─── rerankByContacts ──────────────────────────────────────────────────────
describe('rerankByContacts', () => {
  it('returns input identity for empty array (allows useMemo keying)', () => {
    const empty: ReadonlyArray<RerankableCard> = [];
    expect(rerankByContacts(empty)).toBe(empty);
  });

  it('promotes any-contact cards above no-contact cards (mixed input)', () => {
    const stranger10 = makeCard('s1', { title: 'Stranger10', reviewCount: 10, friendsCount: 0 });
    const stranger5 = makeCard('s2', { title: 'Stranger5', reviewCount: 5, friendsCount: 0 });
    const contact1 = makeCard('s3', { title: 'Contact1', reviewCount: 1, friendsCount: 1 });
    const contact3 = makeCard('s4', { title: 'Contact3', reviewCount: 3, friendsCount: 1 });
    const result = rerankByContacts([stranger10, contact1, stranger5, contact3]);
    expect(result.map((c) => c.subjectId)).toEqual(['s4', 's3', 's1', 's2']);
    // Contact cards on top (by review count desc within bucket: 3 > 1),
    // strangers below (10 > 5 within bucket).
  });

  it('does not mutate the input array', () => {
    const input: ReadonlyArray<RerankableCard> = [
      makeCard('s1', { reviewCount: 5, friendsCount: 0 }),
      makeCard('s2', { reviewCount: 1, friendsCount: 1 }),
    ];
    const inputIdsBefore = input.map((c) => c.subjectId);
    rerankByContacts(input);
    const inputIdsAfter = input.map((c) => c.subjectId);
    expect(inputIdsAfter).toEqual(inputIdsBefore);
  });

  it('all-contact input preserves V1 tiebreak (review count desc, then title)', () => {
    const a = makeCard('s1', { title: 'Aaa', reviewCount: 3, friendsCount: 1 });
    const b = makeCard('s2', { title: 'Bbb', reviewCount: 3, friendsCount: 1 });
    const c = makeCard('s3', { title: 'Ccc', reviewCount: 5, friendsCount: 1 });
    const result = rerankByContacts([a, b, c]);
    expect(result.map((r) => r.subjectId)).toEqual(['s3', 's1', 's2']);
  });

  it('no-contact input collapses to V1 baseline ordering', () => {
    const a = makeCard('s1', { title: 'Aaa', reviewCount: 3, friendsCount: 0 });
    const b = makeCard('s2', { title: 'Bbb', reviewCount: 5, friendsCount: 0 });
    const c = makeCard('s3', { title: 'Ccc', reviewCount: 5, friendsCount: 0 });
    const result = rerankByContacts([a, b, c]);
    expect(result.map((r) => r.subjectId)).toEqual(['s2', 's3', 's1']);
  });
});
