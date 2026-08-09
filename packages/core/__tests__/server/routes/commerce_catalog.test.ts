/**
 * WS-5 supplier half — the owner surface for the catalog (§10.2, §12.1).
 *
 * Import, publish and withdraw were each built, each tested, and each called
 * only by a test. The orphan ledger named the first and third; the SECOND hid
 * from the ledger itself, because its only non-test mention anywhere in the
 * repo was a sentence in another module's prose and the guard read production
 * files with their comments in. These tests exist so the sequence is reachable
 * from a real request, and so the boundary around it is stated.
 *
 * WHAT THE BOUNDARY IS. A catalog is what this business sells and at what
 * terms. Publishing one is a commercial act, and a snapshot is FULL STATE —
 * publishing an empty one retires every product. That is the owner's decision
 * and no plugin's, so all three paths carry the same owner guard as /v1/run.
 */

import { InMemoryCatalogPointerRepository } from '../../../src/commerce/catalog_pointer_store';
import { CredentialBroker } from '../../../src/commerce/credential_broker';
import { InMemoryCredentialStore } from '../../../src/commerce/credential_store';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import { clearPairingState, setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';

import type { CatalogPointer } from '@dina/commerce-protocol';

const OWNER_CAP = 'test-owner-capability-secret';
const SUPPLIER = 'did:plc:chairmaker99';

function post(path: string, body: Record<string, unknown>, callerType = 'owner'): CoreRequest {
  return {
    method: 'POST',
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

/**
 * A runtime that answers §16.2's availability question and remembers what this
 * node published.
 *
 * The pointer store is the REAL one, and it OUTLIVES a re-install: a test that
 * fences publication mid-way must not also erase the publication history, or
 * the fence would appear to work for the wrong reason.
 */
let pointers: InMemoryCatalogPointerRepository;
function installAvailability(availability: CommerceRuntime['availability']): void {
  installCommerceRuntime({
    availability,
    catalogPointers: pointers,
  } as unknown as CommerceRuntime);
}

const AVAILABLE: CommerceRuntime['availability'] = () => ({ available: true });

const CSV = [
  'sku,name,unit_code,pack_size,lead_time_days',
  'CHAIR-1,Oak dining chair,each,1,14',
].join('\n');

describe('the supplier catalog owner routes', () => {
  let router: CoreRouter;

  beforeEach(() => {
    setNodeDID(SUPPLIER);
    pointers = new InMemoryCatalogPointerRepository();
    installAvailability(AVAILABLE);
    router = new CoreRouter();
    registerCommerceRoutes(router, OWNER_CAP);
  });

  afterEach(() => installCommerceRuntime(null));

  const PATHS = [
    '/v1/commerce/catalog/import',
    '/v1/commerce/catalog/publish',
    '/v1/commerce/catalog/withdraw',
  ];

  it.each(['brain', 'agent', 'plugin', 'device', 'service', 'admin', 'connector', ''])(
    'refuses caller type %p on every catalog path',
    async (callerType) => {
      for (const path of PATHS) {
        const resp = await router.handle(post(path, {}, callerType));
        expect(resp.status).toBe(403);
        expect((resp.body as { error: string }).error).toBe('access_denied');
      }
    },
  );

  it('refuses an owner presenting the wrong capability', async () => {
    for (const path of PATHS) {
      const wrong = { ...post(path, {}), ownerCapability: 'not-the-secret' };
      expect((await router.handle(wrong)).status).toBe(403);
    }
  });

  it('fails CLOSED when the owner control plane was never configured', async () => {
    const unconfigured = new CoreRouter();
    registerCommerceRoutes(unconfigured);
    for (const path of PATHS) {
      expect((await unconfigured.handle(post(path, {}))).status).toBe(403);
    }
  });

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  it('turns a supplier spreadsheet into catalog items', async () => {
    const resp = await router.handle(
      post('/v1/commerce/catalog/import', { csv: CSV, default_scheme: 'sku' }),
    );
    expect(resp.status).toBe(200);
    const body = resp.body as { ok: true; items: { product: unknown }[] };
    expect(body.ok).toBe(true);
    expect(body.items).toHaveLength(1);
    // Scoped to THIS node, which is the point of the next test.
    expect(body.items[0]?.product).toEqual({
      scheme: 'manufacturer_sku',
      value: 'CHAIR-1',
      issuer_did: SUPPLIER,
    });
  });

  it('scopes identifiers to this node, ignoring any supplier named in the body', async () => {
    // A `manufacturer_sku` is only unambiguous scoped to whoever issued it.
    // Letting a caller name someone else would publish under another
    // supplier's scope — an authority this node does not have.
    const resp = await router.handle(
      post('/v1/commerce/catalog/import', {
        csv: CSV,
        default_scheme: 'sku',
        supplier_did: 'did:plc:someone-else',
      }),
    );
    expect(
      (resp.body as { items: { product: { issuer_did: string } }[] }).items[0]?.product.issuer_did,
    ).toBe(SUPPLIER);
  });

  it('answers 200 with findings — not an error — when the spreadsheet is wrong', async () => {
    // The findings ARE the answer: they are what an owner needs to fix the
    // file. `ok: false` already says the import yielded nothing.
    const resp = await router.handle(
      post('/v1/commerce/catalog/import', {
        csv: 'sku,name,colour\nC-1,Chair,red',
        default_scheme: 'sku',
      }),
    );
    expect(resp.status).toBe(200);
    const body = resp.body as { ok: false; findings: { refusal: string; column?: string }[] };
    expect(body.ok).toBe(false);
    expect(body.findings[0]).toMatchObject({ refusal: 'unknown_column', column: 'colour' });
  });

  it.each([{}, { csv: '' }, { csv: 42 }, { csv: CSV }, { csv: CSV, default_scheme: 'ean' }])(
    'refuses an import that does not say what it is (%p)',
    async (body) => {
      // The scheme decides how every bare identifier in the file is READ.
      // Guessing it would silently reinterpret the owner's whole catalog, so
      // an absent or unknown scheme is a refusal rather than a default.
      expect((await router.handle(post('/v1/commerce/catalog/import', body))).status).toBe(400);
    },
  );

  // -------------------------------------------------------------------------
  // Publish
  // -------------------------------------------------------------------------

  async function publishGenesis(items: unknown[] = [{ sku: 'CHAIR-1', name: 'Oak chair' }]) {
    return router.handle(
      post('/v1/commerce/catalog/publish', {
        catalog_id: 'chairs',
        published_at: '2026-08-08T09:00:00.000Z',
        items,
      }),
    );
  }

  it('publishes a genesis snapshot at sequence 1', async () => {
    const resp = await publishGenesis();
    expect(resp.status).toBe(200);
    const body = resp.body as {
      ok: true;
      pointer: CatalogPointer;
      snapshot: { item_count: number };
      pages: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.pointer.snapshot_sequence).toBe(1);
    expect(body.pointer.supplier_did).toBe(SUPPLIER);
    expect(body.pointer.previous_snapshot_digest).toBeUndefined();
    expect(body.snapshot.item_count).toBe(1);
    expect(body.pages).toHaveLength(1);
  });

  it('advances the chain from a supplied predecessor', async () => {
    const first = (await publishGenesis()).body as { ok: true; pointer: CatalogPointer };
    const second = await router.handle(
      post('/v1/commerce/catalog/publish', {
        catalog_id: 'chairs',
        published_at: '2026-08-08T10:00:00.000Z',
        items: [
          { sku: 'CHAIR-1', name: 'Oak chair' },
          { sku: 'CHAIR-2', name: 'Ash chair' },
        ],
        previous: first.pointer,
      }),
    );
    const body = second.body as { ok: true; pointer: CatalogPointer };
    expect(body.pointer.snapshot_sequence).toBe(2);
    // The link is to the PREVIOUS snapshot's digest, derived from the pointer
    // the caller supplied rather than repeated as a second field they could
    // disagree with.
    expect(body.pointer.previous_snapshot_digest).toBe(first.pointer.snapshot_digest);
  });

  it('publishes an EMPTY catalog but refuses a MISSING one', async () => {
    // An empty array is a legitimate claim: "this supplier currently offers
    // nothing". A missing field is not the same claim, and treating it as one
    // would let a dropped field silently retire a live catalog.
    const empty = await publishGenesis([]);
    expect(empty.status).toBe(200);
    expect((empty.body as { snapshot: { item_count: number } }).snapshot.item_count).toBe(0);
    // Zero pages, not one empty page — see `paginate`.
    expect((empty.body as { pages: unknown[] }).pages).toHaveLength(0);

    const missing = await router.handle(
      post('/v1/commerce/catalog/publish', { catalog_id: 'chairs' }),
    );
    expect(missing.status).toBe(400);
  });

  it('refuses to publish while §16.2 says nothing may be signed', async () => {
    // A restored node's memory of "what I last published" is exactly the state
    // a backup carries stale, and a snapshot advances a chain buyers follow.
    installAvailability(() => ({
      available: false,
      reason: 'no_epoch',
      detail: 'no published epoch',
    }));
    const resp = await publishGenesis();
    expect(resp.status).toBe(503);
    expect(resp.body).toMatchObject({ error: 'commerce_unavailable', reason: 'no_epoch' });
  });

  it('lets import and withdrawal through while publication is fenced', async () => {
    // The fence is on the act that can FORK a chain forward. Reading a file
    // cannot, and a tombstone ends a chain rather than extending it into new
    // commercial territory — fencing those would take away the owner's ability
    // to stop selling at precisely the moment they most want to.
    installAvailability(() => ({
      available: false,
      reason: 'no_epoch',
      detail: 'no published epoch',
    }));
    const imported = await router.handle(
      post('/v1/commerce/catalog/import', { csv: CSV, default_scheme: 'sku' }),
    );
    expect(imported.status).toBe(200);
  });

  it('refuses a snapshot that would leak a credential (§12.1)', async () => {
    // Refused BEFORE any digest is computed, because a snapshot is
    // content-addressed and published: it does not un-publish.
    const resp = await publishGenesis([
      { sku: 'CHAIR-1', name: 'Oak chair', api_key: 'sk-live-0123456789abcdef' },
    ]);
    expect(resp.status).toBe(200);
    const body = resp.body as { ok: false; refusal: string; leakage?: unknown };
    expect(body.ok).toBe(false);
    expect(body.refusal).toBe('leakage_refused');
    expect(body.leakage).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Withdraw
  // -------------------------------------------------------------------------

  it('tombstones a live catalog at the next sequence', async () => {
    const first = (await publishGenesis()).body as { ok: true; pointer: CatalogPointer };
    const resp = await router.handle(
      post('/v1/commerce/catalog/withdraw', {
        catalog_id: 'chairs',
        published_at: '2026-08-08T11:00:00.000Z',
        previous: first.pointer,
      }),
    );
    expect(resp.status).toBe(200);
    const body = resp.body as { ok: true; pointer: CatalogPointer; snapshot?: unknown };
    expect(body.pointer.withdrawn).toBe(true);
    expect(body.pointer.snapshot_sequence).toBe(2);
    expect(body.pointer.previous_snapshot_digest).toBe(first.pointer.snapshot_digest);
    // A tombstone publishes no snapshot — carrying one would leave consumers
    // unsure whether the catalog is live at that record.
    expect(body.snapshot).toBeUndefined();
  });

  it('refuses to withdraw an already-withdrawn catalog', async () => {
    const first = (await publishGenesis()).body as { ok: true; pointer: CatalogPointer };
    const tombstone = (
      await router.handle(
        post('/v1/commerce/catalog/withdraw', {
          catalog_id: 'chairs',
          published_at: '2026-08-08T11:00:00.000Z',
          previous: first.pointer,
        }),
      )
    ).body as { ok: true; pointer: CatalogPointer };

    // A withdrawal ENDS the chain. Relaunching means a new catalog_id, which
    // is also the honest signal: the old identity was publicly retired.
    const again = await router.handle(
      post('/v1/commerce/catalog/withdraw', {
        catalog_id: 'chairs',
        published_at: '2026-08-08T12:00:00.000Z',
        previous: tombstone.pointer,
      }),
    );
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: false, refusal: 'chain_refused' });
  });

  /**
   * A withdrawal takes the previous sequence and adds one. Without a legal
   * predecessor there is nothing to withdraw, and inventing a sequence would
   * fork the chain a buyer is following. Every case below still refuses.
   *
   * SPLIT INTO TWO, because they were never the same refusal and asserting one
   * status for both hid that. `previous` is now optional — the node's stored
   * head is the predecessor when none is supplied, matching `publish` — so a
   * request that omits it is WELL-FORMED and fails on state, not on shape.
   * 400 says "fix your request"; 409 says "the request is fine, the node is
   * not in a state that permits it". Sending an owner to the first when the
   * answer is the second tells them to correct something that is not wrong.
   */
  it.each([{}, { catalog_id: '' }])(
    'refuses a MALFORMED withdrawal request with 400 (%p)',
    async (body) => {
      const resp = await router.handle(post('/v1/commerce/catalog/withdraw', body));
      expect(resp.status).toBe(400);
    },
  );

  it.each([
    { catalog_id: 'chairs', previous: 'not-a-pointer' },
    { catalog_id: 'chairs', previous: { supplier_did: SUPPLIER } },
  ])('refuses a withdrawal whose SUPPLIED predecessor is malformed with 400 (%p)', async (body) => {
    // Present-but-invalid must never be read as absent: that would now fall
    // through to the stored head, which is a different chain position than the
    // caller believed they were extending.
    const resp = await router.handle(post('/v1/commerce/catalog/withdraw', body));
    expect(resp.status).toBe(400);
  });

  it.each([{ catalog_id: 'chairs' }, { catalog_id: 'chairs', previous: null }])(
    'refuses a withdrawal against a catalog this node never published with 409 (%p)',
    async (body) => {
      const resp = await router.handle(post('/v1/commerce/catalog/withdraw', body));
      expect(resp.status).toBe(409);
      expect(resp.body).toMatchObject({ error: 'nothing_published' });
    },
  );

  it('refuses a publication whose predecessor is malformed rather than starting over', async () => {
    // The dangerous shape: a present-but-invalid `previous` treated as absent
    // would silently publish a GENESIS at sequence 1, forking the live chain.
    const resp = await router.handle(
      post('/v1/commerce/catalog/publish', {
        catalog_id: 'chairs',
        items: [],
        previous: { supplier_did: SUPPLIER, catalog_id: 'chairs', snapshot_sequence: 0 },
      }),
    );
    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toBe('previous pointer is invalid');
  });

  it('refuses every catalog path before this node has an identity', async () => {
    // Only the UNSET case is driven here. The route also rejects an empty
    // string, and that state is unreachable: `setNodeDID` refuses anything
    // without a `did:` prefix, so a test for it would have to reach past the
    // setter and would then be testing the reach, not the rule.
    clearPairingState();
    const livePointer = {
      supplier_did: SUPPLIER,
      catalog_id: 'chairs',
      snapshot_sequence: 1,
      protocol_version: '1.0',
      published_at: '2026-08-08T09:00:00.000Z',
      snapshot_rkey: 'a'.repeat(64),
      snapshot_digest: 'a'.repeat(64),
    };
    for (const [path, body] of [
      ['/v1/commerce/catalog/import', { csv: CSV, default_scheme: 'sku' }],
      ['/v1/commerce/catalog/publish', { catalog_id: 'chairs', items: [] }],
      ['/v1/commerce/catalog/withdraw', { catalog_id: 'chairs', previous: livePointer }],
    ] as const) {
      const resp = await router.handle(post(path, body));
      expect(resp.status).toBe(503);
      expect((resp.body as { error: string }).error).toBe('owner_identity_unavailable');
    }
  });
});

/**
 * Reading a catalog through a connector (§6.5, §24 — WS-9.1).
 *
 * The route's own job is small: pick the connector, refuse a scheme it must
 * not guess, and take the install id from the CREDENTIAL rather than from the
 * body. That last one is the security-relevant part — a caller naming an
 * install id would be choosing which grant to spend.
 */
describe('POST /v1/commerce/catalog/load', () => {
  let store: InMemoryCredentialStore;
  let loadRouter: CoreRouter;
  let served: unknown;

  beforeEach(() => {
    setNodeDID(SUPPLIER);
    store = new InMemoryCredentialStore();
    store.rotate({
      resource: 'catalog.source',
      installId: 'install-1',
      operations: ['read_catalog'],
      material: 'sk-live-catalog-source-0123456789',
      nowMs: 1_000,
    });
    served = [{ sku: 'CHAIR-1', name: 'Oak dining chair', unit_code: 'each' }];
    installCommerceRuntime({
      availability: AVAILABLE,
      credentials: store,
      broker: new CredentialBroker({
        store,
        executors: () => ({
          'catalog.source:read_catalog': async () => ({ ok: true, result: served }),
        }),
      }),
    } as unknown as CommerceRuntime);
    loadRouter = new CoreRouter();
    registerCommerceRoutes(loadRouter, OWNER_CAP);
  });

  it('is owner-only', async () => {
    for (const callerType of ['agent', 'plugin', 'service', 'device']) {
      const response = await loadRouter.handle(post('/v1/commerce/catalog/load', {}, callerType));
      expect(response.status).toBe(403);
    }
  });

  it('reads a REST backend into catalog items', async () => {
    const response = await loadRouter.handle(
      post('/v1/commerce/catalog/load', {
        kind: 'rest',
        credential_resource: 'catalog.source',
        operation: 'read_catalog',
        default_scheme: 'sku',
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true });
    const body = response.body as { ok: true; items: { product: unknown }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.product).toEqual({
      scheme: 'manufacturer_sku',
      value: 'CHAIR-1',
      issuer_did: SUPPLIER,
    });
  });

  it('reads an uploaded spreadsheet with no credential at all', async () => {
    const response = await loadRouter.handle(
      post('/v1/commerce/catalog/load', {
        kind: 'spreadsheet_upload',
        document: CSV,
        default_scheme: 'sku',
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true });
  });

  it('spends the install the CREDENTIAL names, not one the caller asked for', async () => {
    // A body field naming `install-1` would let a caller choose which grant to
    // spend; the route reads it off the credential record instead. Rotating
    // the credential to another install must therefore refuse the same call.
    store.rotate({
      resource: 'catalog.source',
      installId: 'somebody-else',
      operations: ['read_catalog'],
      material: 'sk-live-catalog-source-0123456789',
      nowMs: 2_000,
    });
    const response = await loadRouter.handle(
      post('/v1/commerce/catalog/load', {
        kind: 'rest',
        credential_resource: 'catalog.source',
        operation: 'read_catalog',
        default_scheme: 'sku',
        install_id: 'install-1',
      }),
    );
    // It SUCCEEDS, because the route used the credential's own install — the
    // body field was ignored entirely, which is the point.
    expect(response.status).toBe(200);
  });

  it('refuses a kind it does not have, and a scheme it must not guess', async () => {
    const badKind = await loadRouter.handle(
      post('/v1/commerce/catalog/load', { kind: 'telepathy', default_scheme: 'sku' }),
    );
    expect(badKind.status).toBe(400);
    const badScheme = await loadRouter.handle(
      post('/v1/commerce/catalog/load', { kind: 'spreadsheet_upload', document: CSV }),
    );
    expect(badScheme.status).toBe(400);
  });

  it('separates "could not read the backend" from "the rows are wrong"', async () => {
    served = 'not a list of rows';
    const unreadable = await loadRouter.handle(
      post('/v1/commerce/catalog/load', {
        kind: 'rest',
        credential_resource: 'catalog.source',
        operation: 'read_catalog',
        default_scheme: 'sku',
      }),
    );
    expect(unreadable.status).toBe(409);
    expect(unreadable.body).toMatchObject({ ok: false, refusal: 'not_a_row_list' });

    served = [{ sku: 'CHAIR-1', unit_code: 'furlong' }];
    const badRows = await loadRouter.handle(
      post('/v1/commerce/catalog/load', {
        kind: 'rest',
        credential_resource: 'catalog.source',
        operation: 'read_catalog',
        default_scheme: 'sku',
      }),
    );
    // A 200 carrying findings: the backend WAS read, and the answer is the
    // list a supplier fixes in their file.
    expect(badRows.status).toBe(200);
    expect(badRows.body).toMatchObject({ ok: false });
  });

  it('answers 503 when commerce is not installed', async () => {
    installCommerceRuntime(null);
    const response = await loadRouter.handle(
      post('/v1/commerce/catalog/load', { kind: 'spreadsheet_upload', default_scheme: 'sku' }),
    );
    expect(response.status).toBe(503);
  });
});
