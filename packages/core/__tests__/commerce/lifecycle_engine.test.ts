/**
 * Lifecycle engine (CMC-3): status chain signing, the atomic
 * cancellation race, six-outcome reconcile, held-evidence
 * re-adoption. Dual harness (in-memory + SQLCipher).
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  commerceRecordDigest,
  verifyRestoreFence,
  type CancellationRequest,
  type CommerceOrderStatus,
  type OrderAcknowledgement,
} from '@dina/commerce-protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  CommerceAdmissionEngine,
  CommerceLifecycleEngine,
  InMemoryCommerceOrderRefRepository,
  InMemoryCommerceQuoteLedgerRepository,
  InMemoryCommerceReceiptRepository,
  InMemoryCommerceStatusHeadRepository,
  NON_DISCLOSING_ERROR,
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
  hash,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
  makeChains,
  makeFamilies,
} from './helpers';

interface Harness {
  orderRefs: CommerceOrderRefRepository;
  quotes: CommerceQuoteLedgerRepository;
  receipts: CommerceReceiptRepository;
  statusHeads: CommerceStatusHeadRepository;
  tx: (fn: () => void) => void;
  cleanup: () => void;
}

function inMemoryHarness(): Harness {
  return {
    orderRefs: new InMemoryCommerceOrderRefRepository(),
    quotes: new InMemoryCommerceQuoteLedgerRepository(),
    receipts: new InMemoryCommerceReceiptRepository(),
    statusHeads: new InMemoryCommerceStatusHeadRepository(),
    tx: (fn) => fn(),
    cleanup: () => undefined,
  };
}

function sqliteHarness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-lifecycle-'));
  const adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  return {
    orderRefs: new SQLiteCommerceOrderRefRepository(adapter),
    quotes: new SQLiteCommerceQuoteLedgerRepository(adapter),
    receipts: new SQLiteCommerceReceiptRepository(adapter),
    statusHeads: new SQLiteCommerceStatusHeadRepository(adapter),
    tx: makeReentrantTxRunner(adapter),
    cleanup: () => {
      adapter.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const T0 = Date.parse('2026-08-07T12:30:00.000Z');

/**
 * §12.7/§16.2: held evidence carries the SUPPLIER'S SIGNATURE. A record
 * plus its content digest proves nothing — the digest is a hash of the
 * record, so anyone holding or inventing it can compute it. These tests
 * stub the signature; compiled Core verifies it via verifyHeldEvidence.
 */
function evid<T>(record: T): { record: T; signature: string } {
  return { record, signature: 'cd'.repeat(32) };
}


describe.each([
  ['in-memory', inMemoryHarness],
  ['sqlite', sqliteHarness],
])('lifecycle engine (%s)', (_label, makeHarness) => {
  let h: Harness;
  let clock: { now: number };
  let admission: CommerceAdmissionEngine;
  let engine: CommerceLifecycleEngine;

  const request = makeQuoteRequest();
  const priced_projection = request.delivery.projection;

  beforeEach(() => {
    h = makeHarness();
    clock = { now: T0 };
    admission = new CommerceAdmissionEngine({
      tx: h.tx,
      orderRefs: h.orderRefs,
      families: makeFamilies(h.quotes, clock, () => '1'),
      receipts: h.receipts,
      supplierDid: SUPPLIER_DID,
      now: () => clock.now,
      decisionTimeoutMs: 60_000,
    });
    engine = new CommerceLifecycleEngine({
      tx: h.tx,
      orderRefs: h.orderRefs,
      chains: makeChains(h.statusHeads, clock, () => '1'),
      receipts: h.receipts,
      families: makeFamilies(h.quotes, clock, () => '1'),
      supplierDid: SUPPLIER_DID,
      now: () => clock.now,
      currentEpoch: () => '1',
    });
  });

  afterEach(() => {
    h.cleanup();
  });

  function seedAdmittedOrder() {
    const quote = makeSignedQuote(request);
    h.receipts.put({
      recordDigest: request.request_digest,
      domain: 'request',
      buyerDid: request.buyer_did,
      quoteId: quote.quote_id,
      purchaseOrderId: '',
      recordJson: JSON.stringify(request),
      evidenceJson: '{}',
      createdAt: clock.now,
    });
    expect(admission.registerSignedQuote(quote)).toBeNull();
    const order = makeOrder(quote, priced_projection);
    expect(admission.admitOrder(order, BUYER_DID).kind).toBe('reserved');
    return { quote, order };
  }

  function acceptOrder(purchase_order_id: string) {
    const decided = admission.decideOrder(BUYER_DID, purchase_order_id, {
      kind: 'accepted',
      supplierOrderId: 'so-77',
    });
    expect('acknowledgement' in decided).toBe(true);
  }

  function makeCancellation(order: {
    purchase_order_id: string;
    order_digest: string;
  }): CancellationRequest {
    const draft = {
      protocol_version: '1.0',
      cancellation_id: 'cx-1',
      purchase_order_id: order.purchase_order_id,
      order_digest: order.order_digest,
      idempotency_key: 'idem-cx-1',
      issued_at: '2026-08-07T12:40:00.000Z',
    };
    return {
      ...draft,
      cancellation_digest: commerceRecordDigest(
        'cancellation',
        draft as Record<string, unknown>,
        hash,
      ),
    } as CancellationRequest;
  }

  describe('status chain', () => {
    it('genesis requires a decided order and signs once', () => {
      const { order } = seedAdmittedOrder();
      expect(engine.signGenesis(BUYER_DID, order.purchase_order_id)).toEqual({
        error: 'status: genesis requires a decided order (§9.11)',
      });
      acceptOrder(order.purchase_order_id);
      const genesis = engine.signGenesis(BUYER_DID, order.purchase_order_id);
      expect('status_digest' in genesis && genesis.sequence).toBe('0');
      expect(engine.signGenesis(BUYER_DID, order.purchase_order_id)).toEqual({
        error: 'status: genesis already signed — CAS at signing (§9.11)',
      });
    });

    it('refuses a policy CANCELLATION on a chain that predates a restore (§16.2)', () => {
      // The public signing path had the guard; cancellation reaches the
      // private signer directly and did not. That is worse than the
      // ordinary-successor case: it strands the chain AND records a
      // terminal `cancelled` the buyer can never accept.
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      engine.signGenesis(BUYER_DID, order.purchase_order_id);
      const headBefore = h.statusHeads.get(BUYER_DID, order.purchase_order_id);
      if (headBefore === null) throw new Error('expected a status head');

      const restored = new CommerceLifecycleEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        chains: makeChains(h.statusHeads, clock, () => '2'),
        receipts: h.receipts,
        families: makeFamilies(h.quotes, clock, () => '2'),
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        currentEpoch: () => '2',
      });

      const result = restored.resolveCancellation(makeCancellation(order), BUYER_DID, () => 'cancelled');
      expect('error' in result && result.error).toMatch(/restore fence first/);
      // The head did not move.
      expect(h.statusHeads.get(BUYER_DID, order.purchase_order_id)?.headDigest).toBe(
        headBefore.headDigest,
      );
    });

    it('refuses to sign a GENESIS for an order that predates a restore (§16.2)', () => {
      // The escape no call-site check could catch. "There is no head yet, so
      // nothing can be damaged" is false: the state that matters after a
      // restore is the BUYER's copy. A restored supplier whose head row was
      // lost would sign a second, different sequence-0 record; the buyer then
      // holds two genesis records for one order and rejects the new one as a
      // fork. The fence cannot repair it — unavailable before a genesis
      // exists, blocked afterwards by the same-sequence fork check.
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      // No genesis signed yet, and the local head row is absent exactly as it
      // would be after restoring a backup taken before the genesis.

      const restored = new CommerceLifecycleEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        chains: makeChains(h.statusHeads, clock, () => '2'),
        receipts: h.receipts,
        families: makeFamilies(h.quotes, clock, () => '2'),
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        currentEpoch: () => '2',
      });

      const genesis = restored.signGenesis(BUYER_DID, order.purchase_order_id);
      expect('error' in genesis && genesis.error).toMatch(/order predates a restore/);
      // Nothing was written, so a later reconciliation still has a clean slate.
      expect(h.statusHeads.get(BUYER_DID, order.purchase_order_id)).toBeNull();
    });

    it('refuses a cancellation-won GENESIS on a pre-restore order (§16.2)', () => {
      // Same rule, reached through the private in-transaction signer. Worse
      // than the successor case: this one would record a terminal
      // rejected(cancelled_by_buyer) for an order the supplier may already
      // have accepted and the buyer can prove with a signed acknowledgement.
      const { order } = seedAdmittedOrder();

      const restored = new CommerceLifecycleEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        chains: makeChains(h.statusHeads, clock, () => '2'),
        receipts: h.receipts,
        families: makeFamilies(h.quotes, clock, () => '2'),
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        currentEpoch: () => '2',
      });

      const result = restored.resolveCancellation(makeCancellation(order), BUYER_DID, () => 'cancelled');
      expect('error' in result && result.error).toMatch(/order predates a restore/);
      expect(h.statusHeads.get(BUYER_DID, order.purchase_order_id)).toBeNull();
    });

    it('a RE-ADOPTED order cannot sign a genesis until it is reconciled (§16.2)', () => {
      // Re-adoption rebuilds an order reference from a buyer's held
      // acknowledgement but not the order's lines or quote context, so the
      // node cannot fully describe the order it just adopted. Stamping it
      // pre-restore makes chain creation refuse: failing closed costs a
      // refusal, failing open costs a second conflicting signature.
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      const ackRow = h.receipts.get(
        JSON.parse(
          h.orderRefs.getByOrderId(BUYER_DID, order.purchase_order_id)?.acknowledgementJson ??
            'null',
        )?.acknowledgement_digest ?? '',
      );
      expect(ackRow).not.toBeNull();

      // A fresh node (nothing local) re-adopts from the buyer's evidence.
      const fresh = makeHarness();
      try {
        const engineB = new CommerceLifecycleEngine({
          tx: fresh.tx,
          orderRefs: fresh.orderRefs,
          chains: makeChains(fresh.statusHeads, clock, () => '1'),
          receipts: fresh.receipts,
          families: makeFamilies(fresh.quotes, clock, () => '1'),
          supplierDid: SUPPLIER_DID,
          now: () => clock.now,
          currentEpoch: () => '1',
          verifyHeldEvidence: () => true,
        });
        const heldAck = JSON.parse(
          h.orderRefs.getByOrderId(BUYER_DID, order.purchase_order_id)?.acknowledgementJson ?? '{}',
        ) as OrderAcknowledgement;
        const adopted = engineB.reconcile(
          {
            protocol_version: '1.0',
            purchase_order_id: order.purchase_order_id,
            buyer_did: BUYER_DID,
            supplier_did: SUPPLIER_DID,
            order_digest: order.order_digest,
            idempotency_key: order.idempotency_key,
            held_acknowledgement: evid(heldAck),
          },
          BUYER_DID,
        );
        expect('error' in adopted).toBe(false);

        // The re-adopted order is stamped pre-restore, so no first status.
        const genesis = engineB.signGenesis(BUYER_DID, order.purchase_order_id);
        expect('error' in genesis && genesis.error).toMatch(/not reconciled/);
      } finally {
        fresh.cleanup();
      }
    });

    it('acceptance opens the status chain in the SAME transaction (§12.8)', () => {
      // Before this, acceptance and genesis were two transactions. A
      // cancellation arriving in the gap saw a decided order with no chain
      // and answered refused_policy; the same cancellation a moment later
      // could cancel. The reason code depended on timing, not on the order.
      const { order } = seedAdmittedOrder();

      const atomicAdmission = new CommerceAdmissionEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        families: makeFamilies(h.quotes, clock, () => '1'),
        receipts: h.receipts,
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        decisionTimeoutMs: 60_000,
        createAcceptedGenesisInTx: (b, po) => engine.createAcceptedGenesisInTx(b, po),
      });

      const decided = atomicAdmission.decideOrder(BUYER_DID, order.purchase_order_id, {
        kind: 'accepted',
        supplierOrderId: 'so-atomic',
      });
      expect('acknowledgement' in decided).toBe(true);

      // There is no observable window: the chain exists the moment the
      // order is decided.
      const head = h.statusHeads.get(BUYER_DID, order.purchase_order_id);
      expect(head).not.toBeNull();
      expect(head?.headSequence).toBe('0');
      expect(head?.state).toBe('accepted');
    });

    it('a genesis failure rolls the ACCEPTANCE back rather than stranding it', () => {
      // The other half of atomicity. An accepted order whose chain could not
      // open is precisely the state the race exploited, so it must not be
      // reachable — the decision rolls back and the buyer may retry.
      const { order } = seedAdmittedOrder();

      const brokenAdmission = new CommerceAdmissionEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        families: makeFamilies(h.quotes, clock, () => '1'),
        receipts: h.receipts,
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        decisionTimeoutMs: 60_000,
        createAcceptedGenesisInTx: () => ({ error: 'status: simulated chain failure' }),
      });

      expect(() =>
        brokenAdmission.decideOrder(BUYER_DID, order.purchase_order_id, {
          kind: 'accepted',
          supplierOrderId: 'so-broken',
        }),
      ).toThrow(/could not open its status chain/);

      // SQLite has real transactions; the in-memory runner is a pass-through.
      if (_label === 'sqlite') {
        expect(h.orderRefs.getByOrderId(BUYER_DID, order.purchase_order_id)?.state).toBe('reserved');
        expect(h.statusHeads.get(BUYER_DID, order.purchase_order_id)).toBeNull();
      }
    });

    it('refuses an ordinary successor on a chain that predates a restore (§16.2)', () => {
      // Signing an ordinary update first STRANDS the order permanently.
      // It stamps the new epoch onto the head, and signRestoreFence then
      // demands an epoch strictly higher than the head's — which can never
      // happen again without a second, unjustified restore. Meanwhile the
      // buyer rejects that successor as a fork, since its
      // previous_status_digest names a record it never received.
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      engine.signGenesis(BUYER_DID, order.purchase_order_id);

      // Restore: the live epoch moves to 2, the chain head stays at 1.
      const restored = new CommerceLifecycleEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        chains: makeChains(h.statusHeads, clock, () => '2'),
        receipts: h.receipts,
        families: makeFamilies(h.quotes, clock, () => '2'),
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        currentEpoch: () => '2',
        verifyHeldEvidence: () => true,
      });

      const ordinary = restored.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'preparing',
      });
      expect('error' in ordinary && ordinary.error).toMatch(/restore fence first/);

      // And the fence is still available — the order is not stranded.
      const currentHead = h.statusHeads.get(BUYER_DID, order.purchase_order_id);
      if (currentHead === null) throw new Error('expected a status head');
      const genesisReceipt = h.receipts.get(currentHead.headDigest);
      if (genesisReceipt === null) throw new Error('expected a genesis receipt');
      const fence = restored.signRestoreFence(BUYER_DID, order.purchase_order_id, [
        evid(JSON.parse(genesisReceipt.recordJson) as CommerceOrderStatus),
      ]);
      expect('status_digest' in fence).toBe(true);
    });

    it('refuses to sign a successor when the predecessor receipt is gone', () => {
      // FAIL CLOSED. The cumulative check needs the previous record; when
      // it was merely absent the comparison silently evaporated and Core
      // would sign a REGRESSING fulfilled_quantity and advance the head.
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      engine.signGenesis(BUYER_DID, order.purchase_order_id);
      engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, { state: 'preparing' });
      const partial = engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'partially_fulfilled',
        lines: [{ lineId: 'l1', fulfilledQuantity: { value: '40', unitCode: 'each' } }],
      });
      if (!('status_digest' in partial)) throw new Error('expected a signed status');

      // Simulate receipt loss AT THE REPOSITORY BOUNDARY rather than
      // adding a production delete just to write a test: the engine sees
      // exactly what it would see after corruption or an inconsistent
      // restore — the row is simply not there.
      const lossy: CommerceReceiptRepository = {
        ...h.receipts,
        get: (digest: string) => (digest === partial.status_digest ? null : h.receipts.get(digest)),
        put: (row) => h.receipts.put(row),
      };
      const withLoss = new CommerceLifecycleEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        chains: makeChains(h.statusHeads, clock, () => '1'),
        receipts: lossy,
        families: makeFamilies(h.quotes, clock, () => '1'),
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        currentEpoch: () => '1',
      });

      const regressed = withLoss.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'partially_fulfilled',
        lines: [{ lineId: 'l1', fulfilledQuantity: { value: '10', unitCode: 'each' } }],
      });
      expect('error' in regressed && regressed.error).toMatch(/store integrity failure/);
      // The head did NOT move.
      expect(h.statusHeads.get(BUYER_DID, order.purchase_order_id)?.headDigest).toBe(
        partial.status_digest,
      );
    });

    it('refuses a predecessor receipt whose BODY was tampered with', () => {
      // The other half of the loader condition, isolated. Here the
      // status_digest FIELD still equals the head key, so the key
      // comparison passes and only internal-digest validation can fire.
      // Testing both halves with one fixture is what made the first
      // version of this test green while proving nothing.
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      engine.signGenesis(BUYER_DID, order.purchase_order_id);
      const partial = engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'preparing',
      });
      if (!('status_digest' in partial)) throw new Error('expected a signed status');

      const tampered: CommerceReceiptRepository = {
        ...h.receipts,
        get: (digest: string) => {
          const row = h.receipts.get(digest);
          if (row === null || digest !== partial.status_digest) return row;
          const record = JSON.parse(row.recordJson) as CommerceOrderStatus;
          // Change the BODY, keep the digest field: self-digest breaks,
          // head-key equality still holds.
          return {
            ...row,
            recordJson: JSON.stringify({ ...record, supplier_order_id: 'tampered-99' }),
          };
        },
        put: (row) => h.receipts.put(row),
      };
      const withTamper = new CommerceLifecycleEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        chains: makeChains(h.statusHeads, clock, () => '1'),
        receipts: tampered,
        families: makeFamilies(h.quotes, clock, () => '1'),
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        currentEpoch: () => '1',
      });

      const next = withTamper.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'partially_fulfilled',
        lines: [{ lineId: 'l1', fulfilledQuantity: { value: '40', unitCode: 'each' } }],
      });
      expect('error' in next && next.error).toMatch(/does not match the head/);
    });

    it('refuses a predecessor receipt that is not digest-bound to the head', () => {
      // A row stored under the head digest whose RECORD claims a different
      // status_digest is a substituted predecessor, not a lost one. Core
      // would otherwise judge cumulative fulfilment against a record the
      // chain never pointed at.
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      const genesis = engine.signGenesis(BUYER_DID, order.purchase_order_id);
      if (!('status_digest' in genesis)) throw new Error('expected a genesis');
      const partial = engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'preparing',
      });
      if (!('status_digest' in partial)) throw new Error('expected a signed status');

      // ORTHOGONAL fixture. Mutating status_digest in place also breaks the
      // record's OWN digest, so validateCommerceOrderStatus rejected it
      // first and the head-key comparison never ran — the test passed
      // while the condition it named was dead. Serve instead a record that
      // is fully valid and self-consistent but belongs to a DIFFERENT
      // head, so only `record.status_digest !== headDigest` can fire.
      const genesisRow = h.receipts.get(genesis.status_digest);
      if (genesisRow === null) throw new Error('expected a genesis receipt');
      const swapped: CommerceReceiptRepository = {
        ...h.receipts,
        get: (digest: string) =>
          digest === partial.status_digest ? genesisRow : h.receipts.get(digest),
        put: (row) => h.receipts.put(row),
      };
      const withSwap = new CommerceLifecycleEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        chains: makeChains(h.statusHeads, clock, () => '1'),
        receipts: swapped,
        families: makeFamilies(h.quotes, clock, () => '1'),
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        currentEpoch: () => '1',
      });

      const next = withSwap.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'partially_fulfilled',
        lines: [{ lineId: 'l1', fulfilledQuantity: { value: '40', unitCode: 'each' } }],
      });
      expect('error' in next && next.error).toMatch(/does not match the head/);
    });

    it('signs legal successors with cumulative lines and rejects violations', () => {
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      engine.signGenesis(BUYER_DID, order.purchase_order_id);

      const preparing = engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'preparing',
      });
      expect('status_digest' in preparing && preparing.sequence).toBe('1');

      const partial = engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'partially_fulfilled',
        lines: [{ lineId: 'l1', fulfilledQuantity: { value: '40', unitCode: 'each' } }],
      });
      expect('status_digest' in partial && partial.sequence).toBe('2');

      // Cumulative regression rejected.
      const regressed = engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'partially_fulfilled',
        lines: [{ lineId: 'l1', fulfilledQuantity: { value: '30', unitCode: 'each' } }],
      });
      expect('error' in regressed && regressed.error).toMatch(/regressed/);

      // Illegal graph jump rejected.
      const illegal = engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'delivered',
        disputeWindowEndsAt: '2026-08-14T00:00:00.000Z',
      });
      expect('error' in illegal && illegal.error).toMatch(/illegal transition/);
    });
  });

  describe('cancellation race (§12.8)', () => {
    it('arm 1: cancellation beats acceptance atomically', () => {
      const { quote, order } = seedAdmittedOrder();
      const result = engine.resolveCancellation(
        makeCancellation(order),
        BUYER_DID,
        () => 'cancelled',
      );
      expect('result' in result && result.result).toBe('cancelled');
      if ('result' in result) expect(result.status_digest_at_resolution).toBeDefined();

      // Order decided rejected(cancelled_by_buyer); hold refunded; the
      // late acceptance attempt loses.
      expect(h.quotes.getUse(quote.quote_id, order.purchase_order_id)).toBe('refunded');
      const late = admission.decideOrder(BUYER_DID, order.purchase_order_id, {
        kind: 'accepted',
        supplierOrderId: 'so-late',
      });
      expect('acknowledgement' in late && late.acknowledgement.kind).toBe('rejected');

      // The chain genesis is terminal 'cancelled' (§9.11 cancellation_won).
      expect(h.statusHeads.get(BUYER_DID, order.purchase_order_id)?.state).toBe('cancelled');

      // Reconcile shows the recorded rejection.
      const reconciled = engine.reconcile(
        {
          protocol_version: '1.0',
          purchase_order_id: order.purchase_order_id,
          order_digest: order.order_digest,
          idempotency_key: order.idempotency_key,
        },
        BUYER_DID,
      );
      expect('outcome' in reconciled && reconciled.outcome).toBe('received_rejected');
    });

    it('arm 2: dispatch wins — cancellation is refused, never undone', () => {
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      engine.signGenesis(BUYER_DID, order.purchase_order_id);
      engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'dispatched',
        lines: [{ lineId: 'l1', fulfilledQuantity: { value: '100', unitCode: 'each' } }],
      });
      const result = engine.resolveCancellation(
        makeCancellation(order),
        BUYER_DID,
        () => 'cancelled',
      );
      expect('result' in result && result.result).toBe('refused_already_dispatched');
    });

    it('policy choice cancels through the chain, CAS-bound to the ruled-on head', () => {
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      engine.signGenesis(BUYER_DID, order.purchase_order_id);
      const headBefore = h.statusHeads.get(BUYER_DID, order.purchase_order_id);

      const result = engine.resolveCancellation(
        makeCancellation(order),
        BUYER_DID,
        () => 'cancelled',
      );
      expect('result' in result && result.result).toBe('cancelled');
      if ('result' in result) {
        expect(result.status_digest_at_resolution).toBe(headBefore?.headDigest);
      }
      expect(h.statusHeads.get(BUYER_DID, order.purchase_order_id)?.state).toBe('cancelled');
    });

    it('is idempotent on cancellation_id and non-disclosing to strangers', () => {
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      engine.signGenesis(BUYER_DID, order.purchase_order_id);
      const first = engine.resolveCancellation(
        makeCancellation(order),
        BUYER_DID,
        () => 'refused_policy',
      );
      const repeat = engine.resolveCancellation(
        makeCancellation(order),
        BUYER_DID,
        () => 'cancelled',
      );
      expect(repeat).toEqual(first);

      // Foreign caller, unknown order, digest mismatch: identical shape.
      const foreign = engine.resolveCancellation(
        makeCancellation(order),
        'did:plc:mallory',
        () => 'cancelled',
      );
      expect('error' in foreign && foreign.error).toBe(NON_DISCLOSING_ERROR);
      const mismatch = engine.resolveCancellation(
        makeCancellation({ ...order, order_digest: 'a'.repeat(64) }),
        BUYER_DID,
        () => 'cancelled',
      );
      expect('error' in mismatch && mismatch.error).toBe(NON_DISCLOSING_ERROR);
    });

    /**
     * Codex finding: the replay branch excluded pending_review, so a
     * resent cancellation was evaluated AGAIN — meaning the repeated
     * REQUEST could itself close the review. §12.8 requires a later
     * RESULT to terminate pending review, and a replay to return the
     * recorded outcome unchanged.
     */
    it('replays pending_review instead of re-evaluating, and finalizes separately (§12.8)', () => {
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      engine.signGenesis(BUYER_DID, order.purchase_order_id);
      const cancellation = makeCancellation(order);

      let policyCalls = 0;
      const review = (): 'pending_review' => {
        policyCalls += 1;
        return 'pending_review';
      };

      const first = engine.resolveCancellation(cancellation, BUYER_DID, review);
      expect('result' in first && first.result).toBe('pending_review');
      expect(policyCalls).toBe(1);

      // A RESEND returns the recorded pending_review byte-for-byte and
      // never re-runs policy — so the request cannot close the review.
      const replay = engine.resolveCancellation(cancellation, BUYER_DID, review);
      expect('result' in replay && replay.result).toBe('pending_review');
      expect(policyCalls).toBe(1);
      expect('result_digest' in replay && replay.result_digest).toBe(
        'result_digest' in first ? first.result_digest : 'MISMATCH',
      );

      // Finalization is a SEPARATE operation and is what terminates it.
      const finalized = engine.finalizePendingCancellation(
        BUYER_DID,
        order.purchase_order_id,
        cancellation.cancellation_id,
        'refused_already_dispatched',
      );
      expect('result' in finalized && finalized.result).toBe('refused_already_dispatched');

      // Terminal now: a later replay returns the terminal result, and a
      // second finalization is idempotent rather than overwriting it.
      const afterReplay = engine.resolveCancellation(cancellation, BUYER_DID, review);
      expect('result' in afterReplay && afterReplay.result).toBe('refused_already_dispatched');
      expect(policyCalls).toBe(1);

      const second = engine.finalizePendingCancellation(
        BUYER_DID,
        order.purchase_order_id,
        cancellation.cancellation_id,
        'cancelled',
      );
      expect('result' in second && second.result).toBe('refused_already_dispatched');
    });
  });

  describe('reconcile (§12.7)', () => {
    it('maps phases and decisions to the six outcomes', () => {
      const { order } = seedAdmittedOrder();
      const base = {
        protocol_version: '1.0',
        purchase_order_id: order.purchase_order_id,
        order_digest: order.order_digest,
        idempotency_key: order.idempotency_key,
      };
      let reconciled = engine.reconcile(base, BUYER_DID);
      expect('outcome' in reconciled && reconciled.outcome).toBe('received_processing');

      admission.markEffectStarted(BUYER_DID, order.purchase_order_id);
      reconciled = engine.reconcile(base, BUYER_DID);
      expect('outcome' in reconciled && reconciled.outcome).toBe('received_unresolved');

      acceptOrder(order.purchase_order_id);
      reconciled = engine.reconcile(base, BUYER_DID);
      expect('outcome' in reconciled && reconciled.outcome).toBe('received_accepted');
      if ('outcome' in reconciled && reconciled.outcome === 'received_accepted') {
        expect(reconciled.acknowledgement.order_digest).toBe(order.order_digest);
      }

      // never_received only for a genuinely unknown order without evidence.
      const unknown = engine.reconcile(
        { ...base, purchase_order_id: 'po-x', order_digest: 'b'.repeat(64), idempotency_key: 'idem-x' },
        BUYER_DID,
      );
      expect('outcome' in unknown && unknown.outcome).toBe('never_received');
    });

    it('re-adopts an order from verified held evidence instead of never_received (§16.2)', () => {
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      const decided = engine.reconcile(
        {
          protocol_version: '1.0',
          purchase_order_id: order.purchase_order_id,
          order_digest: order.order_digest,
          idempotency_key: order.idempotency_key,
        },
        BUYER_DID,
      );
      if (!('outcome' in decided) || decided.outcome !== 'received_accepted') {
        throw new Error('setup failed');
      }
      const heldAck = decided.acknowledgement;

      // Simulate the restored supplier: fresh stores, same identity.
      const restored = makeHarness();
      // The app-level verifier checks the retained envelope signature;
      // tests stub it as "authentic for records this supplier signed".
      const restoredEngine = new CommerceLifecycleEngine({
        tx: restored.tx,
        orderRefs: restored.orderRefs,
        chains: makeChains(restored.statusHeads, clock, () => '2'),
        receipts: restored.receipts,
        families: makeFamilies(restored.quotes, clock, () => '2'),
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        currentEpoch: () => '2',
        verifyHeldEvidence: () => true,
      });
      try {
        const readopted = restoredEngine.reconcile(
          {
            protocol_version: '1.0',
            purchase_order_id: order.purchase_order_id,
            order_digest: order.order_digest,
            idempotency_key: order.idempotency_key,
            held_acknowledgement: evid(heldAck),
          },
          BUYER_DID,
        );
        expect('outcome' in readopted && readopted.outcome).toBe('received_accepted');

        // The re-adopted record now answers WITHOUT evidence.
        const followUp = restoredEngine.reconcile(
          {
            protocol_version: '1.0',
            purchase_order_id: order.purchase_order_id,
            order_digest: order.order_digest,
            idempotency_key: order.idempotency_key,
          },
          BUYER_DID,
        );
        expect('outcome' in followUp && followUp.outcome).toBe('received_accepted');

        // Tampered/foreign evidence is refused non-disclosingly.
        const tampered = restoredEngine.reconcile(
          {
            protocol_version: '1.0',
            purchase_order_id: 'po-other',
            order_digest: order.order_digest,
            idempotency_key: 'idem-other',
            held_acknowledgement: evid(heldAck),
          },
          BUYER_DID,
        );
        expect('error' in tampered && tampered.error).toBe(NON_DISCLOSING_ERROR);

        // FAIL CLOSED: without a verifier (or with a refusing one), the
        // same evidence is refused non-disclosingly — a content digest
        // is a hash anyone can compute, never authenticity (§9.12).
        const unverified = makeHarness();
        try {
          const noVerifier = new CommerceLifecycleEngine({
            tx: unverified.tx,
            orderRefs: unverified.orderRefs,
            chains: makeChains(unverified.statusHeads, clock, () => '2'),
            receipts: unverified.receipts,
            families: makeFamilies(unverified.quotes, clock, () => '2'),
            supplierDid: SUPPLIER_DID,
            now: () => clock.now,
            currentEpoch: () => '2',
          });
          const refused = noVerifier.reconcile(
            {
              protocol_version: '1.0',
              purchase_order_id: order.purchase_order_id,
              order_digest: order.order_digest,
              idempotency_key: order.idempotency_key,
              held_acknowledgement: evid(heldAck),
            },
            BUYER_DID,
          );
          expect('error' in refused && refused.error).toBe(NON_DISCLOSING_ERROR);
        } finally {
          unverified.cleanup();
        }
      } finally {
        restored.cleanup();
      }
    });

    it('verified held STATUS receipts disqualify never_received (§16.2)', () => {
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      const genesis = engine.signGenesis(BUYER_DID, order.purchase_order_id);
      if ('error' in genesis) throw new Error(genesis.error);

      const restored = makeHarness();
      try {
        const restoredEngine = new CommerceLifecycleEngine({
          tx: restored.tx,
          orderRefs: restored.orderRefs,
          chains: makeChains(restored.statusHeads, clock, () => '2'),
          receipts: restored.receipts,
          families: makeFamilies(restored.quotes, clock, () => '2'),
          supplierDid: SUPPLIER_DID,
          now: () => clock.now,
          currentEpoch: () => '2',
          verifyHeldEvidence: () => true,
        });
        const result = restoredEngine.reconcile(
          {
            protocol_version: '1.0',
            purchase_order_id: order.purchase_order_id,
            order_digest: order.order_digest,
            idempotency_key: order.idempotency_key,
            held_status_receipts: [evid(genesis)],
          },
          BUYER_DID,
        );
        expect('outcome' in result && result.outcome).toBe('received_unresolved');
      } finally {
        restored.cleanup();
      }
    });

    /**
     * Codex finding: createReserved's boolean gated the WRITES but not
     * the ANSWER — a false fell through to a received_* decision. So an
     * idempotency-key collision with a DIFFERENT order told the buyer
     * their order was durably re-adopted while the supplier held no
     * matching reference (§15.5, §16.2).
     *
     * Uses a GENUINE acknowledgement from a real decision — a
     * hand-built one is rejected by validateOrderAcknowledgement before
     * reaching the re-adoption branch, which would make this pass for
     * the wrong reason.
     */
    it('refuses re-adoption when the idempotency key belongs to another order (§15.5)', () => {
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      const decided = engine.reconcile(
        {
          protocol_version: '1.0',
          purchase_order_id: order.purchase_order_id,
          order_digest: order.order_digest,
          idempotency_key: order.idempotency_key,
        },
        BUYER_DID,
      );
      if (!('outcome' in decided) || decided.outcome !== 'received_accepted') {
        throw new Error('setup failed');
      }
      const heldAck = decided.acknowledgement;

      // Restored supplier: fresh stores, and the order's idempotency key
      // is ALREADY held by a different purchase order.
      const restored = makeHarness();
      const restoredEngine = new CommerceLifecycleEngine({
        tx: restored.tx,
        orderRefs: restored.orderRefs,
        chains: makeChains(restored.statusHeads, clock, () => '2'),
        receipts: restored.receipts,
        families: makeFamilies(restored.quotes, clock, () => '2'),
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        currentEpoch: () => '2',
        verifyHeldEvidence: () => true,
      });
      try {
        restored.orderRefs.createReserved({
          buyerDid: BUYER_DID,
          purchaseOrderId: 'po-different',
          idempotencyKey: order.idempotency_key,
          orderDigest: 'a'.repeat(64),
          quoteId: 'q-other',
          quoteDigest: 'c'.repeat(64),
          pinnedMajor: '1',
        admittedEpoch: '1',
        reconciliationRequired: false,
          decisionDeadlineAt: null,
          createdAt: clock.now,
        });

        const result = restoredEngine.reconcile(
          {
            protocol_version: '1.0',
            purchase_order_id: order.purchase_order_id,
            order_digest: order.order_digest,
            idempotency_key: order.idempotency_key,
            held_acknowledgement: evid(heldAck),
          },
          BUYER_DID,
        );

        // Must NOT claim durable re-adoption...
        expect('outcome' in result && String(result.outcome).startsWith('received_')).toBe(false);
        // ...and must not have created a reference under the real id.
        expect(restored.orderRefs.getByOrderId(BUYER_DID, order.purchase_order_id)).toBeNull();
      } finally {
        restored.cleanup();
      }
    });

    /**
     * Codex finding: reconcile trusted an already-typed request with no
     * runtime validation, and never read protocol_version. Malformed
     * held_status_receipts could throw inside Core, and a request naming
     * an unknown or mismatched major was parsed and answered as v1
     * instead of routing to the retained prior-major handler (§9.13).
     */
    it('validates structure and routes by the order pinned major (§9.13)', () => {
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);

      // Malformed input answers a typed error rather than throwing.
      for (const malformed of [
        undefined,
        null,
        42,
        'not-an-object',
        {},
        { purchase_order_id: order.purchase_order_id },
        {
          protocol_version: '1.0',
          purchase_order_id: order.purchase_order_id,
          order_digest: order.order_digest,
          idempotency_key: order.idempotency_key,
          held_status_receipts: 'not-an-array',
        },
        {
          protocol_version: '1.0',
          purchase_order_id: order.purchase_order_id,
          order_digest: order.order_digest,
          idempotency_key: order.idempotency_key,
          held_status_receipts: [{ junk: true }],
        },
      ]) {
        expect(() =>
          engine.reconcile(malformed as never, BUYER_DID),
        ).not.toThrow();
        const answer = engine.reconcile(malformed as never, BUYER_DID);
        expect('error' in answer).toBe(true);
      }

      // A well-formed request on a DIFFERENT major is refused, not
      // answered as v1.
      const wrongMajor = engine.reconcile(
        {
          protocol_version: '2.0',
          purchase_order_id: order.purchase_order_id,
          order_digest: order.order_digest,
          idempotency_key: order.idempotency_key,
        },
        BUYER_DID,
      );
      expect('error' in wrongMajor).toBe(true);

      // The matching major still works.
      const rightMajor = engine.reconcile(
        {
          protocol_version: '1.0',
          purchase_order_id: order.purchase_order_id,
          order_digest: order.order_digest,
          idempotency_key: order.idempotency_key,
        },
        BUYER_DID,
      );
      expect('outcome' in rightMajor).toBe(true);
    });

    /**
     * The positive case alone did not fence this branch: returning
     * `received_unresolved` for ANY non-empty array produces the same
     * result. These negatives pin the fail-closed property — no
     * verifier, a rejecting verifier, and a foreign supplier_did must
     * all refuse rather than accept unverifiable status evidence.
     */
    it('held STATUS receipts fail CLOSED without a passing verifier (§16.2)', () => {
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      const genesis = engine.signGenesis(BUYER_DID, order.purchase_order_id);
      if (!('status_digest' in genesis)) throw new Error('genesis failed');

      const request = {
        protocol_version: '1.0',
        purchase_order_id: order.purchase_order_id,
        order_digest: order.order_digest,
        idempotency_key: order.idempotency_key,
        held_status_receipts: [evid(genesis)],
      };

      const build = (verify?: () => boolean) =>
        new CommerceLifecycleEngine({
          tx: fresh.tx,
          orderRefs: fresh.orderRefs,
          chains: makeChains(fresh.statusHeads, clock, () => '2'),
          receipts: fresh.receipts,
          families: makeFamilies(fresh.quotes, clock, () => '2'),
          supplierDid: SUPPLIER_DID,
          now: () => clock.now,
          currentEpoch: () => '2',
          ...(verify ? { verifyHeldEvidence: verify } : {}),
        });

      const fresh = makeHarness();
      try {
        // (a) NO verifier at all.
        expect('error' in build().reconcile(request, BUYER_DID)).toBe(true);
        // (b) verifier that rejects.
        expect('error' in build(() => false).reconcile(request, BUYER_DID)).toBe(true);
        // (c) receipt signed by a DIFFERENT supplier, verifier passing.
        // The fixture must be STRUCTURALLY VALID and digest-correct, or it
        // is rejected by HeldEvidence shape validation long before the
        // supplier-identity branch runs — which is exactly how this test
        // passed while asserting nothing about identity.
        const foreignDraft = { ...genesis, supplier_did: 'did:plc:othersupplier' };
        delete (foreignDraft as { status_digest?: string }).status_digest;
        const foreign = {
          ...foreignDraft,
          status_digest: commerceRecordDigest('status', foreignDraft as Record<string, unknown>, hash),
        } as CommerceOrderStatus;
        const identity = build(() => true).reconcile(
          { ...request, held_status_receipts: [evid(foreign)] },
          BUYER_DID,
        );
        expect('error' in identity).toBe(true);
      } finally {
        fresh.cleanup();
      }
    });
  });

  describe('restore fence takeover (§16.2)', () => {
    it('fast-forwards from verified held receipts and signs a fence at the new epoch', () => {
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      const genesis = engine.signGenesis(BUYER_DID, order.purchase_order_id);
      if ('error' in genesis) throw new Error(genesis.error);
      const preparing = engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'preparing',
      });
      if ('error' in preparing) throw new Error(preparing.error);

      // The buyer holds BOTH; the restored supplier is behind (its head
      // is genesis). Epoch has been raised by establishAfterRestore.
      let epoch = '1';
      const restoredEngine = new CommerceLifecycleEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        chains: makeChains(h.statusHeads, clock, () => epoch),
        receipts: h.receipts,
        families: makeFamilies(h.quotes, clock, () => epoch),
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        currentEpoch: () => epoch,
        verifyHeldEvidence: () => true,
      });

      // Same epoch: refused — a fence must strictly raise it.
      expect(
        'error' in
          (restoredEngine.signRestoreFence(BUYER_DID, order.purchase_order_id, [
            evid(genesis),
            evid(preparing),
          ]) as { error?: string }),
      ).toBe(true);

      epoch = '2';
      const fence = restoredEngine.signRestoreFence(BUYER_DID, order.purchase_order_id, [
        evid(genesis),
        evid(preparing),
      ]);
      if ('error' in fence) throw new Error(fence.error);
      expect(fence.restore_fence).toBe(true);
      expect(fence.supplier_epoch).toBe('2');
      // Fenced onto the NEWEST verified receipt, sequence predecessor+1.
      expect(fence.previous_status_digest).toBe(preparing.status_digest);
      expect(fence.sequence).toBe('2');
      expect(fence.state).toBe('preparing');

      // The buyer's verifier accepts it against its held chain.
      expect(verifyRestoreFence(fence, [genesis, preparing], order.accepted_lines, hash)).toBe(
        'head',
      );
      // And the local head really moved.
      expect(h.statusHeads.get(BUYER_DID, order.purchase_order_id)?.headDigest).toBe(
        fence.status_digest,
      );
    });

    it('fails closed without a verifier — unverifiable receipts cannot fence', () => {
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      const genesis = engine.signGenesis(BUYER_DID, order.purchase_order_id);
      if ('error' in genesis) throw new Error(genesis.error);

      const noVerifier = new CommerceLifecycleEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        chains: makeChains(h.statusHeads, clock, () => '2'),
        receipts: h.receipts,
        families: makeFamilies(h.quotes, clock, () => '2'),
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        currentEpoch: () => '2',
      });
      const result = noVerifier.signRestoreFence(BUYER_DID, order.purchase_order_id, [evid(genesis)]);
      expect('error' in result && result.error).toMatch(/no verifiable held status receipts/);
    });
  });

  describe('workflow-pass regressions', () => {
    it('cancellation against an effect_started reservation parks as pending_review (§12.8)', () => {
      const { quote, order } = seedAdmittedOrder();
      admission.markEffectStarted(BUYER_DID, order.purchase_order_id);
      const result = engine.resolveCancellation(
        makeCancellation(order),
        BUYER_DID,
        () => 'cancelled',
      );
      expect('result' in result && result.result).toBe('pending_review');
      // No refund, no genesis — the external outcome still decides.
      expect(h.quotes.getUse(quote.quote_id, order.purchase_order_id)).toBe('held');
      expect(h.statusHeads.get(BUYER_DID, order.purchase_order_id)).toBeNull();
      // The real acceptance still lands afterwards.
      const decided = admission.decideOrder(BUYER_DID, order.purchase_order_id, {
        kind: 'accepted',
        supplierOrderId: 'so-late',
      });
      expect('acknowledgement' in decided && decided.acknowledgement.kind).toBe('accepted');
    });

    /**
     * Both reviewers, round 2: signRestoreFence built the fence with the
     * camelCase key `disputeWindowEndsAt`. A conditional spread gets no
     * excess-property check and buildStatus's `as` cast hid it from tsc,
     * so the generated record lacked the wire field
     * validateCommerceOrderStatus requires for state `delivered` — and
     * signRestoreFence returned an error for EVERY delivered-in-window
     * order, permanently stranding the chain §16.2's takeover exists to
     * rescue. Every prior fence test fenced from `preparing`, which has
     * no such required field, so none of them could see it.
     */
    /**
     * Codex round 2: the fence chose the highest-sequence PRESENTED
     * receipt without comparing it to the supplier's own head. A buyer
     * (or anyone replaying its traffic) could therefore present an
     * authentic but OLDER receipt and rewind a supplier that was already
     * further along — destroying recorded fulfilment and forking the
     * chain. §16.2 fences to the supplier's best-known head; §9.11
     * forbids rollback.
     */
    it('refuses to fence BACKWARD onto an older authentic receipt (§16.2)', () => {
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      const genesis = engine.signGenesis(BUYER_DID, order.purchase_order_id);
      if (!('status_digest' in genesis)) throw new Error('genesis failed');
      const preparing = engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'preparing',
      });
      if (!('status_digest' in preparing)) throw new Error('preparing failed');
      // Local head is now at sequence 1 (preparing).

      const fencing = new CommerceLifecycleEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        chains: makeChains(h.statusHeads, clock, () => '2'),
        receipts: h.receipts,
        families: makeFamilies(h.quotes, clock, () => '2'),
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        currentEpoch: () => '2',
        verifyHeldEvidence: () => true,
      });

      // Present ONLY the older genesis (sequence 0) as evidence.
      const backward = fencing.signRestoreFence(BUYER_DID, order.purchase_order_id, [evid(genesis)]);
      expect('error' in backward).toBe(true);
      expect('error' in backward && backward.error).toMatch(/roll back|behind the local head/);

      // The local head is untouched.
      expect(h.statusHeads.get(BUYER_DID, order.purchase_order_id)?.headDigest).toBe(
        preparing.status_digest,
      );

      // Fencing at the head itself is still allowed.
      const atHead = fencing.signRestoreFence(BUYER_DID, order.purchase_order_id, [evid(preparing)]);
      expect('status_digest' in atHead).toBe(true);
    });

    /**
     * The fork half of the anti-rollback guard. A receipt at the SAME
     * sequence as the local head but with a different digest is two
     * distinct signatures at one height — a fork, not a fast-forward —
     * and this is exactly where an off-by-one in the comparison would
     * land, since fencing AT the head is legitimate.
     */
    it('refuses a same-sequence receipt with a different digest as a fork (§9.11)', () => {
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      const genesis = engine.signGenesis(BUYER_DID, order.purchase_order_id);
      if (!('status_digest' in genesis)) throw new Error('genesis failed');
      const preparing = engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'preparing',
      });
      if (!('status_digest' in preparing)) throw new Error('preparing failed');

      const fencing = new CommerceLifecycleEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        chains: makeChains(h.statusHeads, clock, () => '2'),
        receipts: h.receipts,
        families: makeFamilies(h.quotes, clock, () => '2'),
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        currentEpoch: () => '2',
        verifyHeldEvidence: () => true,
      });

      // Same sequence as the head, different content => different digest.
      const forked = {
        ...preparing,
        evidence_refs: ['forked'],
      };
      const rebuilt = {
        ...forked,
        status_digest: commerceRecordDigest(
          'status',
          { ...forked, status_digest: undefined } as unknown as Record<string, unknown>,
          hash,
        ),
      } as typeof preparing;
      expect(rebuilt.sequence).toBe(preparing.sequence);
      expect(rebuilt.status_digest).not.toBe(preparing.status_digest);

      const attempt = fencing.signRestoreFence(BUYER_DID, order.purchase_order_id, [evid(rebuilt)]);
      expect('error' in attempt).toBe(true);
      expect('error' in attempt && attempt.error).toMatch(/fork/);
      // Head untouched.
      expect(h.statusHeads.get(BUYER_DID, order.purchase_order_id)?.headDigest).toBe(
        preparing.status_digest,
      );
    });

    it('fences a DELIVERED head inside its dispute window (§16.2)', () => {
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      const genesis = engine.signGenesis(BUYER_DID, order.purchase_order_id);
      if (!('status_digest' in genesis)) throw new Error('genesis failed');
      engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'dispatched',
        lines: [{ lineId: 'l1', fulfilledQuantity: { value: '100', unitCode: 'each' } }],
      });
      const delivered = engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'delivered',
        disputeWindowEndsAt: '2026-08-14T00:00:00.000Z',
      });
      if (!('status_digest' in delivered)) throw new Error('delivered failed');

      // A fencing engine over the SAME stores: signRestoreFence needs a
      // verifier, otherwise it refuses before reaching the builder and
      // this test would pass for the wrong reason.
      const fencingEngine = new CommerceLifecycleEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        chains: makeChains(h.statusHeads, clock, () => '2'),
        receipts: h.receipts,
        families: makeFamilies(h.quotes, clock, () => '2'),
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        currentEpoch: () => '2',
        verifyHeldEvidence: () => true,
      });
      const fence = fencingEngine.signRestoreFence(BUYER_DID, order.purchase_order_id, [
        evid(delivered),
      ]);
      // The bug made this an error every time.
      if ('error' in fence) throw new Error(`fence refused a delivered head: ${fence.error}`);

      expect(fence.restore_fence).toBe(true);
      expect(fence.state).toBe('delivered');
      // The wire field must survive onto the fence, or no conforming
      // buyer can validate the record.
      expect(fence.dispute_window_ends_at).toBe('2026-08-14T00:00:00.000Z');
      expect(
        (fence as unknown as Record<string, unknown>).disputeWindowEndsAt,
      ).toBeUndefined();
    });

    /**
     * Codex round 2: the dispute-window check was conditional on being
     * able to READ the delivered head receipt. Receipt loss, corruption,
     * or an inconsistent restore made the deadline evaporate and Core
     * would sign a dispute the window forbids (§9.11). The deadline is
     * digest-bound to the delivered head, so an unreadable head means
     * the deadline is unknown — and unknown must mean refuse.
     */
    it('refuses to sign disputed when the delivered head receipt is unusable (§9.11)', () => {
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      engine.signGenesis(BUYER_DID, order.purchase_order_id);
      engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'dispatched',
        lines: [{ lineId: 'l1', fulfilledQuantity: { value: '100', unitCode: 'each' } }],
      });
      const delivered = engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'delivered',
        disputeWindowEndsAt: '2026-08-14T00:00:00.000Z',
      });
      if (!('status_digest' in delivered)) throw new Error('setup failed');

      // An engine whose receipt store returns a CORRUPT delivered head.
      // (receipts.put ignores conflicts, so the row cannot be poisoned
      // in place — wrap the reader instead.)
      const corruptReceipts = {
        ...h.receipts,
        get: (digest: string) =>
          digest === delivered.status_digest
            ? {
                recordDigest: digest,
                domain: 'status',
                buyerDid: BUYER_DID,
                quoteId: '',
                purchaseOrderId: order.purchase_order_id,
                recordJson: '{ not json',
                evidenceJson: '{}',
                createdAt: clock.now,
              }
            : h.receipts.get(digest),
        listByOrder: (b: string, po: string) => h.receipts.listByOrder(b, po),
        put: (r: Parameters<typeof h.receipts.put>[0]) => h.receipts.put(r),
      } as typeof h.receipts;

      const corruptEngine = new CommerceLifecycleEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        chains: makeChains(h.statusHeads, clock, () => '1'),
        receipts: corruptReceipts,
        families: makeFamilies(h.quotes, clock, () => '1'),
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        currentEpoch: () => '1',
      });

      clock.now = Date.parse('2026-08-10T00:00:00.000Z'); // INSIDE the window
      const attempted = corruptEngine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'disputed',
      });
      // Even inside the window, an unreadable head must refuse rather
      // than sign on an unknown deadline.
      expect('error' in attempted).toBe(true);
      expect('error' in attempted && attempted.error).toMatch(/integrity|does not match|dispute window/);
    });

    it('delivered -> disputed cannot be SIGNED after the dispute window (§9.11)', () => {
      const { order } = seedAdmittedOrder();
      acceptOrder(order.purchase_order_id);
      engine.signGenesis(BUYER_DID, order.purchase_order_id);
      engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'dispatched',
        lines: [{ lineId: 'l1', fulfilledQuantity: { value: '100', unitCode: 'each' } }],
      });
      const delivered = engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'delivered',
        disputeWindowEndsAt: '2026-08-14T00:00:00.000Z',
      });
      expect('status_digest' in delivered).toBe(true);

      clock.now = Date.parse('2026-08-15T00:00:00.000Z'); // past the window
      const late = engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'disputed',
      });
      expect('error' in late && late.error).toMatch(/only before dispute_window_ends_at/);

      clock.now = Date.parse('2026-08-10T00:00:00.000Z'); // inside the window
      const inWindow = engine.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
        state: 'disputed',
      });
      expect('status_digest' in inWindow).toBe(true);
    });
  });
});
