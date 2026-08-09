/**
 * The phone's commerce background plane (WS-2.4).
 *
 * Mobile had no epoch service at all: `getCommerceEpochService()` was READ in
 * two places here and SET in none, so `currentEpoch()` threw for ever and
 * every commerce operation on the product's primary surface refused. Nothing
 * caught it, because a node that refuses everything is exactly what a
 * correctly fail-closed node looks like.
 *
 * These drive the real `startMobileCommercePlane` — the same call the boot
 * makes — against a fake repo, and assert the thing that was false before:
 * after it runs, this node can sign.
 */

import {
  applyMigrations,
  commerceAvailability,
  createCommerceRuntime,
  getCommerceEpochService,
  IDENTITY_MIGRATIONS,
  installCommerceRuntime,
  InMemoryDatabaseAdapter,
  setCommerceEpochService,
  getCatalogRecordReader,
  getCatalogRecordWriter,
  installCatalogRecordReader,
  installCatalogRecordWriter,
} from '@dina/core';

import {
  startMobileCommercePlane,
  stopMobileCommercePlane,
} from '../../src/services/commerce_plane';

const BUSINESS_DID = 'did:plc:chairmakermobile000';

/**
 * How many background ticks the plane starts: admission recovery (§9.9 step 3),
 * epoch revalidation (§16.2), the buyer re-poll (§12.7), and continuity
 * release (§9.13).
 *
 * Named rather than written as a bare number so a change to it is a decision
 * somebody made, not a test that was nudged until it passed. THE DECISION:
 * continuity authorizations carry no expiry, so without a tick to retire them
 * every plugin update leaves a prior CID holding authority over this node's
 * lifecycle lane for ever.
 */
const COMMERCE_TICKS = 4;

/** A fake AT Protocol repo: one record, CAS on the CID we handed out. */
class FakeRepo {
  record: { value: Record<string, unknown>; cid: string } | null = null;
  reads = 0;
  writes = 0;
  unreachable = false;
  /** What the LAST write presented: a CID, null, or the absent marker. */
  lastSwap: string | null = null;
  private nextCid = 1;

  /**
   * KEYED BY collection+rkey, because the catalog writes two records in one
   * publication. A single-slot fake made the snapshot's blind write occupy the
   * pointer's key, so the head's `swapRecord: null` ("only if nothing is
   * there") failed against the snapshot — a fixture artefact that reads
   * exactly like a real CAS bug.
   */
  private readonly records = new Map<string, { value: Record<string, unknown>; cid: string }>();

  getRecord = async (
    collection = 'epoch',
    rkey = 'self',
  ): Promise<{ value: Record<string, unknown>; cid: string } | null> => {
    this.reads += 1;
    if (this.unreachable) throw new Error('ENETDOWN');
    return this.records.get(`${collection}/${rkey}`) ?? this.record;
  };

  putRecord = async (
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
    // OPTIONAL, and the absence is meaningful: an absent `swapRecord` is a
    // blind overwrite, which is what a content-addressed snapshot needs so a
    // retry writing identical bytes does not fail on success.
    options: { swapRecord?: string | null },
  ): Promise<{ cid: string }> => {
    this.writes += 1;
    const key = `${collection}/${rkey}`;
    const live = this.records.get(key) ?? (key === 'epoch/self' ? this.record : null);
    this.lastSwap = 'swapRecord' in options ? (options.swapRecord ?? null) : 'ABSENT';
    if ('swapRecord' in options && (live?.cid ?? null) !== (options.swapRecord ?? null)) {
      throw new Error('swap failed');
    }
    const cid = `cid-${String(this.nextCid++)}`;
    this.records.set(key, { value: record, cid });
    this.record = { value: record, cid };
    return { cid };
  };
}

function installRuntime(adapter: InMemoryDatabaseAdapter): void {
  installCommerceRuntime(
    createCommerceRuntime({
      adapter,
      supplierDid: () => BUSINESS_DID,
      currentEpoch: () => {
        const service = getCommerceEpochService();
        if (service === null) {
          throw new Error('commerce: epoch service not installed — signing is fail-closed (§16.2)');
        }
        return service.currentEpoch();
      },
    }),
  );
}

describe('startMobileCommercePlane', () => {
  let adapter: InMemoryDatabaseAdapter;
  /** Hand-driven timers, so "a tick was started" is observable. */
  let started: number;
  let cleared: number;

  beforeEach(() => {
    adapter = new InMemoryDatabaseAdapter();
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    installRuntime(adapter);
    started = 0;
    cleared = 0;
  });

  afterEach(() => {
    stopMobileCommercePlane();
    setCommerceEpochService(null);
    installCommerceRuntime(null);
  });

  const start = (repo: FakeRepo | undefined) =>
    startMobileCommercePlane({
      adapter,
      pds: repo,
      businessDid: BUSINESS_DID,
      tx: (fn) => {
        adapter.transaction(fn);
      },
      log: () => {
        /* silenced */
      },
      setInterval: () => {
        started += 1;
        return started;
      },
      clearInterval: () => {
        cleared += 1;
      },
    });

  it('publishes the genesis epoch, so the phone can sign at all', async () => {
    // The claim that was false before this existed.
    expect(commerceAvailability()).toMatchObject({ available: false, reason: 'no_epoch' });
    const repo = new FakeRepo();
    await start(repo);
    expect(repo.writes).toBe(1);
    expect(getCommerceEpochService()?.currentEpoch()).toBe('1');
    expect(commerceAvailability()).toEqual({ available: true });
  });

  it('adopts a live epoch rather than republishing over it', async () => {
    const repo = new FakeRepo();
    await start(repo);
    const published = repo.record;
    setCommerceEpochService(null);
    stopMobileCommercePlane();

    await start(repo);
    expect(repo.record).toBe(published);
    expect(repo.writes).toBe(1);
    expect(getCommerceEpochService()?.currentEpoch()).toBe('1');
  });

  it('leaves commerce disabled when this node has no repo, and still starts the sweeps', async () => {
    // A phone with no PDS session has nothing to publish an epoch to. That
    // must not take the other ticks down with it: reservations recorded while
    // commerce was live still have to time out and refund, and an order this
    // node cannot account for still has to be asked about.
    await start(undefined);
    expect(getCommerceEpochService()).toBeNull();
    expect(commerceAvailability()).toMatchObject({ available: false, reason: 'no_epoch' });
    expect(started).toBe(COMMERCE_TICKS);
  });

  it('leaves commerce disabled when the repo cannot be reached', async () => {
    // Fail closed: an unreachable repo is not an empty one, and publishing a
    // genesis over a live chain is the divergence the fence exists to prevent.
    const repo = new FakeRepo();
    repo.unreachable = true;
    await start(repo);
    expect(repo.writes).toBe(0);
    expect(getCommerceEpochService()).toBeNull();
  });

  it("does not leave the previous identity's timers running on a second boot", async () => {
    // A phone signs out and in again inside ONE JS process. Without the
    // idempotent stop at the top of `start`, each identity switch would leave
    // another set of timers re-reading a repo the user has moved away from.
    await start(new FakeRepo());
    expect(started).toBe(COMMERCE_TICKS);
    expect(cleared).toBe(0);

    await start(new FakeRepo());
    // The first set was cleared before the second was created. Without the
    // stop at the top of `start`, this would be 0 and two identities' worth of
    // timers would be live at once.
    expect(cleared).toBe(COMMERCE_TICKS);
    expect(started).toBe(COMMERCE_TICKS * 2);

    stopMobileCommercePlane();
    expect(cleared).toBe(COMMERCE_TICKS * 2);
  });

  it('is a quiet no-op when this node has no commerce runtime', async () => {
    installCommerceRuntime(null);
    const repo = new FakeRepo();
    await start(repo);
    expect(repo.reads).toBe(0);
    expect(getCommerceEpochService()).toBeNull();
  });
});

/**
 * §10.2 CATALOG PUBLICATION ON THE PHONE.
 *
 * Only the server installed the record writer, so `/v1/commerce/catalog/publish`
 * and `/withdraw` refused `no_record_writer` on a deployment that ships a PDS
 * session and already publishes its restore epoch through this very client —
 * a whole owner surface unavailable for no stated reason.
 */
describe('the catalog repo access the phone installs', () => {
  let adapter: InMemoryDatabaseAdapter;
  let repo: FakeRepo;

  beforeEach(() => {
    adapter = new InMemoryDatabaseAdapter();
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    repo = new FakeRepo();
    // CLEARED FIRST. These are module globals, and a sibling suite that booted
    // a node in the same process leaves them installed — so "installs NEITHER
    // on a node with no repo" would read another suite's leftovers as this
    // one's result. It did: these tests passed alone and failed beside
    // `boot_service.test.ts`.
    installCatalogRecordWriter(null);
    installCatalogRecordReader(null);
    installRuntime(adapter);
  });

  afterEach(() => {
    stopMobileCommercePlane();
    installCommerceRuntime(null);
  });

  async function start(pds: FakeRepo | undefined): Promise<void> {
    await startMobileCommercePlane({
      adapter,
      pds: pds as unknown as EpochRepoClient | undefined,
      businessDid: BUSINESS_DID,
      tx: (fn) => fn(),
      log: () => undefined,
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
  }

  it('installs BOTH the writer and the reader when the node has a repo', async () => {
    await start(repo);
    expect(getCatalogRecordWriter()).not.toBeNull();
    expect(getCatalogRecordReader()).not.toBeNull();
  });

  it('writes a snapshot with NO swap condition and a head WITH one', async () => {
    await start(repo);
    const write = getCatalogRecordWriter();
    if (write === null) throw new Error('expected a writer');

    await write({ collection: 'com.dinakernel.commerce.catalogSnapshot', rkey: 'r1', record: {} });
    expect(repo.lastSwap).toBe('ABSENT');

    await write({
      collection: 'com.dinakernel.commerce.catalogPointer',
      rkey: 'chairs',
      record: {},
      swapRecord: null,
    });
    expect(repo.lastSwap).toBeNull();
  });

  it('installs NEITHER on a node with no repo', async () => {
    await start(undefined);
    expect(getCatalogRecordWriter()).toBeNull();
    expect(getCatalogRecordReader()).toBeNull();
  });

  it('CLEARS both when the plane stops, so an identity switch cannot publish into the old repo', async () => {
    await start(repo);
    stopMobileCommercePlane();
    expect(getCatalogRecordWriter()).toBeNull();
    expect(getCatalogRecordReader()).toBeNull();
  });
});
