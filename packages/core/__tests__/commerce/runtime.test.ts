/**
 * The commerce composition root (WS-3.6).
 *
 * Every other commerce test builds its engines by hand. That is fine for
 * testing an engine and useless for testing the WIRING, and the wiring was
 * where commerce was broken: the engines existed, were covered by hundreds of
 * assertions, and were constructed by nothing outside a test file. Both boots
 * installed the stores and stopped there, so no production path could admit an
 * order or sign a status.
 *
 * These tests drive the object a boot actually receives, over a real SQLCipher
 * file, and assert the three things hand-built engines cannot tell us:
 *
 *   1. acceptance opens the status chain in the SAME transaction (§12.8) —
 *      which is true only because the root ties the two engines together;
 *   2. commerce refuses, with a reason, when identity or the epoch is missing
 *      (§16.2 fail-closed) rather than half-acting;
 *   3. the Tier-0 transaction runner is shared, not one per subsystem.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  DEFAULT_DECISION_TIMEOUT_MS,
  createCommerceRuntime,
  getCommerceRuntime,
  installCommerceRuntime,
  commerceAvailability,
  type CommerceRuntime,
} from '../../src/commerce/runtime';
import { uninstall } from '../../src/plugins/install_service';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
} from '../../src/plugins/registry';
import { tier0TxRunner } from '../../src/run/tx';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import { BUYER_DID, SUPPLIER_DID, makeOrder, makeQuoteRequest, makeSignedQuote } from './helpers';

import type { DatabaseAdapter } from '../../src/storage/db_adapter';

const T_ADMIT = Date.parse('2026-08-07T12:30:00.000Z');

interface Fixture {
  adapter: DatabaseAdapter;
  cleanup: () => void;
}

function openDb(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-commerce-runtime-'));
  const adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  return {
    adapter,
    cleanup: () => {
      adapter.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('commerce composition root', () => {
  let fixture: Fixture;
  let clock: { now: number };
  const request = makeQuoteRequest();

  beforeEach(() => {
    fixture = openDb();
    clock = { now: T_ADMIT };
  });

  afterEach(() => {
    installCommerceRuntime(null);
    fixture.cleanup();
  });

  function build(overrides: Partial<Parameters<typeof createCommerceRuntime>[0]> = {}) {
    return createCommerceRuntime({
      adapter: fixture.adapter,
      supplierDid: () => SUPPLIER_DID,
      currentEpoch: () => '1',
      now: () => clock.now,
      ...overrides,
    });
  }

  /** Register the quote family and retain the request the supplier priced. */
  function seedQuote(runtime: CommerceRuntime) {
    const quote = makeSignedQuote(request);
    runtime.receipts.put({
      recordDigest: request.request_digest,
      domain: 'request',
      buyerDid: request.buyer_did,
      quoteId: quote.quote_id,
      purchaseOrderId: '',
      recordJson: JSON.stringify(request),
      evidenceJson: '{}',
      createdAt: clock.now,
    });
    expect(runtime.admission.registerSignedQuote(quote)).toBeNull();
    return quote;
  }

  it('builds engines a boot can use — accepting an order opens its chain (§12.8)', () => {
    const runtime = build();
    const quote = seedQuote(runtime);
    const order = makeOrder(quote, request.delivery.projection);

    expect(runtime.admission.admitOrder(order, BUYER_DID)).toEqual({ kind: 'reserved' });

    const decided = runtime.admission.decideOrder(BUYER_DID, order.purchase_order_id, {
      kind: 'accepted',
      supplierOrderId: 'so-1',
    });
    expect('acknowledgement' in decided && decided.acknowledgement.kind).toBe('accepted');

    // The point of the test. `createAcceptedGenesisInTx` is wired ONLY by the
    // composition root; without it acceptance commits and the genesis is a
    // separate later transaction, so a cancellation landing in between gets
    // an answer that depends on timing rather than on the order. A chain that
    // already exists the instant the decision returns is the observable proof
    // that the root tied the two engines together.
    const chain = runtime.chains.load(BUYER_DID, order.purchase_order_id);
    expect(chain.head).not.toBeNull();
    expect(chain.head?.state).toBe('accepted');
  });

  it('a second genesis is refused — the chain is opened exactly once', () => {
    const runtime = build();
    const quote = seedQuote(runtime);
    const order = makeOrder(quote, request.delivery.projection);
    runtime.admission.admitOrder(order, BUYER_DID);
    runtime.admission.decideOrder(BUYER_DID, order.purchase_order_id, {
      kind: 'accepted',
      supplierOrderId: 'so-1',
    });

    const again = runtime.lifecycle.signGenesis(BUYER_DID, order.purchase_order_id);
    expect('error' in again).toBe(true);
  });

  it('reports WHY commerce cannot act, instead of only throwing (§16.2)', () => {
    const noIdentity = build({
      supplierDid: () => {
        throw new Error('business identity not established');
      },
    });
    expect(noIdentity.availability()).toEqual({
      available: false,
      reason: 'no_identity',
      detail: 'business identity not established',
    });

    const noEpoch = build({
      currentEpoch: () => {
        throw new Error('commerce epoch: not established');
      },
    });
    expect(noEpoch.availability()).toEqual({
      available: false,
      reason: 'no_epoch',
      detail: 'commerce epoch: not established',
    });

    expect(build().availability()).toEqual({ available: true });
  });

  it('identity is read per use, not captured at construction', () => {
    // The order matters: engines are composed at storage-init time, BEFORE
    // identity exists. An engine holding a captured DID would either be
    // unbuildable at boot or sign under an empty one. Building while identity
    // is absent and succeeding after it arrives is what proves the read is
    // deferred.
    let did: string | null = null;
    const runtime = build({
      supplierDid: () => {
        if (did === null) throw new Error('business identity not established');
        return did;
      },
    });
    expect(runtime.availability().available).toBe(false);

    did = SUPPLIER_DID;
    expect(runtime.availability()).toEqual({ available: true });

    const quote = seedQuote(runtime);
    const order = makeOrder(quote, request.delivery.projection);
    expect(runtime.admission.admitOrder(order, BUYER_DID)).toEqual({ kind: 'reserved' });
  });

  it('an uninstalled runtime answers not_installed rather than throwing', () => {
    installCommerceRuntime(null);
    expect(getCommerceRuntime()).toBeNull();
    expect(commerceAvailability()).toEqual({
      available: false,
      reason: 'not_installed',
      detail: 'commerce storage is not initialised on this node',
    });

    installCommerceRuntime(build());
    expect(commerceAvailability()).toEqual({ available: true });
  });

  it('shares ONE Tier-0 transaction runner per database', () => {
    // Commerce is composed at storage-init time and the run plane much later,
    // both over identity.sqlite. Two runners means two depth counters, and a
    // commerce write nested inside an owner command would issue a second
    // BEGIN — which op-sqlite rejects, rolling the command back. Deriving the
    // runner from the db makes the shared instance a fact rather than a rule
    // each boot has to remember.
    expect(tier0TxRunner(fixture.adapter)).toBe(tier0TxRunner(fixture.adapter));

    const other = openDb();
    try {
      expect(tier0TxRunner(other.adapter)).not.toBe(tier0TxRunner(fixture.adapter));
    } finally {
      other.cleanup();
    }
  });

  it('re-entrant: a nested commerce write joins the outer transaction', () => {
    const tx = tier0TxRunner(fixture.adapter);
    const runtime = build();
    const quote = seedQuote(runtime);
    const order = makeOrder(quote, request.delivery.projection);

    // Admission opens its own transaction internally. Wrapping the call in the
    // shared runner is exactly the owner-command shape; a second BEGIN here is
    // the crash this guards.
    expect(() => {
      tx(() => {
        runtime.admission.admitOrder(order, BUYER_DID);
      });
    }).not.toThrow();
    expect(runtime.orders.load(BUYER_DID, order.purchase_order_id)).not.toBeNull();
  });

  it('applies a bounded decision deadline by default (§9.9 step 3)', () => {
    // A boot supplies no timeout, so the default is the one that ships. If it
    // were absent or zero, a pre_effect reservation would either never time
    // out — holding the buyer and the capacity indefinitely — or time out at
    // once. The sweeper's behaviour either side of the deadline is the only
    // way to observe which value is really in force.
    const runtime = build();
    const quote = seedQuote(runtime);
    const order = makeOrder(quote, request.delivery.projection);
    expect(runtime.admission.admitOrder(order, BUYER_DID)).toEqual({ kind: 'reserved' });

    clock.now = T_ADMIT + DEFAULT_DECISION_TIMEOUT_MS - 1;
    expect(runtime.admission.recoverAdmissions()).toEqual({ timedOut: [], stuck: [] });

    clock.now = T_ADMIT + DEFAULT_DECISION_TIMEOUT_MS + 1;
    expect(runtime.admission.recoverAdmissions()).toEqual({
      timedOut: [order.purchase_order_id],
      stuck: [],
    });

    // The timeout refunds the hold, so the capacity comes back. The quote
    // allows a single use, so a second order admitting is the observable
    // proof — and it reads only the public surface, unlike peeking at a
    // counter the aggregate deliberately does not expose.
    const next = makeOrder(quote, request.delivery.projection, {
      purchase_order_id: 'po-2',
      idempotency_key: 'idem-po-2',
    });
    expect(runtime.admission.admitOrder(next, BUYER_DID)).toEqual({ kind: 'reserved' });
  });
});

/**
 * §16.4 (WS-4.5) — an uninstall must not strand open obligations.
 *
 * "Business records survive" is not satisfied by rows remaining in a table.
 * Every commerce lifecycle capability reaches its answer through the backing
 * install's binding, so removing the install while orders are open leaves the
 * records intact and unreachable — the buyer can never learn the outcome of
 * an order the supplier committed to.
 */
describe('commerce obligations gate the plugin uninstall (§16.4)', () => {
  let fixture: Fixture;
  let clock: { now: number };
  const request = makeQuoteRequest();

  beforeEach(() => {
    fixture = openDb();
    clock = { now: T_ADMIT };
  });
  afterEach(() => {
    installCommerceRuntime(null);
    fixture.cleanup();
  });

  function build() {
    return createCommerceRuntime({
      adapter: fixture.adapter,
      supplierDid: () => SUPPLIER_DID,
      currentEpoch: () => '1',
      now: () => clock.now,
    });
  }

  function seedQuote(runtime: CommerceRuntime) {
    const quote = makeSignedQuote(request);
    runtime.receipts.put({
      recordDigest: request.request_digest,
      domain: 'request',
      buyerDid: request.buyer_did,
      quoteId: quote.quote_id,
      purchaseOrderId: '',
      recordJson: JSON.stringify(request),
      evidenceJson: '{}',
      createdAt: clock.now,
    });
    runtime.admission.registerSignedQuote(quote);
    return quote;
  }

  it('a node with no commerce activity owes nothing', () => {
    expect(build().inFlightCount()).toBe(0);
  });

  it('an UNDECIDED order is an open obligation', () => {
    // The supplier has been asked and has not answered. Removing the plugin
    // now means the answer never comes.
    const runtime = build();
    const quote = seedQuote(runtime);
    const order = makeOrder(quote, request.delivery.projection);
    runtime.admission.admitOrder(order, BUYER_DID);

    expect(runtime.inFlightCount()).toBe(1);
  });

  it('an accepted order stays open until its chain reaches a terminal state', () => {
    const runtime = build();
    const quote = seedQuote(runtime);
    const order = makeOrder(quote, request.delivery.projection);
    runtime.admission.admitOrder(order, BUYER_DID);
    runtime.admission.decideOrder(BUYER_DID, order.purchase_order_id, {
      kind: 'accepted',
      supplierOrderId: 'so-1',
    });
    // Decided, so no longer an undecided order — but the chain is `accepted`,
    // which is the middle of the obligation, not the end of it.
    expect(runtime.inFlightCount()).toBe(1);

    runtime.lifecycle.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
      state: 'cancelled',
    });
    expect(runtime.inFlightCount()).toBe(0);
  });

  /**
   * `delivered` is deliberately non-terminal — a buyer inside the dispute
   * window can still dispute, and those are the orders an uninstall would
   * damage most. But "inside the window" is a question about the CLOCK, and
   * the count was asked without one: `countNonTerminal` filters by STATE
   * alone, so a delivered order stayed open forever and a supplier who
   * completed every sale normally could never uninstall the serving pack
   * (§12.8, §16.4).
   *
   * Three points, because a boundary with one sample is an assumption: before
   * the deadline, exactly AT it, and after. The comparison is `> nowMs`, so AT
   * the deadline the window is already over — the rule
   * `countUnfinishedByServingManifest` already used, and the one uninstall
   * simply was not calling.
   */
  it('stops counting a delivered order once its dispute window has passed', () => {
    const runtime = build();
    const quote = seedQuote(runtime);
    const order = makeOrder(quote, request.delivery.projection);
    runtime.admission.admitOrder(order, BUYER_DID);
    runtime.admission.decideOrder(BUYER_DID, order.purchase_order_id, {
      kind: 'accepted',
      supplierOrderId: 'so-1',
    });

    const deadline = clock.now + 60_000;
    const lines = [{ lineId: 'l1', fulfilledQuantity: { value: '100', unitCode: 'each' } }];
    const dispatched = runtime.lifecycle.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
      state: 'dispatched',
      lines,
    });
    // §9.11 makes this a discriminated union: `lines` is REQUIRED for
    // `dispatched` and FORBIDDEN for `delivered`.
    const delivered = runtime.lifecycle.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
      state: 'delivered',
      disputeWindowEndsAt: new Date(deadline).toISOString(),
    });
    // Assert the SETUP, so a refused signature cannot masquerade as an order
    // that is still open for the reason under test. `signStatusUpdate` returns
    // the signed status or `{error}`.
    expect('error' in dispatched ? dispatched.error : null).toBeNull();
    expect('error' in delivered ? delivered.error : null).toBeNull();

    // Inside the window: still an obligation.
    expect(runtime.inFlightCount()).toBe(1);

    // One millisecond before: still open.
    clock.now = deadline - 1;
    expect(runtime.inFlightCount()).toBe(1);

    // EXACTLY at the deadline: over. `> nowMs`, matching
    // `countUnfinishedByServingManifest` — which is the rule this count should
    // have been using all along — and matching the catalog's freshness
    // boundary, where a row read exactly at its `valid_until` is already
    // stale. I first asserted the opposite here; the codebase was consistent
    // and the guess was mine.
    clock.now = deadline;
    expect(runtime.inFlightCount()).toBe(0);

    // And after.
    clock.now = deadline + 1;
    expect(runtime.inFlightCount()).toBe(0);
  });

  it('refuses to sign delivered without a dispute deadline at all', () => {
    // WRITTEN AS "a delivered head with no deadline stays open forever", which
    // turned out to be untestable through this path: §9.11 makes
    // `dispute_window_ends_at` REQUIRED for `delivered`, so the signer refuses
    // before such a head can exist. That is a stronger guarantee than the one
    // I set out to assert, and worth pinning in its own right — the clock-aware
    // count can only ever meet a delivered head that HAS a deadline.
    //
    // The `disputeWindowEndsAt === null` branch in `inFlightCount` therefore
    // guards a head that arrives some other way (a §16.2 restore fence), and
    // stays: unknown counts as open.
    const runtime = build();
    const quote = seedQuote(runtime);
    const order = makeOrder(quote, request.delivery.projection);
    runtime.admission.admitOrder(order, BUYER_DID);
    runtime.admission.decideOrder(BUYER_DID, order.purchase_order_id, {
      kind: 'accepted',
      supplierOrderId: 'so-1',
    });
    runtime.lifecycle.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
      state: 'dispatched',
      lines: [{ lineId: 'l1', fulfilledQuantity: { value: '100', unitCode: 'each' } }],
    });

    const delivered = runtime.lifecycle.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
      state: 'delivered',
    });
    expect('error' in delivered).toBe(true);
    expect('error' in delivered ? delivered.error : '').toMatch(/dispute_window_ends_at/);
  });

  /**
   * §12.8: EVERY resolving event opens a status chain. `decideOrder` did that
   * for a runner's accept AND its reject; the two paths that resolve an order
   * WITHOUT asking a runner did not.
   *
   * An immediate refusal — `quote_unknown` here — is a decision. A refused
   * order with an acknowledgement and no chain gives the buyer nothing to
   * verify, and leaves a row the open-order query counts as unfinished
   * forever, which retains lifecycle authority and blocks plugin uninstall.
   */
  it('opens a rejected chain when admission refuses the order outright (§12.8)', () => {
    const runtime = build();
    // No `registerSignedQuote`, so the family is unknown and admission
    // refuses before any runner is consulted.
    const quote = makeSignedQuote(request);
    const order = makeOrder(quote, request.delivery.projection);

    const outcome = runtime.admission.admitOrder(order, BUYER_DID);
    expect(outcome.kind).toBe('rejected');

    const chain = runtime.chains.load(BUYER_DID, order.purchase_order_id);
    // A refused order must still have a chain.
    expect(chain.head).not.toBeNull();
    expect(chain.head?.state).toBe('rejected');
    // And it is finished, so it does not hold the install open.
    expect(runtime.inFlightCount()).toBe(0);
  });

  it('opens a rejected chain when the decision times out (§12.8)', () => {
    // The recovery sweep resolves an order the supplier never answered. It
    // settled the hold and wrote the acknowledgement, and left no chain.
    const runtime = build();
    const quote = seedQuote(runtime);
    const order = makeOrder(quote, request.delivery.projection);
    expect(runtime.admission.admitOrder(order, BUYER_DID)).toEqual({ kind: 'reserved' });

    clock.now += DEFAULT_DECISION_TIMEOUT_MS + 1;
    const swept = runtime.admission.recoverAdmissions();
    expect(swept.timedOut).toContain(order.purchase_order_id);

    const chain = runtime.chains.load(BUYER_DID, order.purchase_order_id);
    // A timed-out order must still have a chain.
    expect(chain.head).not.toBeNull();
    expect(chain.head?.state).toBe('rejected');
    expect(runtime.inFlightCount()).toBe(0);
  });

  it('counts obligations PER INSTALL, so one pack does not block another', () => {
    // The whole point of WS-4.5. The count was node-wide, because an order
    // recorded the serving manifest CID and not the install — so on a node
    // running two commerce plugins, removing one made an operator resolve the
    // OTHER's orders first. Safe, and wrong.
    const runtime = build();
    const quote = seedQuote(runtime);
    const order = makeOrder(quote, request.delivery.projection);
    runtime.admission.admitOrder(order, BUYER_DID, { servingInstallId: 'pli_supplier' });

    expect(runtime.inFlightCount('pli_supplier')).toBe(1);
    expect(runtime.inFlightCount('pli_somebody_else')).toBe(0);
    // Unscoped is unchanged: a caller that asks about the whole node still
    // gets the whole node.
    expect(runtime.inFlightCount()).toBe(1);
  });

  it('an order attributed to NO install blocks nobody', () => {
    // Orders admitted before the column existed carry ''. Counting them
    // against every install would make every teardown refuse for ever with
    // nothing an operator could do about it, so they belong to no install —
    // and the unscoped count still sees them.
    const runtime = build();
    const quote = seedQuote(runtime);
    const order = makeOrder(quote, request.delivery.projection);
    runtime.admission.admitOrder(order, BUYER_DID);

    expect(runtime.inFlightCount('pli_supplier')).toBe(0);
    expect(runtime.inFlightCount()).toBe(1);
  });

  it('UNINSTALL is refused while an obligation is open, and allowed once it closes', async () => {
    // The guard the count exists for. Without it the plugin is removed, the
    // records stay in their tables, and every order_status / cancel_order /
    // order_reconcile the buyer sends answers `install_unavailable` for ever.
    const runtime = build();
    installCommerceRuntime(runtime);
    const quote = seedQuote(runtime);
    const order = makeOrder(quote, request.delivery.projection);

    const installs = new SQLitePluginInstallRepository(fixture.adapter);
    setPluginInstallRepository(installs);
    try {
      const installId = installs.createPending({
        publisherDid: 'did:plc:acme',
        pluginId: 'com.acme.commerce.supplier',
        label: '',
        executionMode: 'runner',
        currentCid: 'bafyreicid1',
        currentVersion: '0.1.0',
        manifest: {
          $type: 'com.dinakernel.plugin.release',
          plugin_id: 'com.acme.commerce.supplier',
          version: '0.1.0',
          display_name: 'Supplier',
          execution: { mode: 'runner' },
          capabilities: [
            {
              id: 'com.acme.commerce.request_quote',
              display_name: 'Request quote',
              interaction: 'query',
              action_class: 'quote',
              privacy_class: 'personal',
              kinds: ['provider'],
              result_schema: { type: 'object' },
            },
          ],
        } as never,
        installScopeHash: 's'.repeat(64),
        capabilityHashes: { 'com.acme.commerce.request_quote': 'h'.repeat(64) },
        behaviorHash: 'b'.repeat(64),
        presentationHash: 'p'.repeat(64),
        trustAnchor: { kind: 'repo_proof' },
        pendingExpiresAtSec: Math.floor(clock.now / 1000) + 900,
        nowMs: clock.now,
      });
      installs.activate(installId, 'did:plc:plugindevice', clock.now);
      // Admitted UNDER this install (WS-4.5), which is what makes the refusal
      // its business: the count is scoped, so an order the install never
      // served would not block its teardown.
      runtime.admission.admitOrder(order, BUYER_DID, { servingInstallId: installId });

      await expect(uninstall(installId, clock.now)).rejects.toThrow(
        /commerce order\(s\) are still open/,
      );
      // Still installed: the refusal did not half-tear-down.
      expect(installs.getById(installId)?.status).toBe('active');

      // Resolve the obligation and the teardown proceeds.
      runtime.admission.decideOrder(BUYER_DID, order.purchase_order_id, {
        kind: 'rejected',
        reasonCode: 'out_of_stock',
      });
      expect(runtime.inFlightCount()).toBe(0);
      // With a device-revoke callback the teardown runs to completion and
      // the row is removed; without one it stops at paused and hands the
      // device DID back to the caller.
      await uninstall(installId, clock.now, async () => ({ durable: true }));
      expect(installs.getById(installId)).toBeNull();
    } finally {
      setPluginInstallRepository(null);
    }
  });

  it('a REJECTED order closes immediately', () => {
    const runtime = build();
    const quote = seedQuote(runtime);
    const order = makeOrder(quote, request.delivery.projection);
    runtime.admission.admitOrder(order, BUYER_DID);
    runtime.admission.decideOrder(BUYER_DID, order.purchase_order_id, {
      kind: 'rejected',
      reasonCode: 'out_of_stock',
    });
    expect(runtime.inFlightCount()).toBe(0);
  });
});
