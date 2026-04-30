/**
 * Empty-state classifier + copy tests (TN-MOB-031).
 *
 * Covers the three states (`no_results`, `zero_reviews`, `no_contacts`)
 * across every plausible screen context. The non-empty path returns
 * `null` so screens can branch on `result === null` for "render the
 * results list" vs "render the empty-state slot" — that contract is
 * pinned.
 *
 * Pure data + pure function — no RN dependencies, runs under plain Jest.
 */

import {
  EMPTY_STATE_CONTENT,
  classifyEmptyState,
  emptyStateContentFor,
  type EmptyState,
} from '../../src/trust/empty_states';

// ─── Copy guards ──────────────────────────────────────────────────────────

describe('EMPTY_STATE_CONTENT', () => {
  const states: EmptyState[] = ['no_results', 'zero_reviews', 'no_contacts'];

  it('covers every EmptyState — no missing entries', () => {
    for (const s of states) {
      expect(EMPTY_STATE_CONTENT[s]).toBeDefined();
      expect(EMPTY_STATE_CONTENT[s].title).toBeTruthy();
      expect(EMPTY_STATE_CONTENT[s].body).toBeTruthy();
    }
  });

  it('zero_reviews carries no CTA — engagement-bait guard', () => {
    // Documented design choice — see file-header. If a future copy
    // edit adds a "Be the first to review!" button, this assertion
    // forces a pause to revisit the trade-off.
    expect(EMPTY_STATE_CONTENT.zero_reviews.action).toBeNull();
  });

  it('no_results and no_contacts both carry actionable CTAs', () => {
    expect(EMPTY_STATE_CONTENT.no_results.action).toBeTruthy();
    expect(EMPTY_STATE_CONTENT.no_contacts.action).toBeTruthy();
  });

  it('content is frozen — top-level mutation does not corrupt the dict', () => {
    expect(Object.isFrozen(EMPTY_STATE_CONTENT)).toBe(true);
    for (const s of states) {
      expect(Object.isFrozen(EMPTY_STATE_CONTENT[s])).toBe(true);
    }
    const before = EMPTY_STATE_CONTENT.no_results.title;
    try {
      (EMPTY_STATE_CONTENT.no_results as { title: string }).title = 'mutated';
    } catch {
      /* sloppy mode silently no-ops; strict mode throws */
    }
    expect(EMPTY_STATE_CONTENT.no_results.title).toBe(before);
  });
});

// ─── Classifier ───────────────────────────────────────────────────────────

describe('classifyEmptyState — search', () => {
  it('zero results → no_results', () => {
    expect(classifyEmptyState({ kind: 'search', resultCount: 0 })).toBe('no_results');
  });

  it('non-zero results → null (not empty)', () => {
    expect(classifyEmptyState({ kind: 'search', resultCount: 1 })).toBeNull();
    expect(classifyEmptyState({ kind: 'search', resultCount: 999 })).toBeNull();
  });

  it('negative resultCount collapses to no_results (defensive)', () => {
    expect(classifyEmptyState({ kind: 'search', resultCount: -1 })).toBe('no_results');
  });
});

describe('classifyEmptyState — subject', () => {
  it('zero reviews + no contacts → no_contacts (deeper fix surfaces)', () => {
    expect(
      classifyEmptyState({ kind: 'subject', reviewCount: 0, viewerContactCount: 0 }),
    ).toBe('no_contacts');
  });

  it('zero reviews + has contacts → zero_reviews', () => {
    expect(
      classifyEmptyState({ kind: 'subject', reviewCount: 0, viewerContactCount: 5 }),
    ).toBe('zero_reviews');
  });

  it('has reviews → null regardless of contact count', () => {
    expect(
      classifyEmptyState({ kind: 'subject', reviewCount: 1, viewerContactCount: 0 }),
    ).toBeNull();
    expect(
      classifyEmptyState({ kind: 'subject', reviewCount: 12, viewerContactCount: 5 }),
    ).toBeNull();
  });

  it('NaN counts coerce to "empty / no info"', () => {
    expect(
      classifyEmptyState({
        kind: 'subject',
        reviewCount: Number.NaN,
        viewerContactCount: Number.NaN,
      }),
    ).toBe('no_contacts');
  });

  // The atOrBelowZero helper guards every count via
  // `!Number.isFinite(n) || n <= 0`. NaN is covered above; the
  // ±Infinity paths are ALSO load-bearing — a future refactor that
  // narrowed the guard to `Number.isNaN(n) || n <= 0` would silently
  // change Infinity's behavior (Infinity would fall through to "lots
  // of contacts" and skip the empty-state surface). These tests pin
  // every non-finite branch.

  it('+Infinity reviewCount coerces to "empty" (non-finite → loud, not "lots")', () => {
    // +Infinity is not a real count; the defensive choice is "loud
    // empty state" rather than "silently surface lots of reviews
    // that don't exist".
    expect(
      classifyEmptyState({
        kind: 'subject',
        reviewCount: Number.POSITIVE_INFINITY,
        viewerContactCount: 5,
      }),
    ).toBe('zero_reviews');
  });

  it('+Infinity viewerContactCount coerces to "no contacts" branch (non-finite → empty)', () => {
    // viewerContactCount=Infinity must NOT pass the contact-ring
    // gate — we'd surface zero_reviews when actually the ring is
    // garbage-data and we don't know if the user has contacts.
    // Falls through to no_contacts (the deeper "fix the ring first"
    // empty state).
    expect(
      classifyEmptyState({
        kind: 'subject',
        reviewCount: 0,
        viewerContactCount: Number.POSITIVE_INFINITY,
      }),
    ).toBe('no_contacts');
  });

  it('-Infinity counts coerce to empty (defensive — non-finite means "no info")', () => {
    expect(
      classifyEmptyState({
        kind: 'subject',
        reviewCount: Number.NEGATIVE_INFINITY,
        viewerContactCount: Number.NEGATIVE_INFINITY,
      }),
    ).toBe('no_contacts');
  });

  it('non-finite search resultCount coerces to no_results (defensive parity)', () => {
    // Same coercion applies across kinds — atOrBelowZero is called
    // identically. Pinning the search branch separately so a future
    // per-kind divergence (e.g., search uses Math.max(0, n) but
    // subject uses atOrBelowZero) would fail loudly.
    expect(
      classifyEmptyState({ kind: 'search', resultCount: Number.NaN }),
    ).toBe('no_results');
    expect(
      classifyEmptyState({ kind: 'search', resultCount: Number.POSITIVE_INFINITY }),
    ).toBe('no_results');
  });

  it('non-finite contacts contactCount coerces to no_contacts', () => {
    expect(
      classifyEmptyState({ kind: 'contacts', contactCount: Number.NaN }),
    ).toBe('no_contacts');
    expect(
      classifyEmptyState({ kind: 'contacts', contactCount: Number.POSITIVE_INFINITY }),
    ).toBe('no_contacts');
  });
});

describe('classifyEmptyState — contacts', () => {
  it('zero contacts → no_contacts', () => {
    expect(classifyEmptyState({ kind: 'contacts', contactCount: 0 })).toBe('no_contacts');
  });

  it('non-zero contacts → null', () => {
    expect(classifyEmptyState({ kind: 'contacts', contactCount: 1 })).toBeNull();
    expect(classifyEmptyState({ kind: 'contacts', contactCount: 100 })).toBeNull();
  });
});

// ─── Convenience wrapper ──────────────────────────────────────────────────

describe('emptyStateContentFor', () => {
  it('returns the matching content bundle for an empty input', () => {
    expect(emptyStateContentFor({ kind: 'search', resultCount: 0 })).toBe(
      EMPTY_STATE_CONTENT.no_results,
    );
  });

  it('returns null when the screen is non-empty (single-conditional render contract)', () => {
    expect(emptyStateContentFor({ kind: 'search', resultCount: 5 })).toBeNull();
    expect(
      emptyStateContentFor({ kind: 'subject', reviewCount: 3, viewerContactCount: 2 }),
    ).toBeNull();
    expect(emptyStateContentFor({ kind: 'contacts', contactCount: 1 })).toBeNull();
  });

  it('routes the subject branch to no_contacts when the ring is empty', () => {
    expect(
      emptyStateContentFor({ kind: 'subject', reviewCount: 0, viewerContactCount: 0 }),
    ).toBe(EMPTY_STATE_CONTENT.no_contacts);
  });

  it('routes the subject branch to zero_reviews when the ring is non-empty', () => {
    expect(
      emptyStateContentFor({ kind: 'subject', reviewCount: 0, viewerContactCount: 3 }),
    ).toBe(EMPTY_STATE_CONTENT.zero_reviews);
  });
});
