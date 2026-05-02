/**
 * Display data layer for the "reviews authored by this DID" list on
 * the reviewer profile screen.
 *
 * The screen shows a list of attestation rows for everything a
 * particular DID has written. Each row points at a subject — tapping
 * drills into `/trust/<subjectId>`. We project the `SearchAttestationHit`
 * wire shape into a render-ready `AuthoredAttestationRow` so the
 * screen layer stays branch-free.
 *
 * Pure: no React, no I/O. Same convention as `subject_card.ts` and
 * `reviewer_profile_data.ts`.
 */

import type { SearchAttestationHit } from './appview_runtime';

/**
 * One row in the "Reviews written" list.
 */
export interface AuthoredAttestationRow {
  /** Stable identity of the row; used as React `key` + tap target. */
  readonly uri: string;
  /** Subject the review points at — the drill-down destination. */
  readonly subjectId: string;
  /**
   * Subject kind (`product`, `place`, `did`, …). Forwarded from
   * `subjectRefRaw.type`. Carried so the edit-publish path can
   * reconstruct the same SubjectRef → same `subject_id` hash. Drilling
   * into the subject card doesn't need it (the card looks up by
   * subjectId), but edit does.
   */
  readonly subjectKind:
    | 'did'
    | 'organization'
    | 'product'
    | 'content'
    | 'dataset'
    | 'place'
    | 'claim';
  /**
   * Identifying URI for `content` subjects (web URL, etc.). Forwarded
   * verbatim from `subjectRefRaw.uri`. `null` when absent on the wire
   * (e.g. non-content subjects, or content subjects published before
   * the URI was indexed). Edit-publish path passes this through to
   * the write screen as `subjectIdentifier` so the SubjectRef hashes
   * the same way as the original.
   */
  readonly subjectUri: string | null;
  /**
   * DID identifier for `did` / `organization` subjects. Forwarded
   * verbatim from `subjectRefRaw.did`. `null` when absent.
   */
  readonly subjectDid: string | null;
  /**
   * Human-readable subject title. Falls back through
   * `subjectRefRaw.name → did → uri → subjectId` so we always have
   * SOMETHING to render — `subjectId` is a hash and not friendly,
   * but it's better than an empty row.
   */
  readonly subjectTitle: string;
  /**
   * Optional category label (`'office_furniture/chair'` etc.) for
   * the subtitle slot. `null` when not categorised — the screen
   * hides the slot rather than rendering `'—'`.
   */
  readonly category: string | null;
  /** Review sentiment for the chip colour + label. */
  readonly sentiment: 'positive' | 'neutral' | 'negative';
  /**
   * Headline the reviewer wrote — the front-of-card lede. `text` on
   * the wire is `${headline}\n\n${body}`; we split on the first blank
   * line so the row card and any edit-mode pre-fill can show the
   * lede separately from the long-form body.
   */
  readonly headline: string;
  /**
   * Long-form body — everything after the first blank line in the
   * wire `text`. Empty string when the reviewer only wrote a
   * headline (most reviews) or when the attestation carries
   * dimensions only.
   */
  readonly body: string;
  /**
   * Confidence the reviewer asserted on the original record. `null`
   * when the wire didn't include one (older records pre-confidence,
   * or attestation kinds that don't take a confidence). Edit-mode
   * pre-fill uses this; the row card itself doesn't render it
   * today.
   */
  readonly confidence: 'certain' | 'high' | 'moderate' | 'speculative' | null;
  /** Created-at ms timestamp for relative-time formatting. */
  readonly createdAtMs: number;
}

/**
 * Project search hits into rows. Hits with a missing/blank
 * `subjectId` are dropped (a row pointing nowhere is worse than no
 * row). Order is preserved from the wire (which is recent-first
 * when fetched via `searchAttestationsByAuthor`'s `sort=recent`).
 */
export function deriveAuthoredAttestationRows(
  hits: ReadonlyArray<SearchAttestationHit>,
): AuthoredAttestationRow[] {
  const out: AuthoredAttestationRow[] = [];
  for (const hit of hits) {
    if (!hit.subjectId) continue;
    const ref = hit.subjectRefRaw ?? { type: 'claim' };
    const subjectTitle =
      pickFirstNonEmpty(ref.name, ref.did, ref.uri, ref.domain) ?? hit.subjectId;
    const category = isNonEmpty(hit.category) ? hit.category : null;
    const { headline, body } = splitHeadlineBody(
      typeof hit.text === 'string' ? hit.text : '',
    );
    out.push({
      uri: hit.uri,
      subjectId: hit.subjectId,
      subjectKind: ref.type,
      subjectUri: typeof ref.uri === 'string' && ref.uri.length > 0 ? ref.uri : null,
      subjectDid: typeof ref.did === 'string' && ref.did.length > 0 ? ref.did : null,
      subjectTitle,
      category,
      sentiment: hit.sentiment,
      headline,
      body,
      confidence: hit.confidence ?? null,
      // Date.parse returns NaN for malformed input — fall back to 0
      // so the row still renders (with a "long ago" relative label
      // that the screen formatter handles defensively).
      createdAtMs: Number.isFinite(Date.parse(hit.recordCreatedAt))
        ? Date.parse(hit.recordCreatedAt)
        : 0,
    });
  }
  return out;
}

function pickFirstNonEmpty(
  ...candidates: Array<string | undefined>
): string | null {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c;
  }
  return null;
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Inverse of `composeText` from the write screen — splits the wire
 * `text` into a headline + body on the first blank-line separator
 * (`\n\n`). Mirrors how the publish path joins them, so a round-trip
 * through publish → search → edit-prefill reconstructs the same form
 * state. When there's no separator, all the text is the headline
 * (the reviewer wrote a single-line review).
 */
function splitHeadlineBody(text: string): {
  headline: string;
  body: string;
} {
  const sep = text.indexOf('\n\n');
  if (sep < 0) return { headline: text, body: '' };
  return {
    headline: text.slice(0, sep),
    body: text.slice(sep + 2),
  };
}
