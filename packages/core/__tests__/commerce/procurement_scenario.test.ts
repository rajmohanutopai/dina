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

import { commerceRecordDigest } from '@dina/commerce-protocol';
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
import { InMemoryDrainAuthorizationRepository } from '../../src/plugins/drain_authorizations';
import { UpdateRebindCoordinator } from '../../src/plugins/update_rebind';
import { makeReentrantTxRunner } from '../../src/run/tx';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import {
  BUYER_DID,
  SUPPLIER_DID,
  hash,
  makeAdmission,
  makeChains,
  makeFamilies,
  makeLifecycle,
  makeOrder,
  makeOrders,
  makeQuoteRequest,
  makeSignedQuote,
  makeHeldEvidence,
  realHeldEvidenceVerifier,
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
    const lifecycle = makeLifecycle({
      tx: node.tx,
      orders: makeOrders(node.orderRefs, clock),
      chains: makeChains(node.statusHeads, clock, () => epoch.value),
      receipts: node.receipts,
      families: makeFamilies(node.quotes, clock, () => epoch.value),
      supplierDid: () => MANUFACTURER,
      now: () => clock.now,
      currentEpoch: () => epoch.value,
      // The REAL verifier over the REAL test key, not `() => true`. This
      // journey is the one place the whole §12.7 path runs end to end —
      // ChairMaker loses the order, Sancho presents what he kept, ChairMaker
      // re-adopts — and a stub here would let it pass with evidence no
      // supplier could have checked.
      verifyHeldEvidence: realHeldEvidenceVerifier,
    });
    // Acceptance and its status genesis commit together (§12.8) — the same
    // tie the composition root makes in production.
    const admission = makeAdmission({
      tx: node.tx,
      orders: makeOrders(node.orderRefs, clock),
      families: makeFamilies(node.quotes, clock, () => epoch.value),
      receipts: node.receipts,
      supplierDid: () => MANUFACTURER,
      now: () => clock.now,
      decisionTimeoutMs: 60_000,
      createAcceptedGenesisInTx: (b, po) => lifecycle.engine.createAcceptedGenesisInTx(b, po),
    });
    return { admission, lifecycle };
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

  /**
   * §9.13 — ChairMaker updates its Supplier plugin while Sancho's order is
   * still open, and Sancho keeps being served.
   *
   * This is the story WS-3.7 and WS-3.8 exist for, told end to end: the order
   * is admitted under one manifest, the manufacturer ships a new one, and the
   * retailer's next lifecycle question must still be answered under the
   * contract the order was opened against — then the lane closes once the
   * order is done, and not one moment sooner.
   */
  it('keeps Sancho answerable across a mid-order plugin update, then closes the lane', () => {
    const PRIOR_MANIFEST = 'bafyreichairmaker1';
    const NEXT_MANIFEST = 'bafyreichairmaker2';
    const { admission } = engines();

    const quote = makeSignedQuote(request, { quote_id: 'q-chairs-9' });
    expect(admission.registerSignedQuote(quote)).toBeNull();

    // Sancho orders while ChairMaker runs the PRIOR manifest, and the order
    // records which manifest served it.
    const order = makeOrder(quote, pricedProjection);
    expect(admission.admitOrder(order, RETAILER, { servingManifestCid: PRIOR_MANIFEST })).toEqual({
      kind: 'reserved',
    });
    expect(node.orderRefs.getByOrderId(RETAILER, order.purchase_order_id)?.servingManifestCid).toBe(
      PRIOR_MANIFEST,
    );

    // ChairMaker accepts, so the obligation is real and open.
    const decided = admission.decideOrder(RETAILER, order.purchase_order_id, {
      kind: 'accepted',
      supplierOrderId: 'CM-9001',
    });
    expect('acknowledgement' in decided).toBe(true);

    // ChairMaker ships a new plugin version. One open order was served by the
    // prior manifest, so its lane must stay open.
    expect(node.orderRefs.countReservedByServingManifest(PRIOR_MANIFEST)).toBe(0);
    // `decided` is terminal for admission purposes; an order still in
    // PRODUCTION is the case that matters, so use a second, undecided order.
    const quote2 = makeSignedQuote(request, { quote_id: 'q-chairs-10' });
    expect(admission.registerSignedQuote(quote2)).toBeNull();
    const openOrder = makeOrder(quote2, pricedProjection, {
      purchase_order_id: 'po-open-1',
      // A distinct idempotency key too — §15.5 forbids keys aliasing orders.
      idempotency_key: 'idem-po-open-1',
    });
    expect(
      admission.admitOrder(openOrder, RETAILER, { servingManifestCid: PRIOR_MANIFEST }),
    ).toEqual({ kind: 'reserved' });

    // Now the prior manifest has work outstanding.
    expect(node.orderRefs.countReservedByServingManifest(PRIOR_MANIFEST)).toBe(1);
    expect(node.orderRefs.countReservedByServingManifest(NEXT_MANIFEST)).toBe(0);

    // The release gate refuses while that order is open — this is the check
    // that stops an update from stranding a buyer mid-order.
    const drains = new InMemoryDrainAuthorizationRepository();
    const coordinator = new UpdateRebindCoordinator({
      installs: () => null, // apply() is exercised in its own suite
      drains: () => drains,
      countOpenOrders: (cid) => node.orderRefs.countReservedByServingManifest(cid),
      rebindListings: () => ({ rebound: [], commit: () => undefined }),
      tx: (fn) => fn(),
      now: () => clock.now,
    });
    drains.put({
      installId: 'inst-chairmaker',
      previousCid: PRIOR_MANIFEST,
      capabilityId: 'com.dinakernel.commerce.order_status',
      kind: 'lifecycle_continuity',
      approvedScopeHash: 'a'.repeat(64),
      configRevision: 1,
      actionClass: 'read',
      effectsIdempotency: 'supported',
      resultSchemaJson: 'null',
      paramsSchemaJson: 'null',
      maxContextItems: null,
      expiresAt: null,
      // §9.13 — which CONTRACT this row speaks, not just which CID.
      priorVersion: '0.1.0',
      createdAt: clock.now,
    });

    expect(
      coordinator.releaseContinuity(
        'inst-chairmaker',
        PRIOR_MANIFEST,
        'com.dinakernel.commerce.order_status',
      ),
    ).toEqual({ released: false, openOrders: 1 });

    // ChairMaker finishes the outstanding order.
    expect(
      'acknowledgement' in
        admission.decideOrder(RETAILER, openOrder.purchase_order_id, {
          kind: 'accepted',
          supplierOrderId: 'CM-9002',
        }),
    ).toBe(true);
    expect(node.orderRefs.countReservedByServingManifest(PRIOR_MANIFEST)).toBe(0);

    // Only now does the prior manifest's lane close.
    expect(
      coordinator.releaseContinuity(
        'inst-chairmaker',
        PRIOR_MANIFEST,
        'com.dinakernel.commerce.order_status',
      ),
    ).toEqual({ released: true, openOrders: 0 });
    expect(
      drains.listLive(
        'inst-chairmaker',
        PRIOR_MANIFEST,
        'com.dinakernel.commerce.order_status',
        clock.now + 1,
      ),
    ).toEqual([]);
  });

  it('walks the whole journey: quote, order, accept, fulfil, deliver', () => {
    const { admission, lifecycle } = engines();

    // 1. ChairMaker prices Sancho's request and signs a quote.
    const quote = makeSignedQuote(request, { quote_id: 'q-chairs-1' });
    expect(admission.registerSignedQuote(quote)).toBeNull();

    // 2. Sancho approves an exact order against that quote.
    const order = makeOrder(quote, pricedProjection);
    expect(admission.admitOrder(order, RETAILER)).toEqual({ kind: 'reserved' });

    // 3. ChairMaker accepts. The status chain opens in the SAME transaction,
    //    so there is no window where the order is decided but unchained.
    const decided = admission.decideOrder(RETAILER, order.purchase_order_id, {
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
    expect(first.admission.admitOrder(order, RETAILER)).toEqual({ kind: 'reserved' });
    const decided = first.admission.decideOrder(RETAILER, order.purchase_order_id, {
      kind: 'accepted',
      supplierOrderId: 'CM-1001',
    });
    if (!('acknowledgement' in decided)) throw new Error('expected acceptance');

    // Process restart: fresh engines, same durable stores.
    const second = engines();

    // The retailer re-submits (it never saw the reply). §15.5 replay returns
    // the RECORDED answer rather than admitting a second order.
    const replay = second.admission.admitOrder(order, RETAILER);
    expect(replay.kind).toBe('replay');
    if (replay.kind !== 'replay') throw new Error('expected replay');
    expect(replay.acknowledgement.kind).toBe('accepted');
    expect(
      (replay.acknowledgement as OrderAcknowledgement & { supplier_order_id?: string })
        .supplier_order_id,
    ).toBe('CM-1001');

    // And the chain the retailer holds is still the chain the manufacturer has.
    const head = node.statusHeads.get(RETAILER, order.purchase_order_id);
    expect(head?.state).toBe('accepted');
    expect(head?.headSequence).toBe('0');
  });

  it('refuses a second order once the quote capacity is spent', () => {
    const { admission } = engines();
    const quote = makeSignedQuote(request, { quote_id: 'q-chairs-1', max_uses: '1' });
    expect(admission.registerSignedQuote(quote)).toBeNull();

    const first = makeOrder(quote, pricedProjection);
    expect(admission.admitOrder(first, RETAILER)).toEqual({ kind: 'reserved' });

    // A DIFFERENT order against the same single-use quote.
    const second = makeOrder(quote, pricedProjection, {
      purchase_order_id: 'po-2',
      idempotency_key: 'idem-po-2',
    });
    const outcome = admission.admitOrder(second, RETAILER);
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected' || outcome.acknowledgement.kind !== 'rejected') {
      throw new Error('expected a rejected acknowledgement');
    }
    expect(outcome.acknowledgement.reason_code).toBe('quote_consumed');
  });

  it("a competitor cannot order against Sancho's quote", () => {
    // §9.8 audience binding, from the buyer's side of the fence. The refusal
    // is non-disclosing: a stranger learns nothing about whether the quote
    // exists.
    const { admission } = engines();
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
    const outcome = admission.admitOrder(order, 'did:plc:competitor99');
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
    expect(before.admission.admitOrder(order, RETAILER)).toEqual({ kind: 'reserved' });
    const decided = before.admission.decideOrder(RETAILER, order.purchase_order_id, {
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
      makeHeldEvidence(genesis, { from: MANUFACTURER, to: [RETAILER] }),
    ]);
    expect('status_digest' in fence).toBe(true);

    // And the chain moves again from there.
    const resumed = after.lifecycle.signStatusUpdate(RETAILER, order.purchase_order_id, {
      state: 'preparing',
    });
    expect('status_digest' in resumed).toBe(true);
  });

  it('ChairMaker loses the order entirely, recovers it from Sancho, and trades again', () => {
    // The hardest restore case, and the one the earlier fence test does not
    // reach: ChairMaker restores a backup taken BEFORE Sancho's order arrived.
    // The order is not stale on this node — it is ABSENT. Only Sancho's copy
    // proves it ever happened.
    const before = engines();
    const quote = makeSignedQuote(request, { quote_id: 'q-chairs-1' });
    expect(before.admission.registerSignedQuote(quote)).toBeNull();
    const order = makeOrder(quote, pricedProjection);
    expect(before.admission.admitOrder(order, RETAILER)).toEqual({ kind: 'reserved' });
    const decided = before.admission.decideOrder(RETAILER, order.purchase_order_id, {
      kind: 'accepted',
      supplierOrderId: 'CM-1001',
    });
    if (!('acknowledgement' in decided)) throw new Error('expected acceptance');
    // Sancho keeps the signed acknowledgement. That is the whole of its
    // evidence, and after the restore it is the whole of the truth.
    const heldAck = decided.acknowledgement;

    // ChairMaker restores a backup from before the order. A fresh node with
    // nothing: no order reference, no chain, no quote family.
    const restored = makeNode();
    const previous = node;
    node = restored;
    try {
      const after = engines();

      // Sancho asks what happened, presenting what it holds. ChairMaker
      // RE-ADOPTS the order rather than answering `never_received` — the
      // acknowledgement is its own signature and it must honour it.
      const answer = after.lifecycle.reconcile(
        {
          protocol_version: '1.0',
          purchase_order_id: order.purchase_order_id,
          buyer_did: RETAILER,
          supplier_did: MANUFACTURER,
          order_digest: order.order_digest,
          idempotency_key: order.idempotency_key,
          held_acknowledgement: makeHeldEvidence(heldAck, {
            from: MANUFACTURER,
            to: [RETAILER],
          }),
        },
        RETAILER,
      );
      // `received_unresolved`, and the next paragraph is why (WS-2.3).
      // ChairMaker knows the decision — it is holding its own signature —
      // but it cannot ACT on it, and telling Sancho `accepted` would invite
      // him to wait for status updates that cannot come. This assertion used
      // to read `received_accepted`, directly contradicting the comment
      // below it.
      expect('outcome' in answer && answer.outcome).toBe('received_unresolved');

      // The order is back, but ChairMaker cannot describe it: re-adoption
      // recovered the DECISION, not the order's lines. So it is frozen — it
      // may not open a chain, and it may not be cancelled either. Both would
      // commit ChairMaker to something it cannot see.
      const frozenGenesis = after.lifecycle.signGenesis(RETAILER, order.purchase_order_id);
      expect('error' in frozenGenesis).toBe(true);
      const cancellationDraft = {
        protocol_version: '1.0',
        cancellation_id: 'cx-lost-1',
        purchase_order_id: order.purchase_order_id,
        order_digest: order.order_digest,
        idempotency_key: 'idem-cx-lost-1',
        issued_at: '2026-08-07T12:40:00.000Z',
      };
      const frozenCancel = after.lifecycle.resolveCancellation(
        {
          ...cancellationDraft,
          cancellation_digest: commerceRecordDigest(
            'cancellation',
            cancellationDraft as Record<string, unknown>,
            hash,
          ),
        },
        RETAILER,
        () => 'cancelled',
      );
      expect('error' in frozenCancel && frozenCancel.error).toMatch(/awaiting reconciliation/);

      // Sancho presents the order itself. Its digest matches the one inside
      // ChairMaker's own acknowledgement, so ChairMaker can accept it as the
      // order it agreed to — and is describable again.
      expect(after.lifecycle.reconcileRestoredOrder(order, RETAILER)).toEqual({ ok: true });

      // And the unresolved answer was TEMPORARY, which is the other half of
      // the claim: once the ceremony makes the order describable again,
      // Sancho asking the same question gets the decision.
      const afterCeremony = after.lifecycle.reconcile(
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
      expect('outcome' in afterCeremony && afterCeremony.outcome).toBe('received_accepted');

      // Trading resumes: the chain opens and moves.
      const genesis = after.lifecycle.signGenesis(RETAILER, order.purchase_order_id);
      expect('status_digest' in genesis && genesis.sequence).toBe('0');
      const preparing = after.lifecycle.signStatusUpdate(RETAILER, order.purchase_order_id, {
        state: 'preparing',
      });
      expect('status_digest' in preparing).toBe(true);
    } finally {
      restored.cleanup();
      node = previous;
    }
  });

  it('refuses a forged acknowledgement instead of re-adopting the order', () => {
    // THE OTHER HALF of the journey above, and the reason that one means
    // anything. Re-adoption must depend on the CRYPTOGRAPHY, not on the state
    // machine being agreeable. So a dishonest buyer presents an
    // acknowledgement ChairMaker never signed — right shape, right digests,
    // wrong key — and must not be re-adopted.
    //
    // THE ANSWER IS AN ERROR, NOT `never_received`, and the difference
    // matters. `never_received` is the one outcome that authorizes
    // resubmitting the order, so answering it against evidence ChairMaker
    // merely could not verify would invite the duplicate §16.2 exists to
    // prevent. Once evidence is PRESENTED, the only safe answers are
    // "verified, here is the decision" and "I cannot tell" — never
    // "it never happened". If this test ever matches the one above, the
    // verifier has stopped verifying.
    const before = engines();
    const quote = makeSignedQuote(request, { quote_id: 'q-chairs-forge' });
    expect(before.admission.registerSignedQuote(quote)).toBeNull();
    const order = makeOrder(quote, pricedProjection);
    expect(before.admission.admitOrder(order, RETAILER)).toEqual({ kind: 'reserved' });
    const decided = before.admission.decideOrder(RETAILER, order.purchase_order_id, {
      kind: 'accepted',
      supplierOrderId: 'CM-1002',
    });
    if (!('acknowledgement' in decided)) throw new Error('expected acceptance');
    const heldAck = decided.acknowledgement;

    const restored = makeNode();
    const previous = node;
    node = restored;
    try {
      const after = engines();
      const request_ = {
        protocol_version: '1.0',
        purchase_order_id: order.purchase_order_id,
        buyer_did: RETAILER,
        supplier_did: MANUFACTURER,
        order_digest: order.order_digest,
        idempotency_key: order.idempotency_key,
      };

      // (a) signed by someone else.
      const forged = after.lifecycle.reconcile(
        {
          ...request_,
          held_acknowledgement: makeHeldEvidence(heldAck, {
            from: MANUFACTURER,
            to: [RETAILER],
            signingKey: new Uint8Array(32).fill(3),
          }),
        },
        RETAILER,
      );
      expect('error' in forged).toBe(true);
      expect('outcome' in forged).toBe(false);

      // (b) a real message, but addressed to a DIFFERENT buyer. One buyer
      // must not be able to replay another's evidence.
      const notYours = after.lifecycle.reconcile(
        {
          ...request_,
          held_acknowledgement: makeHeldEvidence(heldAck, {
            from: MANUFACTURER,
            to: ['did:plc:someone-else'],
          }),
        },
        RETAILER,
      );
      expect('error' in notYours).toBe(true);
      expect('outcome' in notYours).toBe(false);

      // (c) a real message from ChairMaker whose signed body says nothing
      // about this acknowledgement. The signature verifies; the pairing is
      // the lie, and the binding check is what catches it.
      const unbound = after.lifecycle.reconcile(
        {
          ...request_,
          held_acknowledgement: makeHeldEvidence(heldAck, {
            from: MANUFACTURER,
            to: [RETAILER],
            body: '{"capability":"com.dinakernel.commerce.order_status","result":{}}',
          }),
        },
        RETAILER,
      );
      expect('error' in unbound).toBe(true);
      expect('outcome' in unbound).toBe(false);

      // And the control: the SAME order, honestly evidenced, is re-adopted.
      const honest = after.lifecycle.reconcile(
        {
          ...request_,
          held_acknowledgement: makeHeldEvidence(heldAck, {
            from: MANUFACTURER,
            to: [RETAILER],
          }),
        },
        RETAILER,
      );
      expect('outcome' in honest && honest.outcome).toBe('received_unresolved');
    } finally {
      restored.cleanup();
      node = previous;
    }
  });

  it('an unanswered submission reconciles instead of being ordered twice (§12.7)', () => {
    // The outcome_unknown case: Sancho's Dina submitted and never heard back.
    // Blind resubmission would risk a duplicate order, so it asks instead.
    const { admission, lifecycle } = engines();
    const quote = makeSignedQuote(request, { quote_id: 'q-chairs-1' });
    expect(admission.registerSignedQuote(quote)).toBeNull();
    const order = makeOrder(quote, pricedProjection);
    expect(admission.admitOrder(order, RETAILER)).toEqual({ kind: 'reserved' });

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
    const { admission } = engines();
    const quote = makeSignedQuote(request, { quote_id: 'q-chairs-1' });
    expect(admission.registerSignedQuote(quote)).toBeNull();
    const order = makeOrder(quote, pricedProjection);
    expect(admission.admitOrder(order, RETAILER)).toEqual({ kind: 'reserved' });
    expect(node.orderRefs.getByOrderId(RETAILER, order.purchase_order_id)?.state).toBe('reserved');
  });
});
