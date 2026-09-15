/**
 * The catalog → Offer bridge (RESEARCHER_KERNEL_ARCHITECTURE.md §5.A2).
 *
 * The consumer research loop ranks PUBLISHED CATALOG offers, money-free — a
 * shopper comparing "the best X across suppliers" needs no live RFQ (§7.1).
 * The tested ranking discipline already lives in `offer_ranking.ts`; this
 * module is the seam that lets it run over catalog rows instead of signed
 * quotes, WITHOUT rewriting a single rule.
 *
 * IT INVENTS NOTHING IT CANNOT BACK. `Offer` (offer_ranking.ts) is quote-shaped
 * — it demands a `quoteId`, an `expiresAt`, an `availableQuantity` — and a
 * catalog row has none of the three. Each is synthesized HONESTLY:
 *
 *   - `quoteId` is a deterministic id derived only from the row, never random,
 *     so the `quoteId.localeCompare` tiebreak (offer_ranking.ts) and a re-run
 *     give the same order from the same catalog.
 *   - `expiresAt` is the catalog's own `validUntil`, or a never-expires
 *     sentinel when the catalog set none — so the §13.2 `quote_expired` filter
 *     drops a genuinely stale listing and lets a live one through, rather than
 *     this module inventing a quote lifetime.
 *   - `availableQuantity` is the quantity the shopper asked for. A catalog
 *     carries no live stock (FR-A7), and a published listing IS an offer to
 *     supply; setting it to the request neutralizes the stock filter rather
 *     than fabricating a number the supplier never stated.
 *   - the price is the catalog's INDICATIVE price, used as a comparable figure
 *     across suppliers of the SAME product — not a computed total for the
 *     requested quantity. Multiplying an indicative unit price by a quantity in
 *     an unknown unit would be this module inventing a commercial term (§9.1);
 *     the real total is a signed quote's job, at the close.
 *
 * A row with no indicative price is NOT an offer. It is reported in `unpriced`
 * and surfaced by the card, never scored as free or silently dropped — the same
 * "nothing silently substituted" rule offer_ranking.ts §13.4 keeps.
 *
 * NEITHER IS A ROW WHOSE PRICE IS NOT MONEY. The candidates come from an
 * AppView the owner may have pointed anywhere (§10.6, §20.15), and the ranking
 * does bare `BigInt` arithmetic over `totalMinorUnits`: an empty string would
 * rank as free, a negative would render as garbage, `"12.50"` would throw and
 * sink the whole research. So the price is re-validated HERE with the
 * protocol's own `validateMoney` — the §10.5 validator a buyer runs — and a
 * row that fails it joins `unpriced`, named with the reason, so the card can
 * say "stated a price Dina could not read" instead of scoring it.
 */

import { moneyMinorUnits, type Quantity, validateMoney } from '@dina/commerce-protocol';

import { type Offer } from './offer_ranking';

/** The structural subset of a catalog candidate the bridge reads. */
export interface CatalogOfferInput {
  supplierDid: string;
  /** The listing's service URI — carried through for the §5.A5 hand-off link. */
  serviceUri: string;
  productScheme: string;
  productValue: string;
  /** A stable component of the synthetic offer id (the catalog snapshot). */
  catalogSnapshotRef: string;
  /** The supplier's indicative price for the product, when the catalog states one. */
  indicativePrice?: { currency: string; minorUnits: string };
  /** Regions this listing fulfils into. */
  fulfilmentRegions: readonly { scheme: string; value: string }[];
  /** ISO-8601; absent means the catalog set no expiry. */
  validUntil?: string;
}

/** A listing that is not an offer, and why. */
export interface UnpricedCatalogRow {
  supplierDid: string;
  serviceUri: string;
  /** Absent when the catalog stated no price; the validator's reason when it stated one that is not Money. */
  malformedPrice?: string;
}

export interface CatalogBridgeResult {
  offers: Offer[];
  /** Rows with no readable indicative price — reported, never silently dropped. */
  unpriced: UnpricedCatalogRow[];
}

/**
 * A listing the catalog never expired. Far enough out that the §13.2 expiry
 * filter is a no-op for it, while a real `validUntil` in the past still drops.
 */
export const CATALOG_NEVER_EXPIRES = '9999-12-31T23:59:59.000Z';

/**
 * The deterministic synthetic offer id. Derived only from the row, so two runs
 * over the same catalog produce the same id — the ranking's `quoteId` tiebreak
 * (offer_ranking.ts) depends on it being stable.
 */
export function catalogOfferId(
  input: Pick<
    CatalogOfferInput,
    'supplierDid' | 'productScheme' | 'productValue' | 'catalogSnapshotRef'
  >,
): string {
  return `catalog:${input.supplierDid}:${input.productScheme}:${input.productValue}:${input.catalogSnapshotRef}`;
}

/**
 * Turn catalog candidates for one product into rankable offers.
 *
 * `trustBp` and `leadTimeDays` are left undefined: the catalog states no lead
 * time (the ranking reports it "missing"), and seller trust is attached by the
 * caller from PeerLens rather than fetched here — this module makes no network
 * call, matching the kernel/sidecar rule.
 */
export function catalogCandidatesToOffers(
  candidates: readonly CatalogOfferInput[],
  requestedQuantity: Quantity,
): CatalogBridgeResult {
  const offers: Offer[] = [];
  const unpriced: UnpricedCatalogRow[] = [];

  for (const candidate of candidates) {
    if (candidate.indicativePrice === undefined) {
      unpriced.push({ supplierDid: candidate.supplierDid, serviceUri: candidate.serviceUri });
      continue;
    }
    const malformed = validateMoney({
      currency: candidate.indicativePrice.currency,
      minor_units: candidate.indicativePrice.minorUnits,
    });
    if (malformed !== null) {
      unpriced.push({
        supplierDid: candidate.supplierDid,
        serviceUri: candidate.serviceUri,
        malformedPrice: malformed,
      });
      continue;
    }
    const region = candidate.fulfilmentRegions[0];
    offers.push({
      supplierDid: candidate.supplierDid,
      quoteId: catalogOfferId(candidate),
      // NOTE — reinterpreted field. `Offer.totalMinorUnits` is documented (on the
      // shared buyer path) as the total for the requested quantity. A catalog
      // listing carries only an indicative PER-LISTING price, so this is that
      // figure verbatim, NOT multiplied by quantity. That is correct for the
      // relative price ranking (a constant quantity does not change the order)
      // and honest on the card (labelled "Indicative price"). It is NOT a spend
      // total: the ranker's `over_budget` hard filter compares this against
      // `maxTotalMinorUnits`, so a caller must NOT set a budget on catalog offers
      // until a real quantity total is computed. The consumer loop sets none
      // (§5.A2); the A6 budget wiring must handle this before it does.
      totalMinorUnits: candidate.indicativePrice.minorUnits,
      currency: candidate.indicativePrice.currency,
      availableQuantity: requestedQuantity,
      expiresAt: candidate.validUntil ?? CATALOG_NEVER_EXPIRES,
      region: region === undefined ? undefined : `${region.scheme}:${region.value}`,
    });
  }
  return { offers, unpriced };
}

/**
 * Collapse to one listing per supplier: the cheapest valid price wins; a
 * priced listing beats an unpriced one; among unpriced rows the first stays.
 *
 * The comparison is across SELLERS — a supplier who lists the same product
 * twice is one seller with their best price, not two competitors — and the
 * research loop names its pick by supplier DID, which must then be unambiguous.
 * Runs after `catalogCandidatesToOffers`, so every price here is Money.
 */
export function oneListingPerSupplier(
  offers: readonly Offer[],
  unpriced: readonly UnpricedCatalogRow[],
): { offers: Offer[]; unpriced: UnpricedCatalogRow[]; collapsedListings: number } {
  const best = new Map<string, Offer>();
  for (const offer of offers) {
    const current = best.get(offer.supplierDid);
    if (
      current === undefined ||
      moneyMinorUnits({ currency: offer.currency, minor_units: offer.totalMinorUnits }) <
        moneyMinorUnits({ currency: current.currency, minor_units: current.totalMinorUnits })
    ) {
      best.set(offer.supplierDid, offer);
    }
  }
  const keptUnpriced = new Map<string, UnpricedCatalogRow>();
  for (const row of unpriced) {
    if (best.has(row.supplierDid) || keptUnpriced.has(row.supplierDid)) continue;
    keptUnpriced.set(row.supplierDid, row);
  }
  const keptOffers = offers.filter((o) => best.get(o.supplierDid) === o);
  return {
    offers: keptOffers,
    unpriced: [...keptUnpriced.values()],
    collapsedListings: offers.length + unpriced.length - keptOffers.length - keptUnpriced.size,
  };
}
