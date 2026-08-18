/**
 * §16.2 retention, BUYER SIDE (TRADE_FIRST_STRATEGY §4.2).
 *
 * The supplier's admission path has always retained the order, the bound
 * quote and its own acknowledgement into the receipts store — and every
 * khata reader (`tradeRelationshipReaders`, the §4.4 statement, §4.5
 * dues, the §10 books) walks THAT store. The buyer path retained its
 * purchases only in `buyerOrders`, which those readers never see — so a
 * live buyer node refused every DeliveryNote its supplier sent ("no
 * retained order"), derived no dues, and booked no Purchase vouchers.
 * Found on real nodes, 2026-08-18; invisible to every unit fixture that
 * seeded the buyer's receipts by hand.
 *
 * Two writes, at the two commitments:
 *  - order + bound quote when the order is COMPOSED AND TRACKED (the
 *    submit path's record step — a crash after this must still know
 *    what was ordered);
 *  - the acknowledgement when the order settles ACCEPTED (both settle
 *    choke points: the submit-time ack and `applyReconcileAnswer`).
 *
 * Rows are keyed by the ORDER's own `buyer_did` — this node — which is
 * exactly the second key `tradeRelationshipReaders` already tries.
 * `receipts.put` is first-writer-wins on the digest, so every call here
 * is idempotent and a re-settle re-retains nothing.
 */

import type { BuyerOrderRecord } from './buyer_reconciliation';
import type { CommerceRuntime } from './runtime';
import type { PurchaseOrderProposal, SignedQuote } from '@dina/commerce-protocol';

/** Retain the composed order and the revision it accepted. */
export function retainBuyerOrderAndQuote(
  runtime: CommerceRuntime,
  order: PurchaseOrderProposal,
  heldQuote: SignedQuote | null,
  nowMs: number,
): void {
  runtime.receipts.put({
    recordDigest: order.order_digest,
    domain: 'order',
    buyerDid: order.buyer_did,
    quoteId: order.quote_id,
    purchaseOrderId: order.purchase_order_id,
    recordJson: JSON.stringify(order),
    evidenceJson: '{}',
    createdAt: nowMs,
  });
  if (heldQuote !== null) {
    runtime.receipts.put({
      recordDigest: heldQuote.quote_digest,
      domain: 'quote',
      buyerDid: order.buyer_did,
      quoteId: heldQuote.quote_id,
      purchaseOrderId: '',
      recordJson: JSON.stringify(heldQuote),
      evidenceJson: '{}',
      createdAt: nowMs,
    });
  }
}

/** Retain the supplier's acceptance when a settle lands on it. */
export function retainAcceptedAcknowledgement(
  runtime: CommerceRuntime,
  record: BuyerOrderRecord,
  nowMs: number,
): void {
  if (record.state !== 'accepted' || record.acknowledgement === null) return;
  // §16.2 stores digest-keyed rows only. A settled ack always carries its
  // digest on the wire path (it was digest-verified at admission); an
  // ack without one — a hand-built double — must not become a row keyed
  // by `undefined`.
  if (typeof record.acknowledgement.acknowledgement_digest !== 'string') return;
  if (record.acknowledgement.acknowledgement_digest === '') return;
  runtime.receipts.put({
    recordDigest: record.acknowledgement.acknowledgement_digest,
    domain: 'acknowledgement',
    buyerDid: record.buyerDid,
    quoteId: '',
    purchaseOrderId: record.purchaseOrderId,
    recordJson: JSON.stringify(record.acknowledgement),
    evidenceJson: '{}',
    createdAt: nowMs,
  });
}
