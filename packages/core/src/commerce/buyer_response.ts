/**
 * The buyer's INBOUND seam — where a supplier's answer finally lands (§12.7).
 *
 * WHY THIS EXISTS. The buyer lane was built as a one-way street. The executor
 * sends an order and parks it `ambiguous` on the honest ground that "the
 * acknowledgement arrives later through the response bridge"; the re-poll asks
 * again and parks again. Nothing on this node was the response bridge. So a
 * supplier could accept an order, sign the acknowledgement, answer the
 * reconcile — and the buyer would go on asking for ever, because every answer
 * reached the D2D ingress and stopped there.
 *
 * That failure is invisible in the usual way: an order that never settles looks
 * exactly like a supplier who has not answered yet, and the loop that hides it
 * is the same loop that exists to survive a supplier who really has not.
 *
 * TWO CAPABILITIES, ONE SEAM. A submission's answer and a reconcile's answer
 * are the same document read the same way, and routing them through one
 * function is what stops the two from drifting about what an acknowledgement
 * means. Everything else on the service lane returns `not_commerce` and is left
 * entirely alone.
 *
 * THE SUPPLIER IS THE AUTHENTICATED SENDER, never a field inside the body. The
 * buyer's record is keyed on `(supplierDid, purchaseOrderId)`, so binding to a
 * body field would let any peer settle somebody else's order by naming it.
 *
 * AND IT NEVER TRUSTS THE ANSWER'S SHAPE. Both payloads go through the
 * commerce-protocol validators before anything moves, because this is the one
 * place a counterparty's bytes turn into a commercial state on this node.
 *
 * IT TAKES THE PARSED ENVELOPE, NOT THE RAW STRING. The ingress has already
 * parsed and validated the `service.response` body before it reaches here.
 * Parsing it a second time would be a second reading of the same bytes — two
 * readings that can disagree, and the commerce half would be the one nobody
 * looked at.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  readSignedQuote,
  validateOrderAcknowledgement,
  validateOrderReconcileResult,
  verifySignedQuoteForBuyer,
  type GenesisEvent,
  type OrderAcknowledgement,
  type OrderReconcileResult,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import { FIRST_REPOLL_SECONDS } from './buyer_executor';
import { verifyInboundQuote } from './buyer_quotes';
import { acknowledgementToResult } from './buyer_reconciliation';
import { SUBMIT_ORDER_CAPABILITY } from './buyer_sender';
import { verifyInboundStatus, type EnvelopeEvidence } from './buyer_status';
import { isCommerceCapability } from './capability_names';
import { recordCommerceEvent } from './observability';
import { applyReconcileAnswer } from './reconcile_poller';
import { ORDER_RECONCILE_CAPABILITY } from './reconcile_sweeper';
import { getCommerceRuntime } from './runtime';
import { noteTenderQuoteSettled } from './tender';
import { verifyInboundQuoteDecline } from './trade_ledger';
import { admitSupplierRecords } from './watermark_gate';

import type { BuyerOrderRecord } from './buyer_reconciliation';
import type { ServiceResponseBody } from '@dina/protocol';

const hash: Sha256Fn = (data) => sha256(data);

/**
 * What happened to the answer.
 *
 * Reported rather than logged, so the caller decides what an operator sees and
 * a test can tell "settled" from "silently ignored" — the two render
 * identically from outside, and the second is the defect this file fixes.
 */
export const ORDER_STATUS_CAPABILITY = 'order_status';
export const REQUEST_QUOTE_CAPABILITY = 'request_quote';
export const CANCEL_ORDER_CAPABILITY = 'cancel_order';

/**
 * What the buyer puts ON THE WIRE for a quote request (PC-9).
 *
 * The bare name above stays the canonical lane key — every recognizer
 * canonicalizes through `isCommerceCapability`. The wire carries the full
 * NSID because a supplier's LISTING is where the capability must be
 * declared, and listing keys refuse bare names (`unknown_capability`:
 * a custom capability needs a namespace). One constant per direction,
 * derived from the other, so the two spellings cannot drift.
 */
export const REQUEST_QUOTE_WIRE_CAPABILITY = `com.dinakernel.commerce.${REQUEST_QUOTE_CAPABILITY}`;

/**
 * The five buyer-side lanes, each as a one-member set so
 * `isCommerceCapability` can canonicalize the NSID and hyphenated spellings
 * the way every other commerce gate does.
 */
const SUBMIT_ORDER_LANE: ReadonlySet<string> = new Set([SUBMIT_ORDER_CAPABILITY]);
const ORDER_RECONCILE_LANE: ReadonlySet<string> = new Set([ORDER_RECONCILE_CAPABILITY]);
const ORDER_STATUS_LANE: ReadonlySet<string> = new Set([ORDER_STATUS_CAPABILITY]);
const REQUEST_QUOTE_LANE: ReadonlySet<string> = new Set([REQUEST_QUOTE_CAPABILITY]);
const CANCEL_ORDER_LANE: ReadonlySet<string> = new Set([CANCEL_ORDER_CAPABILITY]);

export type BuyerResponseOutcome =
  /** Not a commerce answer. The overwhelming majority of service responses. */
  | 'not_commerce'
  /** Commerce, but this node has no commerce runtime — nothing to settle. */
  | 'no_runtime'
  /** The supplier reported a failure rather than an answer; the order stays. */
  | 'not_an_answer'
  /** The payload is not a valid acknowledgement / reconcile result. */
  | 'unreadable'
  /** No such order under this supplier. */
  | 'unknown_order'
  /** The order exists but cannot be described, so its answer cannot be judged. */
  | 'undescribable'
  /**
   * §9.11 — the supplier contradicted its own signed chain. The buyer's head
   * does NOT move and the reason is written to the order's `protocolFault`,
   * because the last verified state is the only one this node can stand
   * behind and the contradiction is the evidence that it stopped there.
   */
  | 'chain_fork'
  /**
   * A status answer with no signed records attached.
   *
   * NOT A FAULT, and kept apart from `not_an_answer` for that reason. A
   * supplier whose order has no chain yet answers honestly with display
   * fields alone, and marking that as a protocol fault would accuse an
   * innocent counterparty. It advances nothing, which is the right effect.
   */
  | 'no_signed_chain'
  /** Verified, and every record was one the buyer already held. */
  | 'no_change'
  /**
   * §9.8/§25.3 — the supplier contradicted its own quote chain, or offered a
   * quote addressed to somebody else. Nothing is recorded, and the offer must
   * not reach ranking: a quote this node cannot place in a chain is one it
   * cannot say it was actually offered.
   */
  | 'quote_fork'
  /**
   * §16.2/§25.3 — a record from a generation this supplier has abandoned, or
   * one whose epoch cannot be read. Nothing is recorded.
   *
   * Distinct from `chain_fork` and NOT a protocol fault: most often the
   * supplier did nothing wrong. A pre-restore record it signed honestly was
   * delayed in flight and arrived after the restore that superseded it.
   * Marking the counterparty for that would accuse it of a contradiction it
   * never made.
   */
  | 'stale_epoch'
  /**
   * §16.2 — the answer carried a record attributed to a DIFFERENT supplier
   * than the authenticated sender. Nothing is recorded.
   *
   * KEPT APART FROM `stale_epoch` because the two mean opposite things about
   * the counterparty. A stale epoch is ordinary post-restore traffic; this one
   * happens only when a peer writes a third party's DID into its own answer,
   * which is the watermark-poisoning attempt the sender binding exists to
   * stop. Collapsing them would file the single observable signal of that
   * attack under "supplier restored recently", and §22's decision log would
   * have no way to tell an operator which happened.
   *
   * The usual non-disclosure argument does not apply here: this lane sends the
   * sender no reply at all, so separating the two costs nothing and only the
   * owner ever sees it.
   */
  | 'foreign_supplier'
  /**
   * §12.8 — a supplier's signed cancellation result arrived and was RECOGNISED,
   * but the buyer has no cancellation state machine to apply it to. Named so
   * an operator sees it; see the branch comment.
   */
  | 'cancellation_not_applied'
  /**
   * §9.8 — a quote arrived for a `request_id` this node never sent. Nothing is
   * recorded. Unsolicited quotes are not a lane this buyer has.
   */
  | 'unsolicited_quote'
  /**
   * §9.8/§20.4 — the quote is well formed and correctly addressed, and it does
   * not answer the question this node asked: a different request digest, a
   * different priced projection, lines that do not correspond, or a
   * substitution the request forbade. Nothing is recorded.
   */
  | 'quote_not_our_question'
  /**
   * §3.4 (TRADE_FIRST_STRATEGY) — the supplier answered the quote request
   * with a signed QuoteDecline instead of a quote. Verified against the
   * RETAINED request and recorded in the trade ledger; the tender card
   * reads it from there. Idempotent: a replay lands here too.
   */
  | 'quote_declined'
  | 'applied';

/**
 * Apply an inbound `service.response` to the buyer's order record.
 *
 * `queryId` IS the purchase order id: the buyer's own senders use it as the
 * correlation id precisely so two dispatches about one order cannot look like
 * two different questions. Reading it back here is the other half of that.
 */
export function applyInboundBuyerResponse(args: {
  /** TRANSPORT-authenticated sender. Never a field from the body. */
  supplierDid: string;
  /**
   * §12.7/§16.2 — the VERIFIED envelope that carried this answer.
   *
   * Retained so the buyer can later prove the supplier authenticated a record
   * it now denies. Optional because a node with no transport evidence (an
   * in-process test double) must still be able to settle an order; the effect
   * of its absence is that no held evidence is stored, which makes a future
   * `never_received` legal — the honest degradation, and the same one a buyer
   * that never received anything would get.
   */
  envelope?: EnvelopeEvidence;
  /** The validated `service.response` body the ingress already parsed. */
  response: Pick<ServiceResponseBody, 'capability' | 'query_id' | 'status' | 'result'>;
  nowMs: number;
}): BuyerResponseOutcome {
  const { response } = args;
  // THE SAME QUESTION THE SUPPLIER SIDE ASKS, ASKED THE SAME WAY.
  //
  // These four used to be raw string equality against the bare wire names
  // while every other commerce gate went through `isCommerceCapability`, which
  // canonicalizes the NSID and the hyphenated manifest spellings. §6.6 permits
  // suppliers that are not the reference plugin, so a conforming third party
  // echoing `com.dinakernel.commerce.submit_order` had its acknowledgement
  // silently dropped here as `not_commerce` — and the order then sat in
  // `outcome_unknown` for ever, which is the exact failure §12.7 exists to
  // prevent. `capability_names.ts` claims "every check on both sides now asks
  // the same question of the same function"; this file was the exception.
  const isSubmission = isCommerceCapability(SUBMIT_ORDER_LANE, response.capability);
  const isReconcile = isCommerceCapability(ORDER_RECONCILE_LANE, response.capability);
  const isStatus = isCommerceCapability(ORDER_STATUS_LANE, response.capability);
  const isQuote = isCommerceCapability(REQUEST_QUOTE_LANE, response.capability);
  const isCancellation = isCommerceCapability(CANCEL_ORDER_LANE, response.capability);
  if (!isSubmission && !isReconcile && !isStatus && !isQuote && !isCancellation) {
    return 'not_commerce';
  }
  // Reported apart from `unknown_order`, because an operator watching every
  // answer come back "unknown order" on a node that simply has no commerce
  // runtime would go looking in the order store for a problem that is not
  // there.
  const runtime = getCommerceRuntime();
  if (runtime === null) return 'no_runtime';
  if (response.query_id === '') return 'unknown_order';

  // A supplier that answered `unavailable` or `error` has told us about ITSELF,
  // not about the order. Settling on that would turn "my runner is down" into a
  // commercial outcome; the order stays parked and the re-poll asks again.
  if (response.status !== 'success') return 'not_an_answer';

  // §16.2/§25.3 — THE COUNTERPARTY WATERMARK, on the lane records arrive by.
  //
  // The gate itself has existed since CMC-1 and exactly one caller used it:
  // the plugin TOOL-RESULT lane, where a buyer pack's answer comes back. This
  // is the buyer's other arrival path — a supplier answering over D2D — and
  // it is the one §25.3's delayed-pre-restore-write actually travels on. A
  // record signed BEFORE the supplier's restore sits in a relay queue, or on
  // a node that never learned it had been superseded, and lands afterwards.
  // Its signature verifies and its digest verifies, because the supplier
  // really did sign it. The epoch is the only thing that gives it away, and
  // nothing here was reading it.
  //
  // Unchecked it was appended DURABLY, and the damage compounds: the stale
  // record becomes the head that the next legitimate one is judged against,
  // so a chain that was merely behind turns into a chain that reads as
  // forked — and a fork is recorded as the supplier's fault.
  //
  // Placed here, at the one choke point all four commerce capabilities pass
  // through, rather than inside `verifyInboundQuote` and `verifyInboundStatus`
  // separately: two copies of a fence are two things to forget, and the
  // acknowledgement and reconcile paths would still have had none.
  //
  // Records with no epoch to check pass untouched — an acknowledgement
  // carries no `supplier_epoch`, and inventing a refusal for it would break
  // ordinary submission traffic.
  const admitted = admitSupplierRecords({
    watermarks: runtime.watermarks,
    result: response.result,
    nowMs: args.nowMs,
    // BOUND TO THE AUTHENTICATED SENDER, never to the body. Without this the
    // fence inverts into a weapon: the record's `supplier_did` is a field the
    // peer writes, and raising a watermark from it lets any supplier this
    // buyer talks to permanently cut the buyer off from a THIRD party by
    // naming them at a huge epoch. `raiseTo` only ever goes up.
    expectedSupplierDid: args.supplierDid,
  });
  // The SENDER learns nothing either way — this lane sends no reply — so the
  // two outcomes are kept apart for the OWNER's benefit, not blurred for the
  // peer's. `foreign_supplier` is an attempt to poison a third party's fence;
  // `stale_epoch` is a supplier that restored. An operator reading the
  // decision log must be able to tell those apart.
  if (!admitted.accept) {
    return admitted.refusal.refusal === 'foreign_supplier' ? 'foreign_supplier' : 'stale_epoch';
  }

  if (isCancellation) {
    // §12.8 — RECOGNISED, and deliberately not yet applied.
    //
    // This lane previously returned `not_commerce`, which said the supplier's
    // signed `CancellationResult` was not a commerce document at all — so it
    // vanished with no trace and the buyer's record kept whatever state it
    // had. That is the wrong answer to the wrong question.
    //
    // Applying it needs a buyer-side cancellation applier that does not exist:
    // the buyer's order record has no cancellation state machine, and inventing
    // one here — flipping a record on a counterparty's say-so without the
    // §12.8 race rules the supplier side runs — would be worse than not
    // applying it. So the honest answer is a named outcome the caller audits,
    // which the receive pipeline now writes to the decision log.
    //
    // OPEN, and recorded in implementation-notes.html rather than left to be
    // discovered: the buyer learns of a cancellation only by polling status.
    return 'cancellation_not_applied';
  }

  if (isQuote) {
    return applyInboundQuote({
      supplierDid: args.supplierDid,
      result: response.result,
      nowMs: args.nowMs,
    });
  }

  if (isStatus) {
    return applyInboundStatus({
      supplierDid: args.supplierDid,
      purchaseOrderId: response.query_id,
      result: response.result,
      ...(args.envelope === undefined ? {} : { envelope: args.envelope }),
      nowMs: args.nowMs,
    });
  }

  const result = isReconcile
    ? readReconcileResult(response.result)
    : readAcknowledgementAsResult(response.result);
  if (result === null) return 'unreadable';

  return applyReconcileAnswer({
    supplierDid: args.supplierDid,
    purchaseOrderId: response.query_id,
    result,
    // §12.7 — retained with the acknowledgement it settles on. Without this
    // the buyer holds a supplier's commitment it cannot attribute, and a
    // later `never_received` is legal for want of evidence it actually had.
    ...(args.envelope === undefined ? {} : { envelope: args.envelope }),
    // No evidence argument. `applyReconcileAnswer` reads the node's installed
    // reader, and so does the ask — §12.7's legality rule is about what the
    // buyer PRESENTED, so a node that asks with evidence and judges without it
    // accepts a `never_received` it was entitled to refuse.
    nowMs: args.nowMs,
  });
}

/**
 * §9.11 fork detection, on the receiving side where the spec puts it.
 *
 * The wire answer is the SUPPLIER's published result shape — carrier
 * reference, note, a display state — with the record Core signed attached
 * under `signed_status`. Only the attachment is checkable, so only the
 * attachment is believed: the display fields are never allowed to move this
 * node's view of the chain.
 *
 * AN ANSWER WITH NO SIGNED RECORD IS NOT A FAILURE. A supplier whose order has
 * no chain yet answers honestly with display fields alone, and treating that
 * as a fault would mark an innocent counterparty. It advances nothing, which
 * is the correct effect.
 */
function applyInboundStatus(args: {
  supplierDid: string;
  purchaseOrderId: string;
  result: unknown;
  envelope?: EnvelopeEvidence;
  nowMs: number;
}): BuyerResponseOutcome {
  const runtime = getCommerceRuntime();
  if (runtime === null) return 'no_runtime';
  const record = args.result;
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return 'unreadable';
  const chain = (record as Record<string, unknown>).signed_status_chain;
  if (chain === undefined) return 'no_signed_chain';
  if (!Array.isArray(chain) || chain.length === 0) return 'unreadable';

  const order = runtime.buyerOrders.get(args.supplierDid, args.purchaseOrderId);
  if (order === null) return 'unknown_order';

  // IN ORDER, AND STOPPING AT THE FIRST REFUSAL. The records are links; once
  // one fails to attach, everything after it is unverifiable too, and applying
  // any of it would be accepting a chain with a hole in the middle.
  let applied = 0;
  for (const status of chain) {
    const ingest = verifyInboundStatus({
      supplierDid: args.supplierDid,
      purchaseOrderId: args.purchaseOrderId,
      order: {
        buyerDid: order.buyerDid,
        supplierDid: order.supplierDid,
        lines: order.orderLines,
        genesisEvent: genesisEventOf(order.acknowledgement),
      },
      status,
      // §12.7 — retained with the record, so a later reconcile can prove this
      // supplier authenticated it. Absent evidence stores none, and the
      // honest consequence is that its `never_received` stays legal.
      ...(args.envelope === undefined ? {} : { evidence: args.envelope }),
      repository: runtime.buyerStatus,
      nowMs: args.nowMs,
    });
    if (ingest.outcome === 'applied' || ingest.outcome === 'duplicate') {
      // A duplicate is the ordinary case for the record AT the buyer's stated
      // position: the supplier includes it so the first new link has the
      // predecessor it is checked against.
      if (ingest.outcome === 'applied') applied += 1;
      continue;
    }
    if (ingest.outcome === 'fork') {
      recordProtocolFault(args.supplierDid, order, `status chain fork: ${ingest.detail ?? 'unknown'}`);
      return 'chain_fork';
    }
    if (ingest.outcome === 'not_our_order') {
      // Bound to the wrong conversation. Recorded, because a supplier
      // answering about somebody else's order is not a display glitch.
      recordProtocolFault(args.supplierDid, order, `status binding: ${ingest.detail ?? 'unknown'}`);
      return 'chain_fork';
    }
    if (ingest.outcome === 'undescribable') return 'undescribable';
    return 'unreadable';
  }
  // Everything verified. `no_change` when every record was one the buyer
  // already held — a re-ask with nothing new is not a failure and must not
  // read as one.
  return applied > 0 ? 'applied' : 'no_change';
}

/**
 * The resolving event, read off the acknowledgement the buyer HOLDS.
 *
 * This is what makes genesis checkable at all: §9.11 fixes the genesis state
 * per event, so a supplier that acknowledged `rejected` and then signs an
 * `accepted` genesis is caught here rather than after it has shipped nothing.
 * With no acknowledgement there is no event, and the ingest refuses rather
 * than guessing the most likely one.
 */
function genesisEventOf(acknowledgement: OrderAcknowledgement | null): GenesisEvent | null {
  if (acknowledgement === null) return null;
  switch (acknowledgement.kind) {
    case 'accepted':
      return 'accepted';
    case 'rejected':
      return 'rejected';
    case 'counterproposal':
      return 'counterproposal';
    default:
      return null;
  }
}

/**
 * Write the fault to the order without touching its commercial state.
 *
 * A CAS failure here is ignored ON PURPOSE. Another writer moving the row
 * means the fault may be lost, and re-reading to retry would be the wrong
 * trade: this path runs while answering a counterparty, and a retry loop
 * against a busy row would hold that answer open. The chain itself already
 * refused to move, which is the part that protects the owner.
 */
function recordProtocolFault(
  supplierDid: string,
  order: BuyerOrderRecord,
  fault: string,
): void {
  const runtime = getCommerceRuntime();
  if (runtime === null) return;
  runtime.buyerOrders.put(supplierDid, { ...order, protocolFault: fault });
}

/**
 * §9.8/§25.3 — a supplier's quote, checked against the chain this node holds.
 *
 * WHY THE BUYER CHECKS AT ALL. Supplier-side CAS at signing is run by the
 * party a buyer is worried about, so it protects nobody here. Without a
 * receiver-side check a supplier could hand one buyer revision 3 and another
 * a different revision 3, or open a chain at revision 4 and be believed about
 * three revisions this node never saw — which is re-pricing dressed as a
 * revision.
 *
 * THE QUOTE MAY BE ANYWHERE IN THE ANSWER. A supplier pack publishes its own
 * `request_quote` result shape, so the signed quote is looked for under the
 * conventional key and, failing that, taken as the whole result. Guessing more
 * widely would mean searching a counterparty's document for something to
 * believe.
 */
function applyInboundQuote(args: {
  supplierDid: string;
  result: unknown;
  nowMs: number;
}): BuyerResponseOutcome {
  const runtime = getCommerceRuntime();
  if (runtime === null) return 'no_runtime';
  // §9.8 audience binding needs to know who WE are. Reading the quote's own
  // `buyer_did` instead would be trusting the field the check exists to
  // verify. An empty identity means this node cannot say, and refusing is the
  // only honest answer — a quote addressed to nobody in particular is exactly
  // what a broadcast re-price looks like.
  const nodeDid = runtime.nodeDid();
  if (nodeDid === '') return 'undescribable';
  const candidate =
    args.result !== null && typeof args.result === 'object' && !Array.isArray(args.result)
      ? ((args.result as Record<string, unknown>).quote ?? args.result)
      : args.result;

  // §9.8 BUYER-SIDE BINDINGS, against the request this node actually sent.
  //
  // `verifyInboundQuote` below checks the chain and the audience; it cannot
  // check whether the quote answers the QUESTION, because that needs the
  // retained request. `verifySignedQuoteForBuyer` does — `request_digest`
  // against the request this node sent, `priced_delivery_projection_digest`
  // against the projection it priced, line correspondence, substitution
  // authority, and acceptance-time expiry. It had no caller because there was
  // no store to read from, which left §20.4's bait-and-switch unguarded: a
  // supplier could price a different projection, or answer a different
  // request, and the buyer would record the quote as its own offer.
  //
  // A quote for a request this node never sent is REFUSED, not merely
  // unverified. Unsolicited quotes are not a lane this buyer has: every quote
  // it should ever see answers something it asked for, so an unmatched
  // `request_id` is either a stray or an attempt.
  const structural = readSignedQuote(candidate, hash);
  if (!structural.ok) {
    // §3.4 — the OTHER valid answer on this lane: a signed decline. Tried
    // only after the quote read fails, so a document that is both (cannot
    // exist — different digest fields) never races. Verified against the
    // retained request; recorded in the trade ledger, where the tender
    // card reads it. Every refusal maps onto this lane's existing
    // vocabulary rather than inventing parallel outcomes.
    const declineCandidate =
      args.result !== null && typeof args.result === 'object' && !Array.isArray(args.result)
        ? ((args.result as Record<string, unknown>).decline ?? candidate)
        : candidate;
    const declined = verifyInboundQuoteDecline({
      senderDid: args.supplierDid,
      selfDid: nodeDid,
      decline: declineCandidate,
      repository: runtime.tradeDocuments,
      readRequest: (requestId) => runtime.buyerQuoteRequests.get(requestId),
      evidenceJson: '{}',
      nowMs: args.nowMs,
    });
    switch (declined.outcome) {
      case 'applied':
      case 'duplicate':
        recordCommerceEvent({
          event: 'quote_declined',
          lane: 'order',
          draftId: '',
          atMs: args.nowMs,
        });
        return 'quote_declined';
      case 'not_ours':
        return 'quote_fork';
      case 'refused':
        return declined.detail?.includes('no retained request') === true
          ? 'unsolicited_quote'
          : 'quote_not_our_question';
      case 'conflict':
        return 'quote_declined'; // the held decline stands; idempotent to the caller
      case 'unreadable':
        return 'unreadable';
    }
  }
  // AUDIENCE BEFORE QUESTION, and the order carries meaning. A quote addressed
  // to a different buyer, or claiming a supplier other than the authenticated
  // sender, is `quote_fork` — the outcome that already covers "offered to
  // somebody else". Letting the §9.8 binding check answer first would report
  // every misaddressed quote as one that answers the wrong question, which is
  // a different accusation about a different mistake.
  if (
    structural.quote.buyer_did !== nodeDid ||
    structural.quote.supplier_did !== args.supplierDid
  ) {
    return 'quote_fork';
  }
  const retained = runtime.buyerQuoteRequests.get(structural.quote.request_id);
  if (retained === null) return 'unsolicited_quote';
  const bindingError = verifySignedQuoteForBuyer(
    candidate,
    {
      buyer_did: nodeDid,
      // The TRANSPORT-authenticated sender, not the quote's own field.
      authenticated_supplier_did: args.supplierDid,
      retained_request_digest: retained.request_digest,
      sent_projection_digest: retained.delivery.projection.projection_digest,
      epoch_watermark: runtime.watermarks.get(args.supplierDid),
      retained_request: retained,
      at_iso: new Date(args.nowMs).toISOString(),
    },
    hash,
  );
  if (bindingError !== null) return 'quote_not_our_question';

  const ingest = verifyInboundQuote({
    supplierDid: args.supplierDid,
    buyerDid: nodeDid,
    quote: candidate,
    repository: runtime.buyerQuotes,
    nowMs: args.nowMs,
  });
  switch (ingest.outcome) {
    case 'applied':
    case 'duplicate':
      // §5.4 stage 2's SETTLE (PC-7): a verified quote that answers a photo
      // draft's own request advances that conversation. Runs on `duplicate`
      // too — a crash between the quote landing and the conversation moving
      // must be healed by the redelivery, not wedged by it.
      settleQuoteIntoDraftConversation(runtime, structural.quote, args.nowMs);
      // §3.2 — the tender correlation, same crash-healing rule: a member
      // whose quote landed correlates on redelivery too.
      noteTenderQuoteSettled(structural.quote.request_id, structural.quote.quote_id);
      return ingest.outcome === 'applied' ? 'applied' : 'no_change';
    case 'fork':
    case 'not_our_quote':
      return 'quote_fork';
    default:
      return 'unreadable';
  }
}

/**
 * Advance the draft conversation a VERIFIED quote answers (§5.4 stages 2–3):
 *
 *   - `sent` → `quoted`, holding the exact accepted revision's digest — the
 *     one `/orders/drafts/approve` will refuse to deviate from;
 *   - `quoted` with a NEWER revision → the digest advances; the terms the
 *     buyer will be shown are the terms now on offer;
 *   - `approved` with a newer revision → §5.5's counterproposal row: the old
 *     approval is invalidated and the conversation returns to `quoted`,
 *     because re-approval on the diff is required — an approval must never
 *     outlive the terms it approved;
 *   - a TERMINAL conversation (retired assignment, §5.4 stage 3a) does not
 *     move: the late quote stays visible as supplier history in the verified
 *     store and can never become approvable.
 *
 * Only the quote's OWN request id selects the conversation, and the quote
 * reaching here has already passed `verifySignedQuoteForBuyer` — audience,
 * supplier binding, retained-request digest, §9.1 arithmetic. A quote that
 * failed any of that was refused above and no conversation moved.
 */
function settleQuoteIntoDraftConversation(
  runtime: NonNullable<ReturnType<typeof getCommerceRuntime>>,
  quote: { request_id: string; quote_id: string; quote_digest: string; valid_until: string },
  nowMs: number,
): void {
  for (const draft of runtime.orderDrafts.list()) {
    if (draft.abandoned) continue;
    const conversation = draft.conversations.find((c) => c.requestId === quote.request_id);
    if (conversation === undefined) continue;
    if (
      conversation.state !== 'sent' &&
      conversation.state !== 'quoted' &&
      conversation.state !== 'approved'
    ) {
      return;
    }
    if (conversation.quoteDigest === quote.quote_digest) return;
    runtime.runInTransaction(() => {
      if (conversation.state === 'approved' && conversation.approvalId !== null) {
        runtime.orderApprovals.consume(conversation.approvalId, nowMs);
        conversation.approvalId = null;
      }
      conversation.state = 'quoted';
      conversation.quoteDigest = quote.quote_digest;
      conversation.quoteId = quote.quote_id;
      conversation.quoteValidUntil = quote.valid_until;
      draft.updatedAtMs = nowMs;
      runtime.orderDrafts.put(draft);
    });
    recordCommerceEvent({
      event: 'quote_received',
      lane: 'order',
      draftId: draft.draftId,
      conversationId: conversation.conversationId,
      supplierDid: conversation.supplierDid,
      atMs: nowMs,
    });
    return;
  }
}

function readReconcileResult(value: unknown): OrderReconcileResult | null {
  if (validateOrderReconcileResult(value, hash) !== null) return null;
  return value as OrderReconcileResult;
}

/**
 * A submission's answer is an ACKNOWLEDGEMENT, and it is read through the same
 * mapping the executor uses for the one that came back on the send.
 */
function readAcknowledgementAsResult(value: unknown): OrderReconcileResult | null {
  if (validateOrderAcknowledgement(value, hash) !== null) return null;
  return acknowledgementToResult(value as OrderAcknowledgement, FIRST_REPOLL_SECONDS);
}
