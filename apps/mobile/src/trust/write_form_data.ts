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
export const SUBJECT_NAME_MAX_LENGTH = 200;
export const SUBJECT_IDENTIFIER_MAX_LENGTH = 256;

/** Closed enum of the sentiment selector buttons. Order = display order. */
export const SENTIMENT_OPTIONS: ReadonlyArray<Sentiment> = ['positive', 'neutral', 'negative'];

/** Closed enum of the confidence selector buttons. Order = display order. */
export const CONFIDENCE_OPTIONS: ReadonlyArray<Confidence> = [
  'certain',
  'high',
  'moderate',
  'speculative',
];

/**
 * AppView's `subject.type` taxonomy (mirror of
 * `appview/src/shared/types/lexicon-types.ts:SubjectRef.type`). Order
 * matches the order the picker renders.
 */
export type SubjectKind =
  | 'product'
  | 'place'
  | 'organization'
  | 'content'
  | 'did'
  | 'dataset'
  | 'claim';

export const SUBJECT_KIND_OPTIONS: ReadonlyArray<SubjectKind> = [
  'product',
  'place',
  'organization',
  'content',
  'did',
  'dataset',
  'claim',
];

/**
 * Per-kind hint copy. Surfaced under the picker so the user knows
 * what kind of identifier each option expects. Keep these short — they
 * fit on one line under the chip row.
 */
export const SUBJECT_KIND_HINT: Record<SubjectKind, string> = {
  product: 'A reviewable product (e.g. Aeron Chair, ASIN, ISBN).',
  place: 'A location — restaurant, venue, address.',
  organization: 'A company, publisher, or service provider.',
  content: 'An article, video, podcast, or web page (URL).',
  did: 'A person or AT-protocol identity (did:plc / did:web).',
  dataset: 'A published dataset with a stable URI.',
  claim: 'A factual claim that can be sourced or contested.',
};

// ─── Public types ─────────────────────────────────────────────────────────

/** Form state — all fields, exactly the shape the screen renders. */
export interface WriteFormState {
  readonly sentiment: Sentiment | null;
  readonly headline: string;
  readonly body: string;
  readonly confidence: Confidence | null;
  /**
   * Subject describe-fields (TN-MOB-021). When the screen receives a
   * `subjectId` URL param, `subject` is `null` — the subject already
   * exists in AppView and the form publishes against the existing row.
   * When the user reaches the form via "Add to trust network" (no
   * existing subject), the screen prompts them to fill these fields,
   * and the publish payload carries them as `record.subject`.
   */
  readonly subject: WriteSubjectState | null;
}

/**
 * Per-kind subject input. The screen swaps the visible fields based on
 * `kind`, but the state shape is unified so a kind change doesn't
 * discard already-entered values (a user who types a name then picks
 * a different kind keeps the name).
 */
export interface WriteSubjectState {
  readonly kind: SubjectKind;
  readonly name: string;
  /** DID for `did` / `organization` subjects. */
  readonly did: string;
  /** URI for `content` / `dataset` subjects (often a URL). */
  readonly uri: string;
  /** Stable identifier for `product` / `claim` / `place`. */
  readonly identifier: string;
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
  | 'confidence_required'
  | 'subject_name_required'
  | 'subject_name_too_long'
  | 'subject_did_required'
  | 'subject_did_invalid'
  | 'subject_uri_required'
  | 'subject_uri_invalid'
  | 'subject_identifier_required'
  | 'subject_identifier_too_long';

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
    subject: null,
  };
}

/**
 * Initial state when the user opens the form WITHOUT an existing
 * subjectId (the "describe a new item" path). The kind defaults to
 * `product` because that's the most common review target — the user
 * can pick another kind from the chip row.
 */
export function emptyWriteFormStateWithSubject(
  kind: SubjectKind = 'product',
): WriteFormState {
  return {
    ...emptyWriteFormState(),
    subject: emptySubjectState(kind),
  };
}

export function emptySubjectState(kind: SubjectKind): WriteSubjectState {
  return { kind, name: '', did: '', uri: '', identifier: '' };
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

  // Subject validation — only fires when the form is in
  // "describe a new subject" mode. Forms backed by an existing
  // subjectId leave `subject` null/undefined and skip these checks.
  // Treat undefined as null so legacy callers (tests with old-shape
  // `initial`, edit-mode payloads from the runner) keep working.
  if (state.subject != null) {
    errors.push(...validateSubjectState(state.subject));
  }

  return {
    canPublish: errors.length === 0,
    errors,
    headlineLength: state.headline.length,
    bodyLength: body.length,
  };
}

/**
 * Per-kind subject validation. Returned errors are appended to the
 * outer form's error list so the screen renders them under the
 * relevant subject input.
 */
export function validateSubjectState(
  subject: WriteSubjectState,
): ReadonlyArray<WriteFormError> {
  const errors: WriteFormError[] = [];
  const name = subject.name.trim();

  if (name.length === 0) errors.push('subject_name_required');
  if (subject.name.length > SUBJECT_NAME_MAX_LENGTH) errors.push('subject_name_too_long');

  switch (subject.kind) {
    case 'did':
      if (subject.did.trim().length === 0) errors.push('subject_did_required');
      else if (!isPlausibleDid(subject.did)) errors.push('subject_did_invalid');
      break;
    case 'organization':
      // Organization-level reviews don't strictly need a DID — a name
      // alone is fine (e.g. "Aeron Chairs" without a DID). If the user
      // does provide a DID, validate its shape.
      if (subject.did.trim().length > 0 && !isPlausibleDid(subject.did)) {
        errors.push('subject_did_invalid');
      }
      break;
    case 'content':
    case 'dataset':
      if (subject.uri.trim().length === 0) errors.push('subject_uri_required');
      else if (!isPlausibleUri(subject.uri)) errors.push('subject_uri_invalid');
      break;
    case 'product':
    case 'place':
    case 'claim':
      if (subject.identifier.length > SUBJECT_IDENTIFIER_MAX_LENGTH) {
        errors.push('subject_identifier_too_long');
      }
      // identifier is OPTIONAL for these kinds — name alone is enough
      // to disambiguate within AppView's hash-based subjectId.
      break;
  }
  return errors;
}

function isPlausibleDid(value: string): boolean {
  return /^did:[a-z]+:[A-Za-z0-9._:%-]+$/.test(value.trim());
}

function isPlausibleUri(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim());
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
    case 'subject_name_required':
      return 'Give the subject a name.';
    case 'subject_name_too_long':
      return `Name must be ${SUBJECT_NAME_MAX_LENGTH} characters or fewer.`;
    case 'subject_did_required':
      return 'Enter the subject’s DID (did:plc:… or did:web:…).';
    case 'subject_did_invalid':
      return 'That doesn’t look like a valid DID.';
    case 'subject_uri_required':
      return 'Enter the URL or AT-URI.';
    case 'subject_uri_invalid':
      return 'That URL or URI is malformed.';
    case 'subject_identifier_required':
      return 'An identifier is required.';
    case 'subject_identifier_too_long':
      return `Identifier must be ${SUBJECT_IDENTIFIER_MAX_LENGTH} characters or fewer.`;
  }
}
