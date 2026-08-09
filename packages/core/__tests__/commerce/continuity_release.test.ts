/**
 * §9.13 — retiring a prior manifest's lifecycle lane (WS-3.8).
 *
 * TWO DEFECTS, and the second is only dangerous once the first is fixed.
 *
 * `releaseContinuity` was written, tested, and called by NOTHING. Continuity
 * authorizations are created with `expiresAt: null` on purpose — no clock knows
 * when an order ends — so a prior plugin CID kept authority over this node's
 * lifecycle lane for ever, and every update left another one behind.
 *
 * The counter it would have released on was `countReservedByServingManifest`,
 * which answers "is anything waiting to be DECIDED". An accepted order is
 * `decided` the moment the supplier answers, while its status chain runs on for
 * days. Wiring the release to that counter would have revoked authority the
 * buyer still needs — the failure is worse than the one being fixed, which is
 * why the counter came first.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { ContinuityReleaseSweeper } from '../../src/commerce/continuity_release_sweeper';
import { SQLiteCommerceOrderRefRepository } from '../../src/commerce/order_refs';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const PASSHEX = randomBytes(32).toString('hex');
const BUYER = 'did:plc:sancho42';
const CID = 'bafyprior';

let dir: string;
let adapter: NodeSQLiteAdapter;
let refs: SQLiteCommerceOrderRefRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-continuity-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: PASSHEX,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  refs = new SQLiteCommerceOrderRefRepository(adapter);
});

afterEach(() => {
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedOrder(purchaseOrderId: string): void {
  refs.createReserved({
    buyerDid: BUYER,
    purchaseOrderId,
    idempotencyKey: `idem-${purchaseOrderId}`,
    orderDigest: 'a'.repeat(64),
    quoteId: `q-${purchaseOrderId}`,
    quoteDigest: 'b'.repeat(64),
    pinnedVersion: '1.0',
    servingInstallId: 'i-1',
    servingManifestCid: CID,
    decisionDeadlineAt: null,
    admittedEpoch: '1',
    reconciliationRequired: false,
    createdAt: 1,
  });
}

function decide(purchaseOrderId: string): void {
  adapter.run(`UPDATE commerce_order_refs SET state = 'decided' WHERE purchase_order_id = ?`, [
    purchaseOrderId,
  ]);
}

const NOW = 1_800_000_000_000;

function statusHead(
  purchaseOrderId: string,
  state: string,
  disputeWindowEndsAt: number | null = null,
): void {
  adapter.run(
    `INSERT INTO commerce_status_heads
       (buyer_did, purchase_order_id, head_digest, head_sequence, state, supplier_epoch,
        updated_at, dispute_window_ends_at)
     VALUES (?, ?, ?, '1', ?, '1', 1, ?)`,
    [BUYER, purchaseOrderId, 'c'.repeat(64), state, disputeWindowEndsAt],
  );
}

describe('what counts as WORK a prior manifest still has', () => {
  it('counts a reserved order, as the old counter did', () => {
    seedOrder('po-reserved');
    expect(refs.countUnfinishedByServingManifest(CID, NOW)).toBe(1);
  });

  it('counts an ACCEPTED order whose status chain is still open — the old counter did NOT', () => {
    // The whole finding. `decided` is reached the instant the supplier answers,
    // and dispatch, delivery and any dispute all come after it.
    seedOrder('po-accepted');
    decide('po-accepted');
    statusHead('po-accepted', 'dispatched');
    expect(refs.countReservedByServingManifest(CID)).toBe(0);
    expect(refs.countUnfinishedByServingManifest(CID, NOW)).toBe(1);
  });

  it('counts an accepted order with NO chain yet — accepted, and nothing emitted', () => {
    seedOrder('po-silent');
    decide('po-silent');
    expect(refs.countUnfinishedByServingManifest(CID, NOW)).toBe(1);
  });

  it.each(['rejected', 'cancelled', 'disputed'])('stops counting a %s chain', (state) => {
    seedOrder('po-done');
    decide('po-done');
    statusHead('po-done', state);
    expect(refs.countUnfinishedByServingManifest(CID, NOW)).toBe(0);
  });

  it('counts a delivered chain while its dispute window is still open', () => {
    seedOrder('po-delivered');
    decide('po-delivered');
    statusHead('po-delivered', 'delivered', NOW + 1);
    expect(refs.countUnfinishedByServingManifest(CID, NOW)).toBe(1);
  });

  it('STOPS counting a delivered chain once its dispute window has passed', () => {
    // THE FINDING. This test used to assert the opposite — "STILL counts a
    // delivered chain, because the dispute window is not this query to judge"
    // — on the reasoning that SQL could not evaluate it and the caller would.
    // Neither caller did: both boots handed this count straight to continuity
    // release and uninstall. So a delivered order was unfinished FOR EVER,
    // every prior manifest CID stayed alive, and a supplier could never
    // uninstall a pack whose orders had all completed normally.
    seedOrder('po-delivered');
    decide('po-delivered');
    statusHead('po-delivered', 'delivered', NOW - 1);
    expect(refs.countUnfinishedByServingManifest(CID, NOW)).toBe(0);
  });

  it('treats the deadline as EXCLUSIVE: at the instant it ends, it is over', () => {
    seedOrder('po-boundary');
    decide('po-boundary');
    statusHead('po-boundary', 'delivered', NOW);
    expect(refs.countUnfinishedByServingManifest(CID, NOW)).toBe(0);
    // And one millisecond earlier it is not.
    expect(refs.countUnfinishedByServingManifest(CID, NOW - 1)).toBe(1);
  });

  it('keeps counting a delivered chain that recorded NO deadline — absent is not expired', () => {
    // A head written before the column existed, or by a status record that
    // carried no window. Refusing to guess is the safe direction here, and
    // unlike the old behaviour it is bounded: only these rows persist.
    seedOrder('po-nowindow');
    decide('po-nowindow');
    statusHead('po-nowindow', 'delivered', null);
    expect(refs.countUnfinishedByServingManifest(CID, NOW)).toBe(1);
  });

  it('ignores orders served by a DIFFERENT manifest', () => {
    seedOrder('po-ours');
    refs.createReserved({
      buyerDid: BUYER,
      purchaseOrderId: 'po-theirs',
      idempotencyKey: 'idem-theirs',
      orderDigest: 'a'.repeat(64),
      quoteId: 'q-theirs',
      quoteDigest: 'b'.repeat(64),
      pinnedVersion: '1.0',
      servingInstallId: 'i-1',
      servingManifestCid: 'bafyother',
      decisionDeadlineAt: null,
      admittedEpoch: '1',
      reconciliationRequired: false,
      createdAt: 2,
    });
    expect(refs.countUnfinishedByServingManifest(CID, NOW)).toBe(1);
  });
});

describe('the sweep that finally calls release', () => {
  const LANE = { installId: 'i-1', previousCid: CID, capabilityId: 'cap-1' };

  it('asks the COORDINATOR, and reports what it released', () => {
    const asked: string[] = [];
    const sweeper = new ContinuityReleaseSweeper({
      intervalMs: 1000,
      releasable: () => [LANE],
      release: (installId, previousCid, capabilityId) => {
        asked.push(`${installId}/${previousCid}/${capabilityId}`);
        return { released: true, openOrders: 0 };
      },
    });
    expect(sweeper.sweep()).toBe(1);
    expect(asked).toEqual(['i-1/bafyprior/cap-1']);
  });

  it('does NOT release a lane the coordinator refuses', () => {
    // The coordinator re-reads the count itself, so a stale view here can only
    // ever make the sweep LATE, never early. That asymmetry is the design.
    const released: unknown[] = [];
    const sweeper = new ContinuityReleaseSweeper({
      intervalMs: 1000,
      releasable: () => [LANE],
      release: () => ({ released: false, openOrders: 3 }),
      onReleased: (e) => released.push(e),
    });
    expect(sweeper.sweep()).toBe(0);
    expect(released).toEqual([]);
  });

  it('keeps ticking after a lane throws, rather than dying silently', () => {
    // A throw inside a timer takes the tick down permanently and without a
    // sound; the lane it failed on is retried next pass.
    let ticks = 0;
    const sweeper = new ContinuityReleaseSweeper({
      intervalMs: 1000,
      releasable: () => {
        ticks += 1;
        throw new Error('registry unavailable');
      },
      release: () => ({ released: false, openOrders: 0 }),
      setInterval: (fn) => {
        fn();
        fn();
        return 1;
      },
      clearInterval: () => undefined,
    });
    expect(() => sweeper.start()).not.toThrow();
    expect(ticks).toBe(2);
  });

  it('unrefs its handle, so a pending tick never holds a process open', () => {
    // Regression. Without this the mobile suite stopped exiting: every test
    // that booted the commerce plane left a live 15-minute timer behind, and
    // jest hung after the last assertion passed. A maintenance sweep must
    // never be the reason a process stays alive.
    let unrefs = 0;
    const sweeper = new ContinuityReleaseSweeper({
      intervalMs: 1000,
      releasable: () => [],
      release: () => ({ released: false, openOrders: 0 }),
      setInterval: () => ({
        unref: () => {
          unrefs += 1;
        },
      }),
      clearInterval: () => undefined,
    });
    sweeper.start();
    expect(unrefs).toBe(1);
  });

  it('starts on a platform whose timer handle has no unref', () => {
    // Hermes returns a plain number. The probe is a capability check, not a
    // platform check, so the absence must be silent rather than a TypeError.
    const sweeper = new ContinuityReleaseSweeper({
      intervalMs: 1000,
      releasable: () => [],
      release: () => ({ released: false, openOrders: 0 }),
      setInterval: () => 7,
      clearInterval: () => undefined,
    });
    expect(() => sweeper.start()).not.toThrow();
  });

  it('refuses a non-positive interval rather than spinning', () => {
    expect(
      () =>
        new ContinuityReleaseSweeper({
          intervalMs: 0,
          releasable: () => [],
          release: () => ({ released: false, openOrders: 0 }),
        }),
    ).toThrow(/intervalMs/);
  });
});
