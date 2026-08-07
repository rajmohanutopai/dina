/**
 * Admission engine (CMC-2) — the §9.9 precedence, hold settlement,
 * durable rejections, effect-phase recovery. Dual harness: in-memory
 * and real SQLCipher backends run the identical suite.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { validateOrderAcknowledgement, commerceRecordDigest } from '@dina/commerce-protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  CommerceAdmissionEngine,
  InMemoryCommerceOrderRefRepository,
  InMemoryCommerceQuoteLedgerRepository,
  InMemoryCommerceReceiptRepository,
  SQLiteCommerceOrderRefRepository,
  SQLiteCommerceQuoteLedgerRepository,
  SQLiteCommerceReceiptRepository,
  type CommerceOrderRefRepository,
  type CommerceQuoteLedgerRepository,
  type CommerceReceiptRepository,
} from '../../src/commerce';
import { makeReentrantTxRunner } from '../../src/run/tx';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import {
  BUYER_DID,
  SUPPLIER_DID,
  makeOrder,
  makeProjection,
  makeFamilies,
  makeQuoteRequest,
  makeRevision,
  makeSignedQuote,
 hash } from './helpers';



import type { OrderAcknowledgement } from '@dina/commerce-protocol';

interface Harness {
  orderRefs: CommerceOrderRefRepository;
  quotes: CommerceQuoteLedgerRepository;
  receipts: CommerceReceiptRepository;
  tx: (fn: () => void) => void;
  cleanup: () => void;
}

function inMemoryHarness(): Harness {
  return {
    orderRefs: new InMemoryCommerceOrderRefRepository(),
    quotes: new InMemoryCommerceQuoteLedgerRepository(),
    receipts: new InMemoryCommerceReceiptRepository(),
    tx: (fn) => fn(),
    cleanup: () => undefined,
  };
}

function sqliteHarness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-admission-'));
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
    tx: makeReentrantTxRunner(adapter),
    cleanup: () => {
      adapter.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const DECISION_TIMEOUT_MS = 60_000;
// Inside the quote validity window (issued 11:00Z, valid until 09:00Z next day).
const T_ADMIT = Date.parse('2026-08-07T12:30:00.000Z');

describe.each([
  ['in-memory', inMemoryHarness],
  ['sqlite', sqliteHarness],
])('admission engine (%s)', (_label, makeHarness) => {
  let h: Harness;
  let clock: { now: number };
  let engine: CommerceAdmissionEngine;

  const request = makeQuoteRequest();
  const pricedProjection = request.delivery.projection;

  beforeEach(() => {
    h = makeHarness();
    clock = { now: T_ADMIT };
    engine = new CommerceAdmissionEngine({
      tx: h.tx,
      orderRefs: h.orderRefs,
      families: makeFamilies(h.quotes, clock),
      receipts: h.receipts,
      supplierDid: SUPPLIER_DID,
      now: () => clock.now,
      decisionTimeoutMs: DECISION_TIMEOUT_MS,
    });
  });

  afterEach(() => {
    h.cleanup();
  });

  /** Register a quote family + its request receipt (the provider-bridge
   *  side effect the engine depends on). */
  function seedQuote(overrides: Parameters<typeof makeSignedQuote>[1] = {}) {
    const quote = makeSignedQuote(request, overrides);
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
    expect(engine.registerSignedQuote(quote)).toBeNull();
    return quote;
  }

  it('happy path: reserve, accept, replay returns the recorded acknowledgement', () => {
    const quote = seedQuote();
    const order = makeOrder(quote, pricedProjection);

    expect(engine.admitOrder(order, BUYER_DID)).toEqual({ kind: 'reserved' });

    const decided = engine.decideOrder(BUYER_DID, order.purchase_order_id, {
      kind: 'accepted',
      supplierOrderId: 'so-77',
      externalRef: 'erp-77',
    });
    expect('acknowledgement' in decided && decided.acknowledgement.kind).toBe('accepted');
    expect(h.quotes.getUse(quote.quote_id, order.purchase_order_id)).toBe('committed');

    // Replay — even AFTER quote expiry (§9.8: recorded ack regardless).
    clock.now = Date.parse('2026-08-09T00:00:00.000Z');
    const replay = engine.admitOrder(order, BUYER_DID);
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') {
      expect(replay.acknowledgement.kind).toBe('accepted');
      expect(replay.acknowledgement.order_digest).toBe(order.order_digest);
    }
  });

  it('typed conflicts fire BEFORE any use-count effect', () => {
    const quote = seedQuote();
    const order = makeOrder(quote, pricedProjection);
    expect(engine.admitOrder(order, BUYER_DID).kind).toBe('reserved');

    // Same key, different order id: alias conflict.
    const aliased = makeOrder(quote, pricedProjection, { purchase_order_id: 'po-2' });
    const aliasOutcome = engine.admitOrder(aliased, BUYER_DID);
    expect(aliasOutcome.kind).toBe('conflict');
    if (aliasOutcome.kind === 'conflict') expect(aliasOutcome.error).toMatch(/cannot alias/);

    // Same keys, different digest: payload swap conflict.
    const swapped = makeOrder(quote, pricedProjection, { buyer_reference: 'PO/77' });
    const swapOutcome = engine.admitOrder(swapped, BUYER_DID);
    expect(swapOutcome.kind).toBe('conflict');
    if (swapOutcome.kind === 'conflict') expect(swapOutcome.error).toMatch(/DIFFERENT order_digest/);

    // Neither consumed capacity beyond the original hold.
    expect(h.quotes.activeUseCount(quote.quote_id)).toBe(1);

    // Reserved replay of the SAME payload: processing, no second hold.
    expect(engine.admitOrder(order, BUYER_DID).kind).toBe('processing');
    expect(h.quotes.activeUseCount(quote.quote_id)).toBe(1);
  });

  it('sender binding and audience are enforced', () => {
    const quote = seedQuote();
    const order = makeOrder(quote, pricedProjection);
    const outcome = engine.admitOrder(order, 'did:plc:mallory');
    expect(outcome.kind).toBe('conflict');
    if (outcome.kind === 'conflict') expect(outcome.error).toMatch(/authenticated sender/);
  });

  it('quote_consumed is durable: a later refund cannot flip the recorded answer', () => {
    const quote = seedQuote(); // maxUses default "1"
    const first = makeOrder(quote, pricedProjection);
    expect(engine.admitOrder(first, BUYER_DID).kind).toBe('reserved');

    const second = makeOrder(quote, pricedProjection, {
      purchase_order_id: 'po-2',
      idempotency_key: 'idem-po-2',
    });
    const rejected = engine.admitOrder(second, BUYER_DID);
    expect(rejected.kind).toBe('rejected');
    if (rejected.kind === 'rejected' && rejected.acknowledgement.kind === 'rejected') {
      expect(rejected.acknowledgement.reason_code).toBe('quote_consumed');
    }

    // First order rejected -> hold refunded, capacity free again.
    engine.decideOrder(BUYER_DID, first.purchase_order_id, {
      kind: 'rejected',
      reasonCode: 'policy_rejected',
    });
    expect(h.quotes.activeUseCount(quote.quote_id)).toBe(0);

    // Replay of the consumed rejection returns the FROZEN answer.
    const replay = engine.admitOrder(second, BUYER_DID);
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay' && replay.acknowledgement.kind === 'rejected') {
      expect(replay.acknowledgement.reason_code).toBe('quote_consumed');
    }

    // A NEW order uses the freed capacity.
    const third = makeOrder(quote, pricedProjection, {
      purchase_order_id: 'po-3',
      idempotency_key: 'idem-po-3',
    });
    expect(engine.admitOrder(third, BUYER_DID).kind).toBe('reserved');
  });

  it('supersession: order against a stale revision returns currentQuoteDigest', () => {
    const quote = seedQuote();
    const staleOrder = makeOrder(quote, pricedProjection);
    const rev2 = makeRevision(quote);
    expect(engine.registerSignedQuote(rev2)).toBeNull();

    const outcome = engine.admitOrder(staleOrder, BUYER_DID);
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected' && outcome.acknowledgement.kind === 'rejected') {
      expect(outcome.acknowledgement.reason_code).toBe('quote_superseded');
      expect(outcome.acknowledgement.current_quote_digest).toBe(rev2.quote_digest);
    }
    // The stale rejection did NOT consume the shared counter (§9.9):
    // re-approval against the current head succeeds.
    const currentOrder = makeOrder(rev2, pricedProjection, {
      purchase_order_id: 'po-2',
      idempotency_key: 'idem-po-2',
    });
    expect(engine.admitOrder(currentOrder, BUYER_DID).kind).toBe('reserved');
  });

  it('expiry is an admission-only check', () => {
    const quote = seedQuote();
    const order = makeOrder(quote, pricedProjection);
    clock.now = Date.parse('2026-08-08T09:00:01.000Z'); // past validUntil
    const outcome = engine.admitOrder(order, BUYER_DID);
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected' && outcome.acknowledgement.kind === 'rejected') {
      expect(outcome.acknowledgement.reason_code).toBe('quote_expired');
    }
  });

  it('a changed priced projection field rejects as projection_mismatch', () => {
    const quote = seedQuote();
    const changedRegion = makeProjection({ region: { scheme: 'postal_area', value: '695001' } });
    const order = makeOrder(quote, changedRegion);
    const outcome = engine.admitOrder(order, BUYER_DID);
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected' && outcome.acknowledgement.kind === 'rejected') {
      expect(outcome.acknowledgement.reason_code).toBe('projection_mismatch');
    }
  });

  it('a non-projection binding violation gets its own reason code', () => {
    const quote = seedQuote();
    const order = makeOrder(quote, pricedProjection, {
      approved_total: { currency: 'INR', minor_units: '1' },
    });
    const outcome = engine.admitOrder(order, BUYER_DID);
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected' && outcome.acknowledgement.kind === 'rejected') {
      expect(outcome.acknowledgement.reason_code).toBe('order_binding_mismatch');
    }
  });

  it('pre_effect deadline recovery refunds; effect_started is untouchable', () => {
    const quote = seedQuote({ max_uses: '2' });
    const first = makeOrder(quote, pricedProjection);
    const second = makeOrder(quote, pricedProjection, {
      purchase_order_id: 'po-2',
      idempotency_key: 'idem-po-2',
    });
    expect(engine.admitOrder(first, BUYER_DID).kind).toBe('reserved');
    expect(engine.admitOrder(second, BUYER_DID).kind).toBe('reserved');

    // Second order crossed the external boundary before the crash.
    expect(engine.markEffectStarted(BUYER_DID, 'po-2')).toBe(true);

    clock.now = T_ADMIT + DECISION_TIMEOUT_MS + 1;
    const timedOut = engine.recoverAdmissions();
    expect(timedOut).toEqual(['po-1']);

    // po-1: decided rejected(decision_timeout), hold refunded.
    const replay = engine.admitOrder(first, BUYER_DID);
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay' && replay.acknowledgement.kind === 'rejected') {
      expect(replay.acknowledgement.reason_code).toBe('decision_timeout');
    }
    expect(h.quotes.getUse(quote.quote_id, 'po-1')).toBe('refunded');

    // po-2: STILL reserved and consumed — never timed out, never refunded.
    expect(engine.admitOrder(second, BUYER_DID).kind).toBe('processing');
    expect(h.quotes.getUse(quote.quote_id, 'po-2')).toBe('held');

    // Its real outcome resolves later.
    const decided = engine.decideOrder(BUYER_DID, 'po-2', {
      kind: 'accepted',
      supplierOrderId: 'so-2',
    });
    expect('acknowledgement' in decided).toBe(true);
    expect(h.quotes.getUse(quote.quote_id, 'po-2')).toBe('committed');
  });

  /**
   * The settlement CAS used to be a discarded boolean. A decision that
   * commits while its hold refuses to settle leaks capacity permanently:
   * the order is answered, the unit stays held, and nothing ever notices.
   * Settlement now throws, which aborts the surrounding transaction.
   */
  it('rolls the decision back when the hold cannot settle', () => {
    const quote = seedQuote();
    const order = makeOrder(quote, pricedProjection);
    expect(engine.admitOrder(order, BUYER_DID).kind).toBe('reserved');

    // Corrupt the ledger behind the engine's back: the hold is already
    // settled, so the decision's CAS cannot succeed.
    expect(h.quotes.settleUse(quote.quote_id, order.purchase_order_id, 'committed', clock.now)).toBe(
      true,
    );

    expect(() =>
      engine.decideOrder(BUYER_DID, order.purchase_order_id, {
        kind: 'accepted',
        supplierOrderId: 'so-1',
      }),
    ).toThrow(/commerce integrity/);

    // The order is still undecided — the transaction rolled back rather
    // than leaving an answered order with an unsettled hold. (Only the
    // SQLite harness has real transactions; the in-memory tx runner is a
    // pass-through, so assert the durable behaviour where it exists.)
    if (_label === 'sqlite') {
      const replay = engine.admitOrder(order, BUYER_DID);
      expect(replay.kind).toBe('processing');
    }
  });

  /**
   * Codex round 2: the acknowledgement id was `ack:${purchase_order_id}`.
   * purchase_order_id is itself bounded by MAX_ID_LENGTH (128), so a
   * legal maximum-length order produced a 132-character acknowledgement
   * id — rejected by validateId, hence by every conforming buyer — while
   * Core had already durably DECIDED the order. Reconciliation could
   * then never resolve the outcome.
   */
  it('emits a valid acknowledgement for a maximum-length order id', () => {
    const quote = seedQuote();
    const maxLengthId = 'a'.repeat(128);
    const order = { ...makeOrder(quote, pricedProjection), purchase_order_id: maxLengthId };
    // Re-digest so the proposal itself stays valid.
    const rebuilt = {
      ...order,
      order_digest: commerceRecordDigest(
        'order',
        { ...order, order_digest: undefined } as unknown as Record<string, unknown>,
        hash,
      ),
    };

    expect(engine.admitOrder(rebuilt as never, BUYER_DID)).toEqual({ kind: 'reserved' });
    // The acknowledgement is built at DECIDE time, so that is the path
    // that must survive a maximum-length order id.
    const decided = engine.decideOrder(BUYER_DID, maxLengthId, {
      kind: 'accepted',
      supplierOrderId: 'so-max',
    });
    // UNCONDITIONAL. A guarded assertion asserts nothing when the shape
    // changes — which is exactly how a broken build passes.
    expect('acknowledgement' in decided).toBe(true);
    const ack = (decided as { acknowledgement: OrderAcknowledgement }).acknowledgement;
    expect(ack.acknowledgement_id.length).toBeLessThanOrEqual(128);
    expect(validateOrderAcknowledgement(ack, hash)).toBeNull();
  });

  /**
   * §16.2 post-restore re-offer, OWNER DECISION: Core never synthesizes a
   * replacement quote. It cannot know how much of the original allowance
   * was really consumed — the backup's use counter is precisely the number
   * a stale restore makes untrustworthy — and it holds no commercial
   * authority to set terms. The supplier side owns the re-offer.
   */
  describe('post-restore re-offer seam (§16.2)', () => {
    it('refuses without inventing terms when no supplier re-offer is wired', () => {
      const quote = seedQuote();
      h.quotes.voidUnexpired(clock.now, clock.now);
      const order = makeOrder(quote, pricedProjection);

      const outcome = engine.admitOrder(order, BUYER_DID);
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind !== 'rejected' || outcome.acknowledgement.kind !== 'rejected') {
        throw new Error('expected a rejected acknowledgement');
      }
      expect(outcome.acknowledgement.reason_code).toBe('quote_voided');
      // No digest: naming the voided head would have the buyer re-approve
      // against something that can never become live again.
      expect(outcome.acknowledgement.current_quote_digest).toBeUndefined();
      // And Core signed nothing on its own initiative.
      expect(h.quotes.getHead(quote.quote_id)?.voided).toBe(true);
    });

    it('answers quote_superseded with the SUPPLIER re-offer when the seam is wired', () => {
      const quote = seedQuote();
      h.quotes.voidUnexpired(clock.now, clock.now);
      const order = makeOrder(quote, pricedProjection);

      // The supplier issues a genuinely new family from its own records.
      const replacement = makeSignedQuote(request, { quote_id: 'q-reoffer' });
      const withSeam = new CommerceAdmissionEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        families: makeFamilies(h.quotes, clock),
        receipts: h.receipts,
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        decisionTimeoutMs: DECISION_TIMEOUT_MS,
        resignVoidedQuote: () => replacement,
      });

      const outcome = withSeam.admitOrder(order, BUYER_DID);
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind !== 'rejected' || outcome.acknowledgement.kind !== 'rejected') {
        throw new Error('expected a rejected acknowledgement');
      }
      expect(outcome.acknowledgement.reason_code).toBe('quote_superseded');
      // The digest names the LIVE replacement, so re-approval can succeed.
      expect(outcome.acknowledgement.current_quote_digest).toBe(replacement.quote_digest);
      expect(h.quotes.getHead('q-reoffer')?.headDigest).toBe(replacement.quote_digest);
      expect(h.quotes.getHead('q-reoffer')?.voided).toBe(false);
    });

    it('refuses a counterproposal addressed to a DIFFERENT buyer (§9.8)', () => {
      // The runner is untrusted. Unbound, it can hand buyer A a quote
      // priced for buyer B — unit prices, subtotals, total, payment terms
      // — inside a Core-authenticated acknowledgement, and Core vouches
      // for it. Audience binding is what makes the counter safe to emit.
      const quote = seedQuote();
      const order = makeOrder(quote, pricedProjection);
      expect(engine.admitOrder(order, BUYER_DID).kind).toBe('reserved');

      const forOtherBuyer = makeSignedQuote(request, {
        quote_id: 'q-other-buyer',
        buyer_did: 'did:plc:someoneelse9',
        replaces_quote_digest: quote.quote_digest,
      });
      const outcome = engine.decideOrder(BUYER_DID, order.purchase_order_id, {
        kind: 'counterproposal',
        replacementQuote: forOtherBuyer,
      });
      expect('error' in outcome).toBe(true);
      if (!('error' in outcome)) throw new Error('unreachable');
      // The refusal now comes from QuoteFamily.register, which is the
      // point: the expectation is an argument every registration path must
      // supply, not a comparison each call site must remember to write.
      expect(outcome.error).toMatch(/addressed to a different buyer/);
      // Nothing was written: no foreign family in this supplier's ledger,
      // and the order is still undecided.
      expect(h.quotes.getHead('q-other-buyer')).toBeNull();
      expect(engine.admitOrder(order, BUYER_DID).kind).toBe('processing');
    });

    it('discards a re-offer addressed to a DIFFERENT buyer', () => {
      // The seam is ASKED for this buyer, but its answer is untrusted like
      // any other runner output. Registration binds supplier and epoch;
      // the buyer is a cross-aggregate fact only admission knows. This is
      // the call site I missed when binding the counterproposal path.
      const quote = seedQuote();
      h.quotes.voidUnexpired(clock.now, clock.now);
      const order = makeOrder(quote, pricedProjection);

      const forOtherBuyer = makeSignedQuote(request, {
        quote_id: 'q-reoffer-other',
        buyer_did: 'did:plc:someoneelse9',
      });
      const withSeam = new CommerceAdmissionEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        families: makeFamilies(h.quotes, clock),
        receipts: h.receipts,
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        decisionTimeoutMs: DECISION_TIMEOUT_MS,
        resignVoidedQuote: () => forOtherBuyer,
      });

      const outcome = withSeam.admitOrder(order, BUYER_DID);
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind !== 'rejected' || outcome.acknowledgement.kind !== 'rejected') {
        throw new Error('expected a rejected acknowledgement');
      }
      // Falls back to the honest refusal, and no cross-audience family
      // was written into this supplier's ledger.
      expect(outcome.acknowledgement.reason_code).toBe('quote_voided');
      expect(outcome.acknowledgement.current_quote_digest).toBeUndefined();
      expect(h.quotes.getHead('q-reoffer-other')).toBeNull();
    });

    it('does NOT launder a rejected re-offer into a live head', () => {
      const quote = seedQuote();
      h.quotes.voidUnexpired(clock.now, clock.now);
      const order = makeOrder(quote, pricedProjection);

      // A re-offer that reuses the VOIDED family id cannot register.
      const bad = makeSignedQuote(request, { quote_id: quote.quote_id, quote_revision: '2' });
      const withBadSeam = new CommerceAdmissionEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        families: makeFamilies(h.quotes, clock),
        receipts: h.receipts,
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        decisionTimeoutMs: DECISION_TIMEOUT_MS,
        resignVoidedQuote: () => bad,
      });

      const outcome = withBadSeam.admitOrder(order, BUYER_DID);
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind !== 'rejected' || outcome.acknowledgement.kind !== 'rejected') {
        throw new Error('expected a rejected acknowledgement');
      }
      // Falls back to the honest refusal rather than pointing at a head
      // that was never registered.
      expect(outcome.acknowledgement.reason_code).toBe('quote_voided');
      expect(h.quotes.getHead(quote.quote_id)?.voided).toBe(true);
    });

    it('refuses a family whose EPOCH predates the restore, even unvoided', () => {
      // The hole the aggregate closes, driven through the real admission
      // path rather than the aggregate in isolation. voidUnexpired only
      // marks heads still inside their validity window, so an EXPIRED
      // pre-restore family survives a restore unmarked. Epoch monotonicity
      // is what stops it being spent on the backup's stale use counters.
      const quote = seedQuote({ valid_until: '2026-08-08T09:00:00.000Z' });
      const order = makeOrder(quote, pricedProjection);

      // Restore: epoch moves to 2. Nothing voids this head.
      const restored = new CommerceAdmissionEngine({
        tx: h.tx,
        orderRefs: h.orderRefs,
        families: makeFamilies(h.quotes, clock, () => '2'),
        receipts: h.receipts,
        supplierDid: SUPPLIER_DID,
        now: () => clock.now,
        decisionTimeoutMs: DECISION_TIMEOUT_MS,
      });
      expect(h.quotes.getHead(quote.quote_id)?.voided).toBe(false);

      const outcome = restored.admitOrder(order, BUYER_DID);
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind !== 'rejected' || outcome.acknowledgement.kind !== 'rejected') {
        throw new Error('expected a rejected acknowledgement');
      }
      // stale_epoch reaches the buyer as quote_voided: the family belongs
      // to a generation that no longer exists — request a new quote.
      expect(outcome.acknowledgement.reason_code).toBe('quote_voided');
      expect(outcome.acknowledgement.current_quote_digest).toBeUndefined();
      // And no capacity was taken on the way to the refusal.
      expect(h.quotes.activeUseCount(quote.quote_id)).toBe(0);
    });
  });

  /**
   * §9.8 makes Core the quote-BIRTH gate, so the whole revision-extension
   * contract has to run here. Before this, registerSignedQuote checked only
   * max_uses and previous_quote_digest — which let a faulty or hostile
   * supplier replace a family head with a SKIPPED revision, a DIFFERENT
   * audience or request, or a REGRESSED epoch. The complete verifier
   * already existed in the protocol package and simply was never called.
   */
  describe('quote revision chain (§9.8)', () => {
    it('rejects a skipped revision number', () => {
      const quote = seedQuote();
      const skipped = makeRevision(quote, { quote_revision: '3' }); // head is 1
      expect(engine.registerSignedQuote(skipped)).toMatch(/expected revision 2/);
      expect(h.quotes.getHead(quote.quote_id)?.headRevision).toBe('1');
    });

    it('rejects a revision that changes the audience or the request', () => {
      const quote = seedQuote();
      for (const field of ['buyer_did', 'request_id'] as const) {
        const swapped = field === 'buyer_did' ? 'did:plc:otherbuyer1' : 'req-other';
        const tampered = makeRevision(quote, { [field]: swapped });
        expect(engine.registerSignedQuote(tampered)).toMatch(
          new RegExp(`immutable field ${field} changed`),
        );
      }
      expect(h.quotes.getHead(quote.quote_id)?.headRevision).toBe('1');
    });

    it('rejects a revision whose epoch runs AHEAD of the live one', () => {
      // Core signs a revision NOW, so it must carry the live epoch
      // exactly. Below is stale; ABOVE is the dangerous direction — a
      // future epoch survives the next restore because the aggregate's
      // staleness test compares the head against the live epoch, so a
      // head at 999 still reads as current at epoch 2 and its pre-restore
      // use counters come back with it.
      // The below-the-line direction needs a clock the engine's epoch can
      // move under; it is covered against the aggregate directly. What is
      // reachable here — and what was open — is the ABOVE case.
      const quote = seedQuote({ supplier_epoch: '1' });
      const ahead = makeRevision(quote, { supplier_epoch: '999' });
      expect(engine.registerSignedQuote(ahead)).toMatch(/epoch ahead of this Core/);
      expect(h.quotes.getHead(quote.quote_id)?.headRevision).toBe('1');
    });

    it('refuses to register a quote signed by another supplier (§9.12)', () => {
      // The candidate arrives from an untrusted runner. Registering it
      // would make Core vouch for another supplier's terms and write a
      // foreign family into this supplier's ledger.
      const foreign = makeSignedQuote(request, {
        quote_id: 'q-foreign',
        supplier_did: 'did:plc:othersupplier9',
      });
      expect(engine.registerSignedQuote(foreign)).toMatch(/different supplier/);
      expect(h.quotes.getHead('q-foreign')).toBeNull();
    });

    it('advances valid_until with the head so restore voiding sees the CURRENT deadline', () => {
      const quote = seedQuote();
      const originalValidUntil = h.quotes.getHead(quote.quote_id)?.validUntil;

      // A legal revision that EXTENDS validity.
      const extended = makeRevision(quote, { valid_until: '2026-08-20T09:00:00.000Z' });
      expect(engine.registerSignedQuote(extended)).toBeNull();

      const head = h.quotes.getHead(quote.quote_id);
      expect(head?.headRevision).toBe('2');
      // The stored deadline moved. Left at revision 1's value, restore
      // voiding would judge this head by a stale deadline — an extended,
      // still-live quote could look expired, escape voiding, and resurrect
      // capacity after a restore (§16.2).
      expect(head?.validUntil).toBe(Date.parse('2026-08-20T09:00:00.000Z'));
      expect(head?.validUntil).not.toBe(originalValidUntil);
    });
  });

  it('counterproposal refunds the hold and registers the fresh family', () => {
    const quote = seedQuote();
    const order = makeOrder(quote, pricedProjection);
    expect(engine.admitOrder(order, BUYER_DID).kind).toBe('reserved');

    const replacement = makeSignedQuote(request, {
      quote_id: 'q-2',
      replaces_quote_digest: quote.quote_digest,
    });
    const decided = engine.decideOrder(BUYER_DID, order.purchase_order_id, {
      kind: 'counterproposal',
      replacementQuote: replacement,
    });
    expect(
      'acknowledgement' in decided &&
        (decided as { acknowledgement: OrderAcknowledgement }).acknowledgement.kind,
    ).toBe('counterproposal');
    expect(h.quotes.getUse(quote.quote_id, order.purchase_order_id)).toBe('refunded');
    expect(h.quotes.getHead('q-2')?.headDigest).toBe(replacement.quote_digest);
  });

  it('admission against a voided (restore-fenced) quote rejects quote_voided (§16.2)', () => {
    const quote = seedQuote();
    // Restore voiding: capacity is never resurrected from a backup.
    h.quotes.voidUnexpired(clock.now, clock.now);
    const order = makeOrder(quote, pricedProjection);
    const outcome = engine.admitOrder(order, BUYER_DID);
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected' && outcome.acknowledgement.kind === 'rejected') {
      // NOT quote_superseded: a voided family has no live head, and
      // naming the voided digest would livelock re-approval (§16.2).
      expect(outcome.acknowledgement.reason_code).toBe('quote_voided');
      expect(outcome.acknowledgement.current_quote_digest).toBeUndefined();
    }
    // Proof the dangling pointer would have been a livelock: the voided
    // family refuses any further revision, so that digest is terminal.
    expect(engine.registerSignedQuote(makeRevision(quote))).toMatch(/voided by restore/);
  });

  it('a decided replay wins over later supersession (§9.9 precedence)', () => {
    const quote = seedQuote();
    const order = makeOrder(quote, pricedProjection);
    expect(engine.admitOrder(order, BUYER_DID).kind).toBe('reserved');
    const decided = engine.decideOrder(BUYER_DID, order.purchase_order_id, {
      kind: 'accepted',
      supplierOrderId: 'so-1',
    });
    expect('acknowledgement' in decided).toBe(true);

    // The quote family moves on — then the byte-identical order replays.
    expect(engine.registerSignedQuote(makeRevision(quote))).toBeNull();
    const replay = engine.admitOrder(order, BUYER_DID);
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') expect(replay.acknowledgement.kind).toBe('accepted');
  });

  it('registerSignedQuote enforces the signing CAS and maxUses immutability', () => {
    const quote = seedQuote();
    // Fork: rev2 whose previous digest is not the head.
    const fork = makeRevision(quote, { previous_quote_digest: 'a'.repeat(64) });
    // The full §9.8 revision verifier now catches this earlier and names
    // it precisely: a previous_quote_digest that does not extend the
    // held head IS a supplier fork.
    expect(engine.registerSignedQuote(fork)).toMatch(/supplier fork/);
    // Changed maxUses within the family.
    const mutated = makeRevision(quote, { max_uses: '5' });
    expect(engine.registerSignedQuote(mutated)).toMatch(/max_uses is immutable/);
    // Legal successor advances.
    const rev2 = makeRevision(quote);
    expect(engine.registerSignedQuote(rev2)).toBeNull();
    expect(h.quotes.getHead(quote.quote_id)?.headRevision).toBe('2');
  });
});

/**
 * Codex finding: decideOrder opened a transaction and then called the
 * PUBLIC registerSignedQuote, which opens another. Every existing test
 * hid this because makeReentrantTxRunner tolerates nesting — real
 * op-sqlite issues a raw BEGIN and would throw on device. This harness
 * uses a STRICT runner that refuses to nest, so the bug cannot hide.
 */
describe('no nested transactions (mobile op-sqlite safety)', () => {
  it('counterproposal decides without opening a second transaction', () => {
    let depth = 0;
    let maxDepth = 0;
    const strictTx = (fn: () => void): void => {
      if (depth > 0) {
        throw new Error('nested BEGIN — op-sqlite cannot nest transactions');
      }
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      try {
        fn();
      } finally {
        depth -= 1;
      }
    };

    const receipts = new InMemoryCommerceReceiptRepository();
    const quotes = new InMemoryCommerceQuoteLedgerRepository();
    const clock = { now: T_ADMIT };
    const engine = new CommerceAdmissionEngine({
      tx: strictTx,
      orderRefs: new InMemoryCommerceOrderRefRepository(),
      families: makeFamilies(quotes, clock),
      receipts,
      supplierDid: SUPPLIER_DID,
      now: () => clock.now,
      decisionTimeoutMs: DECISION_TIMEOUT_MS,
    });

    const req = makeQuoteRequest();
    const quote = makeSignedQuote(req);
    receipts.put({
      recordDigest: req.request_digest,
      domain: 'request',
      buyerDid: req.buyer_did,
      quoteId: quote.quote_id,
      purchaseOrderId: '',
      recordJson: JSON.stringify(req),
      evidenceJson: '{}',
      createdAt: clock.now,
    });
    expect(engine.registerSignedQuote(quote)).toBeNull();

    const order = makeOrder(quote, req.delivery.projection);
    expect(engine.admitOrder(order, BUYER_DID).kind).toBe('reserved');

    // The counterproposal path registers a fresh quote family from
    // INSIDE decideOrder's transaction. Before the split, this threw.
    const replacement = makeSignedQuote(req, {
      quote_id: 'q-2',
      replaces_quote_digest: quote.quote_digest,
    });
    const decided = engine.decideOrder(BUYER_DID, order.purchase_order_id, {
      kind: 'counterproposal',
      replacementQuote: replacement,
    });

    expect('acknowledgement' in decided).toBe(true);
    expect(quotes.getHead('q-2')?.headDigest).toBe(replacement.quote_digest);
    expect(maxDepth).toBe(1);
  });
});
