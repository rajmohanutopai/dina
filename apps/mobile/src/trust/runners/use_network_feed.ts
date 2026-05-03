/**
 * Network feed runner — wraps `com.dina.trust.networkFeed` for the
 * Trust tab landing screen. Returns `{ feed, isLoading, error }`
 * for the screen to consume; tests pass `enabled: false` to keep the
 * screen presentational.
 *
 * Maps the AppView attestation rows into the `FeedItem[]` shape the
 * landing screen expects (subjectCardDisplay-derived). Each
 * attestation becomes one feed entry — the surface is "what reviewers
 * I trust just published" so a reviewer-by-reviewer chronological
 * timeline is what we want, NOT a subject-grouped roll-up (search
 * already groups by subject).
 */

import { useEffect, useState } from 'react';

import { networkFeed, type NetworkFeedAttestation } from '../appview_runtime';
import { displayName } from '../handle_display';
import {
  deriveSubjectCard,
  type SubjectCardDisplay,
  type SubjectCardInput,
  type SubjectReview,
} from '../subject_card';

/**
 * Shape for one row of the trust-feed list. Defined here to avoid a
 * cycle with `app/trust/index.tsx` (which imports this runner).
 */
export interface FeedItem {
  readonly subjectId: string;
  readonly display: SubjectCardDisplay;
}

export interface NetworkFeedState {
  feed: readonly FeedItem[];
  isLoading: boolean;
  error: string | null;
}

export interface UseNetworkFeedOptions {
  viewerDid: string;
  enabled: boolean;
  retryNonce?: number;
}

const EMPTY: readonly FeedItem[] = [];

export function useNetworkFeed(opts: UseNetworkFeedOptions): NetworkFeedState {
  const { viewerDid, enabled, retryNonce = 0 } = opts;
  const [state, setState] = useState<NetworkFeedState>({
    feed: EMPTY,
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    if (!enabled) return;
    if (!viewerDid || !viewerDid.startsWith('did:')) return;
    let cancelled = false;
    setState({ feed: EMPTY, isLoading: true, error: null });
    networkFeed(viewerDid, 25)
      .then((response) => {
        if (cancelled) return;
        const items = mapToFeedItems(response.attestations, viewerDid);
        setState({ feed: items, isLoading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof Error
            ? err.message
            : "Couldn't load your network feed. Try again in a moment.";
        setState({ feed: EMPTY, isLoading: false, error: msg });
      });
    return () => {
      cancelled = true;
    };
  }, [viewerDid, enabled, retryNonce]);

  return state;
}

// ─── Mapper ───────────────────────────────────────────────────────────────

/**
 * Convert each attestation into a one-card `FeedItem`. The card is
 * derived from `SubjectCardInput` so it matches the search/results
 * card visuals; we synthesize a minimal `reviews: [oneReview]` set so
 * the card's "top reviewer" line picks up THIS attestation's author +
 * headline. Subject score is unknown at this surface (the wire
 * doesn't carry it), so the card renders without a band badge —
 * matches the search-result card behaviour.
 */
function mapToFeedItems(
  rows: ReadonlyArray<NetworkFeedAttestation>,
  viewerDid: string,
): FeedItem[] {
  const out: FeedItem[] = [];
  for (const row of rows) {
    if (row.subjectId === null) continue;
    const ref = row.subjectRefRaw ?? {};
    const title = ref.name ?? ref.did ?? ref.uri ?? row.subjectId;
    const review: SubjectReview = {
      ring: 'contact', // 1-hop authors ARE the user's contacts.
      reviewerDid: row.authorDid,
      reviewerTrustScore: null,
      // Prefer the resolved handle (`alice.pds.dinakernel.com`) over
      // the raw DID. `displayName` falls back to a truncated DID when
      // the handle isn't yet populated by `backfill-handles`.
      reviewerName: displayName(row.authorHandle, row.authorDid),
      headline: row.text ?? '',
      createdAtMs: Date.parse(row.recordCreatedAt) || Date.now(),
    };
    const input: SubjectCardInput = {
      title,
      category: row.category ?? null,
      subjectTrustScore: null,
      reviewCount: 1,
      reviews: [review],
    };
    out.push({
      subjectId: row.subjectId,
      display: deriveSubjectCard(input, { viewerDid }),
    });
  }
  return out;
}
