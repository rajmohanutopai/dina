/**
 * The supplier's published-catalog surface, and the node becoming the
 * authority on its own publication history (§10.2, FR-P10 — WS-7.8).
 *
 * WHAT CHANGED AND WHY. The publish route used to take `expected_pointer_cid`
 * — the compare-and-swap the repo enforces — out of the request body. That
 * made the CALLER the authority on a fact only this node knows: where its own
 * chain is. A caller that omitted it published a GENESIS over a live chain; a
 * caller that got it wrong lost a race it had no way to understand.
 *
 * The other half is the withdrawal. It BUILT a tombstone and handed it back,
 * and nothing wrote it — so the live catalog stayed live, consumers kept
 * fetching the previous head, and the owner believed they had stopped selling.
 * The gap between those two beliefs is filled with orders.
 *
 * The repo writer here is a real one in the sense that matters: it records
 * every write with the swap value presented, so the CAS claims are checked
 * against what was actually sent rather than against what the route intended.
 */

import { InMemoryCatalogPointerRepository } from '../../../src/commerce/catalog_pointer_store';
import {
  installCatalogRecordReader,
  installCatalogRecordWriter,
} from '../../../src/commerce/catalog_record_writer';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import { clearPairingState, setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest, type CoreResponse } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';

import type { CatalogPointer } from '@dina/commerce-protocol';

const OWNER_CAP = 'test-owner-capability-secret';
const SUPPLIER = 'did:plc:chairmaker99';

let router: CoreRouter;
let pointers: InMemoryCatalogPointerRepository;
/** Every write attempted, in order, with what it CAS'd on. */
let writes: { collection: string; rkey: string; swapRecord?: string | null }[];
let nextCid: number;
let failPointer: boolean;

function request(
  method: 'GET' | 'POST',
  path: string,
  body: Record<string, unknown>,
  callerType = 'owner',
): CoreRequest {
  return {
    method,
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(callerType !== '' ? { callerType, callerDID: 'did:key:caller' } : {}),
    ...(callerType === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
  };
}

const post = (path: string, body: Record<string, unknown>, callerType = 'owner'): CoreRequest =>
  request('POST', path, body, callerType);
const get = (path: string, callerType = 'owner'): CoreRequest =>
  request('GET', path, {}, callerType);

beforeEach(() => {
  setNodeDID(SUPPLIER);
  pointers = new InMemoryCatalogPointerRepository();
  writes = [];
  nextCid = 1;
  failPointer = false;
  installCommerceRuntime({
    availability: () => ({ available: true }),
    catalogPointers: pointers,
  } as unknown as CommerceRuntime);
  installCatalogRecordWriter(async ({ collection, rkey, swapRecord }) => {
    writes.push({ collection, rkey, swapRecord });
    if (failPointer && collection.endsWith('catalogPointer')) {
      throw new Error('the repo refused the swap');
    }
    return { cid: `cid-${String(nextCid++)}` };
  });
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  installCommerceRuntime(null);
  installCatalogRecordWriter(null);
  installCatalogRecordReader(null);
  clearPairingState();
});

function publish(body: Record<string, unknown> = {}): Promise<CoreResponse> {
  return router.handle(
    post('/v1/commerce/catalog/publish', {
      catalog_id: 'chairs',
      published_at: '2026-08-08T09:00:00.000Z',
      items: [{ sku: 'CHAIR-1', name: 'Oak chair' }],
      ...body,
    }),
  );
}

function pointerOf(resp: CoreResponse): CatalogPointer {
  return (resp.body as { pointer: CatalogPointer }).pointer;
}

const pointerWrites = (): typeof writes =>
  writes.filter((w) => w.collection.endsWith('catalogPointer'));

describe('the node remembers what it published', () => {
  it('records the head only after the repo accepted it', async () => {
    const resp = await publish();
    expect(resp.status).toBe(200);
    const stored = pointers.get('chairs');
    expect(stored?.pointer.snapshot_sequence).toBe(1);
    // cid-1 went to the snapshot, cid-2 to the head. The head's is the one
    // the next publication must swap on.
    expect(stored?.pointerCid).toBe('cid-2');
    expect(stored?.snapshotDigest).toBe(pointerOf(resp).snapshot_digest);
    expect(stored?.withdrawn).toBe(false);
  });

  it('records the CHAIN’s own timestamp, not the wall clock', async () => {
    // This is the moment buyers see beside the record. An owner card built on
    // a private second clock would report a publication history the repo
    // never saw.
    await publish({ published_at: '2026-08-08T09:00:00.000Z' });
    expect(pointers.get('chairs')?.publishedAtMs).toBe(Date.parse('2026-08-08T09:00:00.000Z'));
  });

  it('records NOTHING when the head write failed', async () => {
    // A head remembered for a write that did not land would hand the NEXT
    // publication a swap value the repo never issued, turning one lost race
    // into a permanent one.
    failPointer = true;
    const resp = await publish();
    expect(resp.status).toBe(409);
    expect(pointers.get('chairs')).toBeNull();
  });

  it('records nothing when this node has no repo to publish to', async () => {
    // "Built, not written" is a real answer for an operator publishing by
    // hand — but it is not a publication, and the store must not claim one.
    installCatalogRecordWriter(null);
    const resp = await publish();
    expect(resp.status).toBe(200);
    expect((resp.body as { published: unknown }).published).toBeNull();
    expect(pointers.get('chairs')).toBeNull();
  });
});

describe('the compare-and-swap comes from the node, not the caller', () => {
  it('presents NULL on a first publication and the stored CID on the next', async () => {
    await publish();
    expect(pointerWrites()[0]?.swapRecord).toBeNull();
    const storedCid = pointers.get('chairs')?.pointerCid;

    const second = await publish({ published_at: '2026-08-08T10:00:00.000Z' });
    expect(second.status).toBe(200);
    // The swap value is the CID the repo issued for the PREVIOUS head — never
    // a body field, and never re-derived.
    expect(pointerWrites()[1]?.swapRecord).toBe(storedCid);
  });

  it('advances the chain with NO predecessor in the body at all', async () => {
    // The point of the store. Before it, a second publication that forgot to
    // repeat `previous` silently published a genesis at sequence 1 over a live
    // chain.
    const first = await publish();
    const second = await publish({ published_at: '2026-08-08T10:00:00.000Z' });
    expect(pointerOf(second).snapshot_sequence).toBe(2);
    expect(pointerOf(second).previous_snapshot_digest).toBe(pointerOf(first).snapshot_digest);
  });

  it('ignores a body field that used to carry the swap value', async () => {
    // `expected_pointer_cid` is no longer read. A caller still sending it must
    // not be able to steer the CAS — that was the whole defect.
    await publish();
    await publish({
      published_at: '2026-08-08T10:00:00.000Z',
      expected_pointer_cid: 'cid-somebody-elses-guess',
    });
    expect(pointerWrites()[1]?.swapRecord).toBe('cid-2');
  });

  it('REFUSES a predecessor that names a different point in the chain', async () => {
    const first = await publish();
    await publish({ published_at: '2026-08-08T10:00:00.000Z' });

    // The caller believes the chain is still at sequence 1. Publishing
    // anyway would succeed at sequence 3 and the caller would show its user a
    // catalog nobody published; the refusal is the signal to re-read the head.
    const stale = await publish({
      published_at: '2026-08-08T11:00:00.000Z',
      previous: pointerOf(first),
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: 'stale_predecessor', published_sequence: 2 });
    // And nothing was written for it.
    expect(pointerWrites()).toHaveLength(2);
  });

  it('accepts a predecessor that AGREES with the stored head', async () => {
    const first = await publish();
    const second = await publish({
      published_at: '2026-08-08T10:00:00.000Z',
      previous: pointerOf(first),
    });
    expect(second.status).toBe(200);
    expect(pointerOf(second).snapshot_sequence).toBe(2);
  });
});

describe('a withdrawal is PUBLISHED, not merely built', () => {
  it('writes the tombstone to the repo and records it', async () => {
    const first = await publish();
    const resp = await router.handle(
      post('/v1/commerce/catalog/withdraw', {
        catalog_id: 'chairs',
        published_at: '2026-08-08T11:00:00.000Z',
        previous: pointerOf(first),
      }),
    );
    expect(resp.status).toBe(200);
    expect((resp.body as { published: { ok: boolean } }).published.ok).toBe(true);
    // A tombstone names no snapshot, so it writes exactly one record — and it
    // swaps on the head the publication left behind.
    expect(pointerWrites()).toHaveLength(2);
    expect(pointerWrites()[1]?.swapRecord).toBe('cid-2');
    expect(writes.filter((w) => w.collection.endsWith('catalogSnapshot'))).toHaveLength(1);
    const stored = pointers.get('chairs');
    expect(stored?.withdrawn).toBe(true);
    expect(stored?.snapshotDigest).toBe('');
  });

  it('reports 409 rather than 200 when the tombstone write is refused', async () => {
    const first = await publish();
    failPointer = true;
    const resp = await router.handle(
      post('/v1/commerce/catalog/withdraw', {
        catalog_id: 'chairs',
        published_at: '2026-08-08T11:00:00.000Z',
        previous: pointerOf(first),
      }),
    );
    expect(resp.status).toBe(409);
    // Still live in the node's own record, which is the honest state: the
    // catalog was NOT retired.
    expect(pointers.get('chairs')?.withdrawn).toBe(false);
  });

  it('withdraws using ONLY what the published projection gives a client', async () => {
    // THE ACTION HAS TO BE PERFORMABLE BY WHOEVER WAS OFFERED IT.
    // `describeCatalogForOwner` offers `withdraw`, and its view carries
    // catalogId / state / headline / detail / actions / snapshotSequence /
    // publishedAtMs — no pointer, no digest, no sequence to extend. The
    // withdraw route used to demand a full valid `previous` pointer, so a
    // client reading the projection could see the action and had no reachable
    // way to build the body for it. Publish already tolerated an absent
    // `previous`; withdraw now agrees.
    await publish();
    const listed = await router.handle(get('/v1/commerce/catalog/published'));
    expect(listed.status).toBe(200);
    const view = (listed.body as { catalogs: { catalogId: string; actions: string[] }[] })
      .catalogs[0];
    expect(view?.actions).toContain('withdraw');

    const resp = await router.handle(
      post('/v1/commerce/catalog/withdraw', {
        // Exactly the identifier the projection carried, and nothing else.
        catalog_id: view?.catalogId,
        published_at: '2026-08-08T11:00:00.000Z',
      }),
    );
    expect(resp.status).toBe(200);
    expect((resp.body as { published: { ok: boolean } }).published.ok).toBe(true);
    expect(pointers.get('chairs')?.withdrawn).toBe(true);
  });

  it('refuses to withdraw a catalog this node never published', async () => {
    // With `previous` optional, "no stored head and none supplied" is
    // reachable for the first time. Extending a chain that does not exist
    // would mean writing a GENESIS tombstone at sequence 1 — announcing the
    // end of something that never began, and forking any real chain that
    // exists elsewhere.
    const resp = await router.handle(
      post('/v1/commerce/catalog/withdraw', {
        catalog_id: 'never-published',
        published_at: '2026-08-08T11:00:00.000Z',
      }),
    );
    expect(resp.status).toBe(409);
    expect(resp.body).toMatchObject({ error: 'nothing_published' });
    expect(pointerWrites()).toHaveLength(0);
  });

  it('still refuses a supplied predecessor that disagrees with the stored head', async () => {
    // Optional does not mean ignored. When a caller DOES supply a pointer it
    // is still validated and still checked against the node's own record, so
    // making the field optional cannot be used to skip the staleness check.
    const first = await publish();
    const stale = { ...pointerOf(first), snapshot_sequence: 99 };
    const resp = await router.handle(
      post('/v1/commerce/catalog/withdraw', {
        catalog_id: 'chairs',
        published_at: '2026-08-08T11:00:00.000Z',
        previous: stale,
      }),
    );
    expect(resp.status).toBe(409);
    expect(pointers.get('chairs')?.withdrawn).toBe(false);
  });

  it('hands back the built tombstone when this node has no repo', async () => {
    const first = await publish();
    installCatalogRecordWriter(null);
    const resp = await router.handle(
      post('/v1/commerce/catalog/withdraw', {
        catalog_id: 'chairs',
        published_at: '2026-08-08T11:00:00.000Z',
        previous: pointerOf(first),
      }),
    );
    expect(resp.status).toBe(200);
    expect((resp.body as { published: unknown }).published).toBeNull();
    expect((resp.body as { pointer: CatalogPointer }).pointer.withdrawn).toBe(true);
  });
});

describe('recovering from a head this node and the repo disagree about', () => {
  it('REFUSES to publish when the row is there and unreadable', async () => {
    // The dangerous reading is "nothing published", which authorizes a GENESIS
    // at sequence 1 over a live chain. `get` collapses absent and unreadable
    // into null, so the route asks `has` as well.
    await publish();
    const stale = {
      get: (): null => null,
      has: (): boolean => true,
      list: (): [] => [],
      put: (): void => undefined,
    };
    installCommerceRuntime({
      availability: () => ({ available: true }),
      catalogPointers: stale,
    } as unknown as CommerceRuntime);

    const resp = await publish({ published_at: '2026-08-08T10:00:00.000Z' });
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe('published_head_unreadable');
  });

  /**
   * ADOPTION READS THE REPO. It does not take the operator's word for what the
   * repo says — that was the first version, and it let a caller pair the live
   * CID with a fabricated high-sequence pointer, so the next CAS would succeed
   * while publishing a successor to a record that never existed.
   */
  function installReader(answer: { record: unknown; cid: string } | null | Error): void {
    installCatalogRecordReader(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
  }

  it('adopts the head the REPO reports, with the CID the repo issued', async () => {
    const first = await publish();
    // Divergence: the repo moved on and this node never learned.
    const live = { ...pointerOf(first), snapshot_sequence: 7 };
    installReader({ record: live, cid: 'cid-live-head' });

    const adopted = await router.handle(
      post('/v1/commerce/catalog/adopt', { catalog_id: 'chairs' }),
    );
    expect(adopted.status).toBe(200);
    expect(pointers.get('chairs')?.pointer.snapshot_sequence).toBe(7);
    expect(pointers.get('chairs')?.pointerCid).toBe('cid-live-head');

    // The next publication continues from the ADOPTED head, swapping on the
    // CID the repo actually issued.
    const next = await publish({ published_at: '2026-08-08T12:00:00.000Z' });
    expect(pointerOf(next).snapshot_sequence).toBe(8);
    expect(pointerWrites()[1]?.swapRecord).toBe('cid-live-head');
  });

  it('refuses a request that names no catalog', async () => {
    const resp = await router.handle(post('/v1/commerce/catalog/adopt', {}));
    expect(resp.status).toBe(400);
  });

  it('refuses when this node has no way to READ its repo', async () => {
    installCatalogRecordReader(null);
    const resp = await router.handle(post('/v1/commerce/catalog/adopt', { catalog_id: 'chairs' }));
    expect(resp.status).toBe(503);
    expect((resp.body as { error: string }).error).toBe('no_catalog_record_reader');
  });

  it('reports 404 when the repo holds no pointer for that catalog', async () => {
    // Adopting "absent" as a head would record a publication that never
    // happened. An empty store already produces the right answer: a genesis.
    installReader(null);
    const resp = await router.handle(post('/v1/commerce/catalog/adopt', { catalog_id: 'chairs' }));
    expect(resp.status).toBe(404);
  });

  it('reports the repo being unreachable apart from it being empty', async () => {
    installReader(new Error('the PDS is down'));
    const resp = await router.handle(post('/v1/commerce/catalog/adopt', { catalog_id: 'chairs' }));
    expect(resp.status).toBe(503);
    expect((resp.body as { error: string }).error).toBe('catalog_repo_unreachable');
  });

  it.each([
    [
      'a record that is not a pointer',
      { record: { catalog_id: 'chairs' }, cid: 'cid-x' },
      'published_pointer_is_invalid',
    ],
  ])('refuses %s', async (_name, answer, error) => {
    installReader(answer as { record: unknown; cid: string });
    const resp = await router.handle(post('/v1/commerce/catalog/adopt', { catalog_id: 'chairs' }));
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe(error);
  });

  it('refuses a repo answer about a DIFFERENT catalog', async () => {
    const first = await publish();
    installReader({ record: { ...pointerOf(first), catalog_id: 'desks' }, cid: 'cid-x' });
    const resp = await router.handle(post('/v1/commerce/catalog/adopt', { catalog_id: 'chairs' }));
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe('published_pointer_names_another_catalog');
  });

  it('refuses a pointer belonging to ANOTHER SUPPLIER', async () => {
    // Adopting it would let this node publish successors under someone else's
    // name — the same rule the server's writer enforces before every write.
    const first = await publish();
    installReader({
      record: { ...pointerOf(first), supplier_did: 'did:plc:someoneelse' },
      cid: 'cid-x',
    });
    const resp = await router.handle(post('/v1/commerce/catalog/adopt', { catalog_id: 'chairs' }));
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe('published_pointer_names_another_supplier');
  });

  it.each(['brain', 'agent', 'plugin', 'device', 'service', 'admin', 'connector', ''])(
    'refuses caller type %p on adopt',
    async (callerType) => {
      // It rewrites what this node believes it published. Owner-only.
      const resp = await router.handle(post('/v1/commerce/catalog/adopt', {}, callerType));
      expect(resp.status).toBe(403);
    },
  );
});

describe('§16.2 fences the WRITE, not the build', () => {
  /** A node that loses authority partway through a publication. */
  function fenceAfter(calls: number): void {
    let seen = 0;
    installCommerceRuntime({
      availability: () =>
        seen++ < calls
          ? { available: true }
          : { available: false, reason: 'superseded', detail: 'another node restored' },
      catalogPointers: pointers,
    } as unknown as CommerceRuntime);
  }

  it('abandons the publication when authority is lost DURING the snapshot write', async () => {
    // The snapshot write is an awaited round trip. A fence consulted only at
    // the start of the request is consulted at the one moment it could not yet
    // have failed — and the head would advance afterwards regardless.
    fenceAfter(1);
    const resp = await publish();
    expect(resp.status).toBe(409);
    expect((resp.body as { published: { refusal: string } }).published.refusal).toBe(
      'fenced_before_pointer',
    );
    // The snapshot landed and the HEAD did not, which is the safe half:
    // consumers still see the previous publication.
    expect(writes.filter((w) => w.collection.endsWith('catalogSnapshot'))).toHaveLength(1);
    expect(pointerWrites()).toHaveLength(0);
    expect(pointers.get('chairs')).toBeNull();
  });

  it('fences a WITHDRAWAL too, now that a withdrawal writes', async () => {
    // The earlier decision left withdrawal unfenced because it only BUILT a
    // tombstone. A superseded node writing an irreversible tombstone into a
    // repo it no longer owns is exactly what §16.2 is for.
    const first = await publish();
    fenceAfter(0);
    const resp = await router.handle(
      post('/v1/commerce/catalog/withdraw', {
        catalog_id: 'chairs',
        published_at: '2026-08-08T11:00:00.000Z',
        previous: pointerOf(first),
      }),
    );
    expect(resp.status).toBe(503);
    expect((resp.body as { error: string }).error).toBe('commerce_unavailable');
    // Still live in this node's own record: the catalog was NOT retired.
    expect(pointers.get('chairs')?.withdrawn).toBe(false);
  });
});

describe('the published-catalog surface', () => {
  it.each(['brain', 'agent', 'plugin', 'device', 'service', 'admin', 'connector', ''])(
    'refuses caller type %p',
    async (callerType) => {
      const resp = await router.handle(get('/v1/commerce/catalog/published', callerType));
      expect(resp.status).toBe(403);
      expect((resp.body as { error: string }).error).toBe('access_denied');
    },
  );

  it('says the node has no commerce rather than showing an empty list', async () => {
    installCommerceRuntime(null);
    const resp = await router.handle(get('/v1/commerce/catalog/published'));
    expect(resp.status).toBe(503);
    expect((resp.body as { error: string }).error).toBe('commerce_unavailable');
  });

  it('is empty, not absent, before anything is published', async () => {
    const resp = await router.handle(get('/v1/commerce/catalog/published'));
    expect(resp.status).toBe(200);
    expect((resp.body as { catalogs: unknown[] }).catalogs).toEqual([]);
  });

  it('renders each catalog through the ONE projection', async () => {
    await publish();
    await publish({ catalog_id: 'desks', published_at: '2026-08-08T10:00:00.000Z' });
    const live = await router.handle(get('/v1/commerce/catalog/published'));
    const body = live.body as {
      catalogs: { catalogId: string; state: string; actions: string[] }[];
    };
    const byId = new Map(body.catalogs.map((c) => [c.catalogId, c]));
    expect(byId.get('chairs')?.state).toBe('published');
    expect(byId.get('chairs')?.actions).toEqual(['view', 'republish', 'withdraw']);

    // Retire one, and the card stops offering to retire it again.
    await router.handle(
      post('/v1/commerce/catalog/withdraw', {
        catalog_id: 'chairs',
        published_at: '2026-08-08T11:00:00.000Z',
        previous: pointers.get('chairs')?.pointer as unknown as Record<string, unknown>,
      }),
    );
    const after = await router.handle(get('/v1/commerce/catalog/published'));
    const cards = (
      after.body as { catalogs: { catalogId: string; state: string; actions: string[] }[] }
    ).catalogs;
    const chairs = cards.find((c) => c.catalogId === 'chairs');
    expect(chairs?.state).toBe('withdrawn');
    expect(chairs?.actions).not.toContain('withdraw');
    // The other catalog is untouched — a withdrawal retires one chain, not the
    // supplier.
    expect(cards.find((c) => c.catalogId === 'desks')?.state).toBe('published');
  });
});

/**
 * §10.5 (DR-5, NEW-10) — the listing is a published fact, not a per-request one.
 *
 * The producer half of DR-5 landed on the builders and then only half reached
 * the routes: `service_rkey` was read from the request body and nowhere else,
 * so a supplier who published seq 1 with `chairs` and then republished — a
 * reprice, a stock change, anything — silently reverted every buyer to `self`
 * with no error to look at. And `buildCatalogWithdrawal`'s new parameter had
 * no caller that ever supplied it, which is the unreached-capability shape
 * this whole field was added to fix.
 *
 * This route already refuses a MISSING `items` array on exactly this
 * reasoning: a dropped field must not retire a published fact.
 */
describe('the listing survives a republication', () => {
  it('carries a stated listing onto the pointer', async () => {
    const resp = await publish({ service_rkey: 'chairs' });
    expect(resp.status).toBe(200);
    expect(pointerOf(resp).service_rkey).toBe('chairs');
  });

  it('INHERITS it when a later publication does not restate it', async () => {
    await publish({ service_rkey: 'chairs' });

    const second = await publish({
      published_at: '2026-08-08T10:00:00.000Z',
      items: [{ sku: 'CHAIR-1', name: 'Oak chair' }, { sku: 'CHAIR-2', name: 'Ash chair' }],
    });

    expect(second.status).toBe(200);
    expect(pointerOf(second).service_rkey).toBe('chairs');
  });

  it('lets a supplier MOVE the catalog by restating it', async () => {
    await publish({ service_rkey: 'chairs' });
    const moved = await publish({
      published_at: '2026-08-08T10:00:00.000Z',
      service_rkey: 'seating',
    });

    expect(pointerOf(moved).service_rkey).toBe('seating');
  });

  it('stays absent when it was never stated', async () => {
    const resp = await publish();
    expect('service_rkey' in pointerOf(resp)).toBe(false);
  });

  it('refuses a listing rkey that would splice the AT-URI', async () => {
    const resp = await publish({ service_rkey: 'a/b' });
    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toBe('service_rkey is not a usable record key');
  });

  it('carries it onto the TOMBSTONE when the catalog is withdrawn', async () => {
    await publish({ service_rkey: 'chairs' });

    const withdrawn = await router.handle(
      post('/v1/commerce/catalog/withdraw', {
        catalog_id: 'chairs',
        published_at: '2026-08-08T11:00:00.000Z',
      }),
    );

    expect(withdrawn.status).toBe(200);
    expect(pointerOf(withdrawn).service_rkey).toBe('chairs');
  });
});
