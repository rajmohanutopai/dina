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
import { tier0TxRunner } from '../../src/run/tx';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import {
  BUYER_DID,
  SUPPLIER_DID,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
} from './helpers';

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
    expect(runtime.admission.recoverAdmissions()).toEqual([]);

    clock.now = T_ADMIT + DEFAULT_DECISION_TIMEOUT_MS + 1;
    expect(runtime.admission.recoverAdmissions()).toEqual([order.purchase_order_id]);

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
