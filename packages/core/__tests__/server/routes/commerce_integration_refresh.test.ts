/**
 * The catalogue refresh (JIFFY_MERCHANT_INTEGRATION_PLAN §3.1, A1) through
 * the REAL commerce routes on a SQLite runtime: the owner binds a REST
 * source once; a granted integration asks for the same pull again and gets a
 * `prepared` draft waiting for the owner; the body can name no source; the
 * same command replays the same draft; an expected digest is checked before
 * a draft exists; publication stays the owner's route.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  createCommerceRuntime,
  installCommerceRuntime,
  type CommerceRuntime,
} from '../../../src/commerce/runtime';
import { clearPairingState, setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';

import type { BrokeredExecutor } from '../../../src/commerce/credential_broker';

const SUPPLIER = 'did:plc:supplier5678';
const DEVICE = 'did:key:zJiffyIntegration';
const OWNER_CAP = 'test-owner-capability-secret';
const CATALOG = 'cat-bakery';
const T0 = 1_800_000_000_000;

let dir: string;
let adapter: NodeSQLiteAdapter;
let runtime: CommerceRuntime;
let router: CoreRouter;
/** What Jiffy's endpoint serves; the test changes it between pulls. */
let served: Record<string, unknown>[];
let pulls: number;
/** When set, the next pull fails the way an unreachable endpoint does. */
let failNextPull: string | null;

function request(
  method: 'GET' | 'POST',
  p: string,
  caller: Partial<CoreRequest>,
  body: Record<string, unknown> = {},
  query: Record<string, string> = {},
): CoreRequest {
  return {
    method,
    path: p,
    query,
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...caller,
  } as CoreRequest;
}
const owner = (
  method: 'GET' | 'POST',
  p: string,
  body?: Record<string, unknown>,
  query?: Record<string, string>,
): CoreRequest =>
  request(
    method,
    p,
    { callerType: 'owner', callerDID: 'did:key:owner', ownerCapability: OWNER_CAP },
    body,
    query,
  );
const device = (
  method: 'GET' | 'POST',
  p: string,
  body?: Record<string, unknown>,
  query?: Record<string, string>,
): CoreRequest => request(method, p, { callerType: 'staff', callerDID: DEVICE }, body, query);

beforeEach(() => {
  served = [{ identifier: 'CAKE-1', name: 'Birthday cake', pack_size: '1', unit_code: 'each' }];
  pulls = 0;
  failNextPull = null;
  dir = mkdtempSync(path.join(tmpdir(), 'integration-refresh-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  const executor: BrokeredExecutor = async () => {
    pulls += 1;
    if (failNextPull !== null) {
      const error = failNextPull;
      failNextPull = null;
      return { ok: false, error };
    }
    return { ok: true, result: served };
  };
  runtime = createCommerceRuntime({
    adapter,
    supplierDid: () => SUPPLIER,
    currentEpoch: () => '2',
    now: () => T0,
    verifyHeldEvidence: () => true,
    credentialExecutors: () => ({ 'catalog.source:read_catalog': executor }),
  });
  const written = runtime.settings.writeSupplier({
    actingBusinessDid: SUPPLIER,
    catalogSource: {
      kind: 'feed',
      url: 'https://jiffy.example/merchants/bakery/catalog',
      lastHealthyAtIso: null,
    },
    publicRegions: [{ scheme: 'admin_area', value: 'US-CA' }],
    publishIndicativePrice: true,
    quoteAccess: 'anyone',
    responsePolicy: {},
    customerPricingSource: null,
    orderAcceptance: 'review',
    listingState: 'live',
    connectors: [],
    catalogCategoryIds: ['food.bakery'],
  } as never);
  if (!written.ok) throw new Error('fixture: supplier settings must be saveable');
  const rotated = runtime.credentials.rotate({
    resource: 'catalog.source',
    installId: 'install-1',
    operations: ['read_catalog'],
    material: 'sk-live-jiffy-merchant-token-0123456789',
    nowMs: T0,
  });
  if (!rotated.ok) throw new Error(`fixture: credential must store (${JSON.stringify(rotated)})`);
  installCommerceRuntime(runtime);
  setNodeDID(SUPPLIER);
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
  runtime.staffGrants.put({
    deviceDid: DEVICE,
    scope: 'integration_catalog_refresh',
    maxOrderMinorUnits: '',
    currency: '',
    installs: 'supplier',
    createdAt: T0,
    revokedAt: null,
  });
});

afterEach(() => {
  clearPairingState();
  installCommerceRuntime(null);
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

const REFRESH = '/v1/commerce/integration/catalog/refresh';

async function ownerBinds(): Promise<void> {
  const bound = await router.handle(
    owner('POST', '/v1/commerce/catalog/drafts/from_connector', {
      catalog_id: CATALOG,
      kind: 'rest',
      credential_resource: 'catalog.source',
      operation: 'read_catalog',
      default_scheme: 'sku',
    }),
  );
  expect(bound.status).toBe(200);
  expect(runtime.catalogSourceBindings.get(CATALOG)).toMatchObject({
    kind: 'rest',
    credentialResource: 'catalog.source',
    operation: 'read_catalog',
    defaultScheme: 'sku',
  });
}

describe('binding', () => {
  it('the owner’s connector draft remembers its source; an upload remembers nothing; a refresh without a binding is 404', async () => {
    const before = await router.handle(
      device('POST', REFRESH, { catalog_id: CATALOG, command_id: 'cmd-0' }),
    );
    expect(before.status).toBe(404);
    expect((before.body as { error: string }).error).toBe('no_source_binding');
    await ownerBinds();
    const uploaded = await router.handle(
      owner('POST', '/v1/commerce/catalog/drafts/from_connector', {
        catalog_id: 'cat-upload',
        kind: 'spreadsheet_upload',
        document: 'identifier,name,pack_size,unit_code\nX-1,Thing,1,each',
        default_scheme: 'sku',
      }),
    );
    expect(uploaded.status).toBe(200);
    expect(runtime.catalogSourceBindings.get('cat-upload')).toBeNull();
  });

  it('an upload of a bound catalog supersedes its source: the binding goes and a refresh is 404 again', async () => {
    await ownerBinds();
    const uploaded = await router.handle(
      owner('POST', '/v1/commerce/catalog/drafts/from_connector', {
        catalog_id: CATALOG,
        kind: 'spreadsheet_upload',
        document: 'identifier,name,pack_size,unit_code\nX-1,Thing,1,each',
        default_scheme: 'sku',
      }),
    );
    expect(uploaded.status).toBe(200);
    expect(runtime.catalogSourceBindings.get(CATALOG)).toBeNull();
    const after = await router.handle(
      device('POST', REFRESH, { catalog_id: CATALOG, command_id: 'cmd-after-upload' }),
    );
    expect(after.status).toBe(404);
    expect((after.body as { error: string }).error).toBe('no_source_binding');
  });
});

describe('refresh', () => {
  beforeEach(ownerBinds);

  it('pulls the bound source again and leaves a prepared draft for the owner; the body names no source and cannot change one', async () => {
    served = [
      { identifier: 'CAKE-1', name: 'Birthday cake', pack_size: '1', unit_code: 'each' },
      { identifier: 'CAKE-2', name: 'Gluten-free cake', pack_size: '1', unit_code: 'each' },
    ];
    const res = await router.handle(
      device('POST', REFRESH, {
        catalog_id: CATALOG,
        command_id: 'cmd-1',
        // Anything a caller might try to steer with is ignored: the binding rules.
        kind: 'spreadsheet_url',
        credential_resource: 'someone.elses.token',
        operation: 'delete_everything',
      }),
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      ok: boolean;
      replayed: boolean;
      source_digest: string;
      draft: {
        draft_id: string;
        state: string;
        provenance_class: string;
        findings_count: number;
        snapshot_digest: string | null;
      };
    };
    expect(body.replayed).toBe(false);
    expect(body.source_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(body.draft).toMatchObject({
      state: 'prepared',
      provenance_class: 'source_parsed',
      findings_count: 0,
    });
    expect(body.draft.snapshot_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(body.draft.draft_id.startsWith('cdr_int_')).toBe(true);
    expect(pulls).toBe(2); // the owner's bind and this refresh, both through the bound resource
    // Two items reached the draft; nothing was published.
    const draft = runtime.catalogDrafts.get(body.draft.draft_id);
    expect(draft?.items).toHaveLength(2);
    expect(runtime.catalogPointers.get(CATALOG)).toBeNull();
  });

  it('the same command replays the same draft without pulling; a new command pulls again', async () => {
    const first = await router.handle(
      device('POST', REFRESH, { catalog_id: CATALOG, command_id: 'cmd-2' }),
    );
    const firstId = (first.body as { draft: { draft_id: string } }).draft.draft_id;
    const again = await router.handle(
      device('POST', REFRESH, { catalog_id: CATALOG, command_id: 'cmd-2' }),
    );
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      ok: true,
      replayed: true,
      draft: { draft_id: firstId, state: 'prepared' },
    });
    expect(pulls).toBe(2);
    const other = await router.handle(
      device('POST', REFRESH, { catalog_id: CATALOG, command_id: 'cmd-3' }),
    );
    expect((other.body as { draft: { draft_id: string } }).draft.draft_id).not.toBe(firstId);
    expect(pulls).toBe(3);
    // Both drafts are listed to the integration, with no rows in the view.
    const drafts = await router.handle(
      device('GET', '/v1/commerce/integration/catalog/drafts', undefined, { catalog_id: CATALOG }),
    );
    expect(drafts.status).toBe(200);
    const list = (drafts.body as { drafts: { draft_id: string; state: string }[] }).drafts;
    // Two refreshes stopped at `prepared`; the owner's own bind draft is still `created` — theirs to take on.
    expect(list.map((d) => d.state).sort()).toEqual(['created', 'prepared', 'prepared']);
    expect(JSON.stringify(drafts.body)).not.toContain('Birthday cake');
  });

  it('a replay names the draft it minted; the same command under a different precondition is a conflict', async () => {
    const first = await router.handle(
      device('POST', REFRESH, { catalog_id: CATALOG, command_id: 'cmd-6' }),
    );
    expect(first.status).toBe(200);
    const minted = (first.body as { draft: { draft_id: string }; source_digest: string }).draft
      .draft_id;
    const pullsAfterFirst = pulls;
    const replay = await router.handle(
      device('POST', REFRESH, { catalog_id: CATALOG, command_id: 'cmd-6' }),
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      ok: true,
      replayed: true,
      draft_id: minted,
      source_digest: (first.body as { source_digest: string }).source_digest,
    });
    expect((replay.body as { draft: { draft_id: string } }).draft.draft_id).toBe(minted);
    expect(pulls).toBe(pullsAfterFirst);
    const conflict = await router.handle(
      device('POST', REFRESH, {
        catalog_id: CATALOG,
        command_id: 'cmd-6',
        source_digest: 'f'.repeat(64),
      }),
    );
    expect(conflict.status).toBe(409);
    expect((conflict.body as { error: string }).error).toBe('command_conflict');
    const otherCatalog = await router.handle(
      device('POST', REFRESH, { catalog_id: 'cat-other', command_id: 'cmd-6' }),
    );
    expect(otherCatalog.status).toBe(409);
    expect((otherCatalog.body as { error: string }).error).toBe('command_conflict');
    // The owner deleted the draft: the replay still answers with the id it minted.
    runtime.catalogDrafts.delete(minted);
    const afterDelete = await router.handle(
      device('POST', REFRESH, { catalog_id: CATALOG, command_id: 'cmd-6' }),
    );
    expect(afterDelete.body).toMatchObject({
      ok: true,
      replayed: true,
      draft_id: minted,
      draft: null,
    });
  });

  it('a failed refresh leaves nothing behind — no draft, no record — and the same command may try again', async () => {
    const before = runtime.catalogDrafts.listByCatalog(CATALOG).length;
    failNextPull = 'upstream 503';
    const failed = await router.handle(
      device('POST', REFRESH, { catalog_id: CATALOG, command_id: 'cmd-7' }),
    );
    expect(failed.status).toBe(409);
    expect(runtime.catalogDrafts.listByCatalog(CATALOG)).toHaveLength(before);
    expect(runtime.catalogRefreshCommands.get('cmd-7')).toBeNull();
    // A pull that answers rows no item can be made of: the draft is created,
    // cannot be prepared, and is removed again rather than left to replay.
    served = [{ name: 'a row with no identifier, pack size or unit' }];
    const empty = await router.handle(
      device('POST', REFRESH, { catalog_id: CATALOG, command_id: 'cmd-7' }),
    );
    expect(empty.status).toBe(409);
    expect((empty.body as { draft?: unknown }).draft).toBeUndefined();
    expect(runtime.catalogDrafts.listByCatalog(CATALOG)).toHaveLength(before);
    expect(runtime.catalogRefreshCommands.get('cmd-7')).toBeNull();
    served = [{ identifier: 'CAKE-9', name: 'Rye loaf', pack_size: '1', unit_code: 'each' }];
    const retried = await router.handle(
      device('POST', REFRESH, { catalog_id: CATALOG, command_id: 'cmd-7' }),
    );
    expect(retried.status).toBe(200);
    expect((retried.body as { replayed: boolean }).replayed).toBe(false);
    expect(runtime.catalogRefreshCommands.get('cmd-7')?.draftId).toBe(
      (retried.body as { draft: { draft_id: string } }).draft.draft_id,
    );
  });

  it('two overlapping refreshes with one command id pull once and answer alike', async () => {
    const pullsBefore = pulls;
    const [a, b] = await Promise.all([
      router.handle(device('POST', REFRESH, { catalog_id: CATALOG, command_id: 'cmd-race' })),
      router.handle(device('POST', REFRESH, { catalog_id: CATALOG, command_id: 'cmd-race' })),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body).toEqual(b.body);
    expect(pulls).toBe(pullsBefore + 1);
    expect(
      runtime.catalogDrafts.listByCatalog(CATALOG).filter((d) => d.draftId.startsWith('cdr_int_')),
    ).toHaveLength(1);
    // The same caller a moment later is an ordinary replay.
    const later = await router.handle(
      device('POST', REFRESH, { catalog_id: CATALOG, command_id: 'cmd-race' }),
    );
    expect((later.body as { replayed: boolean }).replayed).toBe(true);
  });

  it('an expected source digest is checked before any draft exists', async () => {
    const wrong = await router.handle(
      device('POST', REFRESH, {
        catalog_id: CATALOG,
        command_id: 'cmd-4',
        source_digest: 'a'.repeat(64),
      }),
    );
    expect(wrong.status).toBe(409);
    const wrongBody = wrong.body as { error: string; source_digest: string };
    expect(wrongBody.error).toBe('source_digest_mismatch');
    expect(wrongBody.source_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(runtime.catalogDrafts.listByCatalog(CATALOG)).toHaveLength(1); // the owner's bind draft only
    const right = await router.handle(
      device('POST', REFRESH, {
        catalog_id: CATALOG,
        command_id: 'cmd-4',
        source_digest: wrongBody.source_digest,
      }),
    );
    expect(right.status).toBe(200);
    expect(
      (
        await router.handle(
          device('POST', REFRESH, {
            catalog_id: CATALOG,
            command_id: 'cmd-5',
            source_digest: 'nope',
          }),
        )
      ).status,
    ).toBe(400);
  });

  it('a device without the scope, or with a buyer-only grant, is refused; the owner may refresh too', async () => {
    runtime.staffGrants.revokeDevice(DEVICE, T0 + 1);
    expect(
      (await router.handle(device('POST', REFRESH, { catalog_id: CATALOG, command_id: 'cmd-6' })))
        .status,
    ).toBe(403);
    runtime.staffGrants.put({
      deviceDid: DEVICE,
      scope: 'integration_catalog_refresh',
      maxOrderMinorUnits: '',
      currency: '',
      installs: 'buyer',
      createdAt: T0 + 2,
      revokedAt: null,
    });
    expect(
      (await router.handle(device('POST', REFRESH, { catalog_id: CATALOG, command_id: 'cmd-6' })))
        .status,
    ).toBe(403);
    expect(
      (await router.handle(owner('POST', REFRESH, { catalog_id: CATALOG, command_id: 'cmd-7' })))
        .status,
    ).toBe(200);
  });

  it('the catalogues read names the binding and the published state; publication is still the owner’s route', async () => {
    const catalogs = await router.handle(device('GET', '/v1/commerce/integration/catalogs'));
    expect(catalogs.status).toBe(200);
    // Nothing published yet — but the bound catalogue is listed, so a first
    // refresh can name its catalog_id before a first publication.
    expect((catalogs.body as { catalogs: unknown[] }).catalogs).toEqual([
      {
        catalog_id: CATALOG,
        state: 'unpublished',
        snapshot_sequence: null,
        snapshot_digest: null,
        published_at: null,
        bound: true,
      },
    ]);
    for (const p of [
      '/v1/commerce/catalog/drafts/approve',
      '/v1/commerce/catalog/drafts/publish',
      '/v1/commerce/catalog/publish',
    ]) {
      const res = await router.handle(
        device('POST', p, { draft_id: 'x', approved_snapshot_digest: 'y' }),
      );
      expect([p, res.status]).toEqual([p, 403]);
    }
  });
});
