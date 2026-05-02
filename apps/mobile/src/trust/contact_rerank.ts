/**
 * Contact-aware re-rank for search results (Loyalty-Law-clean
 * client-side personalisation, complement to TN-TEST-080's
 * server-side friend-boost).
 *
 * **The privacy story.** AppView's `viewerDid` friend-boost only
 * uses PUBLIC trust signals — `com.dina.trust.vouch` records the
 * viewer has published. Many real friendships never produce a
 * public vouch (the user has someone's number / has eaten dinner
 * with them / shares an alias for them in the directory but never
 * published a vouch). Those people don't influence AppView-side
 * ranking. Sending the local contact list to AppView would close
 * the gap but violates §3 Absolute Loyalty (the contact graph is
 * private; only the user's local node holds it).
 *
 * **Solution.** AppView returns un-personalised results; this
 * helper re-orders them on-device using `listContacts()` from the
 * keystore-resident contact directory. Zero leak; works offline
 * for the re-rank step; surfaces real-world friendships that the
 * public vouch graph misses.
 *
 * **Boost is a flag, not a multiplier** (mirrors the server-side
 * helper in `appview/src/scorer/algorithms/friend-boost.ts`):
 * cards with ANY contact-authored review rank above cards with
 * none. A card with five contact-reviews doesn't rank above a card
 * with one. This matches the V1 Plan §7 "= 1.5 if any 1-hop
 * reviewer..." semantic and avoids letting heavily-networked
 * viewers push crowd-favoured subjects above relevance.
 *
 * **Within each bucket** (any-contact / none): the existing V1
 * tiebreak (review-count DESC, then title alphabetical) wins. So
 * two contact-cards with 5 vs 2 reviews still order 5 first; the
 * boost only crosses the contact-vs-stranger boundary.
 *
 * **Self-DID excluded** by caller responsibility: the runner that
 * supplies `contactDids` MUST exclude the viewer's own DID. The
 * directory module doesn't store the viewer's own DID as a
 * "contact", so in practice this is a no-op — but the contract is
 * documented so a future change to the directory shape can't
 * silently let viewers boost their own reviews (echo chamber).
 */

import type { SubjectCardDisplay, SubjectReview } from './subject_card';

/**
 * Returns `'contact'` when `reviewerDid` is in the keystore's
 * contact set; otherwise `'stranger'`.
 *
 * Pure function. Returns the input ring unchanged when it's already
 * `'self'` or `'fof'` — those rings carry semantics the contact
 * directory can't override.
 */
export function annotateReviewRing(
  reviewerDid: string | null,
  contactDids: ReadonlySet<string>,
  currentRing: SubjectReview['ring'],
): SubjectReview['ring'] {
  if (currentRing === 'self' || currentRing === 'fof') return currentRing;
  if (reviewerDid === null) return currentRing;
  if (contactDids.has(reviewerDid)) return 'contact';
  return currentRing;
}

/**
 * Search-result card row plus its ID. Mirrors the `SearchResult`
 * shape from `apps/mobile/app/trust/search.tsx` — kept opaque here
 * so the helper doesn't take a runtime dep on the screen module.
 */
export interface RerankableCard {
  readonly subjectId: string;
  readonly display: SubjectCardDisplay;
}

/**
 * Re-rank cards so any-contact cards sort above no-contact cards;
 * within each bucket, preserves the V1 tiebreak (review count DESC,
 * title alphabetical).
 *
 * Pure: returns a new array; does not mutate input.
 *
 * Empty input returns the same empty array (object-identity stable
 * so callers can `useMemo`-key off the reference).
 */
export function rerankByContacts(
  cards: ReadonlyArray<RerankableCard>,
): readonly RerankableCard[] {
  if (cards.length === 0) return cards;
  const sorted = [...cards];
  sorted.sort(compareCards);
  return sorted;
}

function hasContactReviewer(card: RerankableCard): boolean {
  return (card.display.friendsPill?.friendsCount ?? 0) > 0;
}

/**
 * Comparator: any-contact cards before no-contact, then review
 * count DESC, then title ASCENDING (stable alphabetical tiebreak).
 *
 * Exported for unit tests so the boundary contract (any-contact
 * sorts above none, even when the no-contact card has more
 * reviews) is pinned in isolation from the runner.
 */
export function compareCards(a: RerankableCard, b: RerankableCard): number {
  const aHas = hasContactReviewer(a);
  const bHas = hasContactReviewer(b);
  if (aHas !== bHas) return aHas ? -1 : 1;
  const dr = b.display.reviewCount - a.display.reviewCount;
  if (dr !== 0) return dr;
  return a.display.title.localeCompare(b.display.title);
}
