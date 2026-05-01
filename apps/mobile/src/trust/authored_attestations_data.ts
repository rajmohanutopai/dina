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
   * Headline / body text the reviewer wrote. Empty string when the
   * attestation carries dimensions only (no text). Caller decides
   * whether to render — the screen suppresses the line on empty.
   */
  readonly headline: string;
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
    out.push({
      uri: hit.uri,
      subjectId: hit.subjectId,
      subjectTitle,
      category,
      sentiment: hit.sentiment,
      headline: typeof hit.text === 'string' ? hit.text : '',
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
