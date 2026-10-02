/**
 * Which suppliers Ask for quotes sets aside, from PeerLens.
 *
 * A supplier is still SHOWN (the owner sees who sells it, and why Dina left
 * one out), but not asked unless the owner taps "Ask anyway":
 *
 *   - the owner's own newest review of the supplier is negative. The owner's
 *     own experience decides alone: one review is enough, the ranked-review
 *     minimum is for other people's reviews;
 *   - otherwise, a low PeerLens score over enough reviews to mean something
 *     (`RANKED_MIN_REVIEWS`). A score over one or two strangers' reviews is
 *     not a verdict, and a supplier with no reviews is not low trust.
 *
 * The owner's own positive or neutral review wins over a low network score:
 * they have traded with the supplier and chose to say so.
 *
 * Read-only: nothing here contacts a supplier or writes a review.
 */

import { searchAttestationsByAuthor, type SearchAttestationHit } from '../peerlens/appview_runtime';
import { RANKED_MIN_REVIEWS } from '../peerlens/review_source_label';

/** Below this PeerLens score a supplier reads "Low trust" (the picker's words). */
export const LOW_TRUST_BELOW = 0.4;
/** How many of the owner's own reviews are read (the AppView's page limit). */
const OWN_REVIEWS_READ = 100;

export type SetAsideReason = 'own_poor_review' | 'low_peerlens_trust';

export interface SetAside {
  reason: SetAsideReason;
  /** One line for the supplier row. */
  words: string;
  /** The owner's review text, when that is the reason; '' otherwise. */
  note: string;
}

/** The owner's newest review of one supplier. */
export interface OwnReview {
  sentiment: 'positive' | 'neutral' | 'negative';
  text: string | null;
  createdAt: string;
}

/**
 * The owner's reviews by the DID they are about, newest per DID. A review of
 * a person or an organisation carries the DID; a review of a product or a
 * place does not, and says nothing about a supplier here.
 */
export function ownReviewsBySupplier(
  hits: readonly SearchAttestationHit[],
): Map<string, OwnReview> {
  const out = new Map<string, OwnReview>();
  for (const hit of hits) {
    const did = hit.subjectRefRaw.did;
    if (did === undefined || did === '') continue;
    const held = out.get(did);
    if (held !== undefined && Date.parse(held.createdAt) >= Date.parse(hit.recordCreatedAt))
      continue;
    out.set(did, { sentiment: hit.sentiment, text: hit.text, createdAt: hit.recordCreatedAt });
  }
  return out;
}

/** Why this supplier is set aside, or null when it may be asked. */
export function setAsideFor(args: {
  ownReview?: OwnReview;
  trustScore: number | null;
  reviewCount: number | null;
}): SetAside | null {
  if (args.ownReview !== undefined) {
    if (args.ownReview.sentiment !== 'negative') return null;
    return {
      reason: 'own_poor_review',
      words: 'You rated them poorly on PeerLens',
      note: args.ownReview.text?.trim() ?? '',
    };
  }
  if (
    args.trustScore !== null &&
    args.trustScore < LOW_TRUST_BELOW &&
    args.reviewCount !== null &&
    args.reviewCount >= RANKED_MIN_REVIEWS
  ) {
    return {
      reason: 'low_peerlens_trust',
      words: `Low PeerLens trust · ${String(args.reviewCount)} reviews`,
      note: '',
    };
  }
  return null;
}

/**
 * The owner's own supplier reviews, read from the AppView by author. Empty
 * when the owner's DID is unknown (the browser surface has no booted node)
 * or the AppView cannot be reached: the network rule still applies.
 */
export async function loadOwnSupplierReviews(
  ownerDid: string | null,
  readByAuthor: typeof searchAttestationsByAuthor = searchAttestationsByAuthor,
): Promise<Map<string, OwnReview>> {
  if (ownerDid === null || ownerDid === '') return new Map();
  try {
    return ownReviewsBySupplier((await readByAuthor(ownerDid, OWN_REVIEWS_READ)).results);
  } catch {
    return new Map();
  }
}
