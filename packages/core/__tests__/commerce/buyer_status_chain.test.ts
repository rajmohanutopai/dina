/**
 * §9.11 receiver-side fork detection — the buyer's half of the status chain.
 *
 * THE FINDING. The supplier signs a chain and runs a CAS over its own head, and
 * the spec is explicit that this is not the protection: "Receiver-side chain
 * checks remain fork DETECTION for a misbehaving supplier." The party running
 * the supplier-side CAS is the party a buyer is worried about. Core shipped
 * `verifyStatusSuccession` and `verifyRestoreFence`, tested them, and called
 * neither — so a supplier could roll its chain backwards, emit two successors
 * of one head, or re-point a chain at another order, and every one of those
 * was recorded as ordinary progress.
 *
 * Each test below is one thing a misbehaving supplier can try.
 *
 * TWO LAYERS REFUSE, AND THE TESTS SAY WHICH. Several attacks never reach the
 * chain logic because `validateCommerceOrderStatus` already forbids the shape
 * — a genesis carrying a predecessor, a `delivered` with no dispute window, a
 * zero epoch. Those return `unreadable`, and asserting `fork` for them would
 * have been asserting a path the record cannot reach. Where a test expects
 * `unreadable` the comment names the structural rule doing the work.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { commerceRecordDigest, type Sha256Fn } from '@dina/commerce-protocol';

import {
  SQLiteBuyerStatusRepository,
  verifyInboundStatus,
  type BuyerStatusIngest,
} from '../../src/commerce/buyer_status';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { CommerceOrderStatus, PurchaseOrderLine } from '@dina/commerce-protocol';

const PASSHEX = randomBytes(32).toString('hex');
const BUYER = 'did:plc:alonso';
const SUPPLIER = 'did:plc:chairmaker';
const PO = 'po-chairs-1';
const NOW = Date.parse('2026-08-01T10:00:00.000Z');
const hash: Sha256Fn = (data) => sha256(data);

const LINES: PurchaseOrderLine[] = [
  {
    line_id: 'l1',
    product: { scheme: 'manufacturer_sku', value: 'chair-oak', issuer_did: SUPPLIER },
    // From the CLOSED v1 vocabulary. A plausible-looking UN/CEFACT code like
    // 'C62' is rejected, and every case that carries lines would have come
    // back `unreadable` for a reason that has nothing to do with the chain.
    quantity: { unit_code: 'each', value: '10' },
  },
];

let dir: string;
let adapter: NodeSQLiteAdapter;
let repository: SQLiteBuyerStatusRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-buyerchain-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: PASSHEX,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  repository = new SQLiteBuyerStatusRepository(adapter);
});

afterEach(() => {
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A status whose digest is REAL, computed by the protocol's own digester.
 *
 * The standing rule, earned the hard way: if a fixture needs a digest, get it
 * from the thing that makes them. A hand-written 64-hex string fails
 * structural validation, every case returns `unreadable`, and the suite is
 * green about nothing.
 */
function signStatus(fields: Partial<CommerceOrderStatus>): CommerceOrderStatus {
  const base = {
    protocol_version: '1.0',
    purchase_order_id: PO,
    buyer_did: BUYER,
    supplier_did: SUPPLIER,
    sequence: '0',
    state: 'accepted',
    supplier_epoch: '1',
    updated_at: '2026-08-01T09:00:00.000Z',
    ...fields,
  } as Omit<CommerceOrderStatus, 'status_digest'>;
  return {
    ...base,
    status_digest: commerceRecordDigest('status', base as unknown as Record<string, unknown>, hash),
  };
}

function ingest(
  status: CommerceOrderStatus,
  overrides?: {
    lines?: PurchaseOrderLine[] | null;
    genesisEvent?: 'accepted' | 'rejected' | null;
    purchaseOrderId?: string;
  },
): BuyerStatusIngest {
  return verifyInboundStatus({
    supplierDid: SUPPLIER,
    purchaseOrderId: overrides?.purchaseOrderId ?? PO,
    order: {
      buyerDid: BUYER,
      supplierDid: SUPPLIER,
      lines: overrides?.lines === undefined ? LINES : overrides.lines,
      genesisEvent: overrides?.genesisEvent === undefined ? 'accepted' : overrides.genesisEvent,
    },
    status,
    repository,
    nowMs: NOW,
  });
}

const GENESIS = signStatus({});

describe('genesis (§9.11)', () => {
  it('accepts a genesis that matches the acknowledgement the buyer holds', () => {
    expect(ingest(GENESIS)).toEqual({ outcome: 'applied', state: 'accepted' });
    expect(repository.chain(SUPPLIER, PO)).toHaveLength(1);
  });

  it('refuses a genesis whose state contradicts the acknowledgement', () => {
    // The supplier acknowledged `rejected` and then signed an `accepted`
    // genesis. Caught here rather than after it has shipped nothing.
    const result = ingest(GENESIS, { genesisEvent: 'rejected' });
    expect(result.outcome).toBe('fork');
    expect(result.detail).toMatch(/genesis: resolving event "rejected"/);
    expect(repository.chain(SUPPLIER, PO)).toHaveLength(0);
  });

  it('refuses a first record at a non-zero sequence', () => {
    // Structurally valid — a non-genesis MUST carry a predecessor — so this
    // reaches the genesis rule and is refused there.
    const result = ingest(signStatus({ sequence: '4', previous_status_digest: 'a'.repeat(64) }));
    expect(result.outcome).toBe('fork');
    expect(result.detail).toMatch(/sequence "0"/);
  });

  it('refuses a sequence-0 record that carries a predecessor', () => {
    // §9.11's genesis coupling is enforced STRUCTURALLY, so this never reaches
    // the chain logic. Asserting `fork` here would assert an unreachable path.
    const result = ingest(signStatus({ previous_status_digest: 'a'.repeat(64) }));
    expect(result.outcome).toBe('unreadable');
    expect(result.detail).toMatch(/genesis \(sequence "0"\) carries no previous_status_digest/);
  });

  it('refuses to judge a genesis with no acknowledgement held', () => {
    // Refusing rather than guessing the likeliest event. Guessing `accepted`
    // would make an unacknowledged order's genesis unfalsifiable.
    expect(ingest(GENESIS, { genesisEvent: null }).outcome).toBe('undescribable');
  });
});

describe('binding — the record must be about THIS conversation', () => {
  it('refuses a status signed by a supplier that is not the sender', () => {
    expect(ingest(signStatus({ supplier_did: 'did:plc:impostor' })).outcome).toBe('not_our_order');
  });

  it('binds to the TRANSPORT sender even when the order records no supplier', () => {
    // A mutation caught this: with the order's own `supplierDid` populated,
    // the test above is answered by the order-binding check and the
    // transport-binding check could be deleted with every test still green.
    // An order row written before that column existed reads as '', so this is
    // the case where the authenticated sender is the ONLY thing standing
    // between a peer and somebody else's chain.
    const result = verifyInboundStatus({
      supplierDid: SUPPLIER,
      purchaseOrderId: PO,
      order: { buyerDid: BUYER, supplierDid: '', lines: LINES, genesisEvent: 'accepted' },
      status: signStatus({ supplier_did: 'did:plc:impostor' }),
      repository,
      nowMs: NOW,
    });
    expect(result.outcome).toBe('not_our_order');
    expect(result.detail).toMatch(/authenticated sender/);
    expect(repository.chain(SUPPLIER, PO)).toHaveLength(0);
  });

  it('refuses a status naming a different purchase order', () => {
    expect(ingest(signStatus({ purchase_order_id: 'po-other' })).outcome).toBe('not_our_order');
  });

  it('refuses a status naming a different buyer', () => {
    expect(ingest(signStatus({ buyer_did: 'did:plc:sancho' })).outcome).toBe('not_our_order');
  });

  it('checks binding BEFORE succession, so somebody else’s order is not a fork', () => {
    expect(ingest(GENESIS).outcome).toBe('applied');
    // This record would also fail succession. Reporting it as a fork would
    // accuse this supplier of contradicting a chain it never addressed.
    const result = ingest(signStatus({ purchase_order_id: 'po-other' }));
    expect(result.outcome).toBe('not_our_order');
    expect(repository.chain(SUPPLIER, PO)).toHaveLength(1);
  });
});

describe('succession (§9.11)', () => {
  beforeEach(() => {
    expect(ingest(GENESIS).outcome).toBe('applied');
  });

  const successor = (fields: Partial<CommerceOrderStatus>): CommerceOrderStatus =>
    signStatus({
      sequence: '1',
      previous_status_digest: GENESIS.status_digest,
      state: 'preparing',
      updated_at: '2026-08-01T09:30:00.000Z',
      ...fields,
    });

  it('accepts a legal successor that extends the head', () => {
    expect(ingest(successor({}))).toEqual({ outcome: 'applied', state: 'preparing' });
    expect(repository.chain(SUPPLIER, PO).map((s) => s.state)).toEqual(['accepted', 'preparing']);
  });

  it('is idempotent: the same record twice is a duplicate, not a fork', () => {
    const next = successor({});
    expect(ingest(next).outcome).toBe('applied');
    expect(ingest(next)).toEqual({ outcome: 'duplicate', state: 'preparing' });
    expect(repository.chain(SUPPLIER, PO)).toHaveLength(2);
  });

  it('DETECTS A FORK: a second, different successor of one head', () => {
    // The case supplier-side CAS is supposed to prevent, arriving from a
    // supplier that did not run one. Once the first successor is the head, the
    // rival no longer extends it.
    expect(ingest(successor({})).outcome).toBe('applied');
    const rival = successor({ state: 'cancelled', updated_at: '2026-08-01T09:31:00.000Z' });
    const result = ingest(rival);
    expect(result.outcome).toBe('fork');
    expect(result.detail).toMatch(/does not extend the held head/);
    // The head did NOT move.
    expect(repository.chain(SUPPLIER, PO).map((s) => s.state)).toEqual(['accepted', 'preparing']);
  });

  it('refuses a successor that does not name the head', () => {
    const result = ingest(successor({ previous_status_digest: 'b'.repeat(64) }));
    expect(result.outcome).toBe('fork');
    expect(result.detail).toMatch(/does not extend the held head/);
  });

  it('refuses a sequence jump', () => {
    const result = ingest(successor({ sequence: '5' }));
    expect(result.outcome).toBe('fork');
    expect(result.detail).toMatch(/expected sequence 1, got 5/);
  });

  it('refuses an illegal transition', () => {
    // accepted -> delivered skips the graph. The dispute window is present
    // because `delivered` requires one structurally; without it the record
    // would be refused a layer earlier and prove nothing about the graph.
    const result = ingest(
      successor({ state: 'delivered', dispute_window_ends_at: '2026-09-01T00:00:00.000Z' }),
    );
    expect(result.outcome).toBe('fork');
    expect(result.detail).toMatch(/illegal transition accepted -> delivered/);
  });

  it('refuses fulfilment that exceeds the ordered quantity', () => {
    const result = ingest(
      successor({
        state: 'dispatched',
        lines: [{ line_id: 'l1', fulfilled_quantity: { unit_code: 'each', value: '11' } }],
      }),
    );
    expect(result.outcome).toBe('fork');
    expect(result.detail).toMatch(/exceeds the ordered quantity/);
  });

  it('refuses cumulative fulfilment that went backwards', () => {
    // Three records, because the graph says so: accepted -> preparing ->
    // partially_fulfilled. Jumping straight to a partial fulfilment would be
    // refused as an illegal transition and prove nothing about cumulativity.
    expect(ingest(successor({})).outcome).toBe('applied');
    const preparing = repository.chain(SUPPLIER, PO)[1] as CommerceOrderStatus;
    const partial = signStatus({
      sequence: '2',
      previous_status_digest: preparing.status_digest,
      state: 'partially_fulfilled',
      updated_at: '2026-08-01T09:45:00.000Z',
      lines: [{ line_id: 'l1', fulfilled_quantity: { unit_code: 'each', value: '6' } }],
    });
    expect(ingest(partial).outcome).toBe('applied');
    const regressed = signStatus({
      sequence: '3',
      previous_status_digest: partial.status_digest,
      state: 'dispatched',
      updated_at: '2026-08-01T10:00:00.000Z',
      lines: [{ line_id: 'l1', fulfilled_quantity: { unit_code: 'each', value: '3' } }],
    });
    const result = ingest(regressed);
    expect(result.outcome).toBe('fork');
    expect(result.detail).toMatch(/regressed/);
  });

  it('refuses a line the order does not contain', () => {
    const result = ingest(
      successor({
        state: 'dispatched',
        lines: [
          { line_id: 'not-an-order-line', fulfilled_quantity: { unit_code: 'each', value: '1' } },
        ],
      }),
    );
    expect(result.outcome).toBe('fork');
  });
});

describe('epoch monotonicity (§16.2)', () => {
  const PO2 = 'po-chairs-2';
  const genesisAtEpoch2 = signStatus({ purchase_order_id: PO2, supplier_epoch: '2' });

  it('refuses a successor whose supplier_epoch regressed — a stale pre-restore signer', () => {
    expect(ingest(genesisAtEpoch2, { purchaseOrderId: PO2 }).outcome).toBe('applied');
    const stale = signStatus({
      purchase_order_id: PO2,
      sequence: '1',
      previous_status_digest: genesisAtEpoch2.status_digest,
      state: 'preparing',
      supplier_epoch: '1',
      updated_at: '2026-08-01T09:30:00.000Z',
    });
    const result = ingest(stale, { purchaseOrderId: PO2 });
    expect(result.outcome).toBe('fork');
    expect(result.detail).toMatch(/supplier_epoch regressed/);
  });
});

describe('the lines the check runs against', () => {
  it('REFUSES an order whose lines were never kept, rather than checking against none', () => {
    // The trap this guards. `verifyStatusLines` handed an empty list rejects
    // every status that carries lines, so a missing snapshot would turn
    // ordinary dispatch into a supplier fork — accusing an honest
    // counterparty because of a gap on this side.
    const result = ingest(GENESIS, { lines: null });
    expect(result.outcome).toBe('undescribable');
    expect(result.detail).toMatch(/kept no lines/);
  });
});

describe('§16.2 restore fence', () => {
  let firstSuccessor: CommerceOrderStatus;

  beforeEach(() => {
    expect(ingest(GENESIS).outcome).toBe('applied');
    firstSuccessor = signStatus({
      sequence: '1',
      previous_status_digest: GENESIS.status_digest,
      state: 'preparing',
      updated_at: '2026-08-01T09:30:00.000Z',
    });
    expect(ingest(firstSuccessor).outcome).toBe('applied');
  });

  it('accepts a fence at a higher epoch naming an ANCESTOR, and truncates to it', () => {
    // The supplier restored from a backup taken before it signed sequence 1,
    // so it can only reach the genesis. §16.2 lets that take the chain over.
    //
    // SEQUENCE 1, not 2: a fence extends the record it NAMES, so a takeover
    // re-uses the sequence it is replacing. Numbering it head+1 would leave
    // the buyer holding a chain whose sequences no longer describe its length.
    const fence = signStatus({
      sequence: '1',
      previous_status_digest: GENESIS.status_digest,
      state: 'cancelled',
      supplier_epoch: '2',
      restore_fence: true,
      updated_at: '2026-08-01T09:45:00.000Z',
    });
    expect(ingest(fence)).toEqual({ outcome: 'applied', state: 'cancelled' });
    expect(repository.chain(SUPPLIER, PO).map((s) => s.state)).toEqual(['accepted', 'cancelled']);
  });

  it('accepts a fence naming the HEAD, and keeps what came before', () => {
    const fence = signStatus({
      sequence: '2',
      previous_status_digest: firstSuccessor.status_digest,
      state: 'cancelled',
      supplier_epoch: '2',
      restore_fence: true,
      updated_at: '2026-08-01T09:45:00.000Z',
    });
    expect(ingest(fence).outcome).toBe('applied');
    expect(repository.chain(SUPPLIER, PO).map((s) => s.state)).toEqual([
      'accepted',
      'preparing',
      'cancelled',
    ]);
  });

  it('refuses a fence at the SAME epoch — a fence must outrank what it replaces', () => {
    const fence = signStatus({
      sequence: '1',
      previous_status_digest: GENESIS.status_digest,
      state: 'cancelled',
      supplier_epoch: '1',
      restore_fence: true,
      updated_at: '2026-08-01T09:45:00.000Z',
    });
    expect(ingest(fence).outcome).toBe('fork');
    expect(repository.chain(SUPPLIER, PO)).toHaveLength(2);
  });

  it('refuses a fence naming a predecessor outside the held chain', () => {
    const fence = signStatus({
      sequence: '2',
      previous_status_digest: 'c'.repeat(64),
      state: 'cancelled',
      supplier_epoch: '2',
      restore_fence: true,
      updated_at: '2026-08-01T09:45:00.000Z',
    });
    expect(ingest(fence).outcome).toBe('fork');
    expect(repository.chain(SUPPLIER, PO)).toHaveLength(2);
  });

  it('refuses a fence when nothing is held — there is no chain to fence', () => {
    const result = ingest(
      signStatus({
        purchase_order_id: 'po-untouched',
        sequence: '1',
        previous_status_digest: 'a'.repeat(64),
        supplier_epoch: '2',
        restore_fence: true,
      }),
      { purchaseOrderId: 'po-untouched' },
    );
    expect(result.outcome).toBe('fork');
    expect(result.detail).toMatch(/no held chain/);
  });

  it('refuses a fence that rewrites the order it names', () => {
    // A higher-epoch fence naming a held predecessor while changing the
    // purchase order would re-point the buyer's chain at a different trade.
    // Binding catches it before the fence logic, which is the earlier and
    // stricter of the two refusals.
    const fence = signStatus({
      purchase_order_id: 'po-somewhere-else',
      sequence: '1',
      previous_status_digest: GENESIS.status_digest,
      state: 'cancelled',
      supplier_epoch: '2',
      restore_fence: true,
      updated_at: '2026-08-01T09:45:00.000Z',
    });
    expect(ingest(fence).outcome).toBe('not_our_order');
    expect(repository.chain(SUPPLIER, PO)).toHaveLength(2);
  });
});

describe('what the store refuses to hand back', () => {
  it('throws rather than returning a row that no longer matches its record', () => {
    expect(ingest(GENESIS).outcome).toBe('applied');
    // A row edited by anything with the database open. The chain is the
    // yardstick succession runs against, so a tampered head would let the
    // next real status be called a fork.
    adapter.run(
      `UPDATE commerce_buyer_status_records SET record_json = ? WHERE purchase_order_id = ?`,
      [JSON.stringify({ ...GENESIS, state: 'delivered' }), PO],
    );
    expect(() => repository.chain(SUPPLIER, PO)).toThrow(/stored status/);
  });
});
