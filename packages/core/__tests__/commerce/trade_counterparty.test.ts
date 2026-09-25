/**
 * Review item 8, as corrected by the review round: a non-contact reaches the
 * trade lane only as the counterparty of an order this node ACCEPTED (as
 * supplier) or PLACED (as buyer), and only for an order-bound kind. A refused
 * proposal — which any peer can cause by naming a quote this node never
 * issued — leaves a receipt, and must not open the lane.
 */

import { CommerceOrderStore } from '../../src/commerce/commerce_order';
import { InMemoryCommerceOrderRefRepository } from '../../src/commerce/order_refs';
import { InMemoryCommerceReceiptRepository } from '../../src/commerce/receipts';
import {
  ORDER_BOUND_TRADE_KINDS,
  isOrderCounterparty,
} from '../../src/commerce/trade_counterparty';
import { INBOUND_AT_BUYER, INBOUND_AT_SUPPLIER } from '../../src/commerce/trade_ingress';

import {
  BUYER_DID,
  SUPPLIER_DID,
  makeAcknowledgement,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
} from './helpers';

const T0 = 1_800_000_000_000;
const request = makeQuoteRequest();
const quote = makeSignedQuote(request);
const order = makeOrder(quote, request.delivery.projection);

function node(self: string) {
  const receipts = new InMemoryCommerceReceiptRepository();
  const orders = new CommerceOrderStore({
    refs: new InMemoryCommerceOrderRefRepository(),
    now: () => T0,
  });
  return { receipts, orders, nodeDid: () => self };
}

function retainOrder(runtime: ReturnType<typeof node>): void {
  runtime.receipts.put({
    recordDigest: order.order_digest,
    domain: 'order',
    buyerDid: order.buyer_did,
    quoteId: order.quote_id,
    purchaseOrderId: order.purchase_order_id,
    recordJson: JSON.stringify(order),
    evidenceJson: '{}',
    createdAt: T0,
  });
}

function decide(runtime: ReturnType<typeof node>, kind: 'accepted' | 'rejected'): void {
  expect(
    runtime.orders.createReserved({
      buyerDid: order.buyer_did,
      purchaseOrderId: order.purchase_order_id,
      idempotencyKey: order.idempotency_key,
      orderDigest: order.order_digest,
      quoteId: order.quote_id,
      quoteDigest: quote.quote_digest,
      pinnedVersion: '1.0',
      servingManifestCid: '',
      servingInstallId: '',
      admittedEpoch: '1',
      reconciliationRequired: false,
      decisionDeadlineAt: null,
      createdAt: T0,
    }),
  ).toBe(true);
  const ack = makeAcknowledgement({
    purchase_order_id: order.purchase_order_id,
    order_digest: order.order_digest,
    ...(kind === 'accepted'
      ? { kind: 'accepted', supplier_order_id: 'SO-1', accepted_quote_digest: quote.quote_digest }
      : { kind: 'rejected', reason_code: 'quote_unknown' }),
  } as never);
  const loaded = runtime.orders.load(order.buyer_did, order.purchase_order_id);
  expect(loaded?.decide({ acknowledgementJson: JSON.stringify(ack), decidedAt: T0 + 1 }).ok).toBe(
    true,
  );
}

describe('who is a trading counterparty', () => {
  it('the order-bound kinds are exactly the ingress lists, so a new khata kind cannot slip past', () => {
    expect([...ORDER_BOUND_TRADE_KINDS].sort()).toEqual(
      [...INBOUND_AT_BUYER, ...INBOUND_AT_SUPPLIER].sort(),
    );
  });

  it('a supplier admits the buyer of an order it ACCEPTED, for an order-bound kind', () => {
    const supplier = node(SUPPLIER_DID);
    retainOrder(supplier);
    decide(supplier, 'accepted');
    expect(isOrderCounterparty(supplier, BUYER_DID, 'payment_note')).toBe(true);
    expect(isOrderCounterparty(supplier, BUYER_DID, 'delivery_receipt')).toBe(true);
  });

  it('a REFUSED proposal leaves a receipt but makes nobody a counterparty', () => {
    const supplier = node(SUPPLIER_DID);
    retainOrder(supplier);
    decide(supplier, 'rejected');
    expect(isOrderCounterparty(supplier, BUYER_DID, 'payment_note')).toBe(false);
  });

  it('a receipt with no decided order, or a reserved one, admits nothing', () => {
    const supplier = node(SUPPLIER_DID);
    retainOrder(supplier);
    expect(isOrderCounterparty(supplier, BUYER_DID, 'payment_note')).toBe(false);
  });

  it('a buyer admits the supplier of an order it PLACED', () => {
    const buyer = node(BUYER_DID);
    retainOrder(buyer);
    expect(isOrderCounterparty(buyer, SUPPLIER_DID, 'delivery_note')).toBe(true);
    expect(isOrderCounterparty(buyer, 'did:plc:someoneelse', 'delivery_note')).toBe(false);
    expect(isOrderCounterparty(buyer, BUYER_DID, 'delivery_note')).toBe(false);
  });

  it('the revenue-share chain names no order and stays with contacts', () => {
    const supplier = node(SUPPLIER_DID);
    retainOrder(supplier);
    decide(supplier, 'accepted');
    for (const kind of [
      'agreement_proposal',
      'agreement_decision',
      'agreement_termination',
      'settlement_note',
      'settlement_ack',
      'not_a_kind',
      '',
    ]) {
      expect([kind, isOrderCounterparty(supplier, BUYER_DID, kind)]).toEqual([kind, false]);
    }
  });
});
