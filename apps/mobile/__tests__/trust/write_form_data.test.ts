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
  HEADLINE_MAX_LENGTH,
  BODY_MAX_LENGTH,
  SENTIMENT_OPTIONS,
  CONFIDENCE_OPTIONS,
  type WriteFormState,
  type WriteFormError,
} from '../../src/trust/write_form_data';

function withState(overrides: Partial<WriteFormState> = {}): WriteFormState {
  return { ...emptyWriteFormState(), ...overrides };
}

describe('emptyWriteFormState', () => {
  it('returns null sentiment + confidence and empty strings', () => {
    expect(emptyWriteFormState()).toEqual({
      sentiment: null,
      headline: '',
      body: '',
      confidence: null,
      // `subject: null` marks the form as "review-only" — backed by an
      // existing AppView subjectId. The describe-a-new-subject path
      // uses `emptyWriteFormStateWithSubject()` instead.
      subject: null,
    });
  });
});

describe('validateWriteForm — required fields', () => {
  it('empty form has all four errors and canPublish=false', () => {
    const v = validateWriteForm(emptyWriteFormState());
    expect(v.canPublish).toBe(false);
    expect(v.errors).toEqual(
      expect.arrayContaining([
        'headline_empty',
        'sentiment_required',
        'confidence_required',
      ]),
    );
  });

  it('headline + body filled but no sentiment/confidence still fails', () => {
    const v = validateWriteForm(
      withState({ headline: 'Great chair', body: '' }),
    );
    expect(v.canPublish).toBe(false);
    expect(v.errors).toEqual(
      expect.arrayContaining(['sentiment_required', 'confidence_required']),
    );
    expect(v.errors).not.toContain('headline_empty');
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
  ] as Array<[WriteFormError, RegExp]>)('describes %s', (err, pattern) => {
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
