/**
 * End-to-end procurement scenario: a retailer buying from a manufacturer.
 *
 * WHY THIS EXISTS. Every other commerce test drives one engine and asserts one
 * rule. None of them answers the question the spec actually asks (§25.6): can a
 * real buyer request goods, approve one exact order, have the supplier accept
 * it, and can BOTH sides still agree about that order after a restart?
 *
 * The unit suites were green through thirty defects. A scenario test is worth
 * having precisely because it does not know which rule it is testing — it
 * walks the journey and notices when the journey stops working.
 *
 * WHAT IT DOES NOT COVER, stated so the green tick is not read as more than it
 * is: no catalog publication or AppView discovery (WS-5, unbuilt), no plugin
 * runner or D2D transport (the engines are driven directly, as production will
 * drive them once the composition root lands), and no external ERP. This is the
 * supplier-side commerce spine end to end, not the §25.6 manual journey.
 *
 * Cast follows house convention: ChairMaker manufactures, Sancho retails.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  CommerceAdmissionEngine,
  CommerceLifecycleEngine,
  InMemoryCommerceOrderRefRepository,
  InMemoryCommerceQuoteLedgerRepository,
  InMemoryCommerceReceiptRepository,
  InMemoryCommerceStatusHeadRepository,
  SQLiteCommerceOrderRefRepository,
  SQLiteCommerceQuoteLedgerRepository,
  SQLiteCommerceReceiptRepository,
  SQLiteCommerceStatusHeadRepository,
  type CommerceOrderRefRepository,
  type CommerceQuoteLedgerRepository,
  type CommerceReceiptRepository,
  type CommerceStatusHeadRepository,
} from '../../src/commerce';
import { makeReentrantTxRunner } from '../../src/run/tx';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import {
  BUYER_DID,
  SUPPLIER_DID,
  makeChains,
  makeFamilies,
  makeOrder,
  makeOrders,
  makeQuoteRequest,
  makeSignedQuote,
} from './helpers';

import type { CommerceOrderStatus, OrderAcknowledgement } from '@dina/commerce-protocol';

/** Sancho's shop buys; ChairMaker manufactures. */
const RETAILER = BUYER_DID;
const MANUFACTURER = SUPPLIER_DID;

const T0 = Date.parse('2026-08-08T09:00:00.000Z');

interface Node {
  quotes: CommerceQuoteLedgerRepository;
  orderRefs: CommerceOrderRefRepository;
  statusHeads: CommerceStatusHeadRepository;
  receipts: CommerceReceiptRepository;
  tx: (fn: () => void) => void;
  cleanup: () => void;
}

function inMemoryNode(): Node {
  return {
    quotes: new InMemoryCommerceQuoteLedgerRepository(),
    orderRefs: new InMemoryCommerceOrderRefRepository(),
    statusHeads: new InMemoryCommerceStatusHeadRepository(),
    receipts: new InMemoryCommerceReceiptRepository(),
    tx: (fn) => fn(),
    cleanup: () => undefined,
  };
}

function sqliteNode(): Node {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-procurement-'));
  const adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  return {
    quotes: new SQLiteCommerceQuoteLedgerRepository(adapter),
    orderRefs: new SQLiteCommerceOrderRefRepository(adapter),
    statusHeads: new SQLiteCommerceStatusHeadRepository(adapter),
    receipts: new SQLiteCommerceReceiptRepository(adapter),
    tx: makeReentrantTxRunner(adapter),
    cleanup: () => {
      adapter.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe.each([
  ['in-memory', inMemoryNode],
  ['sqlite', sqliteNode],
])('procurement: Sancho buys from ChairMaker (%s)', (label, makeNode) => {
  let node: Node;
  let clock: { now: number };
  let epoch: { value: string };
  const request = makeQuoteRequest();
  const pricedProjection = request.delivery.projection;

  /** Build the manufacturer's engines at the current epoch. */
  function engines() {
    const admission = new CommerceAdmissionEngine({
      tx: node.tx,
      orders: makeOrders(node.orderRefs, clock),
      families: makeFamilies(node.quotes, clock, () => epoch.value),
      receipts: node.receipts,
      supplierDid: MANUFACTURER,
      now: () => clock.now,
      decisionTimeoutMs: 60_000,
    });
    const lifecycle = new CommerceLifecycleEngine({
      tx: node.tx,
      orders: makeOrders(node.orderRefs, clock),
      chains: makeChains(node.statusHeads, clock, () => epoch.value),
      receipts: node.receipts,
      families: makeFamilies(node.quotes, clock, () => epoch.value),
      supplierDid: MANUFACTURER,
      now: () => clock.now,
      currentEpoch: () => epoch.value,
      verifyHeldEvidence: () => true,
    });
    // Acceptance and its status genesis commit together (§12.8).
    const atomic = new CommerceAdmissionEngine({
      tx: node.tx,
      orders: makeOrders(node.orderRefs, clock),
      families: makeFamilies(node.quotes, clock, () => epoch.value),
      receipts: node.receipts,
      supplierDid: MANUFACTURER,
      now: () => clock.now,
      decisionTimeoutMs: 60_000,
      createAcceptedGenesisInTx: (b, po) => lifecycle.createAcceptedGenesisInTx(b, po),
    });
    return { admission, lifecycle, atomic };
  }

  beforeEach(() => {
    node = makeNode();
    clock = { now: T0 };
    epoch = { value: '1' };
    // The manufacturer retains the quote REQUEST it priced against.
    node.receipts.put({
      recordDigest: request.request_digest,
      domain: 'request',
      buyerDid: RETAILER,
      quoteId: 'q-chairs-1',
      purchaseOrderId: '',
      recordJson: JSON.stringify(request),
      evidenceJson: '{}',
      createdAt: clock.now,
    });
  });

  afterEach(() => node.cleanup());

  it('walks the whole journey: quote, order, accept, fulfil, deliver', () => {
    const { admission, lifecycle, atomic } = engines();

    // 1. ChairMaker prices Sancho's request and signs a quote.
    const quote = makeSignedQuote(request, { quote_id: 'q-chairs-1' });
    expect(admission.registerSignedQuote(quote)).toBeNull();

    // 2. Sancho approves an exact order against that quote.
    const order = makeOrder(quote, pricedProjection);
    expect(atomic.admitOrder(order, RETAILER)).toEqual({ kind: 'reserved' });

    // 3. ChairMaker accepts. The status chain opens in the SAME transaction,
    //    so there is no window where the order is decided but unchained.
    const decided = atomic.decideOrder(RETAILER, order.purchase_order_id, {
      kind: 'accepted',
      supplierOrderId: 'CM-1001',
    });
    if (!('acknowledgement' in decided)) throw new Error(JSON.stringify(decided));
    expect(decided.acknowledgement.kind).toBe('accepted');
    expect(node.statusHeads.get(RETAILER, order.purchase_order_id)?.state).toBe('accepted');

    // 4. Capacity was committed, not merely held.
    expect(node.quotes.getUse('q-chairs-1', order.purchase_order_id)).toBe('committed');

    // 5. Production run: preparing -> partially fulfilled -> dispatched.
    const preparing = lifecycle.signStatusUpdate(RETAILER, order.purchase_order_id, {
      state: 'preparing',
    });
    expect('status_digest' in preparing).toBe(true);

    const partial = lifecycle.signStatusUpdate(RETAILER, order.purchase_order_id, {
      state: 'partially_fulfilled',
      lines: [{ lineId: 'l1', fulfilledQuantity: { value: '40', unitCode: 'each' } }],
    });
    expect('status_digest' in partial && partial.sequence).toBe('2');

    // Cumulative snapshots: a LOWER quantity is an illegal update (§9.11).
    const regressed = lifecycle.signStatusUpdate(RETAILER, order.purchase_order_id, {
      state: 'partially_fulfilled',
      lines: [{ lineId: 'l1', fulfilledQuantity: { value: '30', unitCode: 'each' } }],
    });
    expect('error' in regressed).toBe(true);

    const dispatched = lifecycle.signStatusUpdate(RETAILER, order.purchase_order_id, {
      state: 'dispatched',
      lines: [{ lineId: 'l1', fulfilledQuantity: { value: '100', unitCode: 'each' } }],
    });
    expect('status_digest' in dispatched).toBe(true);

    // `delivered` is a discriminated-union arm that FORBIDS a line snapshot
    // (§9.11): dispatched already carried the final quantities, and repeating
    // them would let the two records disagree.
    const delivered = lifecycle.signStatusUpdate(RETAILER, order.purchase_order_id, {
      state: 'delivered',
      disputeWindowEndsAt: '2026-08-22T09:00:00.000Z',
    });
    if (!('status_digest' in delivered)) throw new Error(JSON.stringify(delivered));
    expect(delivered.state).toBe('delivered');
  });

  it('survives a restart: both sides still agree about the order', () => {
    // §25.6 step 13-14 in miniature. Durable state, not in-process state, is
    // what makes an order real — so rebuild the engines from the same stores
    // and check the answer has not moved.
    const first = engines();
    const quote = makeSignedQuote(request, { quote_id: 'q-chairs-1' });
    expect(first.admission.registerSignedQuote(quote)).toBeNull();
    const order = makeOrder(quote, pricedProjection);
    expect(first.atomic.admitOrder(order, RETAILER)).toEqual({ kind: 'reserved' });
    const decided = first.atomic.decideOrder(RETAILER, order.purchase_order_id, {
      kind: 'accepted',
      supplierOrderId: 'CM-1001',
    });
    if (!('acknowledgement' in decided)) throw new Error('expected acceptance');

    // Process restart: fresh engines, same durable stores.
    const second = engines();

    // The retailer re-submits (it never saw the reply). §15.5 replay returns
    // the RECORDED answer rather than admitting a second order.
    const replay = second.atomic.admitOrder(order, RETAILER);
    expect(replay.kind).toBe('replay');
    if (replay.kind !== 'replay') throw new Error('expected replay');
    expect(replay.acknowledgement.kind).toBe('accepted');
    expect((replay.acknowledgement as OrderAcknowledgement & { supplier_order_id?: string })
      .supplier_order_id).toBe('CM-1001');

    // And the chain the retailer holds is still the chain the manufacturer has.
    const head = node.statusHeads.get(RETAILER, order.purchase_order_id);
    expect(head?.state).toBe('accepted');
    expect(head?.headSequence).toBe('0');
  });

  it('refuses a second order once the quote capacity is spent', () => {
    const { admission, atomic } = engines();
    const quote = makeSignedQuote(request, { quote_id: 'q-chairs-1', max_uses: '1' });
    expect(admission.registerSignedQuote(quote)).toBeNull();

    const first = makeOrder(quote, pricedProjection);
    expect(atomic.admitOrder(first, RETAILER)).toEqual({ kind: 'reserved' });

    // A DIFFERENT order against the same single-use quote.
    const second = makeOrder(quote, pricedProjection, {
      purchase_order_id: 'po-2',
      idempotency_key: 'idem-po-2',
    });
    const outcome = atomic.admitOrder(second, RETAILER);
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected' || outcome.acknowledgement.kind !== 'rejected') {
      throw new Error('expected a rejected acknowledgement');
    }
    expect(outcome.acknowledgement.reason_code).toBe('quote_consumed');
  });

  it('a competitor cannot order against Sancho\'s quote', () => {
    // §9.8 audience binding, from the buyer's side of the fence. The refusal
    // is non-disclosing: a stranger learns nothing about whether the quote
    // exists.
    const { admission, atomic } = engines();
    const quote = makeSignedQuote(request, { quote_id: 'q-chairs-1' });
    expect(admission.registerSignedQuote(quote)).toBeNull();

    // The real attack shape: the competitor builds an order naming ITSELF as
    // buyer while pointing at the quote ChairMaker priced for Sancho. (An
    // order that names Sancho as buyer is caught earlier still, as a
    // caller/payload mismatch.)
    const order = makeOrder(quote, pricedProjection, {
      buyer_did: 'did:plc:competitor99',
      purchase_order_id: 'po-competitor',
      idempotency_key: 'idem-competitor',
    });
    const outcome = atomic.admitOrder(order, 'did:plc:competitor99');
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected' || outcome.acknowledgement.kind !== 'rejected') {
      throw new Error('expected a rejected acknowledgement');
    }
    expect(outcome.acknowledgement.reason_code).toBe('quote_unknown');
  });

  it('after a restore, the chain is fenced before it moves again (§16.2)', () => {
    const before = engines();
    const quote = makeSignedQuote(request, { quote_id: 'q-chairs-1' });
    expect(before.admission.registerSignedQuote(quote)).toBeNull();
    const order = makeOrder(quote, pricedProjection);
    expect(before.atomic.admitOrder(order, RETAILER)).toEqual({ kind: 'reserved' });
    const decided = before.atomic.decideOrder(RETAILER, order.purchase_order_id, {
      kind: 'accepted',
      supplierOrderId: 'CM-1001',
    });
    if (!('acknowledgement' in decided)) throw new Error('expected acceptance');
    const genesisRow = node.receipts.get(
      node.statusHeads.get(RETAILER, order.purchase_order_id)?.headDigest ?? '',
    );
    if (genesisRow === null) throw new Error('expected a genesis receipt');
    const genesis = JSON.parse(genesisRow.recordJson) as CommerceOrderStatus;

    // ChairMaker restores a backup. The epoch increments.
    epoch.value = '2';
    const after = engines();

    // An ordinary successor is refused: signing one would strand the order,
    // because the fence needs an epoch strictly higher than the head's.
    const ordinary = after.lifecycle.signStatusUpdate(RETAILER, order.purchase_order_id, {
      state: 'preparing',
    });
    expect('error' in ordinary && ordinary.error).toMatch(/restore fence first/);

    // The fence, presented with Sancho's retained receipt, takes over.
    const fence = after.lifecycle.signRestoreFence(RETAILER, order.purchase_order_id, [
      { record: genesis, signature: 'cd'.repeat(32) },
    ]);
    expect('status_digest' in fence).toBe(true);

    // And the chain moves again from there.
    const resumed = after.lifecycle.signStatusUpdate(RETAILER, order.purchase_order_id, {
      state: 'preparing',
    });
    expect('status_digest' in resumed).toBe(true);
  });

  it('an unanswered submission reconciles instead of being ordered twice (§12.7)', () => {
    // The outcome_unknown case: Sancho's Dina submitted and never heard back.
    // Blind resubmission would risk a duplicate order, so it asks instead.
    const { admission, atomic, lifecycle } = engines();
    const quote = makeSignedQuote(request, { quote_id: 'q-chairs-1' });
    expect(admission.registerSignedQuote(quote)).toBeNull();
    const order = makeOrder(quote, pricedProjection);
    expect(atomic.admitOrder(order, RETAILER)).toEqual({ kind: 'reserved' });

    const answer = lifecycle.reconcile(
      {
        protocol_version: '1.0',
        purchase_order_id: order.purchase_order_id,
        buyer_did: RETAILER,
        supplier_did: MANUFACTURER,
        order_digest: order.order_digest,
        idempotency_key: order.idempotency_key,
      },
      RETAILER,
    );
    expect('error' in answer).toBe(false);
    // Reserved and undecided: the honest answer is "still working on it",
    // never a second admission.
    expect(JSON.stringify(answer)).toMatch(/processing|received/);
  });

  it('reconcile answers for an order this manufacturer never received', () => {
    // The §16.2 recovery case: ChairMaker restored a backup taken before
    // Sancho's order arrived, so it holds no reference at all. The buyer must
    // still be able to ask, and get a truthful answer rather than a refusal.
    const { lifecycle } = engines();
    const answer = lifecycle.reconcile(
      {
        protocol_version: '1.0',
        purchase_order_id: 'po-never-arrived',
        buyer_did: RETAILER,
        supplier_did: MANUFACTURER,
        order_digest: 'a'.repeat(64),
        idempotency_key: 'idem-never',
      },
      RETAILER,
    );
    expect('error' in answer).toBe(false);
    expect(JSON.stringify(answer)).toMatch(/never_received/);
  });

  it(`runs the journey identically on ${label} storage`, () => {
    // The dual harness is the point: an in-memory pass that a real SQLCipher
    // database would fail is not evidence. This case exists so the label is
    // visible in the report rather than implied.
    const { admission, atomic } = engines();
    const quote = makeSignedQuote(request, { quote_id: 'q-chairs-1' });
    expect(admission.registerSignedQuote(quote)).toBeNull();
    const order = makeOrder(quote, pricedProjection);
    expect(atomic.admitOrder(order, RETAILER)).toEqual({ kind: 'reserved' });
    expect(node.orderRefs.getByOrderId(RETAILER, order.purchase_order_id)?.state).toBe('reserved');
  });
});
