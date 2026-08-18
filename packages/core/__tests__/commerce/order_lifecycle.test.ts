/**
 * §5.5's lifecycle rows (PC-8) — "the lifecycle does not end at 'sent'",
 * and none of these transitions may depend on anybody watching. Each case
 * is a row of the design's own table; the last drives the transitions
 * through the REAL sweeper tick, because a lifecycle module only its tests
 * call is the recorded failure mode of this subsystem.
 */

import { DispatchIntentSweeper } from '../../src/commerce/dispatch_intent_sweeper';
import { InMemoryBuyerOrderRepository } from '../../src/commerce/buyer_orders';
import { newBuyerOrder, type BuyerOrderRecord } from '../../src/commerce/buyer_reconciliation';
import { InMemoryBuyerQuoteRequestRepository } from '../../src/commerce/buyer_requests';
import { InMemoryOrderApprovalRepository } from '../../src/commerce/order_approvals';
import {
  InMemoryOrderDraftRepository,
  type OrderConversation,
  type OrderDraft,
} from '../../src/commerce/order_draft_store';
import { sweepOrderDraftLifecycle } from '../../src/commerce/order_lifecycle';
import { installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';
import { makeQuoteRequest } from './helpers';

import type { BuyerOrderState } from '../../src/commerce/buyer_reconciliation';

const NOW = Date.parse('2026-08-16T12:00:00.000Z');
const PAST = '2026-08-15T00:00:00.000Z';
const FUTURE = '2036-01-01T00:00:00.000Z';
const SUPPLIER = 'did:plc:chairmaker99';

/** The request THIS node sent — its `expires_at` is §5.5's timeout clock. */
const REQUEST = makeQuoteRequest({ supplier_did: SUPPLIER, expires_at: PAST });
const LIVE_REQUEST = makeQuoteRequest({
  request_id: 'req-live',
  supplier_did: SUPPLIER,
  idempotency_key: 'idem-live',
  expires_at: FUTURE,
});

let orderDrafts: InMemoryOrderDraftRepository;
let approvals: InMemoryOrderApprovalRepository;
let buyerOrders: InMemoryBuyerOrderRepository;

function conversation(
  overrides: Partial<OrderConversation> & { state: OrderConversation['state'] },
): OrderConversation {
  return {
    conversationId: 'conv-1',
    supplierDid: SUPPLIER,
    lineIds: ['line-1'],
    snapshot: null,
    snapshotDigest: 'd'.repeat(64),
    requestDigest: REQUEST.request_digest,
    requestId: REQUEST.request_id,
    quoteDigest: null,
    quoteId: null,
    quoteValidUntil: null,
    approvalId: null,
    purchaseOrderId: null,
    dispatchIntent: null,
    outcome: null,
    ...overrides,
  };
}

function seed(conversations: OrderConversation[]): void {
  const draft: OrderDraft = {
    draftId: 'odr-1',
    manifest: [{ artifact_id: 'img-1', content_hash: 'a'.repeat(64), page_index: 0 }],
    extraction: { model: 'gpt-4o-mini', schemaVersion: 'order-lines-1' },
    extractionDigest: 'a'.repeat(64),
    lines: [
      {
        lineId: 'line-1',
        text: '100 oak chairs',
        pageIndex: 0,
        fields: { quantity: '100' },
        provenance: { quantity: 'accepted' },
        resolution: {
          kind: 'resolved',
          product: { scheme: 'gtin', value: '09506000134352' },
          supplierDid: SUPPLIER,
          flaggedNewSupplier: false,
        },
        generation: 1,
        assignmentGeneration: 0,
        vouch: { generation: 1, ceremony: 1, receiptDigest: 'b'.repeat(64), vouchedBy: null },
        deferred: false,
        evidence: null,
        submittedIn: null,
      },
    ],
    requirements: [],
    conversations,
    ceremonyCounter: 1,
    abandoned: false,
    createdAtMs: NOW - 86_400_000,
    updatedAtMs: NOW - 86_400_000,
  };
  orderDrafts.put(draft);
}

function record(state: BuyerOrderState, purchaseOrderId = 'po-1'): BuyerOrderRecord {
  return {
    ...newBuyerOrder(purchaseOrderId, {
      protocolVersion: '1.0',
      orderDigest: 'a'.repeat(64),
      idempotencyKey: 'idem-1',
      serviceRkey: 'self',
      quoteDigest: 'b'.repeat(64),
      quoteId: 'q-1',
      buyerDid: 'did:plc:retailer00000000',
      supplierDid: SUPPLIER,
    }),
    state,
    nextPollAtMs: NOW + 60_000,
    pollCount: 0,
  };
}

function held(): OrderConversation {
  const held = orderDrafts.get('odr-1')?.conversations[0];
  if (held === undefined) throw new Error('conversation lost');
  return held;
}

function runtime(): CommerceRuntime {
  const installed = {
    orderDrafts,
    orderApprovals: approvals,
    buyerOrders,
    buyerQuoteRequests: (() => {
      const repo = new InMemoryBuyerQuoteRequestRepository();
      repo.put(REQUEST, NOW - 86_400_000);
      repo.put(LIVE_REQUEST, NOW - 86_400_000);
      return repo;
    })(),
    runInTransaction: (fn: () => unknown) => fn(),
  } as unknown as CommerceRuntime;
  return installed;
}

beforeEach(() => {
  orderDrafts = new InMemoryOrderDraftRepository();
  approvals = new InMemoryOrderApprovalRepository();
  buyerOrders = new InMemoryBuyerOrderRepository();
});

afterEach(() => {
  installCommerceRuntime(null);
});

it('TIMED OUT: no quote before the request expired — durable, with retry options upstream', () => {
  seed([conversation({ state: 'sent' })]);
  const events = sweepOrderDraftLifecycle(runtime(), NOW);
  expect(events).toEqual([
    { draftId: 'odr-1', conversationId: 'conv-1', transition: 'timed_out' },
  ]);
  expect(held().state).toBe('timed_out');
  expect(held().outcome).toBe('no_answer_before_expiry');
});

it('a LIVE request is not a timeout, and a request this node cannot read is not judged', () => {
  seed([
    conversation({ state: 'sent', requestId: LIVE_REQUEST.request_id }),
    conversation({ conversationId: 'conv-2', state: 'sent', requestId: 'req-unretained' }),
  ]);
  expect(sweepOrderDraftLifecycle(runtime(), NOW)).toEqual([]);
  expect(held().state).toBe('sent');
});

it("QUOTE EXPIRED during the human pause: X's price lapsed, the approval dies with it", () => {
  seed([
    conversation({
      state: 'approved',
      quoteDigest: 'e'.repeat(64),
      quoteValidUntil: PAST,
      approvalId: 'oap_lapsed',
    }),
  ]);
  const events = sweepOrderDraftLifecycle(runtime(), NOW);
  expect(events).toEqual([
    { draftId: 'odr-1', conversationId: 'conv-1', transition: 'quote_expired' },
  ]);
  expect(held().state).toBe('quote_expired');
  expect(held().approvalId).toBeNull();
});

it('a quote valid into the future stays approvable', () => {
  seed([conversation({ state: 'quoted', quoteDigest: 'e'.repeat(64), quoteValidUntil: FUTURE })]);
  expect(sweepOrderDraftLifecycle(runtime(), NOW)).toEqual([]);
  expect(held().state).toBe('quoted');
});

it('ACCEPTED: the §12.7 record resolves the unconfirmed submit — lines record their order', () => {
  seed([conversation({ state: 'submitted_unconfirmed', purchaseOrderId: 'po-1' })]);
  buyerOrders.create(SUPPLIER, record('accepted'));
  const events = sweepOrderDraftLifecycle(runtime(), NOW);
  expect(events).toEqual([
    { draftId: 'odr-1', conversationId: 'conv-1', transition: 'submitted' },
  ]);
  expect(held().state).toBe('submitted');
  expect(orderDrafts.get('odr-1')?.lines[0]?.submittedIn).toBe('conv-1');
});

it('REJECTED: reason on the row; lines reopen by the explicit §5.1 action, not by this sweep', () => {
  seed([conversation({ state: 'submitted_unconfirmed', purchaseOrderId: 'po-1' })]);
  buyerOrders.create(SUPPLIER, record('rejected'));
  const events = sweepOrderDraftLifecycle(runtime(), NOW);
  expect(events).toEqual([
    { draftId: 'odr-1', conversationId: 'conv-1', transition: 'rejected' },
  ]);
  expect(held().state).toBe('rejected');
  expect(held().outcome).toBe('supplier_rejected');
  // The sweep marks terminal; retiring assignments is the buyer's decision.
  expect(orderDrafts.get('odr-1')?.lines[0]?.assignmentGeneration).toBe(0);
});

it('COUNTERED (§12.6): back to quoted with the approval dead — re-approval on the diff', () => {
  seed([
    conversation({
      state: 'submitted_unconfirmed',
      purchaseOrderId: 'po-1',
      approvalId: 'oap_old',
    }),
  ]);
  buyerOrders.create(SUPPLIER, record('countered'));
  const events = sweepOrderDraftLifecycle(runtime(), NOW);
  expect(events).toEqual([
    { draftId: 'odr-1', conversationId: 'conv-1', transition: 'counterproposal' },
  ]);
  expect(held().state).toBe('quoted');
  expect(held().approvalId).toBeNull();
});

it('NEVER RECEIVED: the supplier provably never saw it — terminal, named', () => {
  seed([conversation({ state: 'submitted_unconfirmed', purchaseOrderId: 'po-1' })]);
  buyerOrders.create(SUPPLIER, record('never_received'));
  const events = sweepOrderDraftLifecycle(runtime(), NOW);
  expect(events).toEqual([
    { draftId: 'odr-1', conversationId: 'conv-1', transition: 'never_received' },
  ]);
  expect(held().state).toBe('rejected');
  expect(held().outcome).toBe('never_received');
});

it('a record §12.7 has not settled moves nothing', () => {
  seed([conversation({ state: 'submitted_unconfirmed', purchaseOrderId: 'po-1' })]);
  buyerOrders.create(SUPPLIER, record('outcome_unknown'));
  expect(sweepOrderDraftLifecycle(runtime(), NOW)).toEqual([]);
  expect(held().state).toBe('submitted_unconfirmed');
});

it('the REAL sweeper tick drives the same transitions and reports them', async () => {
  seed([conversation({ state: 'sent' })]);
  installCommerceRuntime(runtime());
  const lifecycle: unknown[] = [];
  const sweeper = new DispatchIntentSweeper({
    now: () => NOW,
    onLifecycle: (event) => lifecycle.push(event),
  });
  await sweeper.tick();
  expect(lifecycle).toEqual([
    { draftId: 'odr-1', conversationId: 'conv-1', transition: 'timed_out' },
  ]);
  expect(held().state).toBe('timed_out');
});
