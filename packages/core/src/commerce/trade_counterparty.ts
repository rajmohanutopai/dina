/**
 * Is a DID the counterparty of an order this node holds? (review item 8)
 *
 * Money-free and read-only. The answer rests on a decision this node made or
 * an order its owner placed, never on anything the sender says or can cause:
 *
 *   - As a supplier: an order from that buyer which this node ACCEPTED. A
 *     receipt alone is not enough, because admission retains the receipt of
 *     every REFUSED proposal too, and any peer can cause one of those by
 *     naming a quote this node never issued.
 *   - As a buyer: an order this node itself placed with that supplier (the
 *     owner chose them).
 *
 * Only the order-bound khata kinds qualify. The revenue-share chain names no
 * order, so its documents stay with contacts.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { rehydrateAcknowledgement, rehydratePurchaseOrder, type Sha256Fn } from './rehydrate';

import type { CommerceRuntime } from './runtime';

const hash: Sha256Fn = (data) => sha256(data);

/**
 * The order-bound khata kinds (`INBOUND_AT_BUYER` + `INBOUND_AT_SUPPLIER` in
 * `trade_ingress.ts`). Listed here because that module sits behind the money
 * line and this one must not; a parity test keeps the two lists equal.
 */
export const ORDER_BOUND_TRADE_KINDS: readonly string[] = [
  'delivery_note',
  'payment_ack',
  'order_attachment',
  'delivery_receipt',
  'payment_note',
];

export function isOrderCounterparty(
  runtime: Pick<CommerceRuntime, 'receipts' | 'orders' | 'nodeDid'>,
  did: string,
  kind: string,
): boolean {
  if (!ORDER_BOUND_TRADE_KINDS.includes(kind)) return false;
  const self = runtime.nodeDid();
  if (did === '' || did === self) return false;
  // They ordered from this node, and this node accepted.
  for (const receipt of runtime.receipts.listByBuyerAndDomain(did, 'order')) {
    const order = runtime.orders.load(did, receipt.purchaseOrderId);
    if (order === null || !order.isDecided || order.ref.orderDigest !== receipt.recordDigest) {
      continue;
    }
    const ack = rehydrateAcknowledgement(order.acknowledgementJson, hash);
    if (ack.ok && ack.value.kind === 'accepted') return true;
  }
  // This node ordered from them.
  for (const receipt of runtime.receipts.listByBuyerAndDomain(self, 'order')) {
    const order = rehydratePurchaseOrder(receipt.recordJson, hash);
    if (order.ok && order.value.supplier_did === did) return true;
  }
  return false;
}
