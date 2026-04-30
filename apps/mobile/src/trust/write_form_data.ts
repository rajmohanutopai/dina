/**
 * Compose-flow form-state derivation (TN-MOB-013 / Plan §8.6).
 *
 * The compose screen captures four fields:
 *   - sentiment (positive / neutral / negative — required)
 *   - headline (≤ 140 chars per Plan §8.5 — required)
 *   - body (≤ 4000 chars — optional)
 *   - confidence (certain / high / moderate / speculative — required)
 *
 * The validation logic (which combinations are publishable, what the
 * disabled state of the Publish button is, what error message to
 * surface inline) is non-trivial enough to deserve its own pure
 * module — saves the screen from interleaving form rules with
 * RN-specific rendering.
 *
 * Headline length: Plan §8.5 sets 140 chars as the cap. Body
 * length: 4000 chars is the conservative AppView Zod schema bound.
 * Both checks are bytes-of-UTF-16 (JS string `.length`) — same as
 * AppView's Zod `max(140)` interprets them, so the mobile preflight
 * + the AppView server-side check agree.
 *
 * Pure function. No state. Tested under plain Jest.
 */

import type { Sentiment, Confidence } from '@dina/protocol';

// ─── Public constants ─────────────────────────────────────────────────────

export const HEADLINE_MAX_LENGTH = 140;
export const BODY_MAX_LENGTH = 4000;

/** Closed enum of the sentiment selector buttons. Order = display order. */
export const SENTIMENT_OPTIONS: ReadonlyArray<Sentiment> = ['positive', 'neutral', 'negative'];

/** Closed enum of the confidence selector buttons. Order = display order. */
export const CONFIDENCE_OPTIONS: ReadonlyArray<Confidence> = [
  'certain',
  'high',
  'moderate',
  'speculative',
];

// ─── Public types ─────────────────────────────────────────────────────────

/** Form state — all fields, exactly the shape the screen renders. */
export interface WriteFormState {
  readonly sentiment: Sentiment | null;
  readonly headline: string;
  readonly body: string;
  readonly confidence: Confidence | null;
}

/**
 * Closed taxonomy of validation errors. Closed-enum lets the screen
 * exhaustive-switch the rendering — adding a new error class lights
 * up unhandled-case errors at every render site.
 */
export type WriteFormError =
  | 'headline_empty'
  | 'headline_too_long'
  | 'body_too_long'
  | 'sentiment_required'
  | 'confidence_required';

export interface WriteFormValidation {
  /** True when the form's current state can be published. */
  readonly canPublish: boolean;
  /** Per-field errors. Empty when the field is valid. */
  readonly errors: ReadonlyArray<WriteFormError>;
  /** Headline character count (bytes-of-UTF-16). Surfaced as "X / 140". */
  readonly headlineLength: number;
  /** Body character count. Surfaced as "X / 4000". */
  readonly bodyLength: number;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Build the empty initial state for a fresh compose flow.
 *
 * The screen passes this to its `useState`/store on mount when
 * starting a new review. For the EDIT flow the screen seeds the
 * state from the existing record's fields instead — `WriteFormState`
 * is the same shape either way.
 */
export function emptyWriteFormState(): WriteFormState {
  return {
    sentiment: null,
    headline: '',
    body: '',
    confidence: null,
  };
}

/**
 * Validate the form. Pure, deterministic — call on every render
 * from a `useMemo` to drive the Publish button's disabled state and
 * the inline error labels.
 */
export function validateWriteForm(state: WriteFormState): WriteFormValidation {
  const errors: WriteFormError[] = [];
  const headline = state.headline.trim();
  const body = state.body.trim();

  if (headline.length === 0) errors.push('headline_empty');
  // Length cap uses the RAW value (untrimmed) — the user can see
  // their character count tick up exactly as they type.
  if (state.headline.length > HEADLINE_MAX_LENGTH) errors.push('headline_too_long');
  if (state.body.length > BODY_MAX_LENGTH) errors.push('body_too_long');
  if (state.sentiment === null) errors.push('sentiment_required');
  if (state.confidence === null) errors.push('confidence_required');

  return {
    canPublish: errors.length === 0,
    errors,
    headlineLength: state.headline.length,
    bodyLength: body.length,
  };
}

/**
 * Human-readable label for a `WriteFormError`. Surfaced inline
 * under the affected field. Hard-coded en-only at this stage — the
 * keys are stable so a future i18n bundle lifts them out cleanly.
 */
export function describeWriteFormError(error: WriteFormError): string {
  switch (error) {
    case 'headline_empty':
      return 'A headline is required.';
    case 'headline_too_long':
      return `Headline must be ${HEADLINE_MAX_LENGTH} characters or fewer.`;
    case 'body_too_long':
      return `Body must be ${BODY_MAX_LENGTH} characters or fewer.`;
    case 'sentiment_required':
      return 'Choose a sentiment.';
    case 'confidence_required':
      return 'Choose a confidence level.';
  }
}
