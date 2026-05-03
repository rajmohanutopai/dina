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
import { listContacts } from '@dina/core/src/contacts/directory';
import { searchAttestations, type SearchAttestationHit } from '../appview_runtime';
import { annotateReviewRing, compareCards } from '../contact_rerank';
import { displayName } from '../handle_display';
import { deriveSubjectCard, type SubjectCardInput, type SubjectReview } from '../subject_card';
import { getBootedNode } from '../../hooks/useNodeBootstrap';
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
    // Read the keystore-resident contact directory at search time
    // (sync — the directory hydrates once during persona unlock and
    // stays in memory). Snapshot a Set<DID> so the per-review lookup
    // inside `groupHitsToSearchResults` is O(1). Loyalty Law: this
    // set NEVER leaves the device — the AppView call above runs
    // un-personalised; the local re-rank happens on the response.
    const contactDids = new Set(
      listContacts()
        .map((c) => c.did)
        .filter((did): did is string => typeof did === 'string' && did.length > 0),
    );
    // Pull the booted-node DID so the data layer can flag self-
    // authored attestations even if the wire `ring` came back as
    // 'stranger' (AppView bucketing miss). Empty string is safe — the
    // override in `deriveSubjectCard` short-circuits when viewerDid
    // is falsy.
    const viewerDid = getBootedNode()?.did ?? null;
    searchAttestations(trimmed, 50)
      .then((response) => {
        if (cancelled) return;
        const grouped = groupHitsToSearchResults(response.results, contactDids, viewerDid);
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
 * card display per subject.
 *
 * **Contact-aware re-rank** (Loyalty-Law-clean): when a hit's
 * `authorDid` matches a DID in `contactDids` (the local keystore
 * contact directory), the review's ring flips from `'stranger'`
 * to `'contact'`. The subject_card's existing `friendsPill`
 * derivation already buckets `'self' | 'contact'` as friends and
 * everything else as strangers, so the count surfaces naturally.
 * Cards are then sorted so any-contact cards rank above no-contact
 * cards (within each bucket: review count DESC, title alphabetical).
 *
 * Why "boost is a flag, not a multiplier" matches the V1 plan §7
 * server-side semantic and is documented in `contact_rerank.ts`.
 */
function groupHitsToSearchResults(
  hits: SearchAttestationHit[],
  contactDids: ReadonlySet<string>,
  viewerDid: string | null,
): readonly SearchResult[] {
  if (hits.length === 0) return EMPTY;
  const buckets = new Map<string, { input: SubjectCardInput; reviews: SubjectReview[] }>();
  for (const hit of hits) {
    const subjectId = hit.subjectId;
    if (!subjectId) continue;
    const ref = hit.subjectRefRaw ?? {};
    const title = ref.name ?? ref.did ?? ref.uri ?? subjectId;
    const review: SubjectReview = {
      ring: annotateReviewRing(hit.authorDid, contactDids, 'stranger'),
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
        // Forward the wire's subject kind so the card subtitle
        // can show "Product" instead of "Commerce" for the
        // generic `commerce/product` category fallback. Without
        // this the card label reads as the wrong taxonomy level.
        subjectKind: ref.type ?? null,
      };
      buckets.set(subjectId, { input, reviews });
    }
  }

  const out: SearchResult[] = [];
  for (const [subjectId, { input }] of buckets) {
    out.push({ subjectId, display: deriveSubjectCard(input, { viewerDid }) });
  }
  // Contact-aware re-rank: any-contact cards rank above no-contact
  // cards; within each bucket, V1's review-count-DESC + title-asc
  // tiebreak. Pure helper exported for tests.
  out.sort(compareCards);
  return out;
}
