/**
 * The buyer's side of an ambiguous outcome (§12.7, FR-P6, WS-7.7).
 *
 * A submission may have reached the supplier while the acknowledgement was
 * lost. The buyer parks in `outcome_unknown` and NEVER blindly creates a
 * second order — the whole point of the reconcile capability is that the
 * ambiguity is resolved by contract rather than by guessing.
 *
 * THE RULE WITH TEETH, and the one everything here exists to protect:
 * `never_received` is the only outcome that authorizes resubmission, and it is
 * legal only when the buyer presented NO supplier-signed evidence. A supplier
 * that cannot find the order but was handed an acknowledgement bearing its own
 * valid signature must re-adopt, not deny — and a buyer that resubmitted on
 * such a denial would create the duplicate order the whole protocol is built
 * to avoid. So the buyer checks the legality of the answer it received rather
 * than trusting it, and stays parked when the answer is unsound.
 *
 * `received_unresolved` NEVER authorizes resubmission, however long it loops.
 * There is deliberately no buyer-side timeout that converts it to a terminal
 * state: a timeout would be the buyer deciding, on a clock, that an effect
 * which may have fired did not. Only the supplier's real acknowledgement exits
 * the loop.
 *
 * PURE, and durable by construction: every state transition is a value, so the
 * caller persists it and the loop survives a buyer restart. A poll counter
 * that lived in memory would reset on relaunch and quietly restart a bounded
 * backoff from zero.
 */

import {
  neverReceivedIsLegal,
  reconcileOutcomePermitsResubmission,
  verifyAcknowledgementForOrder,
  type OrderAcknowledgement,
  type OrderReconcileRequest,
  type OrderReconcileResult,
  type PurchaseOrderLine,
} from '@dina/commerce-protocol';

import type { EnvelopeEvidence } from './buyer_status';

/**
 * The buyer-side order states of §12.7.
 *
 * `outcome_unknown` is the DURABLE PARKED FORM of `submitted_unconfirmed`,
 * not a separate lifecycle: the difference is whether the buyer has already
 * asked and been told the answer is not ready.
 */
export type BuyerOrderState =
  | 'submitted_unconfirmed'
  | 'outcome_unknown'
  | 'accepted'
  | 'rejected'
  | 'countered'
  | 'never_received';

/** Is this a state the machine never moves out of? Exported so the store's
 *  conflict resolution and the machine agree on one definition. */
export function isTerminalBuyerState(state: BuyerOrderState): boolean {
  return TERMINAL.has(state);
}

const TERMINAL: ReadonlySet<BuyerOrderState> = new Set([
  'accepted',
  'rejected',
  'countered',
  'never_received',
]);

/**
 * Everything a LATER question about an order needs: what to ask, and where.
 *
 * Named as one thing because it is one thing — an order this node can no
 * longer describe is one it cannot ask about at all, and a partial
 * description is the dangerous case rather than the useful one.
 */
export interface OrderDescription {
  orderDigest: string;
  idempotencyKey: string;
  protocolVersion: string;
  serviceRkey: string;
  /**
   * §9.12/§20.4 — what an ANSWER about this order must match.
   *
   * The re-poll needs `orderDigest` and `idempotencyKey` to ask. These four
   * are what the answer is checked against when it comes back, and they live
   * on the record for the same reason: the answer arrives long after the order
   * is gone from memory, sometimes on a different process, and a check that
   * has to be handed its own yardstick is a check a caller can skip.
   *
   * `buyerDid` is this node and `supplierDid` is the counterparty — stored
   * rather than re-derived, so the comparison is against the order that was
   * actually SENT rather than against whoever happens to be answering.
   */
  quoteDigest: string;
  quoteId: string;
  /**
   * The lines as sent. §9.11's cumulative-fulfilment rule is a RECEIVER check
   * and cannot run without them; see `BuyerOrderRecord.orderLines`.
   */
  orderLines?: PurchaseOrderLine[];
  buyerDid: string;
  supplierDid: string;
}

export interface BuyerOrderRecord {
  purchaseOrderId: string;
  /**
   * §12.7 — what the re-poll needs to ASK, carried on the record itself.
   *
   * The loop is required to survive a restart, which is why `pollCount` is
   * persisted. These are the other half of that: a buyer that knows it should
   * ask again but cannot say WHICH order is asking about nothing, and a
   * supplier's honest answer to that question is `never_received` — the one
   * answer that must never arrive by accident.
   *
   * Empty on a record written before these existed. The sweep treats an
   * undescribable order as "do not ask" rather than "ask anyway".
   */
  orderDigest: string;
  idempotencyKey: string;
  /** The version the order was sent at; a reconcile must match it (§9.13). */
  protocolVersion: string;
  /** WHICH of the supplier's listings the order went to. */
  serviceRkey: string;
  /** The four fields an inbound acknowledgement is bound against; see `OrderDescription`. */
  quoteDigest: string;
  quoteId: string;
  buyerDid: string;
  supplierDid: string;
  /**
   * The row's version, for compare-and-swap (§12.7 durability).
   *
   * Every write to this record is load → decide → write, with an AWAIT in the
   * middle: the executor sends, the poller asks a supplier. Without a swap
   * value the last writer wins, and the writer that wins is the SLOWEST — so a
   * send completing after a re-poll already settled the order overwrites a
   * terminal acknowledgement with `outcome_unknown`, and two workers each
   * spend the one resubmission authorization.
   *
   * Zero on a record this build created before revisions existed; the store
   * treats that as a real value, so a first CAS still has something to match.
   */
  revision: number;
  state: BuyerOrderState;
  /** The acknowledgement that ended the ambiguity, when one did. */
  acknowledgement: OrderAcknowledgement | null;
  /** When the next reconcile poll is due, in epoch ms. Null when not looping. */
  nextPollAtMs: number | null;
  /** How many times the loop has run. Persisted, so a restart cannot reset it. */
  pollCount: number;
  /**
   * True only after a `never_received` that was LEGAL to give.
   *
   * A separate field from the state, because "the supplier never saw it" and
   * "you may send it again" are different claims and the second is the
   * dangerous one. Reading it off the state name would make the dangerous
   * claim the default reading of the safe one.
   */
  resubmissionAuthorized: boolean;
  /**
   * Set when this record is not one the node can stand behind — either the
   * supplier's answer was not one it was entitled to give, or the stored
   * evidence no longer re-validates.
   *
   * Recorded rather than thrown: the order is still the owner's problem, and
   * an exception would lose the reason at exactly the moment somebody needs
   * to read it.
   */
  protocolFault: string | null;
  /**
   * The order's lines AS SENT (§9.11).
   *
   * Null on a record written before this existed, and the status ingest
   * refuses such an order rather than checking its fulfilment against an
   * empty list — an empty list rejects every status that carries lines, so a
   * missing snapshot would turn ordinary dispatch into a supplier fork.
   */
  orderLines: PurchaseOrderLine[] | null;
  /**
   * §12.7/§16.2 — the verified D2D envelope that delivered the
   * acknowledgement.
   *
   * This is what makes a later `never_received` illegal. Null when the
   * acknowledgement arrived with no transport evidence, and the honest
   * consequence is that the supplier's denial stays legal: the buyer cannot
   * present what it cannot attribute.
   */
  ackEvidence: EnvelopeEvidence | null;
}

export function newBuyerOrder(
  purchaseOrderId: string,
  /** Optional so existing callers compile; the sweep skips a record without
   *  it rather than asking a question it cannot phrase. */
  describe?: OrderDescription,
): BuyerOrderRecord {
  return {
    purchaseOrderId,
    orderDigest: describe?.orderDigest ?? '',
    idempotencyKey: describe?.idempotencyKey ?? '',
    protocolVersion: describe?.protocolVersion ?? '',
    serviceRkey: describe?.serviceRkey ?? '',
    quoteDigest: describe?.quoteDigest ?? '',
    quoteId: describe?.quoteId ?? '',
    buyerDid: describe?.buyerDid ?? '',
    supplierDid: describe?.supplierDid ?? '',
    revision: 0,
    state: 'submitted_unconfirmed',
    acknowledgement: null,
    nextPollAtMs: null,
    pollCount: 0,
    resubmissionAuthorized: false,
    protocolFault: null,
    orderLines: describe?.orderLines ?? null,
    ackEvidence: null,
  };
}

/**
 * Is this acknowledgement about the order this record describes?
 *
 * Returns the fault, or null when the answer belongs to the order. The
 * comparison runs through `verifyAcknowledgementForOrder` — the protocol's own
 * rule, so the buyer applies the SAME check a conformance vector pins and a
 * port must implement, rather than a second opinion that can drift.
 *
 * FAILS CLOSED ON AN UNDESCRIBABLE RECORD. A record that cannot say what it
 * ordered cannot judge an answer about it, and the safe reading of "I do not
 * know what I sent" is not "then anything matches". This is the same rule the
 * re-poll already applies when it refuses to ASK from such a record.
 */
export function acknowledgementBindingFault(
  record: BuyerOrderRecord,
  ack: OrderAcknowledgement,
): string | null {
  if (
    record.orderDigest === '' ||
    record.quoteDigest === '' ||
    record.quoteId === '' ||
    record.buyerDid === '' ||
    record.supplierDid === ''
  ) {
    return 'this node cannot say what it ordered, so it cannot confirm this answer is about it';
  }
  return verifyAcknowledgementForOrder(ack, {
    purchase_order_id: record.purchaseOrderId,
    order_digest: record.orderDigest,
    buyer_did: record.buyerDid,
    supplier_did: record.supplierDid,
    quote_digest: record.quoteDigest,
    quote_id: record.quoteId,
    // §9.13 — the record knows the version this conversation was opened at,
    // so the answer is held to it. A supplier upgrading mid-conversation is
    // agreeing to terms written in a different field set.
    ...(record.protocolVersion === '' ? {} : { protocol_version: record.protocolVersion }),
  });
}

/**
 * Write a settlement, and decide what a LOST RACE means.
 *
 * Every buyer-side write is load → await → write: the executor sends, the
 * poller asks a supplier. When the row moved underneath, the answer is NOT
 * "try again with my value" — my value is older than what is already there,
 * and forcing it would let the slowest writer win. Two rules, and both are
 * about the same thing:
 *
 *   the live row is TERMINAL   — leave it. An acknowledgement is the first
 *                                commitment, not the last message; overwriting
 *                                it with `outcome_unknown` is how a settled
 *                                order becomes a duplicate.
 *   the live row is not        — re-apply this answer ON TOP of the live row,
 *                                so the newer poll count and schedule survive
 *                                and the answer is not simply dropped.
 *
 * `resubmissionAuthorized` is never carried forward from MY stale copy, which
 * is what stops two workers each spending the one authorization.
 */
export function settleBuyerOrder(args: {
  orders: {
    get(supplierDid: string, purchaseOrderId: string): BuyerOrderRecord | null;
    put(supplierDid: string, record: BuyerOrderRecord): boolean;
  };
  supplierDid: string;
  settled: BuyerOrderRecord;
  /** Re-derive the answer against a row that moved. */
  reapply: (live: BuyerOrderRecord) => BuyerOrderRecord;
}): BuyerOrderRecord {
  if (args.orders.put(args.supplierDid, args.settled)) {
    return { ...args.settled, revision: args.settled.revision + 1 };
  }
  const live = args.orders.get(args.supplierDid, args.settled.purchaseOrderId);
  if (live === null) return args.settled;
  if (isTerminalBuyerState(live.state)) return live;
  const merged = args.reapply(live);
  // ONE retry. A second conflict means a third writer, and looping here would
  // turn contention into a spin on the hot path of an order lane.
  return args.orders.put(args.supplierDid, merged)
    ? { ...merged, revision: merged.revision + 1 }
    : live;
}

/** Seconds are clamped, so a hostile or buggy supplier cannot park a buyer forever. */
export const MIN_REPOLL_SECONDS = 5;
export const MAX_REPOLL_SECONDS = 3600;

function repollAt(nowMs: number, seconds: number): number {
  const bounded = Math.min(Math.max(Math.floor(seconds), MIN_REPOLL_SECONDS), MAX_REPOLL_SECONDS);
  return nowMs + bounded * 1000;
}

/**
 * Apply a reconcile answer to a parked order.
 *
 * `request` is the reconcile request the buyer SENT, because §12.7's legality
 * rule is about what the buyer presented: a `never_received` answer means one
 * thing against an empty request and something quite different against one
 * carrying the supplier's own signature.
 */
export function applyReconcileResult(args: {
  record: BuyerOrderRecord;
  request: OrderReconcileRequest;
  result: OrderReconcileResult;
  nowMs: number;
}): BuyerOrderRecord {
  const { record, result } = args;
  if (TERMINAL.has(record.state)) {
    // A terminal order does not move. A late answer arriving after the
    // supplier already acknowledged is not new information, and letting it
    // overwrite would make the last message win rather than the first
    // commitment.
    return record;
  }

  switch (result.outcome) {
    case 'received_accepted':
    case 'received_rejected':
    case 'received_countered': {
      // THE ANSWER MUST BE ABOUT THIS ORDER, and until now nothing checked it.
      // The acknowledgement was validated for shape and for its own digest,
      // then stored verbatim as the buyer's record of what was agreed — so a
      // supplier answering the question about order A with an acknowledgement
      // naming order B, a different `order_digest`, a different buyer, or an
      // `accepted_quote_digest` for terms the owner never approved became the
      // settled commercial evidence, and §16.2 re-adoption would later present
      // it back as proof.
      //
      // Checked HERE because every path converges here: the inbound response
      // seam, the reconcile sweep, and the executor's own send outcome. A
      // check at the three call sites is a check two of them can drift from.
      const mismatch = acknowledgementBindingFault(record, result.acknowledgement);
      if (mismatch !== null) {
        // PARKED, not settled and not rejected. The supplier said something
        // this node cannot attribute to this order; the order's real outcome
        // is still unknown, and the loop asks again.
        return {
          ...record,
          state: 'outcome_unknown',
          nextPollAtMs: repollAt(args.nowMs, MIN_REPOLL_SECONDS),
          pollCount: record.pollCount + 1,
          resubmissionAuthorized: false,
          protocolFault: mismatch,
        };
      }
      const state: BuyerOrderState =
        result.outcome === 'received_accepted'
          ? 'accepted'
          : result.outcome === 'received_rejected'
            ? 'rejected'
            : 'countered';
      return {
        ...record,
        state,
        // The EVIDENCE, not just the verdict. §12.7: a bare claim without the
        // acknowledgement payload is invalid, because the buyer's own record
        // of what was agreed is the signed document and not this reply.
        acknowledgement: result.acknowledgement,
        nextPollAtMs: null,
        resubmissionAuthorized: false,
        protocolFault: null,
      };
    }

    case 'received_processing':
    case 'received_unresolved':
      return {
        ...record,
        // THE TWO ARE NOT THE SAME STATE, and §12.7 is explicit about it:
        // `received_processing` means the decision has not reached the
        // external boundary, so the buyer is still simply WAITING
        // (`submitted_unconfirmed`); `received_unresolved` means the effect
        // MAY have fired, which is the parked, ambiguous form. A first version
        // collapsed both into `outcome_unknown` and a surviving mutation
        // proved it: swapping one for the other changed nothing observable,
        // which is exactly what a lost distinction looks like. Neither
        // authorizes resubmission — the difference is what the owner is told.
        state:
          result.outcome === 'received_processing' ? 'submitted_unconfirmed' : 'outcome_unknown',
        nextPollAtMs: repollAt(args.nowMs, result.retry_after_seconds),
        pollCount: record.pollCount + 1,
        // Neither loop authorizes resubmission. `received_unresolved` in
        // particular means the effect MAY have fired, which is the one state
        // where sending again is most likely to duplicate a real order.
        resubmissionAuthorized: false,
        protocolFault: null,
      };

    case 'never_received': {
      const illegal = neverReceivedIsLegal(args.request);
      if (illegal !== null) {
        // The supplier denied an order while holding its own signature on it.
        // The buyer stays PARKED: resubmitting here is precisely the duplicate
        // §12.7 exists to prevent, and treating the denial as terminal would
        // close an order the supplier may still be holding.
        return {
          ...record,
          state: 'outcome_unknown',
          nextPollAtMs: repollAt(args.nowMs, MIN_REPOLL_SECONDS),
          pollCount: record.pollCount + 1,
          resubmissionAuthorized: false,
          protocolFault: illegal,
        };
      }
      return {
        ...record,
        state: 'never_received',
        nextPollAtMs: null,
        // The one outcome that permits it, and the protocol's own predicate
        // decides — not a second reading of the outcome name here.
        resubmissionAuthorized: reconcileOutcomePermitsResubmission(result),
        protocolFault: null,
      };
    }
  }
}

/** What an owner is shown, and what they are offered (§18, WS-7.7). */
export interface OwnerOrderView {
  purchaseOrderId: string;
  state: BuyerOrderState;
  /** One line, in the owner's terms. Never reassuring beyond the evidence. */
  headline: string;
  /** Why the node is in this state, when that is not obvious from the headline. */
  detail: string | null;
  /**
   * What the owner may do. `resend` appears ONLY on an authorized
   * `never_received`; every other state offers waiting or asking again,
   * because those are the only honest options.
   */
  actions: OwnerOrderAction[];
  /** When the node will ask again by itself, in epoch ms. */
  nextPollAtMs: number | null;
  pollCount: number;
}

export type OwnerOrderAction =
  | 'wait'
  | 'reconcile_now'
  | 'resend'
  | 'view_acknowledgement'
  /** §9.11 — ask the supplier where an accepted order has got to. */
  | 'check_status';

/**
 * Render an order for the owner.
 *
 * ONE PROJECTION, shared by every client (FR-P10, WS-7.8). Mobile and web
 * consume this function's output rather than each deriving a headline from the
 * state name — two renderers would eventually disagree about whether
 * `outcome_unknown` means "failed", and one of those readings invites the
 * owner to press send again.
 *
 * The honesty rule: nothing here says an order did not happen unless the
 * supplier said so and was entitled to. Everything else says the truth, which
 * is that the node does not yet know.
 */
export function describeOrderForOwner(record: BuyerOrderRecord): OwnerOrderView {
  const base = {
    purchaseOrderId: record.purchaseOrderId,
    state: record.state,
    nextPollAtMs: record.nextPollAtMs,
    pollCount: record.pollCount,
  };

  switch (record.state) {
    case 'submitted_unconfirmed':
      return {
        ...base,
        headline: 'Sent. Waiting for the supplier to confirm.',
        detail: null,
        actions: ['wait', 'reconcile_now'],
      };

    case 'outcome_unknown':
      return {
        ...base,
        headline: 'Sent. The supplier has not confirmed yet.',
        // Deliberately not "it failed" and not "it went through". Both are
        // claims the node cannot support, and the second one is how a duplicate
        // order gets placed.
        detail:
          record.protocolFault === null
            ? 'The order may have reached them. Dina will keep asking rather than send it again.'
            : `The supplier's answer was not one it could give: ${record.protocolFault}. Dina is still asking.`,
        actions: ['wait', 'reconcile_now'],
      };

    case 'accepted':
      return {
        ...base,
        headline: 'Accepted by the supplier.',
        detail: null,
        // `check_status` lives ONLY here. Before acceptance there is no chain
        // to report on and `reconcile_now` is the right question; after a
        // terminal rejection or counter there is nothing left to fulfil. An
        // accepted order is the one state where a supplier has something to
        // say and no other action asks for it.
        actions: ['view_acknowledgement', 'check_status'],
      };

    case 'rejected':
      return {
        ...base,
        headline: 'Rejected by the supplier.',
        detail: null,
        actions: ['view_acknowledgement'],
      };

    case 'countered':
      return {
        ...base,
        headline: 'The supplier countered with different terms.',
        detail: 'Nothing is agreed until you accept the counter.',
        actions: ['view_acknowledgement'],
      };

    case 'never_received':
      return {
        ...base,
        headline: 'The supplier never received this order.',
        detail: record.resubmissionAuthorized
          ? 'Sending the same order again is safe — it will carry the original key.'
          : 'Dina is not offering to send it again, because the supplier’s answer did not settle the question.',
        // The ONE place `resend` is offered, and only when the answer that
        // produced it was legal.
        actions: record.resubmissionAuthorized ? ['resend'] : ['wait', 'reconcile_now'],
      };
  }
}

/** Is a re-poll due? Kept beside the state machine so callers do not invent it. */
export function isPollDue(record: BuyerOrderRecord, nowMs: number): boolean {
  return record.nextPollAtMs !== null && nowMs >= record.nextPollAtMs;
}

/**
 * An acknowledgement, narrowed to the reconcile outcome that carries it.
 *
 * HERE rather than beside either caller. Two paths receive a supplier's
 * acknowledgement — the answer to a submission and the answer to a reconcile —
 * and they must read the same document the same way. A second copy of this
 * switch would eventually meet a kind one copy knew and the other did not, and
 * the divergence would show up as an order that is `accepted` on one path and
 * parked on the other.
 *
 * An UNKNOWN kind parks rather than settling. The supplier answered something,
 * so the order may well exist, and guessing a terminal state for an answer this
 * build cannot read is how a real commitment gets closed by mistake.
 */
export function acknowledgementToResult(
  acknowledgement: OrderAcknowledgement,
  /** Seconds until the first re-poll of an answer this build cannot read. */
  unknownKindRetrySeconds: number,
): OrderReconcileResult {
  switch (acknowledgement.kind) {
    case 'accepted':
      return { outcome: 'received_accepted', acknowledgement };
    case 'rejected':
      return { outcome: 'received_rejected', acknowledgement };
    case 'counterproposal':
      return { outcome: 'received_countered', acknowledgement };
    default:
      return { outcome: 'received_unresolved', retry_after_seconds: unknownKindRetrySeconds };
  }
}
