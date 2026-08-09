/**
 * The buyer's procurement decision, composed (§13.2–§13.6, WS-5/WS-7 Core half).
 *
 * WHY THIS MODULE EXISTS AND WHAT IT DELIBERATELY IS NOT. Fan-out planning,
 * hard filters, ranking and evidence composition are each built, each tested,
 * and — until now — each called only by a test. The orphan ledger named them:
 * seven exported symbols with no production caller, because the surface that
 * would call them (mobile screens, AppView-backed discovery) does not exist.
 *
 * The temptation was to wait for that surface. That is how the pieces came to
 * be orphans in the first place: each was correct, each was gated, and the
 * ORDER they run in — which is where the interesting mistakes live — was
 * written only inside a scenario test. This module is that order, in
 * production code, reachable from an owner route.
 *
 * IT IS NOT A NEW ABSTRACTION. It adds no rule of its own. Every decision here
 * belongs to a function that already owned it; what this contributes is the
 * sequence, the plumbing between shapes, and one honest answer at the end.
 * Anything it did beyond that would be a second opinion competing with the
 * module that owns the rule.
 *
 * IT DOES NOT SEND ANYTHING. Planning who to ask is a decision; asking is
 * egress, and egress belongs to the service-query sender that already carries
 * gating, signing and transport. A procurement module that also sent would
 * make the plan untestable without a network and would put a second egress
 * path beside the one the four gates guard.
 */

import {
  rankOffers,
  type BuyerRequirements,
  type Offer,
  type RankingResult,
} from './offer_ranking';
import { headlineEvidence, type ComposedEvidence, type HeadlineEvidence } from './product_evidence';
import {
  planQuoteFanout,
  type FanoutCandidate,
  type FanoutPlan,
  type FanoutPolicy,
} from './quote_fanout';

/** What the owner is told about who will be asked, and who will not. */
export interface ProcurementPlan {
  plan: FanoutPlan;
  /**
   * True when nobody survived selection. Reported rather than left for the
   * caller to infer from an empty array: "we asked nobody" and "we asked and
   * nobody answered" are different things to explain to an owner, and they
   * arrive at the same empty list.
   */
  askedNobody: boolean;
}

/**
 * Plan the fan-out.
 *
 * A thin pass-through today, and worth existing anyway: it is the seam a route
 * calls, so the ceiling and the exclusion reasons reach an owner through one
 * named path instead of each caller reaching into `planQuoteFanout` and
 * deciding for itself what to do with `excluded`.
 */
export function planProcurement(
  candidates: readonly FanoutCandidate[],
  policy: FanoutPolicy,
): ProcurementPlan {
  const plan = planQuoteFanout(candidates, policy);
  return { plan, askedNobody: plan.selected.length === 0 };
}

/** The chosen offer, with the reason it was chosen. */
export interface ProcurementChoice {
  ranking: RankingResult;
  /**
   * The winner, or null when nothing survived the hard filters. Null is a
   * legitimate answer: §13.2's filters exist to remove offers a buyer cannot
   * accept, and removing all of them is a result, not a failure.
   */
  best: RankingResult['ranked'][number] | null;
  /**
   * Why the winner is credible, when there is evidence to say so. Null means
   * "no evidence", which an owner surface must render as absence rather than
   * as a neutral score — an unrated supplier and a mediocre one are different.
   */
  headline: HeadlineEvidence | null;
}

/**
 * Filter, rank, and explain.
 *
 * `evidenceFor` is injected rather than fetched: evidence lives in PeerLens
 * and this module must not learn to make network calls. A caller with no
 * evidence source passes nothing and gets a headline of null, which is the
 * honest answer rather than a silent zero.
 */
export function chooseOffer(args: {
  offers: readonly Offer[];
  requirements: BuyerRequirements;
  atIso: string;
  evidenceFor?: (supplierDid: string) => ComposedEvidence | null;
}): ProcurementChoice {
  const ranking = rankOffers(args.offers, args.requirements, args.atIso);
  const best = ranking.ranked[0] ?? null;
  if (best === null) return { ranking, best: null, headline: null };
  const composed = args.evidenceFor?.(best.offer.supplierDid) ?? null;
  return {
    ranking,
    best,
    headline: composed === null ? null : headlineEvidence(composed),
  };
}
