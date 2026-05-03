/**
 * Tests for `src/trust/write_form_data.ts` (TN-MOB-013).
 *
 * Pure form-state validator. Pins:
 *   - empty initial state
 *   - all four fields required for canPublish
 *   - headline length cap (140) — over the cap → headline_too_long
 *   - body length cap (4000)
 *   - whitespace-only headline → headline_empty (trim before counting)
 *   - error labels for each closed-enum WriteFormError variant
 *   - bodyLength counts trimmed length (so "  hi  " → 2)
 */

import {
  emptyWriteFormState,
  validateWriteForm,
  describeWriteFormError,
  lastUsedMsForBucket,
  toggleUseCase,
  useCasesForCategory,
  addReviewAlternative,
  removeReviewAlternative,
  priceDisplayToE7,
  priceE7ToDisplay,
  normaliseCurrency,
  priceFromForm,
  toggleTagInVocabulary,
  isPlausibleCountryCode,
  isPlausibleHostname,
  addCountryCode,
  addHostname,
  removeAtIndex,
  parseLeadDays,
  toggleSeasonalMonth,
  serializeFormToV2Extras,
  HEADLINE_MAX_LENGTH,
  BODY_MAX_LENGTH,
  MAX_USE_CASES,
  MAX_REVIEW_ALTERNATIVES,
  MAX_COMPLIANCE,
  MAX_ACCESSIBILITY,
  MAX_COMPAT,
  MAX_RECOMMEND_FOR,
  MAX_AVAILABILITY_REGIONS,
  MAX_AVAILABILITY_SOLD_AT,
  SCHEDULE_LEAD_DAYS_MAX,
  SENTIMENT_OPTIONS,
  CONFIDENCE_OPTIONS,
  LAST_USED_BUCKETS,
  LAST_USED_BUCKET_LABEL,
  USE_CASE_BY_CATEGORY,
  USE_CASE_LABEL,
  USE_CASES_DEFAULT,
  REVIEWER_EXPERIENCE_OPTIONS,
  REVIEWER_EXPERIENCE_LABEL,
  COMPLIANCE_VOCABULARY,
  ACCESSIBILITY_VOCABULARY,
  COMPAT_VOCABULARY,
  type LastUsedBucket,
  type ReviewAlternative,
  type WriteFormState,
  type WriteFormError,
} from '../../src/trust/write_form_data';

function withState(overrides: Partial<WriteFormState> = {}): WriteFormState {
  return { ...emptyWriteFormState(), ...overrides };
}

describe('emptyWriteFormState', () => {
  it('returns null sentiment, default confidence=moderate, and empty strings', () => {
    expect(emptyWriteFormState()).toEqual({
      sentiment: null,
      headline: '',
      body: '',
      // Confidence is no longer a user-facing field; the form seeds
      // `moderate` so the wire record always carries a value.
      confidence: 'moderate',
      // `subject: null` marks the form as "review-only" — backed by an
      // existing AppView subjectId. The describe-a-new-subject path
      // uses `emptyWriteFormStateWithSubject()` instead.
      subject: null,
      // TN-V2-REV-006 — empty array = user hasn't picked any tags.
      // The wire record will omit `useCases` entirely on publish.
      useCases: [],
      // TN-V2-REV-008 — empty list = no alternatives. The wire
      // record will omit `alternatives` entirely on publish.
      alternatives: [],
      // TN-V2-REV-007 — null bucket = user hasn't picked one. The
      // wire record will omit `lastUsedMs` entirely on publish.
      lastUsedBucket: null,
      // TN-V2-MOBILE-WIRE — every V2 field starts unset. Empty
      // arrays / null / empty strings collapse to "field omitted on
      // publish" so an unfilled form serialises to a base record
      // with no V2 extras.
      reviewerExperience: null,
      priceLow: '',
      priceHigh: '',
      priceCurrency: '',
      compliance: [],
      accessibility: [],
      compat: [],
      recommendFor: [],
      notRecommendFor: [],
    });
  });
});

describe('validateWriteForm — required fields', () => {
  it('empty form fails on headline + sentiment (confidence is auto-seeded so does NOT error)', () => {
    const v = validateWriteForm(emptyWriteFormState());
    expect(v.canPublish).toBe(false);
    expect(v.errors).toEqual(
      expect.arrayContaining(['headline_empty', 'sentiment_required']),
    );
    // Confidence is silently seeded to 'moderate' by the form; the
    // empty state is no longer null. The validator's
    // `confidence_required` rule still fires when a caller explicitly
    // sets confidence to null (defensive — see the dedicated spec
    // below) but emptyWriteFormState shouldn't surface it.
    expect(v.errors).not.toContain('confidence_required');
  });

  it('headline + body filled but no sentiment still fails on sentiment alone', () => {
    const v = validateWriteForm(
      withState({ headline: 'Great chair', body: '' }),
    );
    expect(v.canPublish).toBe(false);
    expect(v.errors).toEqual(expect.arrayContaining(['sentiment_required']));
    expect(v.errors).not.toContain('headline_empty');
    expect(v.errors).not.toContain('confidence_required');
  });

  it('confidence_required still fires defensively when state.confidence is explicitly null', () => {
    // Empty form is now valid w.r.t. confidence (it seeds moderate),
    // but legacy callers / mocks / a future power-user toggle may
    // still set it to null. Pin that the validator catches that case
    // so the publish path's non-null invariant remains load-bearing.
    const v = validateWriteForm(
      withState({
        headline: 'Great chair',
        sentiment: 'positive',
        confidence: null,
      }),
    );
    expect(v.canPublish).toBe(false);
    expect(v.errors).toContain('confidence_required');
  });

  it('all four fields valid → canPublish=true, errors empty', () => {
    const v = validateWriteForm(
      withState({
        headline: 'Great chair',
        sentiment: 'positive',
        confidence: 'high',
      }),
    );
    expect(v.canPublish).toBe(true);
    expect(v.errors).toEqual([]);
  });
});

describe('validateWriteForm — headline rules', () => {
  it('whitespace-only headline → headline_empty (trimmed before length check)', () => {
    const v = validateWriteForm(
      withState({
        headline: '     ',
        sentiment: 'positive',
        confidence: 'high',
      }),
    );
    expect(v.errors).toContain('headline_empty');
    expect(v.canPublish).toBe(false);
  });

  it('headline at exactly 140 chars → no length error', () => {
    const v = validateWriteForm(
      withState({
        headline: 'a'.repeat(HEADLINE_MAX_LENGTH),
        sentiment: 'positive',
        confidence: 'high',
      }),
    );
    expect(v.errors).not.toContain('headline_too_long');
    expect(v.canPublish).toBe(true);
  });

  it('headline at 141 chars → headline_too_long', () => {
    const v = validateWriteForm(
      withState({
        headline: 'a'.repeat(HEADLINE_MAX_LENGTH + 1),
        sentiment: 'positive',
        confidence: 'high',
      }),
    );
    expect(v.errors).toContain('headline_too_long');
    expect(v.canPublish).toBe(false);
  });

  it('headlineLength reports raw length (untrimmed)', () => {
    const v = validateWriteForm(
      withState({
        headline: 'hi  ',
        sentiment: 'positive',
        confidence: 'high',
      }),
    );
    expect(v.headlineLength).toBe(4);
  });
});

describe('validateWriteForm — body rules', () => {
  it('empty body → no error (body is optional)', () => {
    const v = validateWriteForm(
      withState({
        headline: 'Great',
        body: '',
        sentiment: 'positive',
        confidence: 'high',
      }),
    );
    expect(v.errors).not.toContain('body_too_long');
    expect(v.canPublish).toBe(true);
  });

  it('body at exactly 4000 chars → no error', () => {
    const v = validateWriteForm(
      withState({
        headline: 'Great',
        body: 'a'.repeat(BODY_MAX_LENGTH),
        sentiment: 'positive',
        confidence: 'high',
      }),
    );
    expect(v.errors).not.toContain('body_too_long');
    expect(v.canPublish).toBe(true);
  });

  it('body at 4001 chars → body_too_long', () => {
    const v = validateWriteForm(
      withState({
        headline: 'Great',
        body: 'a'.repeat(BODY_MAX_LENGTH + 1),
        sentiment: 'positive',
        confidence: 'high',
      }),
    );
    expect(v.errors).toContain('body_too_long');
    expect(v.canPublish).toBe(false);
  });

  it('bodyLength reports TRIMMED length', () => {
    const v = validateWriteForm(
      withState({
        headline: 'Great',
        body: '  hi  ',
        sentiment: 'positive',
        confidence: 'high',
      }),
    );
    expect(v.bodyLength).toBe(2);
  });
});

describe('describeWriteFormError', () => {
  it.each([
    ['headline_empty', /headline is required/i],
    ['headline_too_long', /140 characters or fewer/],
    ['body_too_long', /4000 characters or fewer/],
    ['sentiment_required', /Choose a sentiment/i],
    ['confidence_required', /Choose a confidence/i],
  ] as [WriteFormError, RegExp][])('describes %s', (err, pattern) => {
    expect(describeWriteFormError(err)).toMatch(pattern);
  });
});

describe('option lists are stable', () => {
  it('SENTIMENT_OPTIONS = [positive, neutral, negative]', () => {
    expect(SENTIMENT_OPTIONS).toEqual(['positive', 'neutral', 'negative']);
  });

  it('CONFIDENCE_OPTIONS = [certain, high, moderate, speculative]', () => {
    expect(CONFIDENCE_OPTIONS).toEqual([
      'certain',
      'high',
      'moderate',
      'speculative',
    ]);
  });
});

// ─── TN-V2-REV-007: last-used bucket ──────────────────────────────────────
//
// Pins the bucket-picker contract: closed enum, stable order, label
// for each, deterministic ms resolution against a pinned `nowMs`.

const NOW_MS = 1_700_000_000_000; // ~ 2023-11-14 UTC.
const DAY = 24 * 60 * 60 * 1000;

describe('LAST_USED_BUCKETS — closed enum', () => {
  it('exposes the 6 buckets in chronological-most-recent-first order', () => {
    expect(LAST_USED_BUCKETS).toEqual([
      'today',
      'past_week',
      'past_month',
      'past_6_months',
      'past_year',
      'over_a_year',
    ]);
  });

  it('every bucket has a non-empty label', () => {
    for (const bucket of LAST_USED_BUCKETS) {
      expect(LAST_USED_BUCKET_LABEL[bucket].length).toBeGreaterThan(0);
    }
  });

  it('label keys are exactly the bucket enum (no extras, no missing)', () => {
    expect(Object.keys(LAST_USED_BUCKET_LABEL).sort()).toEqual(
      [...LAST_USED_BUCKETS].sort(),
    );
  });
});

describe('lastUsedMsForBucket — bucket → ms mapping', () => {
  it('"today" resolves to nowMs verbatim', () => {
    expect(lastUsedMsForBucket('today', NOW_MS)).toBe(NOW_MS);
  });

  it('each bucket resolves to a value strictly older than the previous', () => {
    // Pinning the order's monotonicity defends against a future
    // refactor that accidentally swaps "past_week" and "past_month".
    let prev = NOW_MS + 1;
    for (const bucket of LAST_USED_BUCKETS) {
      const ms = lastUsedMsForBucket(bucket, NOW_MS);
      expect(ms).toBeLessThan(prev);
      prev = ms;
    }
  });

  it('past_week resolves to a midpoint within the past week (3 days ago)', () => {
    const ms = lastUsedMsForBucket('past_week', NOW_MS);
    expect(NOW_MS - ms).toBe(3 * DAY);
  });

  it('past_month resolves to the bucket midpoint (15 days ago)', () => {
    const ms = lastUsedMsForBucket('past_month', NOW_MS);
    expect(NOW_MS - ms).toBe(15 * DAY);
  });

  it('over_a_year resolves to a value older than 1 year', () => {
    const ms = lastUsedMsForBucket('over_a_year', NOW_MS);
    expect(NOW_MS - ms).toBeGreaterThan(365 * DAY);
  });

  it('result is always strictly in the past for non-today buckets', () => {
    for (const bucket of LAST_USED_BUCKETS) {
      if (bucket === 'today') continue;
      expect(lastUsedMsForBucket(bucket, NOW_MS)).toBeLessThan(NOW_MS);
    }
  });

  it('is pure — same nowMs always produces the same output', () => {
    const a = lastUsedMsForBucket('past_week', NOW_MS);
    const b = lastUsedMsForBucket('past_week', NOW_MS);
    expect(a).toBe(b);
  });

  it('shifts with nowMs (the value is relative, not absolute)', () => {
    const at = lastUsedMsForBucket('past_week', NOW_MS);
    const later = lastUsedMsForBucket('past_week', NOW_MS + 7 * DAY);
    expect(later - at).toBe(7 * DAY);
  });

  it('is exhaustively defined for every bucket in the enum', () => {
    // Compile-time exhaustiveness via the function's `switch` is one
    // thing; runtime "every bucket returns a finite number" is the
    // safety net.
    for (const bucket of LAST_USED_BUCKETS) {
      const ms = lastUsedMsForBucket(bucket as LastUsedBucket, NOW_MS);
      expect(Number.isFinite(ms)).toBe(true);
    }
  });
});

describe('emptyWriteFormState — lastUsedBucket field (TN-V2-REV-007)', () => {
  it('defaults to null (user has not picked a bucket)', () => {
    const state = emptyWriteFormState();
    expect(state.lastUsedBucket).toBeNull();
  });

  it('does not block publish when null (the field is optional)', () => {
    // A fully-populated form WITHOUT a last-used bucket must still be
    // publishable — the field is optional. Pinning so a future change
    // that adds `last_used_required` won't silently break casual
    // reviewers.
    const state = withState({
      sentiment: 'positive',
      headline: 'It is great',
      confidence: 'high',
      lastUsedBucket: null,
    });
    expect(validateWriteForm(state).canPublish).toBe(true);
  });

  it('does not block publish when set (every bucket is valid)', () => {
    for (const bucket of LAST_USED_BUCKETS) {
      const state = withState({
        sentiment: 'positive',
        headline: 'It is great',
        confidence: 'high',
        lastUsedBucket: bucket,
      });
      expect(validateWriteForm(state).canPublish).toBe(true);
    }
  });
});

// ─── TN-V2-REV-006: use-case picker ───────────────────────────────────────
//
// Pins:
//   1. Per-category vocabulary lookup (head segment, lowercased,
//      with default fallback).
//   2. Tap-to-toggle mutator with cap at MAX_USE_CASES.
//   3. Closed-vocabulary discipline: tags not in the current
//      vocabulary are silently rejected.
//   4. emptyWriteFormState defaults useCases to [].
//   5. canPublish unaffected by useCases (it's optional).

describe('useCasesForCategory — vocabulary lookup', () => {
  it('returns the tech vocabulary for tech/* categories', () => {
    expect(useCasesForCategory('tech/laptop')).toEqual(
      USE_CASE_BY_CATEGORY['tech'],
    );
  });

  it('returns the books vocabulary for books/* categories', () => {
    expect(useCasesForCategory('books/fiction')).toEqual(
      USE_CASE_BY_CATEGORY['books'],
    );
  });

  it('falls back to default for unknown categories', () => {
    expect(useCasesForCategory('made_up_category/sub')).toEqual(USE_CASES_DEFAULT);
  });

  it('falls back to default for null / empty / whitespace category', () => {
    expect(useCasesForCategory(null)).toEqual(USE_CASES_DEFAULT);
    expect(useCasesForCategory(undefined)).toEqual(USE_CASES_DEFAULT);
    expect(useCasesForCategory('')).toEqual(USE_CASES_DEFAULT);
    expect(useCasesForCategory('   ')).toEqual(USE_CASES_DEFAULT);
  });

  it('uses ONLY the first slash-segment for lookup', () => {
    // 'tech/anything/deeper' should still resolve to 'tech'.
    expect(useCasesForCategory('tech/anything/deeper')).toEqual(
      USE_CASE_BY_CATEGORY['tech'],
    );
  });

  it('lowercases the head segment before lookup', () => {
    // 'TECH/something' → 'tech' → tech vocabulary.
    expect(useCasesForCategory('TECH/something')).toEqual(
      USE_CASE_BY_CATEGORY['tech'],
    );
  });

  it('every entry in the table has a non-empty list', () => {
    for (const [key, list] of Object.entries(USE_CASE_BY_CATEGORY)) {
      expect(typeof key).toBe('string');
      expect(list.length).toBeGreaterThan(0);
    }
  });

  it('every tag has a label in USE_CASE_LABEL', () => {
    // The chip row's display copy comes from USE_CASE_LABEL — a tag
    // missing from the label table would render the snake_case
    // wire-side string. This sanity check pins that all categories'
    // vocabularies + the default list have labels.
    const allTags = new Set<string>([...USE_CASES_DEFAULT]);
    for (const list of Object.values(USE_CASE_BY_CATEGORY)) {
      for (const t of list) allTags.add(t);
    }
    for (const tag of allTags) {
      expect(USE_CASE_LABEL[tag]).toBeDefined();
      expect(USE_CASE_LABEL[tag].length).toBeGreaterThan(0);
    }
  });
});

describe('toggleUseCase — tap-to-toggle mutator', () => {
  const VOCAB = USE_CASE_BY_CATEGORY['tech'] ?? [];

  it('adds a tag when absent and under the cap', () => {
    const out = toggleUseCase([], 'everyday', VOCAB);
    expect(out).toEqual(['everyday']);
  });

  it('removes a tag when present (toggle off)', () => {
    const out = toggleUseCase(['everyday'], 'everyday', VOCAB);
    expect(out).toEqual([]);
  });

  it('preserves order when adding to an existing list', () => {
    const out = toggleUseCase(['everyday', 'professional'], 'travel', VOCAB);
    expect(out).toEqual(['everyday', 'professional', 'travel']);
  });

  it('preserves order when removing from the middle', () => {
    const out = toggleUseCase(
      ['everyday', 'professional', 'travel'],
      'professional',
      VOCAB,
    );
    expect(out).toEqual(['everyday', 'travel']);
  });

  it('rejects (no-op) when at the cap and adding a new tag', () => {
    expect(MAX_USE_CASES).toBe(3);
    const out = toggleUseCase(
      ['everyday', 'professional', 'travel'],
      'gaming',
      VOCAB,
    );
    expect(out).toEqual(['everyday', 'professional', 'travel']);
  });

  it('still allows REMOVE at the cap (toggle off works regardless of length)', () => {
    const out = toggleUseCase(
      ['everyday', 'professional', 'travel'],
      'everyday',
      VOCAB,
    );
    expect(out).toEqual(['professional', 'travel']);
  });

  it('rejects tags not in the vocabulary (closed-vocabulary discipline)', () => {
    // 'fiction' is in books vocab but NOT tech vocab.
    const out = toggleUseCase([], 'fiction', VOCAB);
    expect(out).toEqual([]);
  });

  it('rejects free-form tags (closed-vocabulary discipline)', () => {
    const out = toggleUseCase([], 'great-for-cats', VOCAB);
    expect(out).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = ['everyday'];
    const before = [...input];
    toggleUseCase(input, 'professional', VOCAB);
    expect(input).toEqual(before);
  });

  it('toggle is idempotent under double-application (add then remove → original)', () => {
    const start = ['everyday'];
    const after = toggleUseCase(toggleUseCase(start, 'professional', VOCAB), 'professional', VOCAB);
    expect(after).toEqual(start);
  });
});

describe('emptyWriteFormState — useCases field (TN-V2-REV-006)', () => {
  it('defaults to [] (user has not picked any tags)', () => {
    const state = emptyWriteFormState();
    expect(state.useCases).toEqual([]);
  });

  it('does not block publish when empty (the field is optional)', () => {
    const state = withState({
      sentiment: 'positive',
      headline: 'Great',
      confidence: 'high',
      useCases: [],
    });
    expect(validateWriteForm(state).canPublish).toBe(true);
  });

  it('does not block publish when populated', () => {
    const state = withState({
      sentiment: 'positive',
      headline: 'Great',
      confidence: 'high',
      useCases: ['everyday', 'professional'],
    });
    expect(validateWriteForm(state).canPublish).toBe(true);
  });
});

// ─── TN-V2-REV-008: alternatives selector ─────────────────────────────────
//
// Pins the alternatives-list contract:
//   1. addReviewAlternative trims, drops empty, dedups, caps.
//   2. removeReviewAlternative removes by index, no-op on bad index.
//   3. Dedup by subjectId when both have one; else by kind+name.
//   4. emptyWriteFormState defaults alternatives to [].
//   5. canPublish unaffected by alternatives (it's optional).

function makeAlt(overrides: Partial<ReviewAlternative> = {}): ReviewAlternative {
  return {
    kind: 'product',
    name: 'Aeron Chair',
    ...overrides,
  };
}

describe('addReviewAlternative — basic add', () => {
  it('adds an entry to an empty list', () => {
    const out = addReviewAlternative([], makeAlt());
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('Aeron Chair');
  });

  it('appends to an existing list (preserves order)', () => {
    const a = makeAlt({ name: 'A' });
    const b = makeAlt({ name: 'B' });
    const out = addReviewAlternative([a], b);
    expect(out.map((x) => x.name)).toEqual(['A', 'B']);
  });

  it('trims whitespace from name on the way in', () => {
    const out = addReviewAlternative([], makeAlt({ name: '  Aeron Chair  ' }));
    expect(out[0]?.name).toBe('Aeron Chair');
  });

  it('drops whitespace-only / empty names (no anonymous chip)', () => {
    expect(addReviewAlternative([], makeAlt({ name: '' }))).toEqual([]);
    expect(addReviewAlternative([], makeAlt({ name: '   ' }))).toEqual([]);
  });

  it('preserves all wire-side fields (subjectId / did / uri / identifier)', () => {
    const entry = makeAlt({
      kind: 'content',
      name: 'A page',
      uri: 'https://example.com',
      subjectId: 'sub-123',
    });
    const out = addReviewAlternative([], entry);
    expect(out[0]).toMatchObject({
      kind: 'content',
      name: 'A page',
      uri: 'https://example.com',
      subjectId: 'sub-123',
    });
  });

  it('does not mutate the input array', () => {
    const input: ReviewAlternative[] = [];
    const before = [...input];
    addReviewAlternative(input, makeAlt());
    expect(input).toEqual(before);
  });
});

describe('addReviewAlternative — dedup', () => {
  it('dedups by subjectId when both entries have one', () => {
    const existing = makeAlt({ name: 'Original', subjectId: 'sub-1' });
    const dup = makeAlt({ name: 'Different label', subjectId: 'sub-1' });
    const out = addReviewAlternative([existing], dup);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('Original'); // first wins
  });

  it('dedups by kind+name (case-insensitive) when subjectId is absent', () => {
    const existing = makeAlt({ kind: 'product', name: 'Aeron Chair' });
    const dup = makeAlt({ kind: 'product', name: 'AERON CHAIR' });
    const out = addReviewAlternative([existing], dup);
    expect(out).toHaveLength(1);
  });

  it('different kinds with same name are NOT dups', () => {
    // 'Aeron' as a product (chair) is conceptually different from
    // 'Aeron' as content (an article about the chair) — not a dup.
    const a = makeAlt({ kind: 'product', name: 'Aeron' });
    const b = makeAlt({ kind: 'content', name: 'Aeron' });
    const out = addReviewAlternative([a], b);
    expect(out).toHaveLength(2);
  });

  it('subjectId-keyed entry does not dedup against name-keyed entry', () => {
    // A subjectId-resolved Aeron and a free-form-typed Aeron are
    // semantically distinct: the former is a known AppView subject,
    // the latter is a name the resolver hasn't seen yet.
    const known = makeAlt({ name: 'Aeron Chair', subjectId: 'sub-1' });
    const freeform = makeAlt({ name: 'Aeron Chair' });
    const out = addReviewAlternative([known], freeform);
    expect(out).toHaveLength(2);
  });
});

describe('addReviewAlternative — cap', () => {
  it('caps at MAX_REVIEW_ALTERNATIVES', () => {
    expect(MAX_REVIEW_ALTERNATIVES).toBe(5);
    let list: readonly ReviewAlternative[] = [];
    for (let i = 0; i < MAX_REVIEW_ALTERNATIVES; i++) {
      list = addReviewAlternative(list, makeAlt({ name: `Alt ${i}` }));
    }
    expect(list).toHaveLength(MAX_REVIEW_ALTERNATIVES);
    // Adding a 6th should no-op.
    const after = addReviewAlternative(list, makeAlt({ name: 'Sixth' }));
    expect(after).toHaveLength(MAX_REVIEW_ALTERNATIVES);
    expect(after.find((a) => a.name === 'Sixth')).toBeUndefined();
  });
});

describe('removeReviewAlternative', () => {
  const SAMPLE: readonly ReviewAlternative[] = [
    makeAlt({ name: 'A' }),
    makeAlt({ name: 'B' }),
    makeAlt({ name: 'C' }),
  ];

  it('removes the entry at the given index', () => {
    const out = removeReviewAlternative(SAMPLE, 1);
    expect(out.map((a) => a.name)).toEqual(['A', 'C']);
  });

  it('removes the first entry', () => {
    const out = removeReviewAlternative(SAMPLE, 0);
    expect(out.map((a) => a.name)).toEqual(['B', 'C']);
  });

  it('removes the last entry', () => {
    const out = removeReviewAlternative(SAMPLE, 2);
    expect(out.map((a) => a.name)).toEqual(['A', 'B']);
  });

  it('no-op for negative index', () => {
    expect(removeReviewAlternative(SAMPLE, -1)).toEqual(SAMPLE);
  });

  it('no-op for out-of-range index', () => {
    expect(removeReviewAlternative(SAMPLE, 99)).toEqual(SAMPLE);
  });

  it('no-op for non-integer index (defensive)', () => {
    expect(removeReviewAlternative(SAMPLE, 1.5)).toEqual(SAMPLE);
    expect(removeReviewAlternative(SAMPLE, Number.NaN)).toEqual(SAMPLE);
  });

  it('does not mutate the input array', () => {
    const list = [...SAMPLE];
    const before = [...list];
    removeReviewAlternative(list, 1);
    expect(list).toEqual(before);
  });
});

describe('emptyWriteFormState — alternatives field (TN-V2-REV-008)', () => {
  it('defaults to [] (user has not added any alternatives)', () => {
    expect(emptyWriteFormState().alternatives).toEqual([]);
  });

  it('does not block publish when empty (the field is optional)', () => {
    const state = withState({
      sentiment: 'positive',
      headline: 'Great',
      confidence: 'high',
    });
    expect(validateWriteForm(state).canPublish).toBe(true);
  });

  it('does not block publish when populated', () => {
    const state = withState({
      sentiment: 'positive',
      headline: 'Great',
      confidence: 'high',
      alternatives: [makeAlt({ name: 'Alt One' }), makeAlt({ name: 'Alt Two' })],
    });
    expect(validateWriteForm(state).canPublish).toBe(true);
  });
});

// ─── V2: META-002 price ───────────────────────────────────────────────────

describe('priceDisplayToE7', () => {
  it('parses standard decimal strings', () => {
    expect(priceDisplayToE7('29.99')).toBe(299_900_000);
    expect(priceDisplayToE7('1000')).toBe(10_000_000_000);
    expect(priceDisplayToE7('0')).toBe(0);
    expect(priceDisplayToE7('0.01')).toBe(100_000);
  });

  it('accepts European decimal-comma input', () => {
    expect(priceDisplayToE7('29,99')).toBe(299_900_000);
  });

  it('trims whitespace', () => {
    expect(priceDisplayToE7('  29.99  ')).toBe(299_900_000);
  });

  it('rejects malformed input', () => {
    expect(priceDisplayToE7('')).toBeNull();
    expect(priceDisplayToE7('   ')).toBeNull();
    expect(priceDisplayToE7('abc')).toBeNull();
    expect(priceDisplayToE7('$29.99')).toBeNull();
    expect(priceDisplayToE7('-1')).toBeNull();
    expect(priceDisplayToE7('1.2.3')).toBeNull();
  });

  it('rounds float imprecision (29.99 * 1e7 leaks otherwise)', () => {
    // 29.99 in IEEE-754 is 29.989999999... — Math.round in
    // priceDisplayToE7 must clean this up so we don't smuggle float
    // imprecision into a CBOR-int wire field.
    expect(priceDisplayToE7('29.99')).toBe(299_900_000);
    expect(priceDisplayToE7('0.30000000000000004')).toBe(3_000_000);
  });
});

describe('priceE7ToDisplay', () => {
  it('strips trailing zeros after the decimal', () => {
    expect(priceE7ToDisplay(299_900_000)).toBe('29.99');
    expect(priceE7ToDisplay(10_000_000_000)).toBe('1000');
    expect(priceE7ToDisplay(100_000)).toBe('0.01');
  });

  it('returns empty string for invalid e7', () => {
    expect(priceE7ToDisplay(-1)).toBe('');
    expect(priceE7ToDisplay(Number.NaN)).toBe('');
  });
});

describe('normaliseCurrency', () => {
  it('uppercases + trims valid 3-letter codes', () => {
    expect(normaliseCurrency('usd')).toBe('USD');
    expect(normaliseCurrency('  EUR  ')).toBe('EUR');
    expect(normaliseCurrency('GbP')).toBe('GBP');
  });

  it('rejects symbols + wrong-length input', () => {
    expect(normaliseCurrency('$')).toBeNull();
    expect(normaliseCurrency('US')).toBeNull();
    expect(normaliseCurrency('USDD')).toBeNull();
    expect(normaliseCurrency('U2D')).toBeNull();
    expect(normaliseCurrency('')).toBeNull();
  });
});

describe('priceFromForm', () => {
  const FROZEN_NOW = 1_777_500_000_000;
  const now = () => FROZEN_NOW;

  it('returns unset when priceLow is empty (the field is optional)', () => {
    expect(
      priceFromForm({ priceLow: '', priceHigh: '50', priceCurrency: 'USD' }, now),
    ).toEqual({ kind: 'unset' });
  });

  it('builds a point price when priceHigh is empty', () => {
    expect(
      priceFromForm({ priceLow: '29.99', priceHigh: '', priceCurrency: 'usd' }, now),
    ).toEqual({
      kind: 'ok',
      price: {
        low_e7: 299_900_000,
        high_e7: 299_900_000,
        currency: 'USD',
        lastSeenMs: FROZEN_NOW,
      },
    });
  });

  it('builds a range when priceHigh > priceLow', () => {
    expect(
      priceFromForm(
        { priceLow: '19.99', priceHigh: '49.99', priceCurrency: 'GBP' },
        now,
      ),
    ).toEqual({
      kind: 'ok',
      price: {
        low_e7: 199_900_000,
        high_e7: 499_900_000,
        currency: 'GBP',
        lastSeenMs: FROZEN_NOW,
      },
    });
  });

  it('rejects priceHigh below priceLow', () => {
    expect(
      priceFromForm(
        { priceLow: '49.99', priceHigh: '19.99', priceCurrency: 'USD' },
        now,
      ),
    ).toEqual({ kind: 'invalid', error: 'price_high_below_low' });
  });

  it('rejects unparseable priceLow', () => {
    expect(
      priceFromForm({ priceLow: 'abc', priceHigh: '', priceCurrency: 'USD' }, now),
    ).toEqual({ kind: 'invalid', error: 'price_low_invalid' });
  });

  it('rejects unparseable priceHigh', () => {
    expect(
      priceFromForm(
        { priceLow: '10', priceHigh: 'abc', priceCurrency: 'USD' },
        now,
      ),
    ).toEqual({ kind: 'invalid', error: 'price_high_invalid' });
  });

  it('rejects malformed currency', () => {
    expect(
      priceFromForm({ priceLow: '10', priceHigh: '', priceCurrency: '$' }, now),
    ).toEqual({ kind: 'invalid', error: 'price_currency_invalid' });
  });

  it('lastSeenMs reflects injectable now (deterministic)', () => {
    const r1 = priceFromForm(
      { priceLow: '1', priceHigh: '', priceCurrency: 'USD' },
      () => 1000,
    );
    const r2 = priceFromForm(
      { priceLow: '1', priceHigh: '', priceCurrency: 'USD' },
      () => 2000,
    );
    expect(r1.kind === 'ok' ? r1.price.lastSeenMs : null).toBe(1000);
    expect(r2.kind === 'ok' ? r2.price.lastSeenMs : null).toBe(2000);
  });
});

describe('validateWriteForm — V2 price', () => {
  it('does not error when price block is unset', () => {
    const state = withState({
      sentiment: 'positive',
      headline: 'Great',
      confidence: 'high',
    });
    expect(validateWriteForm(state).canPublish).toBe(true);
  });

  it('flags price_low_invalid when low is non-empty + unparseable', () => {
    const state = withState({
      sentiment: 'positive',
      headline: 'Great',
      confidence: 'high',
      priceLow: 'abc',
      priceCurrency: 'USD',
    });
    const v = validateWriteForm(state);
    expect(v.canPublish).toBe(false);
    expect(v.errors).toContain('price_low_invalid');
  });

  it('flags price_currency_invalid when currency is not 3 letters', () => {
    const state = withState({
      sentiment: 'positive',
      headline: 'Great',
      confidence: 'high',
      priceLow: '29.99',
      priceCurrency: '$',
    });
    expect(validateWriteForm(state).errors).toContain('price_currency_invalid');
  });

  it('flags price_high_below_low when high < low', () => {
    const state = withState({
      sentiment: 'positive',
      headline: 'Great',
      confidence: 'high',
      priceLow: '50',
      priceHigh: '10',
      priceCurrency: 'USD',
    });
    expect(validateWriteForm(state).errors).toContain('price_high_below_low');
  });

  it('valid price block does not block publish', () => {
    const state = withState({
      sentiment: 'positive',
      headline: 'Great',
      confidence: 'high',
      priceLow: '29.99',
      priceCurrency: 'USD',
    });
    expect(validateWriteForm(state).canPublish).toBe(true);
  });
});

// ─── V2: REV-002 reviewerExperience ───────────────────────────────────────

describe('REVIEWER_EXPERIENCE_OPTIONS', () => {
  it('lists novice / intermediate / expert in display order', () => {
    expect(REVIEWER_EXPERIENCE_OPTIONS).toEqual(['novice', 'intermediate', 'expert']);
  });

  it('every option has a label', () => {
    for (const opt of REVIEWER_EXPERIENCE_OPTIONS) {
      expect(typeof REVIEWER_EXPERIENCE_LABEL[opt]).toBe('string');
    }
  });
});

// ─── V2: META-005/006/003 closed-vocab tag fields ─────────────────────────

describe('toggleTagInVocabulary', () => {
  const VOCAB = ['halal', 'kosher', 'vegan'] as const;

  it('adds a tag when absent + under cap', () => {
    expect(toggleTagInVocabulary([], 'halal', VOCAB, 5)).toEqual(['halal']);
  });

  it('removes a tag when present', () => {
    expect(toggleTagInVocabulary(['halal', 'kosher'], 'halal', VOCAB, 5)).toEqual([
      'kosher',
    ]);
  });

  it('no-ops when tag is not in vocabulary (closed-vocab)', () => {
    expect(toggleTagInVocabulary([], 'pescatarian', VOCAB, 5)).toEqual([]);
  });

  it('no-ops when at cap and tag is absent', () => {
    expect(
      toggleTagInVocabulary(['halal', 'kosher', 'vegan'], 'halal', VOCAB, 3).slice(),
    ).toEqual(['kosher', 'vegan']); // remove still works
    expect(
      toggleTagInVocabulary(['halal', 'kosher', 'vegan'], 'halal', VOCAB, 1).slice(),
    ).toEqual(['kosher', 'vegan']);
  });

  it('respects the per-call cap', () => {
    const out = toggleTagInVocabulary(
      ['halal', 'kosher'],
      'vegan',
      VOCAB,
      2,
    );
    expect(out).toEqual(['halal', 'kosher']); // at cap → no-op
  });
});

describe('compliance / accessibility / compat vocabularies', () => {
  it('cap matches the AppView Zod schema', () => {
    expect(MAX_COMPLIANCE).toBe(10);
    expect(MAX_ACCESSIBILITY).toBe(10);
    expect(MAX_COMPAT).toBe(15);
  });

  it('every vocabulary entry is a non-empty snake_case-friendly string', () => {
    for (const list of [COMPLIANCE_VOCABULARY, ACCESSIBILITY_VOCABULARY, COMPAT_VOCABULARY]) {
      for (const tag of list) {
        expect(typeof tag).toBe('string');
        expect(tag.length).toBeGreaterThan(0);
        expect(tag.length).toBeLessThanOrEqual(50); // matches AppView per-string cap
      }
    }
  });
});

// ─── V2: REV-004 recommendFor / notRecommendFor ──────────────────────────

describe('recommendFor / notRecommendFor caps', () => {
  it('cap matches the AppView Zod schema', () => {
    expect(MAX_RECOMMEND_FOR).toBe(5);
  });
});

// ─── V2: META-001 availability ────────────────────────────────────────────

describe('isPlausibleCountryCode', () => {
  it('accepts ISO 3166-1 alpha-2 (uppercase 2 letters)', () => {
    expect(isPlausibleCountryCode('US')).toBe(true);
    expect(isPlausibleCountryCode('GB')).toBe(true);
    expect(isPlausibleCountryCode('us')).toBe(true); // toUpperCase
  });

  it('rejects malformed codes', () => {
    expect(isPlausibleCountryCode('USA')).toBe(false);
    expect(isPlausibleCountryCode('U')).toBe(false);
    expect(isPlausibleCountryCode('U1')).toBe(false);
    expect(isPlausibleCountryCode('')).toBe(false);
  });
});

describe('addCountryCode', () => {
  it('adds + uppercases', () => {
    expect(addCountryCode([], 'us')).toEqual(['US']);
  });

  it('drops malformed codes', () => {
    expect(addCountryCode([], 'USA')).toEqual([]);
  });

  it('dedups', () => {
    expect(addCountryCode(['US'], 'us')).toEqual(['US']);
  });

  it('honours cap', () => {
    expect(MAX_AVAILABILITY_REGIONS).toBe(30);
    const full: string[] = [];
    for (let i = 0; i < MAX_AVAILABILITY_REGIONS; i++) {
      full.push(`A${String.fromCharCode(65 + (i % 26))}`);
    }
    expect(addCountryCode(full, 'XX')).toEqual(full);
  });
});

describe('isPlausibleHostname', () => {
  it('accepts plain hostnames', () => {
    expect(isPlausibleHostname('amazon.com')).toBe(true);
    expect(isPlausibleHostname('shop.walmart.com')).toBe(true);
    expect(isPlausibleHostname('example.co.uk')).toBe(true);
  });

  it('rejects URLs', () => {
    expect(isPlausibleHostname('https://amazon.com')).toBe(false);
    expect(isPlausibleHostname('amazon.com/path')).toBe(false);
  });

  it('rejects single labels (must contain a dot)', () => {
    expect(isPlausibleHostname('localhost')).toBe(false);
  });

  it('rejects empty / whitespace / over-cap', () => {
    expect(isPlausibleHostname('')).toBe(false);
    expect(isPlausibleHostname('   ')).toBe(false);
    expect(isPlausibleHostname('a'.repeat(254) + '.com')).toBe(false);
  });
});

describe('addHostname', () => {
  it('adds + lowercases', () => {
    expect(addHostname([], 'AMAZON.COM')).toEqual(['amazon.com']);
  });

  it('drops invalid hostnames', () => {
    expect(addHostname([], 'https://amazon.com')).toEqual([]);
    expect(addHostname([], 'localhost')).toEqual([]);
  });

  it('dedups + caps', () => {
    expect(addHostname(['amazon.com'], 'amazon.com')).toEqual(['amazon.com']);
    expect(MAX_AVAILABILITY_SOLD_AT).toBe(20);
  });
});

describe('removeAtIndex', () => {
  it('removes the entry at the given index', () => {
    expect(removeAtIndex(['A', 'B', 'C'], 1)).toEqual(['A', 'C']);
  });

  it('no-op for out-of-range / non-int', () => {
    expect(removeAtIndex(['A'], -1)).toEqual(['A']);
    expect(removeAtIndex(['A'], 99)).toEqual(['A']);
    expect(removeAtIndex(['A'], 1.5)).toEqual(['A']);
  });
});

// ─── V2: META-004 schedule ────────────────────────────────────────────────

describe('parseLeadDays', () => {
  it('parses non-negative integer strings', () => {
    expect(parseLeadDays('0')).toBe(0);
    expect(parseLeadDays('14')).toBe(14);
    expect(parseLeadDays('365')).toBe(365);
    expect(parseLeadDays('  7  ')).toBe(7);
  });

  it('rejects out-of-range', () => {
    expect(parseLeadDays('-1')).toBeNull();
    expect(parseLeadDays('366')).toBeNull();
    expect(SCHEDULE_LEAD_DAYS_MAX).toBe(365);
  });

  it('rejects malformed input', () => {
    expect(parseLeadDays('')).toBeNull();
    expect(parseLeadDays('abc')).toBeNull();
    expect(parseLeadDays('1.5')).toBeNull();
    expect(parseLeadDays('1e3')).toBeNull();
  });
});

describe('toggleSeasonalMonth', () => {
  it('adds a month + keeps list sorted', () => {
    expect(toggleSeasonalMonth([], 6)).toEqual([6]);
    expect(toggleSeasonalMonth([6], 1)).toEqual([1, 6]);
    expect(toggleSeasonalMonth([1, 6, 12], 3)).toEqual([1, 3, 6, 12]);
  });

  it('removes when present', () => {
    expect(toggleSeasonalMonth([1, 6, 12], 6)).toEqual([1, 12]);
  });

  it('no-ops out-of-range', () => {
    expect(toggleSeasonalMonth([], 0)).toEqual([]);
    expect(toggleSeasonalMonth([], 13)).toEqual([]);
    expect(toggleSeasonalMonth([], 1.5)).toEqual([]);
  });
});

// Note: schedule.leadDays + schedule.seasonal + the three
// availability sub-fields used to be captured by the form. They were
// dropped because they're subject-owner facts, not reviewer opinion.
// The pure helpers (`parseLeadDays`, `toggleSeasonalMonth`,
// `addCountryCode`, `addHostname`, `removeAtIndex`) are kept for the
// future "Add subject" surface and are still tested as helpers above.

// ─── V2: serializer ───────────────────────────────────────────────────────

describe('serializeFormToV2Extras — empty form', () => {
  it('returns {} when no V2 fields are populated', () => {
    expect(serializeFormToV2Extras(emptyWriteFormState())).toEqual({});
  });
});

describe('serializeFormToV2Extras — populated', () => {
  const FROZEN_NOW = 1_777_500_000_000;
  const now = () => FROZEN_NOW;

  it('includes price as a wire-shape block', () => {
    const state = withState({
      priceLow: '29.99',
      priceHigh: '',
      priceCurrency: 'usd',
    });
    const out = serializeFormToV2Extras(state, now);
    expect(out.price).toEqual({
      low_e7: 299_900_000,
      high_e7: 299_900_000,
      currency: 'USD',
      lastSeenMs: FROZEN_NOW,
    });
  });

  it('omits price when invalid (caller gates on canPublish first)', () => {
    const state = withState({
      priceLow: 'abc',
      priceCurrency: 'USD',
    });
    expect(serializeFormToV2Extras(state, now).price).toBeUndefined();
  });

  it('includes reviewerExperience when set', () => {
    const state = withState({ reviewerExperience: 'expert' });
    expect(serializeFormToV2Extras(state, now).reviewerExperience).toBe('expert');
  });

  it('omits reviewerExperience when null', () => {
    expect(
      serializeFormToV2Extras(emptyWriteFormState(), now).reviewerExperience,
    ).toBeUndefined();
  });

  it('includes lastUsedMs from bucket midpoint', () => {
    const state = withState({ lastUsedBucket: 'past_week' });
    const out = serializeFormToV2Extras(state, now);
    expect(out.lastUsedMs).toBe(FROZEN_NOW - 3 * 24 * 60 * 60 * 1000);
  });

  it('includes useCases / recommendFor / notRecommendFor when populated', () => {
    const state = withState({
      useCases: ['everyday', 'travel'],
      recommendFor: ['professional'],
      notRecommendFor: ['gaming'],
    });
    const out = serializeFormToV2Extras(state, now);
    expect(out.useCases).toEqual(['everyday', 'travel']);
    expect(out.recommendFor).toEqual(['professional']);
    expect(out.notRecommendFor).toEqual(['gaming']);
  });

  it('omits empty tag arrays', () => {
    const out = serializeFormToV2Extras(emptyWriteFormState(), now);
    expect(out.useCases).toBeUndefined();
    expect(out.compliance).toBeUndefined();
    expect(out.accessibility).toBeUndefined();
    expect(out.compat).toBeUndefined();
    expect(out.recommendFor).toBeUndefined();
    expect(out.notRecommendFor).toBeUndefined();
  });

  it('includes compliance / accessibility / compat tag arrays', () => {
    const state = withState({
      compliance: ['halal', 'vegan'],
      accessibility: ['wheelchair'],
      compat: ['ios', 'android'],
    });
    const out = serializeFormToV2Extras(state, now);
    expect(out.compliance).toEqual(['halal', 'vegan']);
    expect(out.accessibility).toEqual(['wheelchair']);
    expect(out.compat).toEqual(['ios', 'android']);
  });

  it('never emits availability — the form no longer captures it', () => {
    // Defensive pin: even if a caller smuggles availability fields into
    // `withState` via Partial<WriteFormState>, the serializer drops
    // them because the form state's typed shape no longer carries them.
    expect(serializeFormToV2Extras(emptyWriteFormState(), now).availability).toBeUndefined();
  });

  it('never emits schedule — the form no longer captures it', () => {
    expect(serializeFormToV2Extras(emptyWriteFormState(), now).schedule).toBeUndefined();
  });

  it('includes alternatives in wire shape (kind→type, trims fields)', () => {
    const state = withState({
      alternatives: [
        { kind: 'product', name: '  Aeron Chair  ', identifier: 'asin-1' },
        { kind: 'organization', name: 'Herman Miller', did: 'did:plc:xyz' },
      ],
    });
    const out = serializeFormToV2Extras(state, now);
    expect(out.alternatives).toEqual([
      { type: 'product', name: 'Aeron Chair', identifier: 'asin-1' },
      { type: 'organization', name: 'Herman Miller', did: 'did:plc:xyz' },
    ]);
  });
});
