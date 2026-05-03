/**
 * Shared helpers for publishing a review attestation.
 *
 * Two surfaces need the same publish payload shape:
 *   1. The full Write/Edit form (`app/trust/write.tsx`) — primary path.
 *   2. The chat-driven inline review-draft card
 *      (`InlineReviewDraftCard`) — Publish straight from the card.
 *
 * Keeping the helpers (`subjectStateToRef`, `categoryFor`,
 * `composeText`, `buildAttestationRecord`) in one module means both
 * surfaces always agree on the canonical SubjectRef tuple — important
 * because AppView hashes that tuple to compute `subject_id`. Diverging
 * helpers would mint a different subject id and split reviews of the
 * same subject across two rows.
 */

import type { SubjectRef as SubjectRefBody } from '@dina/protocol';

import {
  serializeFormToV2Extras,
  type SubjectKind,
  type WriteFormState,
  type WriteSubjectState,
} from './write_form_data';

/**
 * Map the form's per-kind subject inputs into the `SubjectRef` shape
 * AppView expects. Empty fields are dropped — AppView's subject
 * resolver hashes the canonical (`type`, `did`/`uri`/`identifier`,
 * `name`) tuple, so emitting empty strings would mint a different
 * `subject_id` than callers who supply the same fields.
 */
export function subjectStateToRef(s: WriteSubjectState): SubjectRefBody {
  const out: SubjectRefBody = { type: s.kind };
  if (s.name.trim().length > 0) out.name = s.name.trim();
  if (s.did.trim().length > 0) out.did = s.did.trim();
  if (s.uri.trim().length > 0) out.uri = s.uri.trim();
  if (s.identifier.trim().length > 0) out.identifier = s.identifier.trim();
  return out;
}

/**
 * Reasonable default category per subject kind. AppView indexes
 * free-text categories (no closed taxonomy enforced server-side); we
 * pick a sensible top-level slug so the subject card's subtitle renders
 * something meaningful by default.
 */
export function categoryFor(kind: SubjectKind): string {
  switch (kind) {
    case 'product':
      return 'commerce/product';
    case 'place':
      return 'place/general';
    case 'organization':
      return 'organization/general';
    case 'content':
      return 'content/web';
    case 'did':
      return 'identity/person';
    case 'dataset':
      return 'content/dataset';
    case 'claim':
      return 'claim/general';
  }
}

/**
 * Compose the attestation `text` field from the headline + body.
 * Headline is the front-of-card lede; body is optional context.
 * Concatenated with a paragraph break so AppView's FTS index covers
 * both — single-field stays simple; future schema can split if the
 * scoring pipeline benefits from headline-vs-body weighting.
 */
export function composeText(headline: string, body: string): string {
  const h = headline.trim();
  const b = body.trim();
  if (h.length === 0 && b.length === 0) return '';
  if (h.length === 0) return b;
  if (b.length === 0) return h;
  return `${h}\n\n${b}`;
}

/**
 * Build the full attestation record body from a publishable form
 * state. Caller supplies `formState.subject` (non-null — the form's
 * publish guard already enforces that) and the helper handles
 * subject-ref + category + text composition + V2 extras spread.
 *
 * Returns the `record` object the caller passes to `injectAttestation`
 * — it does NOT call `injectAttestation` itself so the caller can pick
 * its own `authorDid`, `rkey`, and `cid`.
 */
export function buildAttestationRecord(
  formState: WriteFormState,
): Record<string, unknown> {
  const subject = formState.subject;
  if (subject === null) {
    throw new Error('buildAttestationRecord: formState.subject is null');
  }
  const subjectRef = subjectStateToRef(subject);
  const v2Extras = serializeFormToV2Extras(formState);
  return {
    subject: subjectRef,
    category: categoryFor(subject.kind),
    sentiment: formState.sentiment,
    confidence: formState.confidence,
    text: composeText(formState.headline, formState.body),
    tags: formState.body.length > 0 ? [] : undefined,
    createdAt: new Date().toISOString(),
    ...v2Extras,
  };
}

/**
 * Generate a per-publish identity tuple (`rkey` + placeholder `cid`).
 * Both surfaces (form + inline card) need identical shape so the
 * AppView's record-id derivation stays consistent — the `cid` is a
 * placeholder that the actual PDS write replaces with a real CID.
 */
export function newPublishKeys(): { rkey: string; cid: string } {
  const ts = Date.now().toString(36);
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    rkey: `mob-${ts}-${suffix}`,
    cid: `bafyreim${ts}`,
  };
}
