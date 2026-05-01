/**
 * Tests for `src/trust/subject_detail_data.ts` (TN-MOB-012).
 *
 * Pure data layer — input → header bundle + 3 grouped review lists.
 * The screen layer (`app/trust/[subjectId].tsx`) renders these
 * directly; this file pins:
 *   - empty / single / many reviews edge cases
 *   - ring-grouping correctness (self+contact → friends; fof; rest → strangers)
 *   - within-group sort: trust score desc, recency desc, name asc
 *   - null-trust handling (`-Infinity` rank — never displaces rated)
 *   - subtitle derivation (matches subject_card behaviour)
 *   - showNumericScore N≥3 + non-null score discipline
 *   - ringCounts arithmetic
 *   - reviewCount clamping (negative / non-finite → 0)
 */

import { deriveSubjectCard } from '../../src/trust/subject_card';
import {
  deriveSubjectDetail,
  type SubjectDetailInput,
} from '../../src/trust/subject_detail_data';

import type { SubjectReview } from '../../src/trust/subject_card';

function makeReview(overrides: Partial<SubjectReview> = {}): SubjectReview {
  return {
    ring: 'contact',
    reviewerDid: 'did:plc:sancho',
    reviewerTrustScore: 0.7,
    reviewerName: 'Sancho',
    headline: 'Worth every penny',
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function makeInput(overrides: Partial<SubjectDetailInput> = {}): SubjectDetailInput {
  return {
    title: 'Aeron chair',
    category: 'office_furniture/chair',
    subjectTrustScore: 0.82,
    reviewCount: 5,
    reviews: [],
    ...overrides,
  };
}

describe('deriveSubjectDetail — header', () => {
  it('passes through title verbatim', () => {
    const detail = deriveSubjectDetail(makeInput({ title: 'Aeron chair' }));
    expect(detail.header.title).toBe('Aeron chair');
  });

  it('humanises category to a subtitle ("office_furniture/chair" → "Office furniture")', () => {
    const detail = deriveSubjectDetail(makeInput({ category: 'office_furniture/chair' }));
    expect(detail.header.subtitle).toBe('Office furniture');
  });

  it('subtitle is null when category is null', () => {
    const detail = deriveSubjectDetail(makeInput({ category: null }));
    expect(detail.header.subtitle).toBeNull();
  });

  it('subtitle is null when category is whitespace-only', () => {
    const detail = deriveSubjectDetail(makeInput({ category: '   ' }));
    expect(detail.header.subtitle).toBeNull();
  });

  it('showNumericScore=true at the N=3 boundary with a non-null score', () => {
    const detail = deriveSubjectDetail(
      makeInput({ subjectTrustScore: 0.7, reviewCount: 3 }),
    );
    expect(detail.header.showNumericScore).toBe(true);
  });

  it('showNumericScore=false when reviewCount < 3', () => {
    const detail = deriveSubjectDetail(
      makeInput({ subjectTrustScore: 0.95, reviewCount: 2 }),
    );
    expect(detail.header.showNumericScore).toBe(false);
  });

  it('showNumericScore=false when score is null even with N≥3', () => {
    const detail = deriveSubjectDetail(
      makeInput({ subjectTrustScore: null, reviewCount: 5 }),
    );
    expect(detail.header.showNumericScore).toBe(false);
  });

  it('reviewCount clamps to 0 for negative input', () => {
    const detail = deriveSubjectDetail(makeInput({ reviewCount: -1 }));
    expect(detail.header.reviewCount).toBe(0);
  });

  it('reviewCount clamps to 0 for NaN', () => {
    const detail = deriveSubjectDetail(makeInput({ reviewCount: NaN }));
    expect(detail.header.reviewCount).toBe(0);
  });

  it('reviewCount floors fractional values', () => {
    const detail = deriveSubjectDetail(makeInput({ reviewCount: 4.7 }));
    expect(detail.header.reviewCount).toBe(4);
  });
});

describe('subtitle parity — deriveSubjectDetail vs deriveSubjectCard', () => {
  // The subtitle derivation is duplicated across `subject_card.ts`
  // and `subject_detail_data.ts` — see the "Same subtitle derivation
  // as subject_card.ts ... deferred until a third call site" comment
  // in subject_detail_data.ts. Two implementations of the same rule
  // are an open drift surface; this suite pins the parity contract
  // so any future divergence (subtle whitespace handling, edge-case
  // null-vs-empty, capitalisation rule) fails loudly here regardless
  // of which side moved.
  //
  // Method: run both helpers on the same category input and compare
  // their `subtitle` outputs. Both surfaces feed the same
  // `SubjectCardDisplay`-like contract; they MUST agree.

  // Both helpers need their own input shape — `deriveSubjectCard`
  // takes the full SubjectCardInput, `deriveSubjectDetail` takes a
  // SubjectDetailInput. We feed them the SAME `category` field via
  // each helper's input builder.
  function pairSubtitles(category: string | null | undefined): {
    card: string | null;
    detail: string | null;
  } {
    const card = deriveSubjectCard({
      title: 'X',
      category: category as string | null | undefined,
      subjectTrustScore: 0.5,
      viewerDid: 'did:plc:viewer',
      reviewCount: 0,
      reviews: [],
    });
    const detail = deriveSubjectDetail(makeInput({ category }));
    return { card: card.subtitle, detail: detail.header.subtitle };
  }

  const PARITY_INPUTS: readonly {
    label: string;
    category: string | null | undefined;
  }[] = [
    { label: 'happy path "office_furniture/chair"', category: 'office_furniture/chair' },
    { label: 'single segment "books"', category: 'books' },
    { label: 'null', category: null },
    { label: 'undefined', category: undefined },
    { label: 'empty string', category: '' },
    { label: 'whitespace-only', category: '   ' },
    { label: 'leading slash "/foo"', category: '/foo' },
    { label: 'trailing slash "foo/"', category: 'foo/' },
    { label: 'lone slash "/"', category: '/' },
    { label: 'multiple slashes "/a/b/c"', category: '/a/b/c' },
    { label: 'underscores collapse "  multi_word_thing  "', category: '  multi_word_thing  ' },
    // Contract-drift regression: an earlier subject_card.ts impl
    // returned '' for these inputs. Pinned here as a parity edge.
    { label: 'all-underscore "__"', category: '__' },
    { label: 'all-underscore "/__/"', category: '/__/' },
    { label: 'all-underscore "  __  "', category: '  __  ' },
    { label: 'triple underscore "___"', category: '___' },
  ];

  it.each(PARITY_INPUTS)(
    'card and detail produce identical subtitle for $label',
    ({ category }) => {
      const { card, detail } = pairSubtitles(category);
      expect(card).toBe(detail);
    },
  );

  it('the "string | null" contract is honoured: parity outputs are never the empty string', () => {
    // Defence against a future edit re-introducing the `''` return.
    // Both implementations must collapse "nothing renderable" to
    // null, never to ''.
    for (const { category } of PARITY_INPUTS) {
      const { card, detail } = pairSubtitles(category);
      expect(card).not.toBe('');
      expect(detail).not.toBe('');
    }
  });
});

describe('ring → friends parity — subject_card vs subject_detail_data', () => {
  // Both modules apply the same ring-classification rule:
  //
  //   - subject_card.ts     : `r.ring === 'self' || r.ring === 'contact'`
  //                           increments the friends count; everything
  //                           else (fof + stranger) increments strangers.
  //                           (Binary card pill view.)
  //   - subject_detail_data : `r.ring === 'self' || r.ring === 'contact'`
  //                           pushes into the friends bucket; fof gets
  //                           its own bucket; stranger gets its own.
  //                           (Ternary detail-section view.)
  //
  // The shapes diverge intentionally — the card collapses fof into
  // strangers because it has a binary pill; the detail screen breaks
  // fof out as a distinct row. But the SHARED semantic is "self and
  // contact are friends; nobody else is". A refactor that changed
  // self → strangers in one module but not the other would silently
  // diverge — the card would say "1 stranger" while the detail screen
  // shows "1 friend". This suite pins parity so any drift fails loudly.

  function pairFriendsClassification(ring: SubjectReview['ring']): {
    cardCountedAsFriend: boolean;
    detailGroupedAsFriend: boolean;
  } {
    const onlyReview = makeReview({
      ring,
      reviewerName: 'X',
      reviewerTrustScore: 0.5,
    });
    // Card path: friendsPill is non-null when at least one review
    // counted as a friend. With a single review, this is the binary
    // signal we need.
    const card = deriveSubjectCard({
      title: 'X',
      category: null,
      subjectTrustScore: 0.5,
      viewerDid: 'did:plc:viewer',
      reviewCount: 1,
      reviews: [onlyReview],
    });
    const cardCountedAsFriend = card.friendsPill !== null;

    // Detail path: friendsReviews is non-empty when at least one
    // review went into the friends bucket.
    const detail = deriveSubjectDetail(
      makeInput({ reviews: [onlyReview] }),
    );
    const detailGroupedAsFriend = detail.friendsReviews.length > 0;
    return { cardCountedAsFriend, detailGroupedAsFriend };
  }

  it.each([
    { ring: 'self' as const, expectedFriend: true },
    { ring: 'contact' as const, expectedFriend: true },
    { ring: 'fof' as const, expectedFriend: false },
    { ring: 'stranger' as const, expectedFriend: false },
  ])(
    'ring=$ring: card and detail agree on friend-classification (expected=$expectedFriend)',
    ({ ring, expectedFriend }) => {
      const { cardCountedAsFriend, detailGroupedAsFriend } =
        pairFriendsClassification(ring);
      expect(cardCountedAsFriend).toBe(expectedFriend);
      expect(detailGroupedAsFriend).toBe(expectedFriend);
      // Always assert parity directly: even if the expected value
      // was wrong, BOTH modules must agree with each other.
      expect(cardCountedAsFriend).toBe(detailGroupedAsFriend);
    },
  );

  it('parity holds across all four rings simultaneously', () => {
    // Single comprehensive pin — feed all four rings at once and
    // assert the card's friends count matches the detail's friends-
    // bucket size. If any ring's classification drifted in either
    // module, the totals would diverge.
    const reviews: SubjectReview[] = [
      makeReview({ ring: 'self', reviewerName: 'Me', reviewerTrustScore: 0.5 }),
      makeReview({ ring: 'contact', reviewerName: 'Sancho', reviewerTrustScore: 0.6 }),
      makeReview({ ring: 'fof', reviewerName: 'Albert', reviewerTrustScore: 0.4 }),
      makeReview({ ring: 'stranger', reviewerName: 'X', reviewerTrustScore: 0.3 }),
      makeReview({ ring: 'stranger', reviewerName: 'Y', reviewerTrustScore: 0.2 }),
    ];

    const card = deriveSubjectCard({
      title: 'X',
      category: null,
      subjectTrustScore: 0.5,
      viewerDid: 'did:plc:viewer',
      reviewCount: reviews.length,
      reviews,
    });
    const detail = deriveSubjectDetail(makeInput({ reviews }));

    // 2 friends (self + contact), 3 non-friends (fof + 2 strangers).
    expect(card.friendsPill).not.toBeNull();
    expect(card.friendsPill?.friendsCount).toBe(2);
    expect(detail.friendsReviews).toHaveLength(2);
    expect(card.friendsPill?.friendsCount).toBe(detail.friendsReviews.length);
  });
});

describe('showNumericScore parity — subject_card vs subject_detail_data', () => {
  // Plan §8.3.1: "Numeric score only when N ≥ 3" — both modules apply
  // the same `reviewCount >= MIN_REVIEWS_FOR_NUMERIC && score.score !== null`
  // formula. Iter-59 unified the constant (subject_detail_data now
  // imports MIN_REVIEWS_FOR_NUMERIC from subject_card), but the
  // formula itself is still duplicated logic. A future refactor that
  // tightened the formula in ONE module (e.g., requiring N≥5 only on
  // the detail header but leaving the card at N≥3) would silently
  // diverge — the search card would say "82" while the detail header
  // shows "HIGH" for the same subject.
  //
  // This suite pins parity so any drift fails loudly. Closes the
  // formula-drift bug class even when the constant is shared.

  function pairShowNumeric(
    subjectTrustScore: number | null,
    reviewCount: number,
  ): { card: boolean; detail: boolean } {
    const card = deriveSubjectCard({
      title: 'X',
      category: null,
      subjectTrustScore,
      viewerDid: 'did:plc:viewer',
      reviewCount,
      reviews: [],
    });
    const detail = deriveSubjectDetail(
      makeInput({ subjectTrustScore, reviewCount }),
    );
    return { card: card.showNumericScore, detail: detail.header.showNumericScore };
  }

  // Coverage matrix: `(reviewCount, score)` boundaries
  //
  //   reviewCount: 0, 1, 2 (below threshold), 3 (boundary), 4, 99 (above)
  //   plus -1 (clamps to 0), NaN (clamps to 0), 3.7 (floors to 3)
  //   score: null (unrated), 0, 0.5, 1.0
  //
  // We don't enumerate the cross-product — just enough cases to pin
  // each rule independently AND together.
  const PARITY_INPUTS: readonly {
    label: string;
    score: number | null;
    reviewCount: number;
  }[] = [
    // Below threshold — false regardless of score
    { label: 'N=0, score=null', score: null, reviewCount: 0 },
    { label: 'N=0, score=0.5', score: 0.5, reviewCount: 0 },
    { label: 'N=2, score=0.99', score: 0.99, reviewCount: 2 },
    // At boundary
    { label: 'N=3, score=null (null score → false)', score: null, reviewCount: 3 },
    { label: 'N=3, score=0.0 (zero score is non-null → true)', score: 0.0, reviewCount: 3 },
    { label: 'N=3, score=0.5', score: 0.5, reviewCount: 3 },
    { label: 'N=3, score=1.0', score: 1.0, reviewCount: 3 },
    // Above boundary
    { label: 'N=99, score=0.5', score: 0.5, reviewCount: 99 },
    { label: 'N=99, score=null', score: null, reviewCount: 99 },
    // Boundary defence: clamping inputs
    { label: 'N=-1 (clamps to 0)', score: 0.5, reviewCount: -1 },
    { label: 'N=NaN (clamps to 0)', score: 0.5, reviewCount: Number.NaN },
    { label: 'N=3.7 (floors to 3)', score: 0.5, reviewCount: 3.7 },
    { label: 'N=2.99 (floors to 2 — just below threshold)', score: 0.5, reviewCount: 2.99 },
  ];

  it.each(PARITY_INPUTS)(
    'card and detail agree on showNumericScore for $label',
    ({ score, reviewCount }) => {
      const { card, detail } = pairShowNumeric(score, reviewCount);
      expect(card).toBe(detail);
    },
  );

  it('the formula honors the N≥3 boundary identically across both modules', () => {
    // Direct cross-module assertions on the load-bearing boundary:
    // N=2 → false on both, N=3 → true on both (with non-null score).
    // Pins the `>=` rather than `>` semantic so a future "off-by-one"
    // refactor (e.g., requiring N>=4) lights up here.
    const below = pairShowNumeric(0.5, 2);
    expect(below.card).toBe(false);
    expect(below.detail).toBe(false);

    const at = pairShowNumeric(0.5, 3);
    expect(at.card).toBe(true);
    expect(at.detail).toBe(true);
  });

  it('null score forces showNumericScore=false on both modules even with N >> threshold', () => {
    // Defends the second clause of the formula:
    // `reviewCount >= MIN && score.score !== null`. If a future refactor
    // dropped the `score !== null` check, an unrated subject with many
    // reviews would surface a fake "0" or "—" as a numeric label.
    const { card, detail } = pairShowNumeric(null, 100);
    expect(card).toBe(false);
    expect(detail).toBe(false);
  });
});

describe('deriveSubjectDetail — ring grouping', () => {
  it('partitions reviews into friends / fof / strangers correctly', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        reviews: [
          // Distinct trust scores so the within-group sort is
          // deterministic by score (Self > Sancho here).
          makeReview({ ring: 'self', reviewerName: 'Self', reviewerTrustScore: 0.9 }),
          makeReview({ ring: 'contact', reviewerName: 'Sancho', reviewerTrustScore: 0.7 }),
          makeReview({ ring: 'fof', reviewerName: 'Albert', reviewerTrustScore: 0.5 }),
          makeReview({ ring: 'stranger', reviewerName: 'Stranger1', reviewerTrustScore: 0.4 }),
          makeReview({ ring: 'stranger', reviewerName: 'Stranger2', reviewerTrustScore: 0.3 }),
        ],
      }),
    );
    expect(detail.friendsReviews.map((r) => r.reviewerName)).toEqual(['Self', 'Sancho']);
    expect(detail.fofReviews.map((r) => r.reviewerName)).toEqual(['Albert']);
    expect(detail.strangerReviews.map((r) => r.reviewerName)).toEqual([
      'Stranger1',
      'Stranger2',
    ]);
  });

  it('self collapses with contacts under the friends bucket', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        reviews: [
          makeReview({ ring: 'self', reviewerName: 'Self', reviewerTrustScore: 0.9 }),
        ],
      }),
    );
    expect(detail.friendsReviews).toHaveLength(1);
    expect(detail.fofReviews).toHaveLength(0);
    expect(detail.strangerReviews).toHaveLength(0);
  });

  it('ringCounts match group sizes', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        reviews: [
          makeReview({ ring: 'contact', reviewerName: 'A' }),
          makeReview({ ring: 'contact', reviewerName: 'B' }),
          makeReview({ ring: 'fof', reviewerName: 'C' }),
          makeReview({ ring: 'stranger', reviewerName: 'D' }),
          makeReview({ ring: 'stranger', reviewerName: 'E' }),
          makeReview({ ring: 'stranger', reviewerName: 'F' }),
        ],
      }),
    );
    expect(detail.header.ringCounts).toEqual({ friends: 2, fof: 1, strangers: 3 });
  });

  it('all groups empty when no reviews', () => {
    const detail = deriveSubjectDetail(makeInput({ reviews: [] }));
    expect(detail.friendsReviews).toEqual([]);
    expect(detail.fofReviews).toEqual([]);
    expect(detail.strangerReviews).toEqual([]);
    expect(detail.header.ringCounts).toEqual({ friends: 0, fof: 0, strangers: 0 });
  });
});

describe('deriveSubjectDetail — within-group ordering', () => {
  it('sorts by trust score descending', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        reviews: [
          makeReview({ ring: 'contact', reviewerName: 'Mid', reviewerTrustScore: 0.5 }),
          makeReview({ ring: 'contact', reviewerName: 'Low', reviewerTrustScore: 0.2 }),
          makeReview({ ring: 'contact', reviewerName: 'High', reviewerTrustScore: 0.9 }),
        ],
      }),
    );
    expect(detail.friendsReviews.map((r) => r.reviewerName)).toEqual(['High', 'Mid', 'Low']);
  });

  it('null trust score sinks to the bottom (treated as -Infinity)', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        reviews: [
          makeReview({ ring: 'contact', reviewerName: 'Unrated', reviewerTrustScore: null }),
          makeReview({ ring: 'contact', reviewerName: 'Rated', reviewerTrustScore: 0.1 }),
        ],
      }),
    );
    expect(detail.friendsReviews.map((r) => r.reviewerName)).toEqual(['Rated', 'Unrated']);
  });

  it('breaks ties on trust score by recency (more recent first)', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        reviews: [
          makeReview({
            ring: 'contact',
            reviewerName: 'A',
            reviewerTrustScore: 0.7,
            createdAtMs: 1_000_000,
          }),
          makeReview({
            ring: 'contact',
            reviewerName: 'B',
            reviewerTrustScore: 0.7,
            createdAtMs: 2_000_000,
          }),
        ],
      }),
    );
    expect(detail.friendsReviews.map((r) => r.reviewerName)).toEqual(['B', 'A']);
  });

  it('breaks ties on score+recency by reviewerName ascending (stable sort)', () => {
    const detail = deriveSubjectDetail(
      makeInput({
        reviews: [
          makeReview({
            ring: 'contact',
            reviewerName: 'Bravo',
            reviewerTrustScore: 0.5,
            createdAtMs: 1_000_000,
          }),
          makeReview({
            ring: 'contact',
            reviewerName: 'Alpha',
            reviewerTrustScore: 0.5,
            createdAtMs: 1_000_000,
          }),
        ],
      }),
    );
    expect(detail.friendsReviews.map((r) => r.reviewerName)).toEqual(['Alpha', 'Bravo']);
  });
});
