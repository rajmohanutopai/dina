/**
 * The trust producer (RESEARCHER_KERNEL_ARCHITECTURE.md §5.A3).
 *
 * `offer_ranking` scores a supplier's PeerLens trust as `Offer.trustBp`
 * (0..10000), but it takes that number as an INPUT — it does not fetch. This
 * module is the fetch: it turns a seller DID's `overallTrustScore` (0..1) into
 * the basis-point figure the ranker consumes, and it does so FAIL-SOFT — a
 * supplier whose profile cannot be read is left with NO trust input, not a
 * zero, because §13.4 is explicit that absent history must never be scored as a
 * bad rating.
 *
 * PRODUCT REVIEWS ARE A DIFFERENT DIMENSION (§7.2). This produces SELLER trust
 * (the merchant's DID). Product-review evidence is designed to feed the
 * comparison card's `evidence` param separately — shown, not folded into the
 * rank — so the two dimensions are never double-counted. That fetch is NOT
 * wired yet: the consumer loop passes no `evidence`, so the card's Evidence line
 * reads "none recorded" today. Wiring the product-subject `subject_scores` fetch
 * is the open remainder of §5.A3 / §7.2.
 */

import { type AppViewClient } from '../appview_client/http';

/**
 * Map a PeerLens `overallTrustScore` (0..1) to `trustBp` (0..10000).
 *
 * `null` — a known DID with no history, or no profile at all — returns
 * `undefined`, so the ranker leaves the trust factor OUT of that offer's score
 * (§13.4) rather than scoring absence as a zero rating. The result is clamped:
 * the score arrives from an AppView, not from here.
 */
export function sellerTrustBp(overallTrustScore: number | null): number | undefined {
  if (overallTrustScore === null) return undefined;
  return Math.max(0, Math.min(10000, Math.round(overallTrustScore * 10000)));
}

/**
 * Fetch seller trust for a set of supplier DIDs, as a map of DID → `trustBp`.
 *
 * A DID with no trust input (no profile, a null score, or a lookup that failed)
 * is ABSENT from the map — the caller reads a missing key as `undefined`, and
 * the ranker treats it as "no history". A failed lookup is logged but never
 * fatal: one supplier's unreadable profile must not sink the whole comparison.
 * DIDs are de-duplicated so a shortlist repeating a supplier costs one fetch.
 */
export async function fetchSellerTrustBp(
  appViewClient: Pick<AppViewClient, 'getProfile'>,
  dids: readonly string[],
  logger?: (event: Record<string, unknown>) => void,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(dids)];
  await Promise.all(
    unique.map(async (did) => {
      try {
        const profile = await appViewClient.getProfile(did);
        const bp = sellerTrustBp(profile?.overallTrustScore ?? null);
        if (bp !== undefined) out.set(did, bp);
      } catch (err) {
        logger?.({
          event: 'trust_producer.getProfile_failed',
          did,
          error: (err as Error).message,
        });
      }
    }),
  );
  return out;
}
