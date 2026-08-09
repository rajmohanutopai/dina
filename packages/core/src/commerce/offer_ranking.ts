/**
 * Offer ranking (§13.2, §13.3, §13.4, FR-B6, FR-B7) — how a retailer chooses
 * between the quotes it collected.
 *
 * TWO STAGES, IN THIS ORDER, AND THE ORDER IS THE RULE.
 *
 *   1. HARD FILTERS remove offers that do not meet the buyer's stated
 *      requirements. An offer in the wrong unit, short of the quantity asked
 *      for, outside the region, or arriving after the deadline is not a worse
 *      offer — it is not an offer. Scoring it and letting a low price pull it
 *      to the top is how a buyer ends up ordering something that cannot
 *      arrive in time.
 *   2. SCORING ranks what survives.
 *
 * §13.2 is explicit that filtering precedes scoring, and the reason is not
 * tidiness: a weighted score can always be dragged across a hard requirement
 * by making one factor extreme enough. A requirement that participates in a
 * score is not a requirement.
 *
 * NO LLM IN THE ARITHMETIC PATH (§13.3, FR-B6). Everything here is integer
 * arithmetic over basis points. A model may write the buyer's requirements and
 * may read the explanation back to them, but it never touches the comparison —
 * a ranking that cannot be recomputed is a ranking nobody can dispute.
 *
 * NOTHING IS SILENTLY SUBSTITUTED (§13.4, FR-B7). An offer with no trust data
 * is not scored as zero (which punishes every new supplier) and not as the
 * maximum (which rewards having no history). The factor is left out of THAT
 * offer's score, the weight actually applied is reported, and the omission is
 * named. A buyer comparing a score built from two factors against one built
 * from three deserves to be told which is which.
 */

import { compareQuantities, unitDef, type Quantity } from '@dina/commerce-protocol';

/** What the buyer asked for. Every field here is a HARD requirement. */
export interface BuyerRequirements {
  /** The quantity needed, in the unit the buyer will order in. */
  quantity: Quantity;
  /** ISO-8601 UTC instant by which goods must arrive, if there is one. */
  neededBy?: string;
  /** Currency the buyer will pay in. An offer in another is not comparable. */
  currency: string;
  /** Regions the buyer can receive into, if restricted. */
  regions?: readonly string[];
  /** Ceiling on total spend, in minor units of `currency`. */
  maxTotalMinorUnits?: string;
}

export interface Offer {
  supplierDid: string;
  quoteId: string;
  /** Total for the requested quantity, in minor units. */
  totalMinorUnits: string;
  currency: string;
  /** What the supplier can actually supply. */
  availableQuantity: Quantity;
  /** ISO-8601 UTC expiry of the signed quote (§9.8). */
  expiresAt: string;
  /** Whole days from order to delivery, when the supplier states one. */
  leadTimeDays?: number;
  /** Region this offer can deliver into. */
  region?: string;
  /**
   * PeerLens trust, 0..10000 basis points. ABSENT means no history — which is
   * a different thing from a bad rating and must never be scored as one.
   */
  trustBp?: number;
}

export type FilterReason =
  | 'quote_expired'
  | 'currency_mismatch'
  | 'insufficient_quantity'
  | 'incomparable_unit'
  | 'region_not_served'
  | 'too_late'
  | 'over_budget';

export interface FilteredOffer {
  offer: Offer;
  reason: FilterReason;
  detail: string;
}

/** A named contribution to a score, in basis points. */
export interface ScoreComponent {
  factor: 'price' | 'lead_time' | 'trust';
  /** Weight actually applied, basis points. */
  weightBp: number;
  /** How this offer did on the factor, 0..10000. */
  valueBp: number;
  /** `weightBp * valueBp / 10000`, the factor's contribution to the score. */
  contributionBp: number;
}

export interface RankedOffer {
  offer: Offer;
  /** 0..10000. Comparable ONLY alongside `weightAppliedBp`. */
  scoreBp: number;
  /** Sum of the weights that could be applied. Below 10000 means data was missing. */
  weightAppliedBp: number;
  components: ScoreComponent[];
  /** Factors this offer could not be scored on, and why. */
  missing: { factor: ScoreComponent['factor']; reason: string }[];
}

export interface RankingResult {
  ranked: RankedOffer[];
  /** Removed BEFORE scoring, each with its reason. Never silently dropped. */
  filtered: FilteredOffer[];
}

/**
 * PRICE AND LEAD TIME ARE RELATIVE; TRUST IS ABSOLUTE.
 *
 * "Cheapest" and "soonest" are only meaningful against the other offers, so
 * both normalise across the shortlist: the best available becomes 10000 and
 * the worst becomes 0. A trust rating is not like that. 4000 means the same
 * thing whoever else happened to quote, and normalising it would stretch the
 * least-bad supplier in a weak field up to full marks — telling the buyer that
 * a mediocre record is excellent because the competition was worse.
 *
 * So `trustBp` is used as given (clamped, because it comes from an AppView
 * rather than from here). A consequence worth knowing when reading a score:
 * an offer that wins every relative factor still cannot reach 10000 unless its
 * trust rating is already 10000.
 */

/**
 * Factor weights, basis points, summing to 10000.
 *
 * Fixed rather than configurable in v1. A buyer-tunable weight vector is a
 * real feature, but it is also the thing that would make two Dinas rank the
 * same offers differently — so it waits until there is a place to record the
 * chosen weights alongside the decision.
 */
const WEIGHTS: Readonly<Record<ScoreComponent['factor'], number>> = {
  price: 6000,
  lead_time: 2500,
  trust: 1500,
};

function isoMillis(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * §13.2 — remove what does not meet the requirements, before any scoring.
 *
 * Every removal is REPORTED. A comparison silently missing a supplier is a
 * comparison the buyer cannot trust, and "why isn't ChairMaker here" is the
 * first question anyone asks of a shortlist.
 */
export function applyHardFilters(
  offers: readonly Offer[],
  requirements: BuyerRequirements,
  atIso: string,
): { passed: Offer[]; filtered: FilteredOffer[] } {
  const passed: Offer[] = [];
  const filtered: FilteredOffer[] = [];
  const now = isoMillis(atIso);
  const budget =
    requirements.maxTotalMinorUnits === undefined ? null : BigInt(requirements.maxTotalMinorUnits);

  for (const offer of offers) {
    const reject = (reason: FilterReason, detail: string): void => {
      filtered.push({ offer, reason, detail });
    };

    const expiry = isoMillis(offer.expiresAt);
    // An unreadable expiry is treated as EXPIRED, not as "no expiry". A quote
    // this buyer cannot date is one it cannot rely on.
    if (expiry === null || (now !== null && now > expiry)) {
      reject('quote_expired', 'the signed quote is no longer valid (§9.8)');
      continue;
    }
    if (offer.currency !== requirements.currency) {
      // NOT converted. A rate applied here would be this node inventing a
      // commercial term, and §9.1 keeps money exact and single-currency.
      reject(
        'currency_mismatch',
        `quoted in ${offer.currency}, buyer pays ${requirements.currency}`,
      );
      continue;
    }
    const wanted = unitDef(requirements.quantity.unit_code);
    const offered = unitDef(offer.availableQuantity.unit_code);
    if (wanted === undefined || offered === undefined) {
      reject('incomparable_unit', 'a quantity uses a unit outside the v1 vocabulary (§9.2)');
      continue;
    }
    const comparison = compareQuantities(offer.availableQuantity, requirements.quantity);
    if (typeof comparison === 'string') {
      // `case` and `pallet` have no base factor without pack evidence, so the
      // protocol refuses the comparison rather than guessing at it.
      reject('incomparable_unit', comparison);
      continue;
    }
    if (comparison < 0) {
      reject('insufficient_quantity', 'the supplier cannot supply the quantity requested');
      continue;
    }
    if (
      requirements.regions !== undefined &&
      requirements.regions.length > 0 &&
      (offer.region === undefined || !requirements.regions.includes(offer.region))
    ) {
      reject('region_not_served', 'the offer does not cover a region the buyer can receive into');
      continue;
    }
    if (requirements.neededBy !== undefined && offer.leadTimeDays !== undefined && now !== null) {
      const deadline = isoMillis(requirements.neededBy);
      const arrival = now + offer.leadTimeDays * 86_400_000;
      if (deadline !== null && arrival > deadline) {
        reject('too_late', `a ${String(offer.leadTimeDays)}-day lead time misses the deadline`);
        continue;
      }
    }
    if (budget !== null && BigInt(offer.totalMinorUnits) > budget) {
      reject('over_budget', 'the total exceeds the buyer’s stated ceiling');
      continue;
    }
    passed.push(offer);
  }
  return { passed, filtered };
}

/**
 * Normalise a value into 0..10000 where LOWER raw is better.
 *
 * With one surviving offer, or with every offer identical on this factor,
 * there is nothing to distinguish and everyone scores full marks. Scoring the
 * lone survivor as zero would be arithmetically defensible and would tell the
 * buyer that their only viable supplier is bad, which it does not.
 */
function lowerIsBetterBp(value: bigint, best: bigint, worst: bigint): number {
  if (worst === best) return 10000;
  const span = worst - best;
  const distance = worst - value;
  return Number((distance * 10000n) / span);
}

/**
 * §13.3/§13.4 — rank the survivors, deterministically, with an explanation.
 *
 * Ties break on `quoteId`, not on input order: a ranking that depended on the
 * order responses happened to arrive would give two buyers different answers
 * from the same evidence.
 */
export function rankOffers(
  offers: readonly Offer[],
  requirements: BuyerRequirements,
  atIso: string,
): RankingResult {
  const { passed, filtered } = applyHardFilters(offers, requirements, atIso);
  if (passed.length === 0) return { ranked: [], filtered };

  const totals = passed.map((o) => BigInt(o.totalMinorUnits));
  const bestTotal = totals.reduce((a, b) => (b < a ? b : a));
  const worstTotal = totals.reduce((a, b) => (b > a ? b : a));

  const leadTimes = passed
    .map((o) => o.leadTimeDays)
    .filter((d): d is number => d !== undefined)
    .map((d) => BigInt(d));
  const bestLead = leadTimes.length > 0 ? leadTimes.reduce((a, b) => (b < a ? b : a)) : null;
  const worstLead = leadTimes.length > 0 ? leadTimes.reduce((a, b) => (b > a ? b : a)) : null;

  const ranked: RankedOffer[] = passed.map((offer) => {
    const components: ScoreComponent[] = [];
    const missing: RankedOffer['missing'] = [];

    const priceBp = lowerIsBetterBp(BigInt(offer.totalMinorUnits), bestTotal, worstTotal);
    components.push({
      factor: 'price',
      weightBp: WEIGHTS.price,
      valueBp: priceBp,
      contributionBp: Math.round((WEIGHTS.price * priceBp) / 10000),
    });

    if (offer.leadTimeDays === undefined || bestLead === null || worstLead === null) {
      // NOT zero and NOT the maximum. Either would be this node inventing a
      // fact about the supplier; the honest answer is that it was not scored.
      missing.push({
        factor: 'lead_time',
        reason: 'the supplier stated no lead time',
      });
    } else {
      const leadBp = lowerIsBetterBp(BigInt(offer.leadTimeDays), bestLead, worstLead);
      components.push({
        factor: 'lead_time',
        weightBp: WEIGHTS.lead_time,
        valueBp: leadBp,
        contributionBp: Math.round((WEIGHTS.lead_time * leadBp) / 10000),
      });
    }

    if (offer.trustBp === undefined) {
      // The case §13.4 exists for. A new supplier has no history, and a
      // ranking that scored absence as a bad rating would make the trust
      // system a barrier to entry rather than a signal.
      missing.push({
        factor: 'trust',
        reason: 'no PeerLens history for this supplier yet',
      });
    } else {
      const trustBp = Math.max(0, Math.min(10000, offer.trustBp));
      components.push({
        factor: 'trust',
        weightBp: WEIGHTS.trust,
        valueBp: trustBp,
        contributionBp: Math.round((WEIGHTS.trust * trustBp) / 10000),
      });
    }

    const weightAppliedBp = components.reduce((sum, c) => sum + c.weightBp, 0);
    const raw = components.reduce((sum, c) => sum + c.contributionBp, 0);
    // Normalised by the weight ACTUALLY applied, so an offer scored on two
    // factors is on the same 0..10000 scale as one scored on three. The
    // scale being shared is not the same as the evidence being equal, which
    // is exactly why `weightAppliedBp` travels with the score.
    const scoreBp = weightAppliedBp === 0 ? 0 : Math.round((raw * 10000) / weightAppliedBp);

    return { offer, scoreBp, weightAppliedBp, components, missing };
  });

  ranked.sort((a, b) =>
    b.scoreBp !== a.scoreBp
      ? b.scoreBp - a.scoreBp
      : a.offer.quoteId.localeCompare(b.offer.quoteId),
  );
  return { ranked, filtered };
}
