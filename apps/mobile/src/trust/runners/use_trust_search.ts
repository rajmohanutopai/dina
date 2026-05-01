/**
 * Search runner — wraps `com.dina.trust.search` for the search screen.
 *
 * Maps the AppView attestation hits into the per-subject card model the
 * presentational `<SearchScreen />` expects. One subject = one card,
 * with the attestations grouped under it as the card's `reviews`.
 *
 * `enabled` is the controlled-vs-uncontrolled gate: tests pass
 * `enabled: false` (or simply don't mount this hook) to keep the
 * screen pure; production routes pass `enabled: true` and the hook
 * drives the network round-trip.
 */

import { useEffect, useState } from 'react';
import { searchAttestations, type SearchAttestationHit } from '../appview_runtime';
import { displayName } from '../handle_display';
import { deriveSubjectCard, type SubjectCardInput, type SubjectReview } from '../subject_card';
import type { SearchResult } from '../../../app/trust/search';

export interface TrustSearchState {
  results: readonly SearchResult[];
  isLoading: boolean;
  error: string | null;
}

export interface UseTrustSearchOptions {
  q: string;
  enabled: boolean;
  retryNonce?: number;
}

const EMPTY: readonly SearchResult[] = [];

export function useTrustSearch(opts: UseTrustSearchOptions): TrustSearchState {
  const { q, enabled, retryNonce = 0 } = opts;
  const [state, setState] = useState<TrustSearchState>({
    results: EMPTY,
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    if (!enabled) return;
    const trimmed = q.trim();
    if (trimmed.length === 0) {
      setState({ results: EMPTY, isLoading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ results: EMPTY, isLoading: true, error: null });
    searchAttestations(trimmed, 50)
      .then((response) => {
        if (cancelled) return;
        const grouped = groupHitsToSearchResults(response.results);
        setState({ results: grouped, isLoading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof Error
            ? err.message
            : 'Search failed. Check your connection and try again.';
        setState({ results: EMPTY, isLoading: false, error: msg });
      });
    return () => {
      cancelled = true;
    };
  }, [q, enabled, retryNonce]);

  return state;
}

// ─── Grouping helpers ─────────────────────────────────────────────────────

/**
 * Group a flat list of attestation hits by subject, then derive one
 * card display per subject. Cards are ordered by review count (desc),
 * then alphabetically on title for deterministic output.
 */
function groupHitsToSearchResults(hits: SearchAttestationHit[]): readonly SearchResult[] {
  if (hits.length === 0) return EMPTY;
  const buckets = new Map<string, { input: SubjectCardInput; reviews: SubjectReview[] }>();
  for (const hit of hits) {
    const subjectId = hit.subjectId;
    if (!subjectId) continue;
    const ref = hit.subjectRefRaw ?? {};
    const title = ref.name ?? ref.did ?? ref.uri ?? subjectId;
    const review: SubjectReview = {
      ring: 'stranger',
      reviewerDid: hit.authorDid,
      reviewerTrustScore: null,
      // Prefer the resolved handle (`alice.pds.dinakernel.com`)
      // when AppView has backfilled it; fall back to a truncated
      // DID via the shared `displayName` helper. Keeps search
      // cards visually consistent with subject detail / feed.
      reviewerName: displayName(hit.authorHandle, hit.authorDid),
      headline: hit.text ?? '',
      createdAtMs: Date.parse(hit.recordCreatedAt) || Date.now(),
    };
    const existing = buckets.get(subjectId);
    if (existing) {
      existing.reviews.push(review);
      existing.input = {
        ...existing.input,
        reviewCount: existing.input.reviewCount + 1,
        reviews: existing.reviews,
      };
    } else {
      const reviews: SubjectReview[] = [review];
      const input: SubjectCardInput = {
        title,
        category: hit.category ?? null,
        subjectTrustScore: null,
        reviewCount: 1,
        reviews,
      };
      buckets.set(subjectId, { input, reviews });
    }
  }

  const out: SearchResult[] = [];
  for (const [subjectId, { input }] of buckets) {
    out.push({ subjectId, display: deriveSubjectCard(input) });
  }
  out.sort((a, b) => {
    const dr = b.display.reviewCount - a.display.reviewCount;
    if (dr !== 0) return dr;
    return a.display.title.localeCompare(b.display.title);
  });
  return out;
}
