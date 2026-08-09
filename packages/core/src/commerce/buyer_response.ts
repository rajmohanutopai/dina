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
  validateOrderAcknowledgement,
  validateOrderReconcileResult,
  type GenesisEvent,
  type OrderAcknowledgement,
  type OrderReconcileResult,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import { FIRST_REPOLL_SECONDS } from './buyer_executor';
import { acknowledgementToResult } from './buyer_reconciliation';
import { SUBMIT_ORDER_CAPABILITY } from './buyer_sender';
import { verifyInboundQuote } from './buyer_quotes';
import { verifyInboundStatus, type EnvelopeEvidence } from './buyer_status';
import { applyReconcileAnswer } from './reconcile_poller';
import { ORDER_RECONCILE_CAPABILITY } from './reconcile_sweeper';
import { getCommerceRuntime } from './runtime';

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
  const isSubmission = response.capability === SUBMIT_ORDER_CAPABILITY;
  const isReconcile = response.capability === ORDER_RECONCILE_CAPABILITY;
  const isStatus = response.capability === ORDER_STATUS_CAPABILITY;
  const isQuote = response.capability === REQUEST_QUOTE_CAPABILITY;
  if (!isSubmission && !isReconcile && !isStatus && !isQuote) return 'not_commerce';
  // Reported apart from `unknown_order`, because an operator watching every
  // answer come back "unknown order" on a node that simply has no commerce
  // runtime would go looking in the order store for a problem that is not
  // there.
  if (getCommerceRuntime() === null) return 'no_runtime';
  if (response.query_id === '') return 'unknown_order';

  // A supplier that answered `unavailable` or `error` has told us about ITSELF,
  // not about the order. Settling on that would turn "my runner is down" into a
  // commercial outcome; the order stays parked and the re-poll asks again.
  if (response.status !== 'success') return 'not_an_answer';

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

  const ingest = verifyInboundQuote({
    supplierDid: args.supplierDid,
    buyerDid: nodeDid,
    quote: candidate,
    repository: runtime.buyerQuotes,
    nowMs: args.nowMs,
  });
  switch (ingest.outcome) {
    case 'applied':
      return 'applied';
    case 'duplicate':
      return 'no_change';
    case 'fork':
    case 'not_our_quote':
      return 'quote_fork';
    default:
      return 'unreadable';
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
