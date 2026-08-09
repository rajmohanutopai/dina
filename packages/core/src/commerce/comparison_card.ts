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

export interface ComparisonCard {
  kind: 'commerce_comparison';
  /** Ordered, so a generic list renderer produces a readable card. */
  fields: CardField[];
  /** The action a generic renderer offers. Exactly one, and never "buy". */
  primaryAction: 'review_order';
  /**
   * Alternatives, ordered as the ranking ordered them, so a renderer that can
   * show more than the winner does not have to re-sort and risk disagreeing.
   */
  alternatives: { supplierDid: string; total: string; leadTime: string }[];
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
}

const NOT_STATED = 'not stated';

function money(value: Money | null | undefined): string {
  return value === null || value === undefined
    ? NOT_STATED
    : `${value.currency} ${value.minor_units}`;
}

function days(value: number | null | undefined): string {
  return value === null || value === undefined ? NOT_STATED : `${String(value)} days`;
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
}): ComparisonCard {
  const winner = args.ranking.ranked[0] ?? null;
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
    // and the reasons are the useful part.
    fields.push({ label: 'Recommended', value: 'none — no offer met the requirements' });
    return {
      kind: 'commerce_comparison',
      fields: [...fields, ...filteredReasons(args.ranking)],
      primaryAction: 'review_order',
      alternatives: [],
      incomparable: incomparableFields(args.ranking),
    };
  }

  fields.push(
    { label: 'Recommended', value: winner.offer.supplierDid },
    {
      label: 'Total landed cost',
      value: money({ currency: winner.offer.currency, minor_units: winner.offer.totalMinorUnits }),
    },
    { label: 'Delivery estimate', value: days(winner.offer.leadTimeDays) },
    { label: 'Quote valid until', value: winner.offer.expiresAt },
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

  return {
    kind: 'commerce_comparison',
    fields: [...fields, ...filteredReasons(args.ranking)],
    primaryAction: 'review_order',
    alternatives: args.ranking.ranked.slice(1).map((entry) => ({
      supplierDid: entry.offer.supplierDid,
      total: money({ currency: entry.offer.currency, minor_units: entry.offer.totalMinorUnits }),
      leadTime: days(entry.offer.leadTimeDays),
    })),
    incomparable: incomparableFields(args.ranking),
  };
}

/** Why each dropped offer was dropped — one line per offer, never a count. */
function filteredReasons(ranking: RankingResult): CardField[] {
  return ranking.filtered.map((entry) => ({
    label: 'Excluded',
    value: `${entry.offer.supplierDid}: ${entry.reason}`,
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
