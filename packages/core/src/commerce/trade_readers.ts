/**
 * The khata relationship readers (TRADE_FIRST_STRATEGY §4.2–§4.4), over
 * the §16.2 receipts store — ONE definition shared by the owner routes,
 * the D2D trade ingress and the tender comparison, because an order this
 * node retained must resolve identically whichever seam asks.
 *
 * The readers try BOTH relationship keys: an order's `buyer_did` is this
 * node on the buyer side and the counterparty on the supplier side, and
 * the reader, not its callers, is where that fact lives. Every record is
 * re-validated through the rehydration module on the way out — the
 * verified-on-read discipline of the stores it walks.
 *
 * A purchase order id is the buyer's choice, so it names one order only
 * together with both parties. Every read checks that the record is between
 * THIS node and the counterparty. `role` names this node's side: pass it
 * whenever the caller knows it, because a dual-role pair can hold one id on
 * each side. With no role the buyer side is tried first.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  rehydrateAcknowledgement,
  rehydratePurchaseOrder,
  rehydrateSignedQuote,
  type Sha256Fn,
} from './rehydrate';

import type { CommerceMoneyStores, CommerceRuntime } from './runtime';
import type { PurchaseOrderProposal, SignedQuote } from '@dina/commerce-protocol';

const hash: Sha256Fn = (data) => sha256(data);

type TradeRole = 'buyer' | 'supplier';

export interface TradeRelationshipReaders {
  readOrder: (
    counterpartyDid: string,
    purchaseOrderId: string,
    role?: TradeRole,
  ) => PurchaseOrderProposal | null;
  readBoundQuote: (
    counterpartyDid: string,
    purchaseOrderId: string,
    role?: TradeRole,
  ) => SignedQuote | null;
  /**
   * Orders of this relationship holding an accepted acknowledgement.
   * `role` names THIS node's side; §4.4 defines the fold per orientation,
   * so a dual-role pair (each supplies the other) is TWO ledgers and a
   * money fold must never merge them. Absent role keeps both — for
   * existence checks only, never for folding.
   */
  listAcceptedOrderIds: (counterpartyDid: string, role?: 'buyer' | 'supplier') => string[];
  /**
   * True when this node holds the supplier's REJECTED acknowledgement for
   * the order and no accepted one: the order is settled as not happening.
   */
  isOrderRejected: (counterpartyDid: string, purchaseOrderId: string) => boolean;
  /** The retained ACCEPTED acknowledgement's clock (§4.5 from_acceptance). */
  readAcceptance: (
    counterpartyDid: string,
    purchaseOrderId: string,
    role?: TradeRole,
  ) => { acceptedAt: string } | null;
}

export function tradeRelationshipReaders(runtime: CommerceRuntime): TradeRelationshipReaders {
  /** The (buyer, supplier) pairs an order of this relationship can have. */
  const sides = (
    counterpartyDid: string,
    role?: TradeRole,
  ): { buyer: string; supplier: string }[] => {
    const self = runtime.nodeDid();
    const asBuyer = { buyer: self, supplier: counterpartyDid };
    const asSupplier = { buyer: counterpartyDid, supplier: self };
    if (role === 'buyer') return [asBuyer];
    if (role === 'supplier') return [asSupplier];
    return [asBuyer, asSupplier];
  };
  const readOrder = (
    counterpartyDid: string,
    purchaseOrderId: string,
    role?: TradeRole,
  ): PurchaseOrderProposal | null => {
    for (const { buyer, supplier } of sides(counterpartyDid, role)) {
      for (const receipt of runtime.receipts.listByOrder(buyer, purchaseOrderId)) {
        if (receipt.domain !== 'order') continue;
        const order = rehydratePurchaseOrder(receipt.recordJson, hash);
        if (
          order.ok &&
          order.value.purchase_order_id === purchaseOrderId &&
          order.value.buyer_did === buyer &&
          order.value.supplier_did === supplier
        ) {
          return order.value;
        }
      }
    }
    return null;
  };
  const readBoundQuote = (
    counterpartyDid: string,
    purchaseOrderId: string,
    role?: TradeRole,
  ): SignedQuote | null => {
    const order = readOrder(counterpartyDid, purchaseOrderId, role);
    if (order === null) return null;
    for (const receipt of runtime.receipts.listByQuote(order.quote_id)) {
      if (receipt.domain !== 'quote') continue;
      const quote = rehydrateSignedQuote(receipt.recordJson, hash);
      if (quote.ok && quote.value.quote_digest === order.quote_digest) return quote.value;
    }
    return null;
  };
  const listAcceptedOrderIds = (counterpartyDid: string, role?: 'buyer' | 'supplier'): string[] => {
    const ids = new Set<string>();
    const self = runtime.nodeDid();
    for (const buyerKey of [self, counterpartyDid]) {
      for (const receipt of runtime.receipts.listByBuyerAndDomain(buyerKey, 'acknowledgement')) {
        const ack = rehydrateAcknowledgement(receipt.recordJson, hash);
        if (!ack.ok || ack.value.kind !== 'accepted') continue;
        const pair =
          ack.value.buyer_did === self && ack.value.supplier_did === counterpartyDid
            ? 'buyer'
            : ack.value.supplier_did === self && ack.value.buyer_did === counterpartyDid
              ? 'supplier'
              : null;
        if (pair === null) continue;
        if (role !== undefined && pair !== role) continue;
        ids.add(ack.value.purchase_order_id);
      }
    }
    return [...ids];
  };
  const readAcceptance = (
    counterpartyDid: string,
    purchaseOrderId: string,
    role?: TradeRole,
  ): { acceptedAt: string } | null => {
    for (const { buyer, supplier } of sides(counterpartyDid, role)) {
      for (const receipt of runtime.receipts.listByOrder(buyer, purchaseOrderId)) {
        if (receipt.domain !== 'acknowledgement') continue;
        const ack = rehydrateAcknowledgement(receipt.recordJson, hash);
        if (!ack.ok || ack.value.kind !== 'accepted') continue;
        if (ack.value.purchase_order_id !== purchaseOrderId) continue;
        if (ack.value.buyer_did !== buyer || ack.value.supplier_did !== supplier) continue;
        if (typeof ack.value.accepted_at !== 'string' || ack.value.accepted_at === '') continue;
        return { acceptedAt: ack.value.accepted_at };
      }
    }
    return null;
  };
  const isOrderRejected = (counterpartyDid: string, purchaseOrderId: string): boolean => {
    // A buyer tracks the supplier's answer on its own order record; its
    // receipts retain accepted acknowledgements only.
    if (runtime.buyerOrders.get(counterpartyDid, purchaseOrderId)?.state === 'rejected')
      return true;
    let rejected = false;
    for (const { buyer, supplier } of sides(counterpartyDid)) {
      for (const receipt of runtime.receipts.listByOrder(buyer, purchaseOrderId)) {
        if (receipt.domain !== 'acknowledgement') continue;
        const ack = rehydrateAcknowledgement(receipt.recordJson, hash);
        if (!ack.ok || ack.value.purchase_order_id !== purchaseOrderId) continue;
        if (ack.value.buyer_did !== buyer || ack.value.supplier_did !== supplier) continue;
        if (ack.value.kind === 'accepted') return false;
        if (ack.value.kind === 'rejected') rejected = true;
      }
    }
    return rejected;
  };
  return { readOrder, readBoundQuote, listAcceptedOrderIds, readAcceptance, isOrderRejected };
}

/**
 * Which sides of a khata this node holds evidence for, per §4.4's
 * one-fold-per-orientation rule. Evidence is money-bearing only: accepted
 * orders, delivery notes and payment acknowledgements — the documents a
 * fold reads. A pair with BOTH sides populated is two ledgers, and the
 * statement surface must name the one it wants.
 */
export function tradeOrientations(
  runtime: CommerceRuntime,
  money: CommerceMoneyStores,
  counterpartyDid: string,
): { supplier: boolean; buyer: boolean } {
  const readers = tradeRelationshipReaders(runtime);
  let supplier = readers.listAcceptedOrderIds(counterpartyDid, 'supplier').length > 0;
  let buyer = readers.listAcceptedOrderIds(counterpartyDid, 'buyer').length > 0;
  for (const row of money.tradeDocuments.listByCounterparty(counterpartyDid, 'delivery_note')) {
    if (row.direction === 'outbound') supplier = true;
    else buyer = true;
  }
  for (const row of money.tradeDocuments.listByCounterparty(counterpartyDid, 'payment_ack')) {
    if (row.direction === 'outbound') supplier = true;
    else buyer = true;
  }
  return { supplier, buyer };
}
