/**
 * THE DISASTER JOURNEY: ChairMaker loses a disk mid-order (§16.2, §12.7, §25.3).
 *
 * WHY THIS EXISTS ON TOP OF THE OTHER SCENARIOS. The happy path is covered
 * three times over — engines directly, the plugin lane, and the buyer's whole
 * discovery-to-delivery sequence. None of them survives a restore, and the
 * restore path is where the last several items were built: the epoch watermark
 * (WS-2.9), the Core-answered reconcile lane (WS-4.6), the reconciliation
 * census (WS-4.3), receipt arrival evidence (WS-2.8), and the archive
 * preflight (WS-4.2).
 *
 * Every one of those was built alone, gated alone, and — in four cases out of
 * five — turned out on inspection to be reachable only from its own test. That
 * is this codebase's signature defect, and one sequence over one set of facts
 * is the only thing that finds it.
 *
 * THE STORY. Sancho orders chairs. ChairMaker accepts, the chain opens, and
 * then ChairMaker's node is restored from a backup taken BEFORE the order
 * arrived. Sancho is now holding a signed acceptance for an order the supplier
 * has no record of, and a status record signed in the abandoned generation is
 * still in flight somewhere. What has to happen next is the whole point.
 *
 * WHAT IT DOES NOT CLAIM. No sockets, no relay, no second process. The §25.6
 * manual journey is two live nodes and stays manual.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { createCommerceRuntime, installCommerceRuntime } from '../../src/commerce';
import { preflightCommerceArchive } from '../../src/commerce/archive_preflight';
import { readEvidence } from '../../src/commerce/receipt_evidence';
import { buildReconciliationCensus } from '../../src/commerce/reconciliation_census';
import { admitSupplierRecords } from '../../src/commerce/watermark_gate';
import { InMemoryCommerceEpochWatermarkRepository } from '../../src/commerce/watermarks';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import {
  BUYER_DID,
  SUPPLIER_DID,
  makeHeldEvidence,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
} from './helpers';

import type { CommerceRuntime } from '../../src/commerce/runtime';
import type { CommerceEpochWatermarkRepository } from '../../src/commerce/watermarks';
import type { OrderAcknowledgement } from '@dina/commerce-protocol';

/**
 * Inside the fixture quote's validity window. The helper's `valid_until` is
 * 2026-08-08T09:00:00Z, and a clock ON that instant means the quote has
 * expired — admission answers `quote_unknown` and the whole journey never
 * starts.
 */
const T0 = Date.parse('2026-08-07T12:00:00.000Z');

/**
 * The reconcile request Sancho sends, carrying the evidence he holds.
 *
 * `held_acknowledgement` is what makes `never_received` ILLEGAL (§16.2): the
 * supplier signed this, so it cannot claim the order never arrived and invite
 * a resubmission that would charge Sancho twice. The signature is checked by
 * compiled Core against the supplier's key — this scenario supplies a verifier
 * that accepts, because the subject here is the recovery sequence and not the
 * crypto, which `lifecycle_engine` tests directly.
 */
function reconcileRequest(
  order: { purchase_order_id: string; order_digest: string },
  acknowledgement: OrderAcknowledgement,
): Record<string, unknown> {
  return {
    protocol_version: '1.0',
    purchase_order_id: order.purchase_order_id,
    order_digest: order.order_digest,
    idempotency_key: `rec-${order.purchase_order_id}`,
    held_acknowledgement: makeHeldEvidence(acknowledgement),
  };
}

describe('ChairMaker is restored mid-order, and Sancho gets an honest answer', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  let runtime: CommerceRuntime;
  /** The supplier's generation. A restore increments it (§16.2). */
  let epoch: string;
  let clock: { now: number };

  /** Rebuild the supplier's runtime — what a boot does after a restore. */
  function bootSupplier(
    overrides: { verifyHeldEvidence?: () => boolean } = {},
  ): CommerceRuntime {
    const built = createCommerceRuntime({
      adapter,
      supplierDid: () => SUPPLIER_DID,
      currentEpoch: () => epoch,
      now: () => clock.now,
      // §12.7/§16.2 — re-adoption is FAIL-CLOSED without a verifier: absent
      // means "cannot verify" and the engine refuses rather than trusting a
      // stranger's claim about what this supplier signed. The scenario
      // supplies one, which is what an app does at composition.
      verifyHeldEvidence: overrides.verifyHeldEvidence ?? ((): boolean => true),
    });
    installCommerceRuntime(built);
    return built;
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'commerce-disaster-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    epoch = '1';
    clock = { now: T0 };
    runtime = bootSupplier();
  });

  afterEach(() => {
    installCommerceRuntime(null);
    try {
      adapter.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Sancho places an order ChairMaker accepts, and the chain opens. */
  function placeAndAccept(purchaseOrderId = 'po-chairs-1'): {
    order: ReturnType<typeof makeOrder>;
    /** What Sancho keeps: ChairMaker's own signed answer. */
    acknowledgement: OrderAcknowledgement;
  } {
    const request = makeQuoteRequest();
    // The request receipt first. Admission re-reads the retained REQUEST to
    // check the order's delivery projection against the quote's priced one
    // (§9.9); without it the family cannot verify and answers `quote_unknown`,
    // which reads as "no such quote" and is the wrong story entirely.
    runtime.receipts.put({
      recordDigest: request.request_digest,
      domain: 'request',
      buyerDid: request.buyer_did,
      quoteId: '',
      purchaseOrderId: '',
      recordJson: JSON.stringify(request),
      evidenceJson: '{}',
      createdAt: clock.now,
    });
    const quote = makeSignedQuote(request, { supplier_epoch: epoch });
    expect(runtime.admission.registerSignedQuote(quote)).toBeNull();
    const order = makeOrder(quote, request.delivery.projection, {
      purchase_order_id: purchaseOrderId,
      idempotency_key: `idem-${purchaseOrderId}`,
    });
    expect(runtime.admission.admitOrder(order, BUYER_DID)).toEqual({ kind: 'reserved' });
    const decided = runtime.admission.decideOrder(BUYER_DID, purchaseOrderId, {
      kind: 'accepted',
      supplierOrderId: 'so-1',
    });
    if (!('acknowledgement' in decided)) throw new Error('the supplier did not answer');
    return { order, acknowledgement: decided.acknowledgement };
  }

  it('carries one order through loss and recovery, end to end', () => {
    // ─── 1. Business as usual. Sancho orders; ChairMaker accepts; the chain
    //        opens at the current generation.
    const { order, acknowledgement } = placeAndAccept();
    expect(runtime.chains.load(BUYER_DID, order.purchase_order_id).exists).toBe(true);

    // The receipt says HOW ChairMaker came to hold the proposal: it arrived,
    // from the authenticated sender (WS-2.8). Not "we have the document" —
    // "you sent it to us" is what a dispute rests on.
    const arrival = runtime.receipts.get(order.order_digest);
    expect(readEvidence(arrival?.evidenceJson ?? '').observations).toEqual([
      expect.objectContaining({ kind: 'received', fromDid: BUYER_DID }),
    ]);

    // ─── 2. The disk dies. ChairMaker restores a backup taken BEFORE the
    //        order arrived, so the order reference and its chain are gone.
    //        This is modelled by clearing them, which is exactly what a
    //        pre-order archive restores to.
    adapter.execute('DELETE FROM commerce_order_refs');
    adapter.execute('DELETE FROM commerce_status_heads');

    // §16.2 — the restore fence: a new generation, so nothing this node signs
    // can be confused with what the old one signed.
    epoch = '2';
    runtime = bootSupplier();

    // ─── 3. Sancho asks. He holds a signed acceptance; ChairMaker holds
    //        nothing. This is the case §12.7 exists for, and the answer must
    //        NOT be `never_received` — §16.2 makes that illegal against a
    //        held supplier-signed acknowledgement, because it would authorize
    //        Sancho to resubmit and be charged twice.
    const readopted = runtime.lifecycle.reconcile(
      reconcileRequest(order, acknowledgement),
      BUYER_DID,
    );
    expect('error' in readopted).toBe(false);
    if ('error' in readopted) throw new Error(readopted.error);
    expect(readopted.outcome).not.toBe('never_received');

    // ─── 4. The order is back, and FROZEN. It has no lines, no quote context
    //        and no external state, so ChairMaker must not sign a status for
    //        it until the ceremony runs.
    const frozen = runtime.orders.listAwaitingReconciliation();
    expect(frozen.map((o) => o.purchaseOrderId)).toEqual([order.purchase_order_id]);

    // The owner-facing census says what is stuck and — the part that matters —
    // that this node cannot clear it (WS-4.3).
    const census = buildReconciliationCensus(frozen);
    expect(census.buyerCount).toBe(1);
    expect(census.clearedBy).toBe('buyer_presents_held_order_proposal');

    // ─── 5. Sancho presents the proposal he holds. Its digest must equal the
    //        one on the reference, which came from ChairMaker's OWN signed
    //        acknowledgement — so a different order cannot be substituted.
    expect(runtime.lifecycle.reconcileRestoredOrder(order, BUYER_DID)).toEqual({ ok: true });
    expect(runtime.orders.listAwaitingReconciliation()).toEqual([]);

    // ─── 6. The order can describe itself again, and belongs to THIS
    //        generation rather than the one the restore abandoned.
    const recovered = runtime.orders.load(BUYER_DID, order.purchase_order_id);
    expect(recovered?.ref.admittedEpoch).toBe('2');
    expect(recovered?.ref.reconciliationRequired).toBe(false);
  });

  /**
   * §25.3 delayed-pre-restore-write, from SANCHO's side.
   *
   * A status ChairMaker signed before the restore is still in a relay queue.
   * It is genuinely signed and its digest verifies; nothing on ChairMaker's
   * side can stop it, because ChairMaker is not the one delivering it. Only
   * Sancho, holding the highest epoch he has ever seen, can tell.
   */
  it('refuses a status from the generation ChairMaker abandoned', () => {
    const watermarks: CommerceEpochWatermarkRepository =
      new InMemoryCommerceEpochWatermarkRepository();

    // Sancho has seen generation 2 — he heard about the restore, from the
    // reconcile answer above or from any later record.
    expect(
      admitSupplierRecords({
        watermarks,
        result: { status: { supplier_did: SUPPLIER_DID, supplier_epoch: '2' } },
        nowMs: T0,
      }).accept,
    ).toBe(true);

    // The delayed write finally lands. Generation 1 is over.
    const stale = admitSupplierRecords({
      watermarks,
      result: { status: { supplier_did: SUPPLIER_DID, supplier_epoch: '1', state: 'dispatched' } },
      nowMs: T0 + 1_000,
    });
    expect(stale.accept).toBe(false);

    // And the fence did not move down. One delayed write must not reopen the
    // gate for every other one behind it.
    expect(watermarks.get(SUPPLIER_DID)).toBe('2');
  });

  /**
   * The archive that would have caused a WORSE disaster: one whose orders
   * point at quotes it does not carry. §16.2 refuses it whole rather than
   * importing the coherent part, because a dropped order reference makes this
   * node deny an order Sancho holds signed evidence for (WS-4.2).
   */
  it('refuses to restore an archive that cannot describe its own orders', () => {
    placeAndAccept('po-chairs-2');

    const tables = {
      commerce_receipts: adapter.query('SELECT * FROM commerce_receipts'),
      commerce_order_refs: adapter.query('SELECT * FROM commerce_order_refs'),
      // The quote heads are missing — the shape a torn archive has.
      commerce_quote_heads: [],
      commerce_quote_uses: adapter.query('SELECT * FROM commerce_quote_uses'),
      commerce_status_heads: adapter.query('SELECT * FROM commerce_status_heads'),
      commerce_epoch_watermarks: adapter.query('SELECT * FROM commerce_epoch_watermarks'),
    };

    const verdict = preflightCommerceArchive(tables);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.some((f) => f.refusal === 'dangling_quote_reference')).toBe(true);

    // The SAME archive with its quotes intact passes, so the refusal is about
    // the tear and not about the shape of the fixture.
    expect(
      preflightCommerceArchive({
        ...tables,
        commerce_quote_heads: adapter.query('SELECT * FROM commerce_quote_heads'),
      }).ok,
    ).toBe(true);
  });

  /**
   * The frozen order must not be able to move on its own. Between re-adoption
   * and the ceremony there is a window where a supplier who forgot could sign
   * a status for an order it cannot describe — which is how a chain forks
   * against the genesis the buyer already holds.
   */
  it('will not advance a re-adopted order until the ceremony has run', () => {
    const { order, acknowledgement } = placeAndAccept('po-chairs-3');
    adapter.execute('DELETE FROM commerce_order_refs');
    adapter.execute('DELETE FROM commerce_status_heads');
    epoch = '2';
    runtime = bootSupplier();

    runtime.lifecycle.reconcile(reconcileRequest(order, acknowledgement), BUYER_DID);

    // Frozen: no chain may open.
    const blocked = runtime.lifecycle.signGenesis(BUYER_DID, order.purchase_order_id);
    expect('error' in blocked).toBe(true);

    // The ceremony is the ONLY way through.
    expect(runtime.lifecycle.reconcileRestoredOrder(order, BUYER_DID)).toEqual({ ok: true });
    const opened = runtime.lifecycle.signGenesis(BUYER_DID, order.purchase_order_id);
    expect('error' in opened).toBe(false);
  });

  /**
   * THE ORDER THAT HAD ALREADY MOVED.
   *
   * The case above is an order Sancho never saw progress on: a fresh genesis
   * is the truth, and signing one is right. This is the other case §16.2
   * names — "orders created entirely after the backup come back the same way"
   * — where Sancho holds a chain ChairMaker lost.
   *
   * The ceremony clears `reconciliationRequired` and nothing else, so
   * ChairMaker would sign a SECOND sequence-0 record: a different epoch and a
   * different instant, therefore a different digest, at a sequence Sancho
   * already has. §9.11 obliges Sancho to reject it as a fork, and every later
   * record too — the order is stranded by the ceremony meant to rescue it,
   * and neither side is told why.
   *
   * So the evidence Sancho presents is recorded at re-adoption, and chain
   * CREATION refuses for ever. The way forward is the restore fence, which
   * exists precisely to fast-forward onto evidence a supplier can verify.
   */
  it('never opens a fresh chain for an order whose buyer holds one', () => {
    const { order, acknowledgement } = placeAndAccept('po-chairs-4');
    // What Sancho kept: the genesis ChairMaker signed on acceptance.
    const heldStatus = adapter.query<{ record_json: string }>(
      "SELECT record_json FROM commerce_receipts WHERE domain = 'status' AND purchase_order_id = ?",
      [order.purchase_order_id],
    )[0];
    expect(heldStatus).toBeDefined();

    adapter.execute('DELETE FROM commerce_order_refs');
    adapter.execute('DELETE FROM commerce_status_heads');
    epoch = '2';
    runtime = bootSupplier();

    runtime.lifecycle.reconcile(
      {
        ...reconcileRequest(order, acknowledgement),
        held_status_receipts: [makeHeldEvidence(JSON.parse(heldStatus.record_json))],
      },
      BUYER_DID,
    );

    // The ceremony still runs — the order IS describable again...
    expect(runtime.lifecycle.reconcileRestoredOrder(order, BUYER_DID)).toEqual({ ok: true });
    // ...and a genesis is STILL refused, because Sancho has one already.
    const blocked = runtime.lifecycle.signGenesis(BUYER_DID, order.purchase_order_id);
    expect('error' in blocked).toBe(true);
    if (!('error' in blocked)) throw new Error('expected a refusal');
    // Named, so an operator reads what to do rather than "cannot sign".
    expect(blocked.error).toContain('restore fence');
  });

  /**
   * THE BACKUP TAKEN AFTER A SUCCESSFUL RECOVERY.
   *
   * Every part of this ran green while the archive it produces could not be
   * restored: re-adoption writes `quote_id: ''`, the ceremony clears
   * `reconciliation_required` and does NOT fill the quote in, and the preflight
   * required every order reference to name a quote family the archive carries.
   * So the owner recovered the order, took a backup, and that backup was the
   * broken one — silently, until the day they needed it.
   *
   * Driven through the real engines and the real tables rather than a
   * hand-built fixture, because the defect was in the SEQUENCE, not in any one
   * of them.
   */
  it('produces a restorable archive after a re-adopted order is reconciled', () => {
    const { order, acknowledgement } = placeAndAccept('po-chairs-6');
    adapter.execute('DELETE FROM commerce_order_refs');
    adapter.execute('DELETE FROM commerce_status_heads');
    epoch = '2';
    runtime = bootSupplier();

    runtime.lifecycle.reconcile(reconcileRequest(order, acknowledgement), BUYER_DID);
    expect(runtime.lifecycle.reconcileRestoredOrder(order, BUYER_DID)).toEqual({ ok: true });

    // What `createArchive` would carry.
    const verdict = preflightCommerceArchive({
      commerce_receipts: adapter.query('SELECT * FROM commerce_receipts'),
      commerce_order_refs: adapter.query('SELECT * FROM commerce_order_refs'),
      commerce_quote_heads: adapter.query('SELECT * FROM commerce_quote_heads'),
      commerce_quote_uses: adapter.query('SELECT * FROM commerce_quote_uses'),
      commerce_status_heads: adapter.query('SELECT * FROM commerce_status_heads'),
      commerce_epoch_watermarks: adapter.query('SELECT * FROM commerce_epoch_watermarks'),
    });
    expect(verdict.findings).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('still opens a chain when the presented evidence does NOT verify', () => {
    // The bar is set by OUR OWN signature, not by the buyer's say-so. A
    // receipt this node cannot verify proves no chain exists elsewhere, so it
    // must not freeze an order that is otherwise ready to move.
    const { order, acknowledgement } = placeAndAccept('po-chairs-5');
    const heldStatus = adapter.query<{ record_json: string }>(
      "SELECT record_json FROM commerce_receipts WHERE domain = 'status' AND purchase_order_id = ?",
      [order.purchase_order_id],
    )[0];

    adapter.execute('DELETE FROM commerce_order_refs');
    adapter.execute('DELETE FROM commerce_status_heads');
    epoch = '2';
    runtime = bootSupplier();

    runtime.lifecycle.reconcile(
      {
        ...reconcileRequest(order, acknowledgement),
        // Genuine ENVELOPE, but addressed to somebody else — so the binding
        // check refuses it and this node learns nothing about a chain.
        held_status_receipts: [
          makeHeldEvidence(JSON.parse(heldStatus.record_json), { to: ['did:plc:someoneelse'] }),
        ],
      },
      BUYER_DID,
    );
    expect(runtime.lifecycle.reconcileRestoredOrder(order, BUYER_DID)).toEqual({ ok: true });
    expect('error' in runtime.lifecycle.signGenesis(BUYER_DID, order.purchase_order_id)).toBe(
      false,
    );
  });
});
