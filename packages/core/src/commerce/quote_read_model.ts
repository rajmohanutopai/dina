/**
 * What a supplier is shown about the quotes they have issued (FR-P10, §18.3).
 *
 * The ORDER surface got this treatment first: one projection, so mobile and web
 * render the same headline and the same action list rather than each deriving
 * one from a state name. The argument was that two renderers eventually
 * disagree about what `outcome_unknown` means, and one of those readings puts a
 * duplicate order on the wire.
 *
 * The quote surface has the same shape and its own version of that risk. A
 * quote's state is a JOIN — the head's `voided` flag, its validity window, its
 * revision, and how much of its capacity is spent — and a client computing
 * "live" from any one of those alone is wrong in a specific, expensive way: an
 * owner told a voided quote is live will honour terms this node has already
 * refused to stand behind, and a supplier who says a thing twice and means it
 * once has a dispute rather than a sale.
 *
 * SO THE JOIN HAPPENS HERE, ONCE. The precedence below is the SAME order
 * `QuoteFamily` uses when it refuses, and that is not a coincidence to be
 * tidied away: a card that ranked expiry above voiding would tell an owner a
 * quote merely lapsed when in fact this node disowned it.
 */

import type { CommerceQuoteHead } from './quote_ledger';

/**
 * What an owner may do with one of their own quotes.
 *
 * Deliberately short. `void` is the only ACT — everything else on this surface
 * is a fact about a quote the owner already issued, and inventing buttons for
 * facts is how a card starts offering to un-expire something.
 */
/**
 * What an owner may do with one of their own quotes.
 *
 * `view` ONLY, and that is a correction rather than the original design. The
 * first version offered `void` on a live quote, and nothing performs it: the
 * aggregate exposes `voidPreRestore` — §16.2's blanket disowning after a
 * restore — and there is no owner-initiated void of a single quote anywhere,
 * no route and no aggregate method. Offering a button that can only dead-end
 * breaks this codebase's own rule that the command is authorized by the SAME
 * projection that offered it, and it breaks it in the direction that matters:
 * an owner who believes they withdrew an offer, and has not.
 *
 * The gap is real and recorded (WS-7.8). A supplier SHOULD be able to disown
 * one quote. Until that command exists, the card says what is true.
 */
export type OwnerQuoteAction = 'view';

export type OwnerQuoteState =
  /** Signed, in date, capacity left. The only state that can still be ordered against. */
  | 'live'
  /** Disowned by this node (§16.2 restore, or an owner's own decision). */
  | 'voided'
  /** Past its validity window. */
  | 'expired'
  /** Every counted use is spent (§9.9). */
  | 'consumed';

export interface OwnerQuoteView {
  quoteId: string;
  buyerDid: string;
  state: OwnerQuoteState;
  /** One line, in the owner's terms. */
  headline: string;
  /** Why, when the headline alone would leave an owner guessing. */
  detail: string | null;
  actions: OwnerQuoteAction[];
  /** Counted uses spent against this family, and the ceiling. */
  usesSpent: number;
  maxUses: number;
  /** End of the validity window, epoch ms. */
  validUntil: number;
  headRevision: string;
}

/**
 * Render one quote family for its owner.
 *
 * `usesSpent` is passed in rather than read here, because counting uses is a
 * second store's question and a read model that reached for it would be a read
 * model that needs a database. The caller joins; this decides what the join
 * MEANS.
 */
export function describeQuoteForOwner(
  head: CommerceQuoteHead,
  usesSpent: number,
  nowMs: number,
): OwnerQuoteView {
  const maxUses = Number.parseInt(head.maxUses, 10);
  const base = {
    quoteId: head.quoteId,
    buyerDid: head.buyerDid,
    // NaN would render as "NaN of 3 used" on somebody's screen. A max_uses
    // this build cannot read is treated as ONE — the protocol default — which
    // is the reading that offers the least and is therefore the safe one.
    maxUses: Number.isSafeInteger(maxUses) && maxUses > 0 ? maxUses : 1,
    usesSpent,
    validUntil: head.validUntil,
    headRevision: head.headRevision,
  };

  // PRECEDENCE, and it matches `QuoteFamily`'s refusal order on purpose.
  // Voided outranks expired because they are different facts: expiry is time
  // passing, voiding is this node disowning the offer. An owner told "expired"
  // about a voided quote would reasonably re-issue the same terms.
  if (head.voided) {
    return {
      ...base,
      state: 'voided',
      headline: 'Withdrawn. This node will not stand behind it.',
      detail:
        'A quote is voided by a restore (§16.2) or by your own decision. Issue a fresh quote rather than re-offering this one.',
      actions: ['view'],
    };
  }
  if (nowMs >= head.validUntil) {
    return {
      ...base,
      state: 'expired',
      headline: 'Expired.',
      // Said plainly because it is the common case and an owner reading it
      // needs to know the offer is simply over, not that anything went wrong.
      detail: null,
      actions: ['view'],
    };
  }
  if (usesSpent >= base.maxUses) {
    return {
      ...base,
      state: 'consumed',
      headline: 'Fully used.',
      detail: `All ${String(base.maxUses)} of this quote's uses are spent. A further order against it is refused.`,
      actions: ['view'],
    };
  }
  return {
    ...base,
    state: 'live',
    headline: 'Live. The buyer can still order against this.',
    detail:
      base.maxUses > 1
        ? `${String(base.maxUses - usesSpent)} of ${String(base.maxUses)} uses remain.`
        : null,
    actions: ['view'],
  };
}
