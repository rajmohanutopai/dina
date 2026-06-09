/**
 * `reviewSourceLabel` — the chat source-pill gate. "Ranked reviews" only at a
 * real ranking (≥ 3); "Network reviews" for 1–2; nothing otherwise. Locks the
 * threshold so the pill never overclaims a ranking on thin data.
 */

import { RANKED_MIN_REVIEWS, reviewSourceLabel } from '../../src/peerlens/review_source_label';

describe('reviewSourceLabel', () => {
  it('≥ RANKED_MIN reviews → "Ranked reviews"', () => {
    expect(reviewSourceLabel([`reviewsrc:${RANKED_MIN_REVIEWS}`])).toBe('Ranked reviews');
    expect(reviewSourceLabel(['reviewsrc:12'])).toBe('Ranked reviews');
  });

  it('1–2 reviews → "Network reviews" (no ranking claim)', () => {
    expect(reviewSourceLabel(['reviewsrc:1'])).toBe('Network reviews');
    expect(reviewSourceLabel(['reviewsrc:2'])).toBe('Network reviews');
  });

  it('0 / no token / undefined → no pill (null)', () => {
    expect(reviewSourceLabel(['reviewsrc:0'])).toBeNull();
    expect(reviewSourceLabel([])).toBeNull();
    expect(reviewSourceLabel(undefined)).toBeNull();
    expect(reviewSourceLabel(['some-ask-id', 'taskId:abc'])).toBeNull(); // identity-key sources ignored
  });

  it('ignores non-review source tokens but still finds the review one alongside them', () => {
    expect(reviewSourceLabel(['ask-123', 'reviewsrc:5'])).toBe('Ranked reviews');
  });

  it('malformed count → no pill', () => {
    expect(reviewSourceLabel(['reviewsrc:abc'])).toBeNull();
    expect(reviewSourceLabel(['reviewsrc:'])).toBeNull();
  });
});
