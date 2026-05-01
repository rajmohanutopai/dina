/**
 * Subject card display data tests (TN-MOB-020).
 *
 * Pins the rules screens depend on:
 *
 *   - Score format follows plan §8.3.1 (numeric only when n ≥ 3).
 *   - Friends pill semantics (always shown when ≥ 1 contact reviewed;
 *     hidden when zero — a "0 friends" badge would mislead).
 *   - Top-reviewer ordering: closer ring → higher trust → more
 *     recent → stable name tiebreak. Unrated trust does NOT
 *     displace a rated reviewer.
 *   - Subtitle derivation from `subject.category` first segment with
 *     underscore→space + capitalisation.
 *
 * Pure function — runs under plain Jest, no RN deps.
 */

import {
  MIN_REVIEWS_FOR_NUMERIC,
  deriveSubjectCard,
  type SubjectCardInput,
  type SubjectReview,
} from '../../src/trust/subject_card';

function review(partial: Partial<SubjectReview> = {}): SubjectReview {
  return {
    ring: 'stranger',
    reviewerDid: 'did:plc:reviewer',
    reviewerTrustScore: 0.5,
    reviewerName: 'reviewer',
    headline: 'headline',
    createdAtMs: 1_700_000_000_000,
    ...partial,
  };
}

function input(partial: Partial<SubjectCardInput> = {}): SubjectCardInput {
  return {
    title: 'Aeron Chair',
    category: 'office_furniture/chair',
    subjectTrustScore: 0.82,
    reviewCount: 14,
    reviews: [],
    ...partial,
  };
}

// ─── Title + subtitle ─────────────────────────────────────────────────────

describe('deriveSubjectCard — title + subtitle', () => {
  it('passes title through', () => {
    const r = deriveSubjectCard(input({ title: 'Aeron Chair' }));
    expect(r.title).toBe('Aeron Chair');
  });

  it('humanises the first category segment ("office_furniture/chair" → "Office furniture")', () => {
    const r = deriveSubjectCard(input({ category: 'office_furniture/chair' }));
    expect(r.subtitle).toBe('Office furniture');
  });

  it('handles a single-segment category', () => {
    const r = deriveSubjectCard(input({ category: 'books' }));
    expect(r.subtitle).toBe('Books');
  });

  it('null / undefined / empty category → no subtitle', () => {
    expect(deriveSubjectCard(input({ category: null })).subtitle).toBeNull();
    expect(deriveSubjectCard(input({ category: undefined })).subtitle).toBeNull();
    expect(deriveSubjectCard(input({ category: '' })).subtitle).toBeNull();
    expect(deriveSubjectCard(input({ category: '   ' })).subtitle).toBeNull();
    expect(deriveSubjectCard(input({ category: '/' })).subtitle).toBeNull();
  });

  it('collapses underscores and excess whitespace', () => {
    const r = deriveSubjectCard(input({ category: '  multi_word_thing  ' }));
    expect(r.subtitle).toBe('Multi word thing');
  });

  it('all-underscore segment → null subtitle (contract: string | null, not "")', () => {
    // Regression guard: an earlier impl returned the empty string when
    // humanise produced no characters (e.g., `'__'` → `'__'.replace(/_+/g, ' ').trim() === ''`).
    // The contract says `subtitle: string | null` with null = absent;
    // returning '' is contract drift that breaks `value ?? fallback`
    // composition for any future caller. Both `'__'` and `'/__/'`
    // and `'  __  '` collapse to nothing-renderable → null.
    expect(deriveSubjectCard(input({ category: '__' })).subtitle).toBeNull();
    expect(deriveSubjectCard(input({ category: '/__/' })).subtitle).toBeNull();
    expect(deriveSubjectCard(input({ category: '  __  ' })).subtitle).toBeNull();
    expect(deriveSubjectCard(input({ category: '___' })).subtitle).toBeNull();
  });
});

// ─── Score format (plan §8.3.1) ───────────────────────────────────────────

describe('deriveSubjectCard — score format', () => {
  it('MIN_REVIEWS_FOR_NUMERIC is 3 (per plan §8.3.1)', () => {
    expect(MIN_REVIEWS_FOR_NUMERIC).toBe(3);
  });

  it('shows numeric when reviewCount ≥ 3', () => {
    const r = deriveSubjectCard(input({ reviewCount: 3 }));
    expect(r.showNumericScore).toBe(true);
    expect(r.score.score).toBeGreaterThan(0); // numeric component is real
  });

  it('shows band only when reviewCount < 3', () => {
    expect(deriveSubjectCard(input({ reviewCount: 0 })).showNumericScore).toBe(false);
    expect(deriveSubjectCard(input({ reviewCount: 1 })).showNumericScore).toBe(false);
    expect(deriveSubjectCard(input({ reviewCount: 2 })).showNumericScore).toBe(false);
  });

  it('shows band only when subject is unrated, even with many reviews (numeric makes no sense)', () => {
    const r = deriveSubjectCard(input({ subjectTrustScore: null, reviewCount: 100 }));
    expect(r.showNumericScore).toBe(false);
  });

  it('reviewCount < 0 / NaN clamps to 0 (defensive — bad wire data does not break the card)', () => {
    expect(deriveSubjectCard(input({ reviewCount: -5 })).reviewCount).toBe(0);
    expect(deriveSubjectCard(input({ reviewCount: Number.NaN })).reviewCount).toBe(0);
  });

  it('non-integer reviewCount floors (a card never says "14.7 reviews")', () => {
    expect(deriveSubjectCard(input({ reviewCount: 14.7 })).reviewCount).toBe(14);
  });
});

// ─── Friends pill ─────────────────────────────────────────────────────────

describe('deriveSubjectCard — friends pill', () => {
  it('null when zero contacts reviewed (no misleading "0 friends" badge)', () => {
    const r = deriveSubjectCard(
      input({
        reviews: [review({ ring: 'stranger' }), review({ ring: 'fof' })],
      }),
    );
    expect(r.friendsPill).toBeNull();
  });

  it('"self" counts as a friend (your own review still hides the empty-network case)', () => {
    const r = deriveSubjectCard(input({ reviews: [review({ ring: 'self' })] }));
    expect(r.friendsPill).toEqual({ friendsCount: 1, strangersCount: 0 });
  });

  it('counts contacts as friends and everyone else (fof + stranger) as strangers', () => {
    const r = deriveSubjectCard(
      input({
        reviews: [
          review({ ring: 'contact' }),
          review({ ring: 'contact' }),
          review({ ring: 'fof' }),
          review({ ring: 'stranger' }),
          review({ ring: 'stranger' }),
        ],
      }),
    );
    expect(r.friendsPill).toEqual({ friendsCount: 2, strangersCount: 3 });
  });

  it('shows pill when at least one contact reviewed even if vastly outnumbered', () => {
    const reviews: SubjectReview[] = [review({ ring: 'contact' })];
    for (let i = 0; i < 99; i++) reviews.push(review({ ring: 'stranger' }));
    const r = deriveSubjectCard(input({ reviews }));
    expect(r.friendsPill).toEqual({ friendsCount: 1, strangersCount: 99 });
  });

  it('empty reviews → no pill', () => {
    const r = deriveSubjectCard(input({ reviews: [] }));
    expect(r.friendsPill).toBeNull();
  });
});

// ─── Top reviewer ─────────────────────────────────────────────────────────

describe('deriveSubjectCard — top reviewer ordering', () => {
  it('null when no reviews', () => {
    const r = deriveSubjectCard(input({ reviews: [] }));
    expect(r.topReviewer).toBeNull();
  });

  it('closer ring beats farther ring regardless of trust score', () => {
    const r = deriveSubjectCard(
      input({
        reviews: [
          review({ ring: 'stranger', reviewerTrustScore: 0.95, reviewerName: 'Far' }),
          review({ ring: 'contact', reviewerTrustScore: 0.4, reviewerName: 'Near' }),
        ],
      }),
    );
    expect(r.topReviewer?.reviewerName).toBe('Near');
  });

  // Pin the FULL ring-rank ladder: self > contact > fof > stranger.
  // The single contact-vs-stranger test above pins ONE pair on the
  // ladder. A refactor that swapped self↔contact, or contact↔fof, or
  // fof↔stranger would not be caught — each pair needs its own
  // assertion. Each test uses the strongest-trust reviewer on the
  // weaker ring side so the ring rule is the SOLE deciding factor.

  it('self beats contact regardless of trust score (ring rank: self > contact)', () => {
    const r = deriveSubjectCard(
      input({
        reviews: [
          review({ ring: 'contact', reviewerTrustScore: 0.99, reviewerName: 'HighContact' }),
          review({ ring: 'self', reviewerTrustScore: 0.01, reviewerName: 'LowSelf' }),
        ],
      }),
    );
    expect(r.topReviewer?.reviewerName).toBe('LowSelf');
    expect(r.topReviewer?.ring).toBe('self');
  });

  it('contact beats fof regardless of trust score (ring rank: contact > fof)', () => {
    const r = deriveSubjectCard(
      input({
        reviews: [
          review({ ring: 'fof', reviewerTrustScore: 0.99, reviewerName: 'HighFof' }),
          review({ ring: 'contact', reviewerTrustScore: 0.01, reviewerName: 'LowContact' }),
        ],
      }),
    );
    expect(r.topReviewer?.reviewerName).toBe('LowContact');
    expect(r.topReviewer?.ring).toBe('contact');
  });

  it('fof beats stranger regardless of trust score (ring rank: fof > stranger)', () => {
    const r = deriveSubjectCard(
      input({
        reviews: [
          review({ ring: 'stranger', reviewerTrustScore: 0.99, reviewerName: 'HighStranger' }),
          review({ ring: 'fof', reviewerTrustScore: 0.01, reviewerName: 'LowFof' }),
        ],
      }),
    );
    expect(r.topReviewer?.reviewerName).toBe('LowFof');
    expect(r.topReviewer?.ring).toBe('fof');
  });

  it('full ladder transitivity: self wins over fof and stranger', () => {
    // Defends transitivity — self beats every farther ring, not just
    // the immediately-adjacent contact. Catches a refactor that
    // assigned self=3 but accidentally made contact=4 or stranger=4.
    const r = deriveSubjectCard(
      input({
        reviews: [
          review({ ring: 'fof', reviewerTrustScore: 0.99, reviewerName: 'F' }),
          review({ ring: 'stranger', reviewerTrustScore: 0.95, reviewerName: 'S' }),
          review({ ring: 'self', reviewerTrustScore: 0.01, reviewerName: 'Me' }),
        ],
      }),
    );
    expect(r.topReviewer?.reviewerName).toBe('Me');
    expect(r.topReviewer?.ring).toBe('self');
  });

  it('higher trust wins within the same ring', () => {
    const r = deriveSubjectCard(
      input({
        reviews: [
          review({ ring: 'contact', reviewerTrustScore: 0.4, reviewerName: 'Lower' }),
          review({ ring: 'contact', reviewerTrustScore: 0.9, reviewerName: 'Higher' }),
        ],
      }),
    );
    expect(r.topReviewer?.reviewerName).toBe('Higher');
  });

  it('unrated (null trust) does NOT displace a rated reviewer', () => {
    const r = deriveSubjectCard(
      input({
        reviews: [
          review({ ring: 'contact', reviewerTrustScore: null, reviewerName: 'Unrated' }),
          review({ ring: 'contact', reviewerTrustScore: 0.1, reviewerName: 'BarelyRated' }),
        ],
      }),
    );
    expect(r.topReviewer?.reviewerName).toBe('BarelyRated');
  });

  it('more recent wins among equal trust within the same ring', () => {
    const r = deriveSubjectCard(
      input({
        reviews: [
          review({
            ring: 'contact',
            reviewerTrustScore: 0.5,
            reviewerName: 'Old',
            createdAtMs: 1_000,
          }),
          review({
            ring: 'contact',
            reviewerTrustScore: 0.5,
            reviewerName: 'New',
            createdAtMs: 2_000,
          }),
        ],
      }),
    );
    expect(r.topReviewer?.reviewerName).toBe('New');
  });

  it('stable tiebreak by reviewerName ascending', () => {
    // Two reviewers tied on every other axis — name asc decides.
    const baseline = {
      ring: 'contact',
      reviewerTrustScore: 0.5,
      createdAtMs: 1_000,
    } as const;
    const r = deriveSubjectCard(
      input({
        reviews: [
          review({ ...baseline, reviewerName: 'Zebra' }),
          review({ ...baseline, reviewerName: 'Apple' }),
        ],
      }),
    );
    expect(r.topReviewer?.reviewerName).toBe('Apple');
  });

  it('top-reviewer line carries headline, ring, and band', () => {
    const r = deriveSubjectCard(
      input({
        reviews: [
          review({
            ring: 'contact',
            reviewerTrustScore: 0.85,
            reviewerName: 'Sancho',
            headline: 'Worth every penny for the back',
          }),
        ],
      }),
    );
    expect(r.topReviewer).toMatchObject({
      headline: 'Worth every penny for the back',
      reviewerName: 'Sancho',
      ring: 'contact',
      band: 'high',
    });
  });
});
