/**
 * The buyer's inbound seam, driven through the REAL receive pipeline (§12.7).
 *
 * `buyer_response.test.ts` proves the seam's rules. This proves it is REACHED,
 * which is the half that keeps going missing on this workstream: a defence
 * nothing calls looks exactly like a defence that never fires, and the whole
 * buyer lane sat one-way for that reason.
 *
 * So this test starts where a supplier's answer actually starts — a sealed,
 * signed `service.response` arriving over D2D — and asserts the order settles.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { commerceRecordDigest, type Sha256Fn } from '@dina/commerce-protocol';
import { TEST_ED25519_SEED } from '@dina/test-harness';

import { resetAuditState } from '../../src/audit/service';
import { InMemoryBuyerOrderRepository } from '../../src/commerce/buyer_orders';
import { newBuyerOrder, type BuyerOrderRecord } from '../../src/commerce/buyer_reconciliation';
import { installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';
import { getPublicKey } from '../../src/crypto/ed25519';
import { sealMessage, type DinaMessage } from '../../src/d2d/envelope';
import { clearGatesState } from '../../src/d2d/gates';
import { resetQuarantineState } from '../../src/d2d/quarantine';
import { receiveD2D } from '../../src/d2d/receive_pipeline';
import { resetServiceWindows, setRequesterWindow } from '../../src/service/windows';
import { resetStagingState } from '../../src/staging/service';
import { clearReplayCache } from '../../src/transport/adversarial';

const hash: Sha256Fn = (data) => sha256(data);

const supplierPriv = TEST_ED25519_SEED;
const supplierPub = getPublicKey(supplierPriv);
const buyerPriv = new Uint8Array(32).fill(0x42);
const buyerPub = getPublicKey(buyerPriv);

const SUPPLIER = 'did:plc:chairmaker99';
const BUYER = 'did:plc:sancho42';
const ORDER_DIGEST = 'a'.repeat(64);
const QUOTE_DIGEST = 'b'.repeat(64);
const QUOTE_ID = 'q-1';
const PO = 'po-1';

let buyerOrders: InMemoryBuyerOrderRepository;

function parked(): BuyerOrderRecord {
  return {
    ...newBuyerOrder(PO, {
      protocolVersion: '1.0',
      orderDigest: ORDER_DIGEST,
      idempotencyKey: 'idem-1',
      serviceRkey: 'wholesale',
      quoteDigest: QUOTE_DIGEST,
      quoteId: QUOTE_ID,
      buyerDid: BUYER,
      supplierDid: SUPPLIER,
    }),
    state: 'outcome_unknown',
    nextPollAtMs: Date.now() - 1,
    pollCount: 1,
  };
}

function acceptance(): Record<string, unknown> {
  const base = {
    protocol_version: '1.0',
    acknowledgement_id: 'ack-1',
    purchase_order_id: PO,
    order_digest: ORDER_DIGEST,
    buyer_did: BUYER,
    supplier_did: SUPPLIER,
    issued_at: '2026-08-09T10:00:00Z',
    kind: 'accepted',
    supplier_order_id: 'so-1',
    accepted_quote_digest: QUOTE_DIGEST,
    accepted_at: '2026-08-09T10:00:00Z',
  };
  return { ...base, acknowledgement_digest: commerceRecordDigest('acknowledgement', base, hash) };
}

/** A sealed, signed `service.response` exactly as the relay would deliver it. */
function sealedAnswer(capability: string, result: unknown, from = SUPPLIER) {
  const msg: DinaMessage = {
    id: `msg-${capability}`,
    type: 'service.response',
    from,
    to: BUYER,
    created_time: Date.now(),
    body: JSON.stringify({
      query_id: PO,
      capability,
      status: 'success',
      result,
      ttl_seconds: 300,
    }),
  };
  return sealMessage(msg, supplierPriv, buyerPub);
}

beforeEach(() => {
  clearGatesState();
  resetStagingState();
  resetAuditState();
  resetQuarantineState();
  clearReplayCache();
  resetServiceWindows();
  buyerOrders = new InMemoryBuyerOrderRepository();
  installCommerceRuntime({ buyerOrders } as unknown as CommerceRuntime);
  buyerOrders.create(SUPPLIER, parked());
});

afterEach(() => {
  installCommerceRuntime(null);
  resetServiceWindows();
});

describe('a supplier answer arriving over D2D', () => {
  it('settles the parked order when the acknowledgement lands', () => {
    // The window the buyer's own send opened. Without it the ingress denies
    // the response, which is the correct behaviour and also the reason this
    // test opens one rather than asserting against a denied message.
    setRequesterWindow(SUPPLIER, PO, 'submit_order', 300);

    const result = receiveD2D(
      sealedAnswer('submit_order', acceptance()),
      buyerPub,
      buyerPriv,
      [supplierPub],
      'unknown',
      { authenticatedFromDID: SUPPLIER, authenticatedToDID: BUYER },
    );

    expect(result.action).toBe('bypassed');
    const after = buyerOrders.get(SUPPLIER, PO);
    expect(after?.state).toBe('accepted');
    expect(after?.nextPollAtMs).toBeNull();
  });

  it('settles on a reconcile answer the same way', () => {
    setRequesterWindow(SUPPLIER, PO, 'order_reconcile', 300);

    receiveD2D(
      sealedAnswer('order_reconcile', {
        outcome: 'received_accepted',
        acknowledgement: acceptance(),
      }),
      buyerPub,
      buyerPriv,
      [supplierPub],
      'unknown',
      { authenticatedFromDID: SUPPLIER, authenticatedToDID: BUYER },
    );

    expect(buyerOrders.get(SUPPLIER, PO)?.state).toBe('accepted');
  });

  it('leaves the order alone when the ingress refuses the response', () => {
    // No window: the answer is dropped before the seam. The order must stay
    // parked rather than settle on a message the node did not accept — the
    // seam must sit BEHIND the gate, not beside it.
    const result = receiveD2D(
      sealedAnswer('submit_order', acceptance()),
      buyerPub,
      buyerPriv,
      [supplierPub],
      'unknown',
      { authenticatedFromDID: SUPPLIER, authenticatedToDID: BUYER },
    );

    expect(result.action).not.toBe('bypassed');
    expect(buyerOrders.get(SUPPLIER, PO)?.state).toBe('outcome_unknown');
  });

  it('does not let one node settle an order placed with another', () => {
    // A peer that legitimately holds a window of its own relays ChairMaker's
    // acknowledgement verbatim. The record is keyed on the AUTHENTICATED
    // sender, so ChairMaker's order does not move.
    const IMPOSTOR = 'did:plc:impostor';
    setRequesterWindow(IMPOSTOR, PO, 'submit_order', 300);

    const result = receiveD2D(
      sealedAnswer('submit_order', acceptance(), IMPOSTOR),
      buyerPub,
      buyerPriv,
      [supplierPub],
      'unknown',
      { authenticatedFromDID: IMPOSTOR, authenticatedToDID: BUYER },
    );

    expect(result.action).toBe('bypassed');
    expect(buyerOrders.get(SUPPLIER, PO)?.state).toBe('outcome_unknown');
  });

  it('carries every other capability through untouched', () => {
    setRequesterWindow(SUPPLIER, PO, 'eta_query', 300);

    const result = receiveD2D(
      sealedAnswer('eta_query', { eta_minutes: 45 }),
      buyerPub,
      buyerPriv,
      [supplierPub],
      'unknown',
      { authenticatedFromDID: SUPPLIER, authenticatedToDID: BUYER },
    );

    expect(result.action).toBe('bypassed');
    expect(buyerOrders.get(SUPPLIER, PO)?.state).toBe('outcome_unknown');
  });
});
