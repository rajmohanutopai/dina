import { formatMoney } from './money_display';
import { headlineEvidence, type ComposedEvidence } from './product_evidence';

import type { RankingResult } from './offer_ranking';
import type { Money, Quantity } from '@dina/commerce-protocol';

/**
 * The comparison card, as data (§18.4, WS-7.4).
 *
 * §18.4's requirement is unusual and worth taking literally: the result must
 * remain useful ON THE GENERIC CARDSPEC FALLBACK. A future comparison block
 * may enhance it — but the baseline has to work when nothing renders it
 * specially.
 *
 * That forces a shape. Every field §18.4 names is a plain string or a small
 * value a generic renderer can print in order; nothing here depends on a
 * bespoke component existing, and there is no field whose absence leaves a
 * blank where a number should be. A card that only reads well inside its own
 * custom view is a card that reads badly everywhere else, which is exactly the
 * situation an owner meets on a device that has not shipped the new block yet.
 *
 * IT IS A PROJECTION, NOT A SECOND OPINION. The ranking already decided; this
 * renders the decision and the reasons the ranking recorded. A card that
 * re-scored would eventually disagree with the thing it claims to explain.
 *
 * ONE DECISION MAY SIT ABOVE THE RANKING: THE OWNER'S (§5.A6). The ranking is
 * money-free arithmetic over price, lead time and trust; it knows nothing of
 * "never buy from ChairMaker again" or "a proven seller over the cheapest".
 * When the caller has weighed the offers against the owner's stated
 * preferences it passes a `choice` — WHICH offer, WHY in the owner's terms,
 * and what was set aside — and the card renders that decision, labelled as
 * the owner's ("Chosen for"), with the ranking's own reasons kept beneath it.
 * Still a projection: the card scores nothing and picks nothing; it says what
 * the caller decided and why. Without a `choice` the ranking's #1 stands.
 *
 * THE VERB IS "REVIEW ORDER". Not "Buy now" — §18.4 is explicit, and the
 * reason is the Cart Handover principle: Dina advises on purchases and never
 * completes one without the human seeing the order.
 */

export interface ComparisonCardRequest {
  /** What the owner asked for, in their words where they gave any. */
  label: string;
  quantity: Quantity;
}

/** One line of the card, as a generic renderer would print it. */
export interface CardField {
  label: string;
  value: string;
}

/**
 * A money-free hand-off link (§5.A5 — Deep Link Default / Cart Handover). Names
 * WHERE to buy the offer; there is deliberately no "buy" action here, so no
 * money ever moves through Dina — the human completes the purchase at the
 * source, which is also credited.
 */
export interface HandoffLink {
  supplierDid: string;
  /** The seller as the owner knows them (their contact's name), when they do. */
  sellerName?: string;
  /** The supplier's listing service URI. */
  serviceUri?: string;
  /** A deep link to the source page that credits the seller. */
  sourceUrl?: string;
}

/**
 * The owner's preferences decided (§5.A6). `supplierDid` names the chosen
 * offer — one of the RANKED offers, never an invented one — or is absent when
 * the preferences ruled every offer out (a budget nothing meets). `reason` is
 * in the owner's terms. `setAside` names the offers the preferences excluded,
 * each with its reason; they leave the alternatives and the hand-off links and
 * appear as "Set aside" lines instead.
 */
export interface ComparisonChoice {
  supplierDid?: string;
  reason: string;
  setAside?: { supplierDid: string; reason: string }[];
}

export interface ComparisonCard {
  kind: 'commerce_comparison';
  /** Ordered, so a generic list renderer produces a readable card. */
  fields: CardField[];
  /**
   * The action a generic renderer offers. Exactly one, and never "buy".
   * `review_order` leads into the buyer's order draft; `where_to_buy` is the
   * money-free consumer hand-off (§5.A5) — Dina credits the source and lets the
   * human complete the purchase there.
   */
  primaryAction: 'review_order' | 'where_to_buy';
  /**
   * Alternatives, ordered as the ranking ordered them, so a renderer that can
   * show more than the winner does not have to re-sort and risk disagreeing.
   * `seller` is the display label — the owner's name for the seller with the
   * DID, or the DID alone.
   */
  alternatives: { supplierDid: string; seller: string; total: string; leadTime: string }[];
  /**
   * Factors the RANKING could not score, named.
   *
   * §18.4 asks for "missing or incomparable fields" as a first-class part of
   * the card rather than an omission, because the alternative is a comparison
   * that looks complete while quietly leaving out the thing that mattered.
   *
   * Taken from what the ranking RECORDED (`missing`), not inferred here. A
   * first draft compared the offers itself and worked out which fields were
   * stated unevenly — a second opinion that would eventually disagree with the
   * thing this card claims to explain.
   */
  incomparable: string[];
  /**
   * Money-free hand-off links, present ONLY in `where_to_buy` mode. Absent in
   * the order path, whose fields and verb are unchanged by hand-off mode.
   */
  handoff?: HandoffLink[];
}

const NOT_STATED = 'not stated';

function money(value: Money | null | undefined): string {
  return value === null || value === undefined ? NOT_STATED : formatMoney(value);
}

function days(value: number | null | undefined): string {
  return value === null || value === undefined ? NOT_STATED : `${String(value)} days`;
}

/**
 * Render a validity date. A catalog listing that the supplier never expired
 * carries a far-future sentinel (year >= 9000); shown as an honest "no stated
 * expiry" rather than a nonsense date. Any real date passes through unchanged,
 * so the order card's dates are unchanged by hand-off mode.
 */
function renderValidity(expiresAt: string): string {
  const year = Number(expiresAt.slice(0, 4));
  return Number.isFinite(year) && year >= 9000 ? 'no stated expiry' : expiresAt;
}

/**
 * Build the card from a ranking the buyer already performed.
 *
 * `evidence` is optional and injected: it lives in PeerLens, and this module
 * must not learn to fetch. Absent evidence renders as an explicit "no
 * evidence" line rather than a neutral score, because an unrated supplier and
 * a mediocre one are different and a zero makes them look the same.
 */
export function buildComparisonCard(args: {
  request: ComparisonCardRequest;
  ranking: RankingResult;
  evidence?: ComposedEvidence | null;
  /**
   * `order` (default) leads into the buyer's order draft with the fields and
   * verb it always had (plus the `seller` label on alternatives). `handoff` is the money-free consumer
   * research card (§5.A5): a `where_to_buy` action, indicative-price labels,
   * and the hand-off links.
   */
  mode?: 'order' | 'handoff';
  /** Where-to-buy links, rendered ONLY in `handoff` mode. */
  handoff?: HandoffLink[];
  /**
   * The owner's decision over the ranking (§5.A6). Throws when it names a
   * supplier that is not among the ranked offers — a choice the card cannot
   * show is a caller error, never a silent fallback to the ranking's #1.
   */
  choice?: ComparisonChoice;
  /** The owner's names for sellers, by DID — rendered beside the DID. */
  sellerNames?: Readonly<Record<string, string>>;
}): ComparisonCard {
  const mode = args.mode ?? 'order';
  const primaryAction: ComparisonCard['primaryAction'] =
    mode === 'handoff' ? 'where_to_buy' : 'review_order';
  const priceLabel = mode === 'handoff' ? 'Indicative price' : 'Total landed cost';
  const validityLabel = mode === 'handoff' ? 'Listing valid until' : 'Quote valid until';
  const seller = (did: string): string => {
    const name = args.sellerNames?.[did];
    return name === undefined || name === '' ? did : `${name} (${did})`;
  };

  const choice = args.choice;
  const setAside = new Set((choice?.setAside ?? []).map((s) => s.supplierDid));
  const setAsideFields: CardField[] = (choice?.setAside ?? []).map((s) => ({
    label: 'Set aside',
    value: `${seller(s.supplierDid)}: ${s.reason}`,
  }));
  // Hand-off links follow the decision: a seller the owner set aside gets no
  // where-to-buy line on a card that just said not to buy from them.
  const handoff = (args.handoff ?? []).filter((h) => !setAside.has(h.supplierDid));

  let winner: RankingResult['ranked'][number] | null;
  if (choice === undefined) {
    winner = args.ranking.ranked[0] ?? null;
  } else if (choice.supplierDid === undefined) {
    winner = null;
  } else {
    const matches = args.ranking.ranked.filter((r) => r.offer.supplierDid === choice.supplierDid);
    if (matches.length === 0) {
      throw new Error(
        `comparison_card: choice names ${choice.supplierDid}, which is not among the ranked offers`,
      );
    }
    // A supplier with two ranked offers cannot be chosen by DID alone — the
    // caller must collapse to one offer per supplier before asking (the
    // research tool does), so this is a caller error, not a coin toss.
    if (matches.length > 1) {
      throw new Error(
        `comparison_card: choice names ${choice.supplierDid}, which has ${String(matches.length)} ranked offers`,
      );
    }
    winner = matches[0];
  }
  const headline = args.evidence == null ? null : headlineEvidence(args.evidence);

  const fields: CardField[] = [
    {
      label: 'Requested',
      value: `${args.request.label} — ${args.request.quantity.value} ${args.request.quantity.unit_code}`,
    },
    { label: 'Valid candidates', value: String(args.ranking.ranked.length) },
  ];

  if (winner === null) {
    // NOT an error, and not an empty card. Every offer failing the hard filters
    // is a result: §13.2's filters exist to remove what a buyer cannot accept,
    // and the reasons are the useful part. The same holds when the OWNER'S
    // preferences ruled every offer out: the card says so, in their terms, and
    // still lists what was on the table.
    fields.push({
      label: 'Recommended',
      value: choice === undefined ? 'none — no offer met the requirements' : `none — ${choice.reason}`,
    });
    return {
      kind: 'commerce_comparison',
      fields: [...fields, ...setAsideFields, ...filteredReasons(args.ranking, seller)],
      primaryAction,
      alternatives: args.ranking.ranked
        .filter((entry) => !setAside.has(entry.offer.supplierDid))
        .map((entry) => alternative(entry, seller)),
      incomparable: incomparableFields(args.ranking),
      ...(mode === 'handoff' ? { handoff } : {}),
    };
  }

  fields.push(
    { label: 'Recommended', value: seller(winner.offer.supplierDid) },
    ...(choice === undefined ? [] : [{ label: 'Chosen for', value: choice.reason }]),
    ...setAsideFields,
    {
      label: priceLabel,
      value: money({ currency: winner.offer.currency, minor_units: winner.offer.totalMinorUnits }),
    },
    { label: 'Delivery estimate', value: days(winner.offer.leadTimeDays) },
    { label: validityLabel, value: renderValidity(winner.offer.expiresAt) },
    {
      label: 'Confidence',
      // The ranking's own score, named as what it is. A percentage would
      // imply a probability nobody computed.
      value: `${String(winner.scoreBp)} of 10000`,
    },
    {
      label: 'Evidence',
      value:
        headline === null
          ? 'none recorded for this supplier'
          : `${String(headline.meanRatingBp)} of 10000, ${headline.scope}, ${String(headline.distinctSources)} source(s)`,
    },
  );

  // The REASONS the ranking recorded, in its own terms. Naming the factor and
  // its contribution lets an owner see WHY this offer won rather than being
  // told that it did.
  for (const component of winner.components) {
    fields.push({
      label: 'Why',
      // CONTRIBUTION, not the raw factor score: `valueBp` alone says how well
      // the offer did on a factor, and `contributionBp` says how much that
      // actually moved the total. An owner asking "why did this win" is asking
      // the second question.
      value: `${component.factor}: ${String(component.contributionBp)} of ${String(component.weightBp)}`,
    });
  }
  if (winner.weightAppliedBp < 10000) {
    // Stated, because a score computed over fewer factors is not comparable to
    // one computed over all of them, and the number alone does not say so.
    fields.push({
      label: 'Scored on',
      value: `${String(winner.weightAppliedBp)} of 10000 of the ranking weight`,
    });
  }

  // The rest of the ranking, in its order, minus the winner (by identity, so
  // a supplier's second ranked offer in the order path is still listed) and
  // anything the owner set aside — the ranking's #1 stays visible as an
  // alternative when the owner's choice passed it over.
  const chosen = winner;
  return {
    kind: 'commerce_comparison',
    fields: [...fields, ...filteredReasons(args.ranking, seller)],
    primaryAction,
    alternatives: args.ranking.ranked
      .filter((entry) => entry !== chosen && !setAside.has(entry.offer.supplierDid))
      .map((entry) => alternative(entry, seller)),
    incomparable: incomparableFields(args.ranking),
    ...(mode === 'handoff' ? { handoff } : {}),
  };
}

function alternative(
  entry: RankingResult['ranked'][number],
  seller: (did: string) => string,
): ComparisonCard['alternatives'][number] {
  return {
    supplierDid: entry.offer.supplierDid,
    seller: seller(entry.offer.supplierDid),
    total: money({ currency: entry.offer.currency, minor_units: entry.offer.totalMinorUnits }),
    leadTime: days(entry.offer.leadTimeDays),
  };
}

/** Why each dropped offer was dropped — one line per offer, never a count. */
function filteredReasons(ranking: RankingResult, seller: (did: string) => string): CardField[] {
  return ranking.filtered.map((entry) => ({
    label: 'Excluded',
    value: `${seller(entry.offer.supplierDid)}: ${entry.reason}`,
  }));
}

/**
 * What the ranking said it could not score, deduplicated and ordered.
 *
 * Read off `missing` rather than recomputed: the ranking is the authority on
 * which factors it could apply, and a card that worked it out independently
 * would eventually contradict the score it is explaining.
 */
function incomparableFields(ranking: RankingResult): string[] {
  const seen = new Set<string>();
  for (const entry of ranking.ranked) {
    for (const gap of entry.missing) seen.add(`${gap.factor}: ${gap.reason}`);
  }
  return [...seen].sort();
}
