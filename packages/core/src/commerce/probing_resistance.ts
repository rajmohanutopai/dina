/**
 * Competitor and probing resistance (§14.3, §20.10) — what a stranger can
 * learn by asking.
 *
 * THE ATTACK. A competitor does not need to breach anything to hurt a
 * supplier: they need only ask. Send a hundred quote requests at varying
 * quantities and the replies draw the supplier's price curve, its volume
 * breaks, and which products it can actually source. Every individual answer
 * was legitimate; the harm is in the aggregate, which is why no single-request
 * check can see it.
 *
 * TWO DEFENCES, and they answer different halves.
 *
 *   1. A BUDGET per counterparty over a window. Genuine buyers ask a few
 *      times; a curve needs many. This is the only defence that sees the
 *      aggregate, and it is why the decision needs history rather than just
 *      the request in front of it.
 *   2. A UNIFORM refusal. Once the budget is spent — or the supplier simply
 *      does not quote this peer — the answer must be indistinguishable from
 *      "no such product". Otherwise the refusal itself is the oracle: a
 *      prober learns the catalog by watching WHICH requests get a different
 *      shape of "no".
 *
 * WHY BOTH. A budget with distinguishable refusals leaks the catalog before
 * the budget runs out. Uniform refusals with no budget leak the price curve to
 * anyone patient enough. Neither is sufficient and neither is the other's
 * fallback.
 *
 * WHAT THIS IS NOT. It is not authorization — §11.2 subject gating already
 * decides who may speak about an existing order. This decides whether a
 * supplier answers a PRICING question at all, which is a commercial judgement
 * the owner makes and this module only enforces.
 */

/** How the owner has classified this counterparty. */
export type CounterpartyStanding =
  /** A contact the owner keeps: a real customer relationship. */
  | 'known'
  /** Seen before, no relationship asserted. The default for a peer. */
  | 'unknown'
  /** The owner has said no. */
  | 'blocked';

export interface ProbingPolicy {
  /**
   * Quote requests a KNOWN counterparty may make per window. Generous: a real
   * customer revising an order several times is ordinary behaviour, and a
   * limit that catches them is a limit that will be turned off.
   */
  knownBudget: number;
  /**
   * Quote requests an UNKNOWN counterparty may make per window. Small but not
   * zero — a stranger has to be able to become a customer, and §20.10's
   * concern is the curve, not the first question.
   */
  unknownBudget: number;
  /** Window length in ms. */
  windowMs: number;
}

export const DEFAULT_PROBING_POLICY: ProbingPolicy = {
  knownBudget: 60,
  unknownBudget: 5,
  windowMs: 60 * 60 * 1000,
};

/** One recorded quote request from a counterparty. */
export interface QuoteAttempt {
  fromDid: string;
  atMs: number;
}

/**
 * The ONE refusal a prober may ever see.
 *
 * Deliberately a single constant rather than a message built per case. Two
 * refusals that differ by a word are two refusals a prober can tell apart, and
 * every "helpful" detail here — which product, whose budget, what window — is
 * a bit of the catalog handed over. An operator learns the real reason from
 * the returned `reason` field, which never crosses the wire.
 */
export const PROBING_REFUSAL = 'commerce: no quote available for this request';

export type ProbingReason =
  /** Owner has blocked this counterparty. */
  | 'blocked'
  /** Budget for this counterparty class is spent for the window. */
  | 'budget_exhausted';

export type QuoteAdmission =
  | { quote: true; remaining: number }
  /**
   * `error` is what the peer sees and is the SAME string in every case;
   * `reason` is for the owner's log and never leaves the node.
   */
  | { quote: false; error: typeof PROBING_REFUSAL; reason: ProbingReason };

/**
 * Decide whether to answer a pricing question from this counterparty.
 *
 * `recentAttempts` is the caller's window of history. Passing it in rather
 * than holding state here keeps this pure and testable, and lets the caller
 * own retention — a supplier should not accumulate a permanent log of who
 * asked what, which would be its own privacy problem.
 */
export function admitQuoteRequest(args: {
  fromDid: string;
  standing: CounterpartyStanding;
  recentAttempts: readonly QuoteAttempt[];
  nowMs: number;
  policy?: ProbingPolicy;
}): QuoteAdmission {
  const policy = args.policy ?? DEFAULT_PROBING_POLICY;
  const refuse = (reason: ProbingReason): QuoteAdmission => ({
    quote: false,
    error: PROBING_REFUSAL,
    reason,
  });

  if (args.standing === 'blocked') return refuse('blocked');

  const since = args.nowMs - policy.windowMs;
  // Counted for THIS counterparty only. A global counter would let one busy
  // customer exhaust the budget for everyone, which turns a privacy defence
  // into an outage a competitor can trigger deliberately.
  const used = args.recentAttempts.filter(
    (attempt) => attempt.fromDid === args.fromDid && attempt.atMs > since,
  ).length;

  const budget = args.standing === 'known' ? policy.knownBudget : policy.unknownBudget;
  if (used >= budget) return refuse('budget_exhausted');
  return { quote: true, remaining: budget - used - 1 };
}

/**
 * Whether two refusals are indistinguishable to the peer that received them.
 *
 * Exported because it is the property §14.3 actually requires, and a property
 * worth asserting directly rather than by eyeballing two string literals. If a
 * future refusal path adds a detail "just for debugging", this is what fails.
 */
export function refusalsAreUniform(a: QuoteAdmission, b: QuoteAdmission): boolean {
  if (a.quote || b.quote) return false;
  return a.error === b.error;
}
