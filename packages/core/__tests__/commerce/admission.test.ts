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
import { readEvidence } from '../../src/commerce/receipt_evidence';
import { makeReentrantTxRunner } from '../../src/run/tx';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import {
  BUYER_DID,
  SUPPLIER_DID,
  hash,
  makeAdmission,
  makeFamilies,
  makeOrder,
  makeOrders,
  makeProjection,
  makeQuoteRequest,
  makeRevision,
  makeSignedQuote,
} from './helpers';

import type { OrderAcknowledgement } from '@dina/commerce-protocol';

interface Harness {
  orderRefs: CommerceOrderRefRepository;
  quotes: CommerceQuoteLedgerRepository;
  receipts: CommerceReceiptRepository;
  tx: (fn: () => void) => void;
  /**
   * Edit a stored record's body AFTER it was written, leaving its digest
   * untouched — the corruption a shape check cannot see.
   *
   * TEST-SIDE ONLY. `put` is first-writer-wins for the body on purpose
   * (WS-2.8), so there is no production affordance for this and there must
   * not be: each harness reaches past its own repository the way disk
   * corruption or a half-finished migration would.
   */
  tamperReceiptBody: (recordDigest: string, recordJson: string) => void;
  /**
   * Corrupt a decided order's stored acknowledgement. Also test-side only:
   * `decide` is a CAS on `state = 'reserved'`, so a second call is refused —
   * correctly — and there is no production path that rewrites this column.
   */
  tamperAcknowledgement: (purchaseOrderId: string, acknowledgementJson: string) => void;
  cleanup: () => void;
}

function inMemoryHarness(): Harness {
  const receipts = new InMemoryCommerceReceiptRepository();
  const orderRefs = new InMemoryCommerceOrderRefRepository();
  return {
    orderRefs,
    quotes: new InMemoryCommerceQuoteLedgerRepository(),
    receipts,
    tx: (fn) => fn(),
    tamperReceiptBody: (recordDigest, recordJson) => {
      const map = (receipts as unknown as { byDigest: Map<string, { recordJson: string }> })
        .byDigest;
      const stored = map.get(recordDigest);
      if (stored === undefined) throw new Error(`no receipt for ${recordDigest}`);
      map.set(recordDigest, { ...stored, recordJson });
    },
    tamperAcknowledgement: (purchaseOrderId, acknowledgementJson) => {
      const map = (
        orderRefs as unknown as {
          byOrderId: Map<string, { purchaseOrderId: string; acknowledgementJson: string }>;
        }
      ).byOrderId;
      for (const [key, ref] of map) {
        if (ref.purchaseOrderId === purchaseOrderId) {
          map.set(key, { ...ref, acknowledgementJson });
        }
      }
    },
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
    tamperReceiptBody: (recordDigest, recordJson) => {
      adapter.run('UPDATE commerce_receipts SET record_json = ? WHERE record_digest = ?', [
        recordJson,
        recordDigest,
      ]);
    },
    tamperAcknowledgement: (purchaseOrderId, acknowledgementJson) => {
      adapter.run(
        'UPDATE commerce_order_refs SET acknowledgement_json = ? WHERE purchase_order_id = ?',
        [acknowledgementJson, purchaseOrderId],
      );
    },
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
  let engine: ReturnType<typeof makeAdmission>;

  const request = makeQuoteRequest();
  const pricedProjection = request.delivery.projection;

  beforeEach(() => {
    h = makeHarness();
    clock = { now: T_ADMIT };
    engine = makeAdmission({
      tx: h.tx,
      orders: makeOrders(h.orderRefs, clock),
      families: makeFamilies(h.quotes, clock),
      receipts: h.receipts,
      supplierDid: () => SUPPLIER_DID,
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

  /**
   * WS-2.8 (§9.12) — the order proposal ARRIVED, and the receipt says so.
   *
   * The evidence column existed since CMC-1 with every caller writing `'{}'`.
   * What a dispute turns on is not "we agree this is the document" but "you
   * sent it to me" — so the arrival, and who was authenticated when it
   * arrived, is the fact worth keeping.
   */
  it('records ARRIVAL evidence naming the authenticated sender', () => {
    const quote = seedQuote();
    const order = makeOrder(quote, pricedProjection);
    engine.admitOrder(order, BUYER_DID);

    const stored = h.receipts.get(order.order_digest);
    expect(stored).not.toBeNull();
    expect(readEvidence(stored?.evidenceJson ?? '').observations).toEqual([
      expect.objectContaining({ kind: 'received', fromDid: BUYER_DID }),
    ]);
  });

  /**
   * The refusal a counterparty hears is deliberately non-disclosing:
   * `quote_unknown` covers an expired quote, a quote this node never held, and
   * a retained record it could not read back. Telling a stranger which one
   * would let them probe the supplier's ledger.
   *
   * That is right for the counterparty and wrong for the node's OWN operator,
   * who otherwise debugs a live refusal with exactly as much information as an
   * attacker has. Writing the disaster-recovery scenario cost an hour to this:
   * a clock on the quote's `valid_until` answered `quote_unknown`, which reads
   * as "no such quote" and sends you looking in the wrong place.
   */
  describe('the operator is told more than the counterparty', () => {
    it('distinguishes an EXPIRED quote from one that was never held', () => {
      const quote = seedQuote();
      const order = makeOrder(quote, pricedProjection);
      clock.now = Date.parse('2026-08-09T00:00:00.000Z'); // past valid_until

      const expired = engine.admitOrder(order, BUYER_DID);
      expect(expired.kind).toBe('rejected');
      if (expired.kind !== 'rejected') throw new Error('expected a rejection');
      // The WIRE answer stays flat...
      expect(
        expired.acknowledgement.kind === 'rejected' && expired.acknowledgement.reason_code,
      ).toBe('quote_expired');
      // ...and the operator hears which refusal the family actually made.
      expect(expired.detail).toContain('quote_expired');
    });

    it('does not call a missing quote family "quote_unknown" and stop there', () => {
      const quote = seedQuote();
      const order = makeOrder(quote, pricedProjection, { quote_id: 'q-never-existed' });
      const unknown = engine.admitOrder(order, BUYER_DID);
      expect(unknown.kind).toBe('rejected');
      if (unknown.kind !== 'rejected') throw new Error('expected a rejection');
      expect(
        unknown.acknowledgement.kind === 'rejected' && unknown.acknowledgement.reason_code,
      ).toBe('quote_unknown');
      // Names the id, so an operator knows WHICH family was looked for.
      expect(unknown.detail).toContain('q-never-existed');
    });

    it('never leaks the detail into the acknowledgement the buyer receives', () => {
      // The whole point of the split. If the detail rode on the wire the
      // non-disclosing reason code would be decoration.
      const quote = seedQuote();
      const order = makeOrder(quote, pricedProjection, { quote_id: 'q-never-existed' });
      const rejected = engine.admitOrder(order, BUYER_DID);
      if (rejected.kind !== 'rejected') throw new Error('expected a rejection');
      expect(JSON.stringify(rejected.acknowledgement)).not.toContain('q-never-existed');
    });
  });

  /**
   * WS-2.2 — the retained request is the YARDSTICK, so it is read through the
   * ingress validator rather than cast.
   *
   * Admission checks the order's delivery against the PRICED PROJECTION this
   * record carries. Read as `JSON.parse(…) as {delivery: …}`, a projection
   * edited in the store after writing became the standard the order had to
   * match — so a mismatched order would pass, and the corruption would show up
   * as a wrong commercial outcome rather than an error.
   */
  describe('the retained request is validated on the way out', () => {
    it('refuses an order when the retained request no longer matches its digest', () => {
      const quote = seedQuote();
      const order = makeOrder(quote, pricedProjection);

      // Edit the stored request AFTER writing, leaving its digest untouched.
      // A shape check passes this; re-deriving the digest does not.
      const stored = h.receipts.get(quote.request_digest);
      if (stored === null) throw new Error('the fixture did not retain the request');
      const tampered = JSON.parse(stored.recordJson) as {
        delivery: { projection: { destination_region?: string } };
      };
      tampered.delivery.projection.destination_region = 'XX-elsewhere';
      h.tamperReceiptBody(quote.request_digest, JSON.stringify(tampered));

      const outcome = engine.admitOrder(order, BUYER_DID);
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind !== 'rejected') throw new Error('expected a rejection');
      expect(outcome.detail).toContain('unreadable');
    });

    it('FREEZES the refusal — repairing the store does not retroactively accept', () => {
      // §9.9's strongest sentence: "An admission answer, once given, is
      // frozen — a replay of the rejected proposal still returns the recorded
      // acknowledgement, never a retroactive acceptance."
      //
      // The integrity path is where that is easiest to get wrong, because the
      // condition genuinely HEALS: an operator restores the receipt from a
      // backup and the order would now bind perfectly. A node that re-evaluated
      // would hand the buyer an acceptance for a proposal it has already told
      // them was refused — and the buyer has moved on, possibly by ordering
      // elsewhere. Two tests above prove the refusal; this one proves it stays
      // refused, which is the half the previous version left as a comment.
      const quote = seedQuote();
      const order = makeOrder(quote, pricedProjection);
      const good = h.receipts.get(quote.request_digest);
      if (good === null) throw new Error('the fixture did not retain the request');

      h.tamperReceiptBody(quote.request_digest, 'not json at all');
      const first = engine.admitOrder(order, BUYER_DID);
      expect(first.kind).toBe('rejected');

      // The store is repaired, byte for byte.
      h.tamperReceiptBody(quote.request_digest, good.recordJson);

      const replay = engine.admitOrder(order, BUYER_DID);
      expect(replay.kind).toBe('replay');
      if (replay.kind !== 'replay') throw new Error('expected the recorded answer');
      expect(replay.acknowledgement.kind).toBe('rejected');
      expect(replay.acknowledgement.order_digest).toBe(order.order_digest);
      // And it is a REAL acknowledgement, not a shape: the same validator the
      // wire uses accepts it, because this is what the buyer receives.
      expect(validateOrderAcknowledgement(replay.acknowledgement, hash)).toBeNull();
    });

    it('refunds the hold when it freezes, so the quote is usable again', () => {
      // The refusal is durable; the CAPACITY is not consumed by it. §9.9:
      // "every rejected outcome REFUNDS it". A buyer whose order died on a
      // local corruption must be able to submit a fresh one against the same
      // quote, or the supplier's own disk fault silently spends the offer.
      const quote = seedQuote();
      const good = h.receipts.get(quote.request_digest);
      if (good === null) throw new Error('the fixture did not retain the request');
      const first = makeOrder(quote, pricedProjection);

      h.tamperReceiptBody(quote.request_digest, 'not json at all');
      expect(engine.admitOrder(first, BUYER_DID).kind).toBe('rejected');
      h.tamperReceiptBody(quote.request_digest, good.recordJson);

      // A DIFFERENT order against the SAME quote. If the frozen rejection had
      // spent the family's single use, this would die `quote_consumed` and the
      // supplier's own disk fault would have cost them the sale.
      const second = makeOrder(quote, pricedProjection, {
        purchase_order_id: 'po-after-repair',
        idempotency_key: 'idem-after-repair',
      });
      expect(engine.admitOrder(second, BUYER_DID).kind).toBe('reserved');
    });

    it('does not THROW on a corrupt retained request', () => {
      // It used to: `JSON.parse` inside `admitInTx`, inside a transaction, on
      // the inbound path, where everything else returns a typed refusal.
      const quote = seedQuote();
      const order = makeOrder(quote, pricedProjection);
      h.tamperReceiptBody(quote.request_digest, 'not json at all');

      // ONE call: a second would be a replay of the first refusal, which is
      // correct behaviour and would assert nothing about the throw.
      let outcome: ReturnType<typeof engine.admitOrder> | undefined;
      expect(() => {
        outcome = engine.admitOrder(order, BUYER_DID);
      }).not.toThrow();
      expect(outcome?.kind).toBe('rejected');
    });
  });

  /**
   * WS-2.2 — the stored acknowledgement is the supplier's COMMITMENT, and a
   * replayed submission receives it verbatim. Two failures were reachable
   * through the cast this replaces: a corrupt column threw out of admission,
   * and `JSON.parse('null') as OrderAcknowledgement` produced a null typed as
   * a commitment, which would reach a buyer as "here is what we agreed".
   */
  describe('a stored acknowledgement that cannot be read is not an answer', () => {
    function decideThenCorrupt(corrupt: string): ReturnType<typeof engine.admitOrder> {
      const quote = seedQuote();
      const order = makeOrder(quote, pricedProjection);
      engine.admitOrder(order, BUYER_DID);
      engine.decideOrder(BUYER_DID, order.purchase_order_id, {
        kind: 'accepted',
        supplierOrderId: 'so-1',
      });
      h.tamperAcknowledgement(order.purchase_order_id, corrupt);
      // The replay path reads it back.
      return engine.admitOrder(order, BUYER_DID);
    }

    it('refuses rather than replaying an unreadable acknowledgement', () => {
      const outcome = decideThenCorrupt('not json');
      expect(outcome.kind).toBe('conflict');
      if (outcome.kind !== 'conflict') throw new Error('expected a conflict');
      expect(outcome.error).toContain('store integrity');
    });

    it('calls an EMPTY column absent, not unparseable', () => {
      // Behaviourally the same refusal — `JSON.parse('')` throws either way —
      // so this pins the MESSAGE, which is the only thing the branch adds.
      // An operator reading "is not JSON" about an empty column goes looking
      // for corruption; "is absent" says the write never happened.
      const outcome = decideThenCorrupt('');
      expect(outcome.kind).toBe('conflict');
      if (outcome.kind !== 'conflict') throw new Error('expected a conflict');
      expect(outcome.error).toContain('absent');
    });

    it('refuses a stored NULL rather than handing a buyer a null commitment', () => {
      // `JSON.parse('null')` succeeds. Only validation catches this one, and
      // it is the shape a missing column produced.
      expect(decideThenCorrupt('null').kind).toBe('conflict');
    });

    it('refuses an acknowledgement whose digest no longer matches its content', () => {
      const quote = seedQuote();
      const order = makeOrder(quote, pricedProjection);
      engine.admitOrder(order, BUYER_DID);
      const decided = engine.decideOrder(BUYER_DID, order.purchase_order_id, {
        kind: 'accepted',
        supplierOrderId: 'so-1',
      });
      if (!('acknowledgement' in decided)) throw new Error('expected an acknowledgement');
      // Edit the body, leave the digest. A shape check passes; re-deriving
      // the digest does not.
      const tampered = { ...decided.acknowledgement, supplier_order_id: 'so-SOMEONE-ELSE' };
      h.tamperAcknowledgement(order.purchase_order_id, JSON.stringify(tampered));
      expect(engine.admitOrder(order, BUYER_DID).kind).toBe('conflict');
    });
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
    if (swapOutcome.kind === 'conflict')
      expect(swapOutcome.error).toMatch(/DIFFERENT order_digest/);

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

  /**
   * WS-2.2 — a timed-out reservation is resolved from the ORDER REFERENCE.
   *
   * The sweeper used to load and re-validate the order proposal first and
   * `continue` if either step failed. That looked like prudence and was a
   * leak with no floor: the row stays in the expired set for ever, so it is
   * reconsidered and skipped on every future sweep, the quote capacity it
   * holds never comes back, and the buyer's `order_reconcile` answers
   * `received_processing` indefinitely. Silently — the sweep reported only
   * its successes, so an operator saw "0 timed out" either way.
   *
   * A `rejected(decision_timeout)` needs none of the proposal. Its three
   * fields are on the reference, the order digest got there from admission,
   * and the outcome commits to nothing.
   */
  it('times out an expired reservation even when its order receipt is gone', () => {
    const quote = seedQuote();
    const order = makeOrder(quote, pricedProjection);
    expect(engine.admitOrder(order, BUYER_DID).kind).toBe('reserved');

    // The receipt store came back from a restore without this record, or it
    // was corrupted in place. Both reduce to "the proposal is unreadable".
    h.receipts.put({
      recordDigest: order.order_digest,
      domain: 'order',
      buyerDid: BUYER_DID,
      quoteId: quote.quote_id,
      purchaseOrderId: order.purchase_order_id,
      recordJson: '{ truncated',
      evidenceJson: '{}',
      createdAt: clock.now,
    });

    clock.now = T_ADMIT + DECISION_TIMEOUT_MS + 1;
    const sweep = engine.recoverAdmissions();
    expect(sweep.timedOut).toEqual([order.purchase_order_id]);
    expect(sweep.stuck).toEqual([]);
    // The capacity came back — the observable half of the leak.
    expect(h.quotes.getUse(quote.quote_id, order.purchase_order_id)).toBe('refunded');
    // And the buyer gets a real answer instead of `received_processing` for
    // ever. The acknowledgement is still bound to the right order, because
    // the digest on the reference came from admission.
    const replay = engine.admitOrder(order, BUYER_DID);
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') {
      expect(replay.acknowledgement.kind).toBe('rejected');
      expect(replay.acknowledgement.order_digest).toBe(order.order_digest);
      if (replay.acknowledgement.kind === 'rejected') {
        expect(replay.acknowledgement.reason_code).toBe('decision_timeout');
      }
    }
  });

  it('a second sweep finds nothing left to do', () => {
    // The leak's signature was a row that came back every sweep for ever.
    const quote = seedQuote();
    const order = makeOrder(quote, pricedProjection);
    expect(engine.admitOrder(order, BUYER_DID).kind).toBe('reserved');
    clock.now = T_ADMIT + DECISION_TIMEOUT_MS + 1;
    expect(engine.recoverAdmissions().timedOut).toEqual([order.purchase_order_id]);
    expect(engine.recoverAdmissions()).toEqual({ timedOut: [], stuck: [] });
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
    const sweep = engine.recoverAdmissions();
    expect(sweep.timedOut).toEqual(['po-1']);
    // Nothing unresolvable. A sweep that answers "0 timed out" must not read
    // the same as one where every expired row is stuck, so the two are
    // separate fields and both are asserted.
    expect(sweep.stuck).toEqual([]);

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
    expect(
      h.quotes.settleUse(quote.quote_id, order.purchase_order_id, 'committed', clock.now),
    ).toBe(true);

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
      const withSeam = makeAdmission({
        tx: h.tx,
        orders: makeOrders(h.orderRefs, clock),
        families: makeFamilies(h.quotes, clock),
        receipts: h.receipts,
        supplierDid: () => SUPPLIER_DID,
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
      const withSeam = makeAdmission({
        tx: h.tx,
        orders: makeOrders(h.orderRefs, clock),
        families: makeFamilies(h.quotes, clock),
        receipts: h.receipts,
        supplierDid: () => SUPPLIER_DID,
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
      const withBadSeam = makeAdmission({
        tx: h.tx,
        orders: makeOrders(h.orderRefs, clock),
        families: makeFamilies(h.quotes, clock),
        receipts: h.receipts,
        supplierDid: () => SUPPLIER_DID,
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
      const restored = makeAdmission({
        tx: h.tx,
        orders: makeOrders(h.orderRefs, clock),
        families: makeFamilies(h.quotes, clock, () => '2'),
        receipts: h.receipts,
        supplierDid: () => SUPPLIER_DID,
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
    const engine = makeAdmission({
      tx: strictTx,
      orders: makeOrders(new InMemoryCommerceOrderRefRepository(), clock),
      families: makeFamilies(quotes, clock),
      receipts,
      supplierDid: () => SUPPLIER_DID,
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
