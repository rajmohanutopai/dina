/**
 * The buyer order store against a REAL database (§12.7 — WS-7.7).
 *
 * WHY THIS FILE EXISTS. Every other suite reaches the buyer lane through
 * `InMemoryBuyerOrderRepository`, which stores whole objects — so it cannot
 * disagree with itself about columns, and every claim the SQL makes went
 * unchecked. A mutation that swapped two adjacent bind parameters survived the
 * entire suite, which is the same bug class that already bit this workstream
 * once: a new column added to the VALUES list and not to the column list, and
 * a SELECT that never learned the column and stored the literal text
 * "undefined".
 *
 * A round trip through real SQL is the only thing that catches either.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  buildBuyerApprovalPayload,
  type BuyerApprovalContext,
} from '../../src/commerce/approval_payload';
import { submitApprovedOrder } from '../../src/commerce/buyer_executor';
import { SQLiteBuyerOrderRepository } from '../../src/commerce/buyer_orders';
import { newBuyerOrder, type BuyerOrderRecord } from '../../src/commerce/buyer_reconciliation';
import { installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import { BUYER_DID, makeOrder, makeQuoteRequest, makeSignedQuote } from './helpers';

const PASSHEX = randomBytes(32).toString('hex');
const SUPPLIER = 'did:plc:chairmaker99';

/** Every field distinct, so a swap between any two is visible. */
const DESCRIBED = {
  orderDigest: 'a'.repeat(64),
  idempotencyKey: 'idem-distinct-1',
  protocolVersion: '1.0',
  serviceRkey: 'wholesale',
  // Distinct from `orderDigest` on purpose: both are 64-hex and adjacent in
  // the row, which is exactly the pair a swapped bind parameter exchanges.
  quoteDigest: 'c'.repeat(64),
  quoteId: 'q-distinct-1',
  buyerDid: 'did:plc:sancho42',
  supplierDid: SUPPLIER,
};

let dir: string;
let adapter: NodeSQLiteAdapter;
let repo: SQLiteBuyerOrderRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-buyer-orders-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: PASSHEX,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  repo = new SQLiteBuyerOrderRepository(adapter);
});

afterEach(() => {
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function record(id: string, over: Partial<BuyerOrderRecord> = {}): BuyerOrderRecord {
  return { ...newBuyerOrder(id, DESCRIBED), ...over };
}

describe('the round trip through real SQL', () => {
  it('reads back every field it was given, field for field', () => {
    // Written out one assertion per field rather than a deep-equal, because
    // the failure this catches is a SWAP: a deep-equal on a record built from
    // the same helper would pass with two values exchanged if the helper made
    // them look alike. They are all distinct on purpose.
    const written = record('po-1', {
      state: 'outcome_unknown',
      nextPollAtMs: 1_700_000_000_000,
      pollCount: 3,
      resubmissionAuthorized: false,
      protocolFault: 'supplier denied while holding evidence',
    });
    expect(repo.create(SUPPLIER, written)).toBe(true);

    const read = repo.get(SUPPLIER, 'po-1');
    expect(read?.purchaseOrderId).toBe('po-1');
    expect(read?.orderDigest).toBe(DESCRIBED.orderDigest);
    expect(read?.idempotencyKey).toBe(DESCRIBED.idempotencyKey);
    expect(read?.protocolVersion).toBe(DESCRIBED.protocolVersion);
    expect(read?.serviceRkey).toBe(DESCRIBED.serviceRkey);
    expect(read?.state).toBe('outcome_unknown');
    expect(read?.nextPollAtMs).toBe(1_700_000_000_000);
    expect(read?.pollCount).toBe(3);
    expect(read?.resubmissionAuthorized).toBe(false);
    expect(read?.protocolFault).toBe('supplier denied while holding evidence');
  });

  it('never stores the STRING "undefined" for a column the SELECT forgot', () => {
    // The exact defect this workstream shipped once: a column added to the
    // write and missing from the read, so `String(row.missing)` wrote the
    // four-letter word back on the next `put`.
    repo.create(SUPPLIER, record('po-1'));
    const read = repo.get(SUPPLIER, 'po-1');
    if (read === null) throw new Error('the row this test just wrote is not there');
    repo.put(SUPPLIER, { ...read, pollCount: 9 });

    const again = repo.get(SUPPLIER, 'po-1');
    for (const value of [
      again?.orderDigest,
      again?.idempotencyKey,
      again?.protocolVersion,
      again?.serviceRkey,
    ]) {
      expect(value).not.toBe('undefined');
      expect(value).not.toBe('null');
      expect(value).not.toBe('');
    }
  });

  it('survives a restart with the question intact', () => {
    // §12.7's actual requirement. A counter that survives and a digest that
    // does not is durability in name only: the buyer knows it should ask and
    // cannot say what about.
    repo.create(SUPPLIER, record('po-1', { state: 'outcome_unknown', pollCount: 4 }));
    adapter.close();

    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: PASSHEX,
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    const reopened = new SQLiteBuyerOrderRepository(adapter);

    const read = reopened.get(SUPPLIER, 'po-1');
    expect(read?.pollCount).toBe(4);
    expect(read?.orderDigest).toBe(DESCRIBED.orderDigest);
    expect(read?.idempotencyKey).toBe(DESCRIBED.idempotencyKey);
    expect(read?.serviceRkey).toBe(DESCRIBED.serviceRkey);
  });

  it('refuses to overwrite an order already being tracked', () => {
    // §12.7 forbids a second order for one purchase, and the cheapest place to
    // honour it is the INSERT.
    expect(repo.create(SUPPLIER, record('po-1', { pollCount: 1 }))).toBe(true);
    expect(repo.create(SUPPLIER, record('po-1', { pollCount: 99 }))).toBe(false);
    expect(repo.get(SUPPLIER, 'po-1')?.pollCount).toBe(1);
  });

  it('keeps two suppliers apart under the same order id', () => {
    const OTHER = 'did:plc:otherworks';
    repo.create(SUPPLIER, record('po-1', { pollCount: 1 }));
    repo.create(OTHER, record('po-1', { pollCount: 7 }));
    expect(repo.get(SUPPLIER, 'po-1')?.pollCount).toBe(1);
    expect(repo.get(OTHER, 'po-1')?.pollCount).toBe(7);
  });

  it('lists the unsettled oldest-poll-first and omits the settled', () => {
    repo.create(SUPPLIER, record('po-late', { state: 'outcome_unknown', nextPollAtMs: 2_000 }));
    repo.create(
      SUPPLIER,
      record('po-early', { state: 'submitted_unconfirmed', nextPollAtMs: 1_000 }),
    );
    repo.create(SUPPLIER, record('po-done', { state: 'accepted', nextPollAtMs: null }));

    expect(repo.listUnsettled().map((e) => e.record.purchaseOrderId)).toEqual([
      'po-early',
      'po-late',
    ]);
  });

  it('carries the description onto the listing, not only onto the single read', () => {
    // The sweep reads through `listUnsettled`, so a SELECT that named the new
    // columns in `get` and not here would leave every swept order
    // undescribable — and undescribable orders are SKIPPED, which is silence
    // rather than an error.
    repo.create(SUPPLIER, record('po-1', { state: 'outcome_unknown', nextPollAtMs: 1_000 }));
    const listed = repo.listUnsettled()[0]?.record;
    expect(listed?.orderDigest).toBe(DESCRIBED.orderDigest);
    expect(listed?.idempotencyKey).toBe(DESCRIBED.idempotencyKey);
    expect(listed?.serviceRkey).toBe(DESCRIBED.serviceRkey);
    expect(listed?.protocolVersion).toBe(DESCRIBED.protocolVersion);
  });

  it('reads a row written before the description columns existed as EMPTY, not as null text', () => {
    // The migration defaults these to ''. A row that predates them must read
    // as "cannot describe" so the sweep skips it — never as a digest-shaped
    // string that would send a supplier a question about an order that never
    // had that digest.
    adapter.run(
      `INSERT INTO commerce_buyer_orders
         (supplier_did, purchase_order_id, state, poll_count, resubmission_authorized)
       VALUES (?, ?, 'outcome_unknown', 2, 0)`,
      [SUPPLIER, 'po-legacy'],
    );
    const read = repo.get(SUPPLIER, 'po-legacy');
    expect(read?.orderDigest).toBe('');
    expect(read?.idempotencyKey).toBe('');
    expect(read?.serviceRkey).toBe('');
    expect(read?.pollCount).toBe(2);
  });
});

/**
 * The executor's crash boundary, against real SQL (§12.7, WS-3.7 / WS-7.8).
 *
 * "RECORD, then send" is the executor's whole safety argument, and the two
 * paths reach the store differently: a first submission INSERTS (so a
 * concurrent duplicate cannot slip past) and a resend OVERWRITES (so the
 * authorization is spent before anything leaves). The in-memory double upserts
 * on both, which makes the distinction invisible — a mutation that swapped them
 * survived the whole suite. Real SQL does not: `put` is an UPDATE, and an
 * INSERT that should have happened and did not leaves an order on the wire with
 * nothing recording it.
 */
describe('record-before-send, against real SQL', () => {
  const REQUEST = makeQuoteRequest();
  const QUOTE = makeSignedQuote(REQUEST, { quote_id: 'q-sql' });
  const ORDER = makeOrder(QUOTE, REQUEST.delivery.projection);

  const CONTEXT: BuyerApprovalContext = {
    actingBusinessDid: BUYER_DID,
    principal: {
      principalDid: 'did:plc:sanchoowner',
      authorityDomain: 'procurement',
      policyRevision: null,
    },
    serviceUri: `at://${ORDER.supplier_did}/com.dinakernel.service.profile/self`,
    displayedLabels: { l1: 'Oak dining chair' },
    productKeys: { l1: 'gtin:05012345678900' },
    linePrices: { l1: { currency: 'INR', minor_units: '500' } },
    charges: [],
    quoteRevision: 1,
    quoteExpiresAt: '2026-08-09T09:00:00.000Z',
    install: {
      installId: 'install-buyer',
      capabilityId: 'com.dinakernel.commerce.submit-order',
      manifestCid: 'bafyreibuyer',
      installScopeHash: 's'.repeat(64),
      configRevision: '1',
    },
  };

  function approval() {
    const built = buildBuyerApprovalPayload(ORDER, CONTEXT);
    if (!built.ok) throw new Error(`fixture is missing ${built.missing.join(', ')}`);
    return built.payload;
  }

  beforeEach(() => {
    installCommerceRuntime({ buyerOrders: repo } as unknown as CommerceRuntime);
  });
  afterEach(() => installCommerceRuntime(null));

  it('leaves a DURABLE record of a first submission that never came back', async () => {
    // The order left, the supplier went quiet, the process could die here. The
    // row is what makes the re-poll possible at all; without it the order is
    // lost silently, which is the one failure §12.7 cannot recover from.
    const result = await submitApprovedOrder({
      order: ORDER,
      approved: approval(),
      context: CONTEXT,
      serviceRkey: 'self',
      send: async () => ({ kind: 'ambiguous', reason: 'sent' }),
      nowMs: 1_700_000_000_000,
    });
    expect(result.ok).toBe(true);
    const stored = repo.get(ORDER.supplier_did, ORDER.purchase_order_id);
    expect(stored).not.toBeNull();
    expect(stored?.orderDigest).toBe(ORDER.order_digest);
    expect(stored?.serviceRkey).toBe('self');
  });

  it('leaves a DURABLE record at the moment a resend crosses the boundary', async () => {
    repo.create(ORDER.supplier_did, {
      ...newBuyerOrder(ORDER.purchase_order_id, {
        orderDigest: ORDER.order_digest,
        idempotencyKey: ORDER.idempotency_key,
        protocolVersion: ORDER.protocol_version,
        serviceRkey: 'self',
        // From the REAL order, not restated: these are what a later answer is
        // checked against, and a fixture that invents them would be testing a
        // binding no order ever carried.
        quoteDigest: ORDER.quote_digest,
        quoteId: ORDER.quote_id,
        buyerDid: ORDER.buyer_did,
        supplierDid: ORDER.supplier_did,
      }),
      state: 'never_received',
      resubmissionAuthorized: true,
    });

    const atSendTime: BuyerOrderRecord[] = [];
    await submitApprovedOrder({
      order: ORDER,
      approved: approval(),
      context: CONTEXT,
      serviceRkey: 'self',
      send: async () => {
        const seen = repo.get(ORDER.supplier_did, ORDER.purchase_order_id);
        if (seen !== null) atSendTime.push(seen);
        return { kind: 'ambiguous', reason: 'sent' };
      },
      nowMs: 1_700_000_000_000,
      resend: true,
    });
    // Written, and the authorization already spent — so a crash here cannot be
    // turned into a second resend.
    expect(atSendTime).toHaveLength(1);
    expect(atSendTime[0]?.resubmissionAuthorized).toBe(false);
    expect(atSendTime[0]?.state).toBe('submitted_unconfirmed');
  });

  it('refuses a second order for the same purchase, at the INSERT', async () => {
    await submitApprovedOrder({
      order: ORDER,
      approved: approval(),
      context: CONTEXT,
      serviceRkey: 'self',
      send: async () => ({ kind: 'ambiguous', reason: 'sent' }),
      nowMs: 1_700_000_000_000,
    });
    let secondSend = 0;
    const again = await submitApprovedOrder({
      order: ORDER,
      approved: approval(),
      context: CONTEXT,
      serviceRkey: 'self',
      send: async () => {
        secondSend += 1;
        return { kind: 'ambiguous', reason: 'sent' };
      },
      nowMs: 1_700_000_000_001,
    });
    expect(again.ok).toBe(false);
    expect(secondSend).toBe(0);
  });
});
