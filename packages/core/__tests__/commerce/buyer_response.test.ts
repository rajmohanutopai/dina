/**
 * The buyer's inbound seam (§12.7) — where a supplier's answer lands.
 *
 * The lane it closes was a one-way street: the executor sent an order and
 * parked it, the re-poll asked again and parked again, and every answer
 * reached the D2D ingress and stopped. An order that never settles is
 * indistinguishable from a supplier who has not answered yet, which is why
 * nothing noticed.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { commerceRecordDigest, type Sha256Fn } from '@dina/commerce-protocol';
import { type ServiceResponseBody } from '@dina/protocol';

import { InMemoryBuyerOrderRepository } from '../../src/commerce/buyer_orders';
import { newBuyerOrder, type BuyerOrderRecord } from '../../src/commerce/buyer_reconciliation';
import { applyInboundBuyerResponse } from '../../src/commerce/buyer_response';
import { installHeldEvidenceReader } from '../../src/commerce/reconcile_poller';
import { installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';
import { makeHeldEvidence } from './helpers';

const hash: Sha256Fn = (data) => sha256(data);

const NOW = 1_700_000_000_000;
const SUPPLIER = 'did:plc:chairmaker99';
const BUYER = 'did:plc:sancho42';
const ORDER_DIGEST = 'a'.repeat(64);
// The order this node SENT. An answer is now checked against these, so the
// fixture record and the fixture acknowledgement have to agree about them —
// which is the property under test, not boilerplate.
const QUOTE_DIGEST = 'b'.repeat(64);
const QUOTE_ID = 'q-1';

const DESCRIBED = {
  protocolVersion: '1.0',
  orderDigest: ORDER_DIGEST,
  idempotencyKey: 'idem-1',
  serviceRkey: 'wholesale',
  quoteDigest: QUOTE_DIGEST,
  quoteId: QUOTE_ID,
  buyerDid: BUYER,
  supplierDid: SUPPLIER,
};

let buyerOrders: InMemoryBuyerOrderRepository;

beforeEach(() => {
  buyerOrders = new InMemoryBuyerOrderRepository();
  installCommerceRuntime({ buyerOrders } as unknown as CommerceRuntime);
  buyerOrders.create(SUPPLIER, parked('po-1'));
});
afterEach(() => {
  installCommerceRuntime(null);
  installHeldEvidenceReader(null);
});

function parked(id: string): BuyerOrderRecord {
  return {
    ...newBuyerOrder(id, DESCRIBED),
    state: 'outcome_unknown',
    nextPollAtMs: NOW - 1,
    pollCount: 1,
  };
}

/** A real, digest-valid acceptance — the validator recomputes the digest. */
function acceptance(purchaseOrderId = 'po-1'): Record<string, unknown> {
  const base = {
    protocol_version: '1.0',
    acknowledgement_id: 'ack-1',
    purchase_order_id: purchaseOrderId,
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

/**
 * The validated `service.response` body the ingress hands over. Built as an
 * object rather than a JSON string on purpose: the ingress has already parsed
 * and validated it, and the seam reads that object rather than the bytes.
 */
function response(body: {
  capability: string;
  status: string;
  result?: unknown;
  error?: string;
  queryId?: string;
}): {
  capability: string;
  query_id: string;
  status: ServiceResponseBody['status'];
  result?: unknown;
} {
  return {
    capability: body.capability,
    query_id: body.queryId ?? 'po-1',
    status: body.status as ServiceResponseBody['status'],
    result: body.result,
  };
}

describe('routing', () => {
  it('leaves every non-commerce capability entirely alone', () => {
    // This runs on EVERY inbound service response on the node. A seam that
    // touched anything else would be a commerce dependency in the bus-timetable
    // lane.
    expect(
      applyInboundBuyerResponse({
        supplierDid: SUPPLIER,
        response: response({ capability: 'bus_eta', status: 'success', result: acceptance() }),
        nowMs: NOW,
      }),
    ).toBe('not_commerce');
    expect(buyerOrders.get(SUPPLIER, 'po-1')?.state).toBe('outcome_unknown');
  });

  it('says so rather than blaming the order store when there is no commerce runtime', () => {
    installCommerceRuntime(null);
    expect(
      applyInboundBuyerResponse({
        supplierDid: SUPPLIER,
        response: response({ capability: 'submit_order', status: 'success', result: acceptance() }),
        nowMs: NOW,
      }),
    ).toBe('no_runtime');
  });
});

describe('a submission answered later (§9.10)', () => {
  it('settles the parked order on the acknowledgement', () => {
    expect(
      applyInboundBuyerResponse({
        supplierDid: SUPPLIER,
        response: response({ capability: 'submit_order', status: 'success', result: acceptance() }),
        nowMs: NOW,
      }),
    ).toBe('applied');
    const after = buyerOrders.get(SUPPLIER, 'po-1');
    expect(after?.state).toBe('accepted');
    // Settled means it stops appearing to the re-poll. That IS how the loop
    // ends — no cancellation, no timer to forget.
    expect(after?.nextPollAtMs).toBeNull();
    expect(after?.acknowledgement).not.toBeNull();
  });

  it('refuses an acknowledgement whose digest does not match its own content', () => {
    // The row is the buyer's record of a commitment. A tampered or truncated
    // answer must not become one.
    const tampered = { ...acceptance(), supplier_order_id: 'so-swapped' };
    expect(
      applyInboundBuyerResponse({
        supplierDid: SUPPLIER,
        response: response({ capability: 'submit_order', status: 'success', result: tampered }),
        nowMs: NOW,
      }),
    ).toBe('unreadable');
    expect(buyerOrders.get(SUPPLIER, 'po-1')?.state).toBe('outcome_unknown');
  });

  it('treats a supplier reporting its own failure as no answer at all', () => {
    // `unavailable` is a fact about the SUPPLIER, not about the order.
    // Settling on it would turn "my runner is down" into a commercial outcome.
    expect(
      applyInboundBuyerResponse({
        supplierDid: SUPPLIER,
        response: response({
          capability: 'submit_order',
          status: 'unavailable',
          error: 'runner offline',
        }),
        nowMs: NOW,
      }),
    ).toBe('not_an_answer');
    expect(buyerOrders.get(SUPPLIER, 'po-1')?.state).toBe('outcome_unknown');
  });
});

describe('a reconcile answered later (§12.7)', () => {
  it('settles on a terminal answer', () => {
    expect(
      applyInboundBuyerResponse({
        supplierDid: SUPPLIER,
        response: response({
          capability: 'order_reconcile',
          status: 'success',
          result: { outcome: 'received_accepted', acknowledgement: acceptance() },
        }),
        nowMs: NOW,
      }),
    ).toBe('applied');
    expect(buyerOrders.get(SUPPLIER, 'po-1')?.state).toBe('accepted');
  });

  it('re-parks an unresolved answer without authorizing a resend', () => {
    expect(
      applyInboundBuyerResponse({
        supplierDid: SUPPLIER,
        response: response({
          capability: 'order_reconcile',
          status: 'success',
          result: { outcome: 'received_unresolved', retry_after_seconds: 60 },
        }),
        nowMs: NOW,
      }),
    ).toBe('applied');
    const after = buyerOrders.get(SUPPLIER, 'po-1');
    expect(after?.state).toBe('outcome_unknown');
    expect(after?.nextPollAtMs).toBeGreaterThan(NOW);
    expect(after?.resubmissionAuthorized).toBe(false);
  });

  it('refuses a never_received answer given against evidence the buyer presented', () => {
    // The legality rule, reaching the wire: a supplier holding its own
    // signature must RE-ADOPT, not deny.
    // Installed on the NODE, not passed here. The ask and the apply must read
    // the same evidence: a buyer that presents its evidence and then judges the
    // answer as though it had presented none accepts a `never_received` it was
    // entitled to refuse.
    installHeldEvidenceReader(() => ({
      held_acknowledgement: makeHeldEvidence(acceptance()) as never,
    }));
    applyInboundBuyerResponse({
      supplierDid: SUPPLIER,
      response: response({
        capability: 'order_reconcile',
        status: 'success',
        result: { outcome: 'never_received' },
      }),
      nowMs: NOW,
    });
    expect(buyerOrders.get(SUPPLIER, 'po-1')?.resubmissionAuthorized).toBe(false);
  });

  it('refuses an outcome outside the frozen §12.7 vocabulary', () => {
    // A fourth outcome value is a wire-major change. Reading one as anything
    // would let a counterparty invent a state this node has never reasoned
    // about.
    expect(
      applyInboundBuyerResponse({
        supplierDid: SUPPLIER,
        response: response({
          capability: 'order_reconcile',
          status: 'success',
          result: { outcome: 'received_maybe' },
        }),
        nowMs: NOW,
      }),
    ).toBe('unreadable');
    expect(buyerOrders.get(SUPPLIER, 'po-1')?.state).toBe('outcome_unknown');
  });
});

describe('who the answer is about', () => {
  it('is keyed on the AUTHENTICATED sender, not on any field in the payload', () => {
    // The acknowledgement names ChairMaker as the supplier. A different peer
    // relaying it must not settle ChairMaker's order — otherwise any node
    // could close somebody else's business by naming it.
    expect(
      applyInboundBuyerResponse({
        supplierDid: 'did:plc:someoneelse',
        response: response({ capability: 'submit_order', status: 'success', result: acceptance() }),
        nowMs: NOW,
      }),
    ).toBe('unknown_order');
    expect(buyerOrders.get(SUPPLIER, 'po-1')?.state).toBe('outcome_unknown');
  });

  it('reports an answer for an order this node does not hold', () => {
    expect(
      applyInboundBuyerResponse({
        supplierDid: SUPPLIER,
        response: response({
          capability: 'submit_order',
          status: 'success',
          result: acceptance('po-nobody'),
          queryId: 'po-nobody',
        }),
        nowMs: NOW,
      }),
    ).toBe('unknown_order');
  });

  it('does not judge an answer for an order it can no longer describe', () => {
    // `never_received` is legal only when nothing was presented, so judging it
    // against a request that cannot be rebuilt would make an illegal answer
    // look legal.
    buyerOrders.create(SUPPLIER, {
      ...newBuyerOrder('po-legacy'),
      state: 'outcome_unknown',
      nextPollAtMs: NOW - 1,
      pollCount: 1,
    });
    expect(
      applyInboundBuyerResponse({
        supplierDid: SUPPLIER,
        response: response({
          capability: 'order_reconcile',
          status: 'success',
          result: { outcome: 'never_received' },
          queryId: 'po-legacy',
        }),
        nowMs: NOW,
      }),
    ).toBe('undescribable');
    expect(buyerOrders.get(SUPPLIER, 'po-legacy')?.resubmissionAuthorized).toBe(false);
  });

  it('refuses a result that is not a record at all', () => {
    // `result` is `unknown` on the wire: the ingress validates the ENVELOPE and
    // deliberately says nothing about the payload, so a string, a number or a
    // null reaches here and must be refused rather than reached into.
    for (const junk of ['not json at all', 42, null, ['a']]) {
      expect(
        applyInboundBuyerResponse({
          supplierDid: SUPPLIER,
          response: response({ capability: 'submit_order', status: 'success', result: junk }),
          nowMs: NOW,
        }),
      ).toBe('unreadable');
    }
    expect(buyerOrders.get(SUPPLIER, 'po-1')?.state).toBe('outcome_unknown');
  });

  it('refuses an absent result on a success answer', () => {
    // `result` is optional on the wire. A supplier reporting success with
    // nothing in it has told us nothing, and treating an empty answer as one
    // would settle an order on silence.
    expect(
      applyInboundBuyerResponse({
        supplierDid: SUPPLIER,
        response: response({ capability: 'submit_order', status: 'success' }),
        nowMs: NOW,
      }),
    ).toBe('unreadable');
  });
});
