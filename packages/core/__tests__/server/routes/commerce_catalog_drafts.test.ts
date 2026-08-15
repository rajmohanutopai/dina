/**
 * The photo-catalog lane's owner surface (§6, PCL-6).
 *
 * DRIVEN THROUGH THE ROUTER against a real commerce runtime on real SQLite,
 * because the defect this lane exists to close is "built and nothing calls
 * it". A test that called `CatalogDraftService` directly would prove the
 * engine works and leave exactly the gap the orphan ledger keeps catching.
 *
 * The suite is mostly BOUNDARY and REFUSAL. The happy path cannot complete
 * today — `userPresent` is wired to `false` because §10 item 9's presence
 * primitive has no production caller — and that is the honest state rather
 * than something to mock away. Asserting the refusal is what will make the
 * day it gets wired visible: these tests change when presence lands.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { createCommerceRuntime, installCommerceRuntime } from '../../../src/commerce/runtime';
import { clearPairingState, setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';

import type { CatalogDraft } from '../../../src/commerce/catalog_draft_store';
import type { CatalogItem } from '@dina/commerce-protocol';

const OWNER_CAP = 'test-owner-capability-secret';
const SUPPLIER = 'did:plc:chairmaker99';
const CATALOG = 'chairmaker-main';

/**
 * DERIVED FROM THE SOURCE, not typed out.
 *
 * `/drafts/repair` was added to the router and not to this list, so none of
 * the five boundary assertions below covered the most mutating draft route
 * there is — it rewrites stored rows, re-imports, re-assembles every item and
 * re-seeds provenance. A list maintained by memory stops covering the thing it
 * was written for on the day someone adds a route, which is the same defect
 * `boundary.test.ts` fixed by deriving its service list from the directory.
 *
 * BOTH LISTS COME FROM ONE MATCH, split by whether the route takes a
 * `draft_id`. An earlier version derived only this one and left the ingress
 * list hand-typed, so a new `/from_*` route was filtered out of here and
 * absent from there — covered by neither loop, which is worse than the hand
 * -kept list it replaced. Complementary filters over one source cannot do
 * that: every route the router declares lands in exactly one of them.
 */
const [DRAFT_ROUTES, INGRESS_ROUTES]: [string[], string[]] = (() => {
  const source = readFileSync(
    path.join(__dirname, '..', '..', '..', 'src', 'server', 'routes', 'commerce.ts'),
    'utf8',
  );
  const found = [...source.matchAll(/'(\/v1\/commerce\/catalog\/drafts\/[a-z_]+)'/g)].map(
    (m) => m[1] ?? '',
  );
  const all = [...new Set(found)];
  const isIngress = (route: string): boolean => /\/from_[a-z_]+$/.test(route);
  const withDraftId = all.filter((route) => !isIngress(route));
  const ingress = all.filter(isIngress);
  // A derivation that silently matched nothing would make every assertion
  // below vacuous, which is the failure mode this replaces. Both halves need a
  // floor: a regex that stopped matching the ingress routes would empty that
  // loop while leaving this one looking healthy.
  if (withDraftId.length < 6) throw new Error(`derived only ${String(withDraftId.length)} draft routes`);
  if (ingress.length < 3) throw new Error(`derived only ${String(ingress.length)} ingress routes`);
  return [withDraftId, ingress];
})();

const NON_OWNER: (string | undefined)[] = [
  undefined,
  'brain',
  'admin',
  'connector',
  'device',
  'agent',
  'plugin',
  'service',
];

let dir: string;
let adapter: NodeSQLiteAdapter;
let router: CoreRouter;

/**
 * `callerType` takes NO default, deliberately.
 *
 * It had one — `= 'owner'` — and a JavaScript default parameter fires on
 * `undefined`, so the "no caller type at all" row of the NON_OWNER list became
 * the OWNER case and sailed through the guard. The boundary test was asserting
 * the opposite of what it claimed, and only noticed because the owner path
 * then 404'd on a draft that did not exist. An explicit argument at every call
 * site is what stops the absent case being quietly rewritten.
 */
function post(
  routePath: string,
  body: Record<string, unknown>,
  callerType: string | undefined,
  capability = OWNER_CAP,
): CoreRequest {
  return {
    method: 'POST',
    path: routePath,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(callerType !== undefined ? { callerType, callerDID: 'did:key:caller' } : {}),
    ...(callerType === 'owner' ? { ownerCapability: capability } : {}),
  };
}

function item(): CatalogItem {
  return {
    product: { scheme: 'manufacturer_sku', value: 'CHAIR-1', issuer_did: SUPPLIER },
    supplier_did: SUPPLIER,
    catalog_id: CATALOG,
    item_revision: 'rev-1',
    name: 'Oak dining chair',
    category_ids: ['furniture.seating'],
    pack: { sell_unit: { value: '1', unit_code: 'each' } },
    fulfilment_regions: [{ scheme: 'admin_area', value: 'IN-KA' }],
    freshness: { generated_at: '2026-08-13T09:00:00.000Z' },
  };
}

function seedDraft(overrides: Partial<CatalogDraft> = {}): void {
  const it = item();
  const accepted: Record<string, 'accepted'> = {};
  for (const key of Object.keys(it)) accepted[key] = 'accepted';
  const runtime = createCommerceRuntime({
    adapter,
    supplierDid: () => SUPPLIER,
    currentEpoch: () => '2',
    now: () => 1_800_000_000_000,
    verifyHeldEvidence: () => true,
  });
  runtime.catalogDrafts.put({
    draftId: 'draft-1',
    catalogId: CATALOG,
    state: 'created',
    provenanceClass: 'model_derived',
    defaultScheme: 'sku',
    publishClaim: null,
    extraction: { model: 'test-extractor', schemaVersion: '1' },
    contentRevision: 0,
    rows: [],
    findings: [],
    provenance: { '0': accepted },
    items: [it],
    generatedAtIso: '2026-08-13T09:00:00.000Z',
    itemRevision: 'rev-1',
    receipt: null,
    held: null,
    approval: null,
    publication: null,
    createdAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_000_000,
    ...overrides,
  });
  installCommerceRuntime(runtime);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'catalog-draft-routes-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  installCommerceRuntime(
    createCommerceRuntime({
      adapter,
      supplierDid: () => SUPPLIER,
      currentEpoch: () => '2',
      now: () => 1_800_000_000_000,
      verifyHeldEvidence: () => true,
    }),
  );
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
  // The node's own DID, which the catalog routes read as the supplier of
  // record. Without it every one of them answers `owner_identity_unavailable`.
  setNodeDID(SUPPLIER);
});

afterEach(() => {
  clearPairingState();
  installCommerceRuntime(null);
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the boundary', () => {
  it('refuses every non-owner caller on every draft route (403)', async () => {
    for (const routePath of DRAFT_ROUTES) {
      for (const callerType of NON_OWNER) {
        const resp = await router.handle(post(routePath, { draft_id: 'draft-1' }, callerType));
        expect(resp.status).toBe(403);
        expect((resp.body as { error: string }).error).toBe('access_denied');
      }
    }
  });

  it('refuses an owner presenting the wrong capability', async () => {
    for (const routePath of DRAFT_ROUTES) {
      const resp = await router.handle(
        post(routePath, { draft_id: 'draft-1' }, 'owner', 'not-the-secret'),
      );
      expect(resp.status).toBe(403);
    }
  });

  it('fails CLOSED when the owner control plane was never configured', async () => {
    // Brain's own router registers no capability. Falling back to "allow"
    // would put a publication surface on a router with no owner at all.
    const unconfigured = new CoreRouter();
    registerCommerceRoutes(unconfigured);
    for (const routePath of DRAFT_ROUTES) {
      const resp = await unconfigured.handle(post(routePath, { draft_id: 'draft-1' }, 'owner'));
      expect(resp.status).toBe(403);
    }
  });

  it('says "no commerce here" rather than failing oddly', async () => {
    installCommerceRuntime(null);
    for (const routePath of DRAFT_ROUTES) {
      const resp = await router.handle(post(routePath, { draft_id: 'draft-1' }, 'owner'));
      expect(resp.status).toBe(503);
      expect((resp.body as { error: string }).error).toBe('commerce_unavailable');
    }
  });
});

describe('what each route requires before it reaches an engine', () => {
  it('refuses every route with no draft id', async () => {
    for (const routePath of DRAFT_ROUTES) {
      const resp = await router.handle(post(routePath, {}, 'owner'));
      expect(resp.status).toBe(400);
      expect((resp.body as { error: string }).error).toBe('draft_id_required');
    }
  });

  it('takes NO item list — the items published are the items stored', async () => {
    // The property the draft id exists for. Passing items must not create or
    // alter a publication; the route reads only the id.
    seedDraft();
    const resp = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/confirm',
        { draft_id: 'draft-1', items: [{ ...item(), name: 'Substituted by the caller' }] },
        'owner',
      ),
    );
    // Refused for want of presence, NOT because the items were accepted and
    // then rejected — and nothing in the stored draft moved.
    expect(resp.status).toBe(409);
    const runtime = createCommerceRuntime({
      adapter,
      supplierDid: () => SUPPLIER,
      currentEpoch: () => '2',
      now: () => 1_800_000_000_000,
      verifyHeldEvidence: () => true,
    });
    expect(runtime.catalogDrafts.get('draft-1')?.items[0]?.name).toBe('Oak dining chair');
  });

  it('refuses approve with no digest — an owner must name what they approved', async () => {
    seedDraft();
    const resp = await router.handle(
      post('/v1/commerce/catalog/drafts/approve', { draft_id: 'draft-1' }, 'owner'),
    );
    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toBe('approved_snapshot_digest_required');
  });

  it('answers 404 for a draft that does not exist, and 409 for one in the wrong state', async () => {
    // Different problems for a client: one is a bad id, the other is an
    // ordering mistake, and collapsing them sends an operator to the wrong
    // place.
    expect((await router.handle(post(DRAFT_ROUTES[0], { draft_id: 'nope' }, 'owner'))).status).toBe(404);
    seedDraft();
    expect(
      (await router.handle(post('/v1/commerce/catalog/drafts/prepare', { draft_id: 'draft-1' }, 'owner')))
        .status,
    ).toBe(409);
  });
});

describe('presence is not wired, and the lane says so rather than pretending', () => {
  it('refuses confirm on a model-derived draft with no_user_presence', async () => {
    // §10 item 9. When the presence primitive is wired this test changes,
    // which is the point of asserting the current state rather than mocking
    // past it: the day it lands is visible in the diff.
    seedDraft();
    const resp = await router.handle(post(DRAFT_ROUTES[0], { draft_id: 'draft-1' }, 'owner'));
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe('no_user_presence');
  });

  it('and an exempt class still advances, so the exemption is reachable', async () => {
    // The mirror. Without it "presence is never established" would be
    // indistinguishable from "every draft is refused for every reason".
    seedDraft({ provenanceClass: 'source_parsed', provenance: {} });
    const resp = await router.handle(post(DRAFT_ROUTES[0], { draft_id: 'draft-1' }, 'owner'));
    expect(resp.status).toBe(200);
    expect((resp.body as { draft: CatalogDraft }).draft.state).toBe('confirmed');
    expect((resp.body as { draft: CatalogDraft }).draft.receipt).toBeNull();
  });

  it('an exempt draft reaches prepare and holds real snapshot bytes', async () => {
    // Proves the route chain actually composes: settings-free assembly, the
    // publisher's leakage gate, pagination and the digest, through HTTP.
    seedDraft({ provenanceClass: 'source_parsed', provenance: {} });
    await router.handle(post(DRAFT_ROUTES[0], { draft_id: 'draft-1' }, 'owner'));
    const resp = await router.handle(
      post('/v1/commerce/catalog/drafts/prepare', {
        draft_id: 'draft-1',
        published_at: '2026-08-13T09:00:00.000Z',
      }, 'owner'),
    );
    expect(resp.status).toBe(200);
    const draft = (resp.body as { draft: CatalogDraft }).draft;
    expect(draft.state).toBe('prepared');
    expect(draft.held?.snapshot.snapshot_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(draft.held?.pages).toHaveLength(1);
  });

  it('but approve STILL refuses without presence, on the exempt class too', async () => {
    // §12.1 step 11 is not class-conditional. This is the route-level proof of
    // the rule the service tests pin: the confirm exemption must not reach the
    // snapshot review.
    seedDraft({ provenanceClass: 'source_parsed', provenance: {} });
    await router.handle(post(DRAFT_ROUTES[0], { draft_id: 'draft-1' }, 'owner'));
    const prepared = await router.handle(
      post('/v1/commerce/catalog/drafts/prepare', {
        draft_id: 'draft-1',
        published_at: '2026-08-13T09:00:00.000Z',
      }, 'owner'),
    );
    const digest = (prepared.body as { draft: CatalogDraft }).draft.held?.snapshot.snapshot_digest;
    const resp = await router.handle(
      post('/v1/commerce/catalog/drafts/approve', {
        draft_id: 'draft-1',
        approved_snapshot_digest: digest,
      }, 'owner'),
    );
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe('no_user_presence');
  });
});

describe('the shipped publish route is untouched', () => {
  it('still accepts an item list — because the draft lane cannot publish yet', async () => {
    // NOT "because retiring it is an owner decision", which is what this test
    // used to say and is now stale: §6 retires the body and §10 item 14 is
    // decided. The body survives for a different and narrower reason — §10
    // item 9's presence primitive is unwired, so `approve` refuses on every
    // class and the draft lane can publish nothing at all. Retiring the body
    // today would take catalog publication to zero rather than make it safe.
    //
    // The route is guarded on exactly that condition, so the bypass closes by
    // itself the day presence lands. `boundary.test.ts` pins that both halves
    // read the SAME presence function, which is the part a comment cannot.
    seedDraft();
    const resp = await router.handle(
      post(
        '/v1/commerce/catalog/publish',
        {
          catalog_id: CATALOG,
          published_at: '2026-08-13T09:00:00.000Z',
          items: [{ sku: 'CHAIR-1', name: 'Oak dining chair' }],
        },
        'owner',
      ),
    );
    expect(resp.status).not.toBe(404);
    expect((resp.body as { error?: string }).error).not.toBe('item_list_retired');
  });
});

/**
 * The rows-ingress seam (§10 item 8) — the only way a draft is born.
 *
 * Before this existed the four operations above could only act on a draft a
 * TEST had written, which is the same "built and nothing calls it" defect one
 * layer along. These drive the routes an owner actually reaches.
 */
describe('rows ingress', () => {
  /** One readable row, in the extraction's own record shape. */
  const ROW = { identifier: 'CHAIR-1', name: 'Oak dining chair', pack_size: '1', unit_code: 'each' };

  /** §5 asks which model read the values, and against which schema. */
  const EXTRACTION = { model: 'gemini-2.5-flash', schema_version: 'catalog-rows-1' };

  function writeSettings(extra: Record<string, unknown> = {}): void {
    const runtime = createCommerceRuntime({
      adapter,
      supplierDid: () => SUPPLIER,
      currentEpoch: () => '2',
      now: () => 1_800_000_000_000,
      verifyHeldEvidence: () => true,
    });
    const written = runtime.settings.writeSupplier({
      actingBusinessDid: SUPPLIER,
      catalogSource: { kind: 'inline', lastHealthyAtIso: '2026-08-08T09:00:00.000Z' },
      publicRegions: [{ scheme: 'admin_area', value: 'IN-KA' }],
      publishIndicativePrice: true,
      quoteAccess: 'anyone',
      responsePolicy: {},
      customerPricingSource: null,
      orderAcceptance: 'review',
      listingState: 'live',
      connectors: [],
      catalogCategoryIds: ['furniture.seating'],
      ...extra,
    } as never);
    if (!written.ok) throw new Error('fixture: supplier settings must be saveable');
    installCommerceRuntime(runtime);
  }

  function draftsNow(): CatalogDraft[] {
    const runtime = createCommerceRuntime({
      adapter,
      supplierDid: () => SUPPLIER,
      currentEpoch: () => '2',
      now: () => 1_800_000_000_000,
      verifyHeldEvidence: () => true,
    });
    return runtime.catalogDrafts.listByCatalog(CATALOG);
  }

  it('refuses every non-owner caller on both ingress routes (403)', async () => {
    writeSettings();
    for (const routePath of INGRESS_ROUTES) {
      for (const callerType of NON_OWNER) {
        const resp = await router.handle(
          post(routePath, { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], csv: 'x' }, callerType),
        );
        expect(resp.status).toBe(403);
      }
    }
    // AND NOTHING WAS STORED. A 403 that still wrote the draft would leave the
    // rows on disk for whoever asks next.
    expect(draftsNow()).toEqual([]);
  });

  it('requires a catalog id and an identifier scheme', async () => {
    writeSettings();
    for (const routePath of INGRESS_ROUTES) {
      const noCatalog = await router.handle(
        post(routePath, { default_scheme: 'sku', rows: [ROW], csv: 'x' }, 'owner'),
      );
      expect(noCatalog.status).toBe(400);
      expect((noCatalog.body as { error: string }).error).toBe('catalog_id is required');

      // NOT DEFAULTED: the scheme decides how every bare identifier is READ,
      // so guessing it would silently reinterpret the seller's whole catalog.
      // The connector route names its `kind` first, so accept either refusal —
      // what matters is that neither route proceeds without a scheme.
      const noScheme = await router.handle(
        post(routePath, { catalog_id: CATALOG, rows: [ROW], csv: 'x', kind: 'rest' }, 'owner'),
      );
      expect(noScheme.status).toBe(400);
      expect((noScheme.body as { error: string }).error).toContain('default_scheme');
    }
    expect(draftsNow()).toEqual([]);
  });

  it('refuses an extraction that will not say which model read the rows', async () => {
    // §5: "where a model produced the value, the extraction's model and schema
    // version with it". A receipt that cannot name the model records less than
    // the person was shown when they vouched for it — and the model is inside
    // the receipt preimage, so it cannot be attached afterwards either.
    writeSettings();
    for (const partial of [{}, { model: 'm' }, { schema_version: 'v' }, { model: '', schema_version: 'v' }]) {
      const resp = await router.handle(
        post(
          '/v1/commerce/catalog/drafts/from_extraction',
          { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...partial },
          'owner',
        ),
      );
      expect(resp.status).toBe(400);
    }
    expect(draftsNow()).toEqual([]);
  });

  it('records the extraction on the draft, and the CSV lane records none', async () => {
    writeSettings();
    const extracted = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    expect((extracted.body as { draft: CatalogDraft }).draft.extraction).toEqual({
      model: 'gemini-2.5-flash',
      schemaVersion: 'catalog-rows-1',
    });

    // A file the seller wrote inferred nothing, so there is no model to name —
    // and the absence is a real state, not a missing field.
    const uploaded = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_file',
        {
          catalog_id: CATALOG,
          default_scheme: 'sku',
          csv: 'identifier,name,pack_size,unit_code\nCHAIR-1,Oak dining chair,1,each\n',
        },
        'owner',
      ),
    );
    expect((uploaded.body as { draft: CatalogDraft }).draft.extraction).toBeNull();
  });

  it('refuses before touching the rows when the seller has no settings', async () => {
    // Deliberately NOT calling writeSettings.
    const resp = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    expect(resp.status).toBe(409);
    // Absent, not invalid: first run has nothing to fix, and sending a seller
    // looking for a corruption that is not there is its own bug.
    expect((resp.body as { error: string }).error).toBe('supplier_settings_absent');
  });

  it('stores a draft in created, assembled from the rows', async () => {
    writeSettings();
    const resp = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    expect(resp.status).toBe(200);
    const body = resp.body as { ok: boolean; draft: CatalogDraft };
    expect(body.ok).toBe(true);
    expect(body.draft.state).toBe('created');
    expect(body.draft.contentRevision).toBe(1);
    expect(body.draft.items).toHaveLength(1);
    expect(body.draft.items[0]?.name).toBe('Oak dining chair');
    // The seller's settings supplied these; no row did.
    expect(body.draft.items[0]?.category_ids).toEqual(['furniture.seating']);
    expect(body.draft.items[0]?.fulfilment_regions).toEqual([{ scheme: 'admin_area', value: 'IN-KA' }]);

    // MINTED ONCE AND STORED. A rebuild that re-derives either moves
    // `snapshot_digest` out from under the owner's approval (§10 item 8), so
    // the draft has to be where they live.
    expect(body.draft.items[0]?.freshness.generated_at).toBe(body.draft.generatedAtIso);
    expect(body.draft.items[0]?.item_revision).toBe(body.draft.itemRevision);

    // And it SURVIVED — the response is not the only copy.
    const stored = draftsNow();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.draftId).toBe(body.draft.draftId);
  });

  it('marks model-read fields proposed and settings-supplied fields exempt', async () => {
    writeSettings();
    const resp = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    const draft = (resp.body as { draft: CatalogDraft }).draft;
    const provenance = draft.provenance['0'] ?? {};

    // THE WHOLE POINT OF THE LANE. `name` and `pack` came off the photograph,
    // so a person has to accept them before they can be published.
    expect(provenance.name).toBe('proposed');
    expect(provenance.pack).toBe('proposed');
    expect(provenance.product).toBe('proposed');
    // These the assembler minted or the settings supplied. No model produced
    // them, so there is nothing to vouch for.
    expect(provenance.supplier_did).toBe('not_model_derived');
    expect(provenance.catalog_id).toBe('not_model_derived');
    expect(provenance.item_revision).toBe('not_model_derived');
    expect(provenance.category_ids).toBe('not_model_derived');
    expect(provenance.fulfilment_regions).toBe('not_model_derived');
    expect(provenance.freshness).toBe('not_model_derived');

    // EVERY field of the item is accounted for. A field with no entry reads as
    // `proposed`, so a gap here would block publication rather than leak one —
    // but it would also mean this map and the assembler had drifted.
    expect(Object.keys(provenance).sort()).toEqual(Object.keys(draft.items[0] ?? {}).sort());
  });

  it('assigns the provenance class from the route, and the body cannot change it', async () => {
    writeSettings();
    const extraction = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        {
          catalog_id: CATALOG,
          default_scheme: 'sku',
          ...EXTRACTION,
          rows: [ROW],
          // A caller trying to exempt itself from confirmation entirely.
          provenance_class: 'owner_authored',
        },
        'owner',
      ),
    );
    expect((extraction.body as { draft: CatalogDraft }).draft.provenanceClass).toBe('model_derived');

    const file = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_file',
        {
          catalog_id: CATALOG,
          default_scheme: 'sku',
          ...EXTRACTION,
          csv: 'identifier,name,pack_size,unit_code\nCHAIR-1,Oak dining chair,1,each\n',
          provenance_class: 'model_derived',
        },
        'owner',
      ),
    );
    const fileDraft = (file.body as { draft: CatalogDraft }).draft;
    expect(fileDraft.provenanceClass).toBe('owner_authored');
    // Nothing was inferred, so no field is waiting on a person.
    expect(fileDraft.provenance['0']?.name).toBe('not_model_derived');
  });

  it('PERSISTS the rows and the findings when a row cannot be read (§5 step 3)', async () => {
    // THE ORDER §5 GIVES IS 3 DRAFT, 4 REPAIR, 5 ASSEMBLE. An earlier version
    // imported and assembled first and stored nothing unless both succeeded —
    // so a photographed price list with one unreadable cell produced no draft
    // at all, and the repair step it feeds had nothing to repair. The findings
    // came back in an HTTP response and the durable `findings` column no code
    // could populate.
    writeSettings();
    const resp = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        {
          catalog_id: CATALOG,
          default_scheme: 'sku',
          ...EXTRACTION,
          // Minor units with no currency beside them: the importer will not
          // read a bare number as a price.
          rows: [{ ...ROW, list_price_minor_units: '1500' }],
        },
        'owner',
      ),
    );
    expect(resp.status).toBe(200);
    const draft = (resp.body as { draft: CatalogDraft }).draft;

    // A draft EXISTS, holding the rows and what is wrong with them.
    expect(draft.state).toBe('created');
    expect(draft.rows[0]?.cells.name).toBe('Oak dining chair');
    expect(draft.findings.length).toBeGreaterThan(0);
    expect(draft.items).toEqual([]);
    expect(draftsNow()).toHaveLength(1);

    // And it cannot advance: no items means nothing to confirm.
    const confirmed = await router.handle(
      post('/v1/commerce/catalog/drafts/confirm', { draft_id: draft.draftId }, 'owner'),
    );
    expect(confirmed.status).toBe(409);
    expect((confirmed.body as { error: string }).error).toBe('no_items');
  });

  it('repairs a cell and re-assembles from the corrected rows (§5 steps 4-5)', async () => {
    // THE STEP THAT MAKES THE LANE USABLE. Without it a seller whose photo had
    // one smudged line had no way forward at all.
    writeSettings({ tradingCurrency: 'INR' });
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        {
          catalog_id: CATALOG,
          default_scheme: 'sku',
          ...EXTRACTION,
          // The model could not read the name off the page, so it came back
          // empty rather than guessed (§5 step 2).
          rows: [{ ...ROW, name: '' }],
        },
        'owner',
      ),
    );
    const draft = (created.body as { draft: CatalogDraft }).draft;
    expect(draft.items).toEqual([]);
    expect(JSON.stringify(draft.findings)).toContain('no_name');

    const repaired = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/repair',
        { draft_id: draft.draftId, row: 2, column: 'name', value: 'Oak dining chair' },
        'owner',
      ),
    );
    expect(repaired.status).toBe(200);
    const after = (repaired.body as { draft: CatalogDraft }).draft;

    // The rows now say what the seller typed, the findings are gone, and the
    // item exists.
    expect(after.rows[0]?.cells.name).toBe('Oak dining chair');
    expect(after.findings).toEqual([]);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]?.name).toBe('Oak dining chair');
    // A repair is content, so it bumps the revision.
    expect(after.contentRevision).toBe(draft.contentRevision + 1);
    // A repair is NOT a new draft: the stamp is the one minted at ingress, so
    // rebuilding cannot move the digest under an approval. Asserted on the
    // ITEM, because that is what the stamp actually writes — an earlier
    // version checked the draft's own columns, which `recordEdit` preserves
    // whatever the stamp says, so the assertion could not fail.
    expect(after.generatedAtIso).toBe(draft.generatedAtIso);
    expect(after.itemRevision).toBe(draft.itemRevision);
    expect(after.items[0]?.freshness.generated_at).toBe(draft.generatedAtIso);
    expect(after.items[0]?.item_revision).toBe(draft.itemRevision);
    // And the repaired draft can now advance.
    expect(after.items[0]?.name).toBe('Oak dining chair');
  });

  it('does not carry an acceptance across a change of PRODUCT IDENTITY', async () => {
    // Provenance is carried by product identity, not by array position.
    //
    // The reviewer's scenario for this — a repair inserting an item and
    // shifting later ones — turns out to be unreachable: import and assembly
    // are both all-or-nothing, so a draft's items are either all present or
    // none, and item i always comes from row i. THIS case is reachable, and
    // positional pairing gets it wrong: repairing the IDENTIFIER makes the row
    // a different product, while `name` is untouched. Carrying by position
    // hands the new product an acceptance made about the old one.
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    const draft = (created.body as { draft: CatalogDraft }).draft;
    await router.handle(
      post(
        '/v1/commerce/catalog/drafts/accept',
        { draft_id: draft.draftId, fields: ['0.name'] },
        'owner',
      ),
    );
    expect(draftsNow()[0]?.provenance['0']?.name).toBe('accepted');

    const repaired = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/repair',
        { draft_id: draft.draftId, row: 2, column: 'identifier', value: 'CHAIR-2' },
        'owner',
      ),
    );
    const after = (repaired.body as { draft: CatalogDraft }).draft;
    expect(after.items[0]?.product.value).toBe('CHAIR-2');
    // Same name, DIFFERENT product — so the acceptance does not follow it.
    expect(after.items[0]?.name).toBe('Oak dining chair');
    expect(after.provenance['0']?.name).toBe('proposed');
  });

  it('keeps an acceptance on the SAME product across an unrelated repair', async () => {
    // The other direction: identity-keyed carrying must still carry, or every
    // repair would silently discard every decision the seller had made.
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        {
          catalog_id: CATALOG,
          default_scheme: 'sku',
          ...EXTRACTION,
          rows: [{ ...ROW, brand: 'Oakworks' }],
        },
        'owner',
      ),
    );
    const draft = (created.body as { draft: CatalogDraft }).draft;
    await router.handle(
      post(
        '/v1/commerce/catalog/drafts/accept',
        { draft_id: draft.draftId, fields: ['0.name'] },
        'owner',
      ),
    );

    // Repair a DIFFERENT field on the same product.
    const repaired = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/repair',
        { draft_id: draft.draftId, row: 2, column: 'brand', value: 'Oak Works Ltd' },
        'owner',
      ),
    );
    const after = (repaired.body as { draft: CatalogDraft }).draft;
    expect(after.items[0]?.brand).toBe('Oak Works Ltd');
    // `name` did not change, so the acceptance stands.
    expect(after.provenance['0']?.name).toBe('accepted');
    // `brand` did change, so it is back to needing a decision.
    expect(after.provenance['0']?.brand).toBe('proposed');
  });

  it('clears an off-vocabulary column the model invented, unblocking the draft', async () => {
    // REACHABLE WITHOUT ANY CALLER ERROR. `/from_extraction` takes arbitrary
    // records and keeps every key, and the importer refuses a column that is
    // not a catalog field — by NAME, so setting its value to '' changes
    // nothing. Import is all-or-nothing, so one invented key blocked the whole
    // draft for ever until a repair could remove the key itself.
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        {
          catalog_id: CATALOG,
          default_scheme: 'sku',
          ...EXTRACTION,
          rows: [{ ...ROW, colour_of_the_label: 'red' }],
        },
        'owner',
      ),
    );
    const draft = (created.body as { draft: CatalogDraft }).draft;
    expect(draft.items).toEqual([]);
    expect(JSON.stringify(draft.findings)).toContain('unknown_column');

    // Emptying the value is NOT enough — the finding is about the name.
    const emptied = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/repair',
        { draft_id: draft.draftId, row: 2, column: 'colour_of_the_label', value: '' },
        'owner',
      ),
    );
    expect((emptied.body as { draft: CatalogDraft }).draft.items).toEqual([]);

    // Removing the key is.
    const cleared = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/repair',
        { draft_id: draft.draftId, row: 2, column: 'colour_of_the_label', value: null },
        'owner',
      ),
    );
    const after = (cleared.body as { draft: CatalogDraft }).draft;
    expect(after.findings).toEqual([]);
    expect(after.items).toHaveLength(1);
    expect(after.rows[0]?.cells.colour_of_the_label).toBeUndefined();
  });

  it('removes a row the model invented (§8), and refuses to remove the last one', async () => {
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        {
          catalog_id: CATALOG,
          default_scheme: 'sku',
          ...EXTRACTION,
          rows: [ROW, { identifier: 'GHOST-1', name: 'A product that does not exist', pack_size: '1', unit_code: 'each' }],
        },
        'owner',
      ),
    );
    const draft = (created.body as { draft: CatalogDraft }).draft;
    expect(draft.items).toHaveLength(2);

    const removed = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/repair',
        { draft_id: draft.draftId, row: 3, column: null },
        'owner',
      ),
    );
    const after = (removed.body as { draft: CatalogDraft }).draft;
    expect(after.rows).toHaveLength(1);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]?.product.value).toBe('CHAIR-1');

    // A draft with no rows is not a catalog.
    const last = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/repair',
        { draft_id: draft.draftId, row: 2, column: null },
        'owner',
      ),
    );
    expect(last.status).toBe(409);
    expect((last.body as { error: string }).error).toBe('no_items');
  });

  it('refuses a repair naming a row the draft does not have', async () => {
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    const draftId = (created.body as { draft: CatalogDraft }).draft.draftId;

    const resp = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/repair',
        { draft_id: draftId, row: 99, column: 'name', value: 'x' },
        'owner',
      ),
    );
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe('unknown_field');
  });

  it('sends a repaired-away acceptance back to needing a decision', async () => {
    // A field the seller ACCEPTED and then changed by repairing a row must not
    // keep its acceptance: that would record a person vouching for a value
    // they never saw.
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    const draft = (created.body as { draft: CatalogDraft }).draft;
    await router.handle(
      post(
        '/v1/commerce/catalog/drafts/accept',
        { draft_id: draft.draftId, fields: ['0.name'] },
        'owner',
      ),
    );
    expect(draftsNow()[0]?.provenance['0']?.name).toBe('accepted');

    const repaired = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/repair',
        { draft_id: draft.draftId, row: 2, column: 'name', value: 'Teak dining chair' },
        'owner',
      ),
    );
    const after = (repaired.body as { draft: CatalogDraft }).draft;
    expect(after.items[0]?.name).toBe('Teak dining chair');
    expect(after.provenance['0']?.name).toBe('proposed');
  });

  it('prices in the SELLER\'s currency, never the row\'s', async () => {
    writeSettings({ tradingCurrency: 'INR' });
    const resp = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        {
          catalog_id: CATALOG,
          default_scheme: 'sku',
          ...EXTRACTION,
          // The row says USD. The seller trades in INR.
          rows: [{ ...ROW, list_price_minor_units: '1500', currency: 'USD' }],
        },
        'owner',
      ),
    );
    const draft = (resp.body as { draft: CatalogDraft }).draft;
    expect(draft.items[0]?.indicative_price).toEqual({ currency: 'INR', minor_units: '1500' });
    // The DIGITS are the model's, so the field still waits on a person even
    // though its currency came from settings.
    expect(draft.provenance['0']?.indicative_price).toBe('proposed');
  });

  it('accepts named fields, and Core writes the state rather than the caller', async () => {
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    const draft = (created.body as { draft: CatalogDraft }).draft;
    expect(draft.provenance['0']?.name).toBe('proposed');

    const accepted = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/accept',
        { draft_id: draft.draftId, fields: ['0.name', '0.pack'] },
        'owner',
      ),
    );
    expect(accepted.status).toBe(200);
    const after = (accepted.body as { draft: CatalogDraft }).draft;
    expect(after.provenance['0']?.name).toBe('accepted');
    expect(after.provenance['0']?.pack).toBe('accepted');
    // Untouched fields keep waiting. An acceptance is not a blanket yes.
    expect(after.provenance['0']?.product).toBe('proposed');
    // Provenance IS content, so this bumped the revision — which is what
    // makes any held snapshot and approval stale.
    expect(after.contentRevision).toBe(draft.contentRevision + 1);
  });

  it('refuses an acceptance naming a field that is not waiting on a decision', async () => {
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    const draftId = (created.body as { draft: CatalogDraft }).draft.draftId;

    for (const ref of [
      '0.supplier_did', // already exempt — nothing to accept
      '0.no_such_field', // no such field on the item
      '9.name', // no such item
    ]) {
      const resp = await router.handle(
        post('/v1/commerce/catalog/drafts/accept', { draft_id: draftId, fields: [ref] }, 'owner'),
      );
      expect(resp.status).toBe(409);
      expect((resp.body as { error: string }).error).toBe('unknown_field');
    }

    const empty = await router.handle(
      post('/v1/commerce/catalog/drafts/accept', { draft_id: draftId, fields: [] }, 'owner'),
    );
    expect((empty.body as { error: string }).error).toBe('nothing_named');
  });

  it('gives the caller no way to write a provenance state directly', async () => {
    // THE FORGERY THE LANE EXISTS TO REFUSE. `recordEdit` takes a whole
    // provenance map; if any route passed one through, a client could mark
    // every field `not_model_derived` and satisfy "nothing is still proposed"
    // with nothing confirmed at all.
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    const draftId = (created.body as { draft: CatalogDraft }).draft.draftId;

    const forged = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/accept',
        {
          draft_id: draftId,
          fields: ['0.name'],
          provenance: { '0': { name: 'not_model_derived', product: 'not_model_derived' } },
          items: [{ ...item(), name: 'Substituted' }],
        },
        'owner',
      ),
    );
    const after = (forged.body as { draft: CatalogDraft }).draft;
    // The named field was accepted, because that is what a seller may do.
    expect(after.provenance['0']?.name).toBe('accepted');
    // Everything else in the body was ignored.
    expect(after.provenance['0']?.product).toBe('proposed');
    expect(after.items[0]?.name).toBe('Oak dining chair');
  });

  it('walks the model-derived lane as far as presence allows', async () => {
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    const draft = (created.body as { draft: CatalogDraft }).draft;

    // Accept EVERY field still waiting, which is what a seller working
    // through the review screen would end up doing.
    const waiting = Object.entries(draft.provenance['0'] ?? {})
      .filter(([, state]) => state === 'proposed')
      .map(([field]) => `0.${field}`);
    expect(waiting.length).toBeGreaterThan(0);
    const accepted = await router.handle(
      post('/v1/commerce/catalog/drafts/accept', { draft_id: draft.draftId, fields: waiting }, 'owner'),
    );
    expect(accepted.status).toBe(200);

    // Nothing is proposed any more, so `confirm` stops on the ONE thing
    // actually missing: §10 item 9's presence primitive. Before `accept`
    // existed this refused as `unconfirmed_field` for ever — a state machine
    // with a state it could not leave.
    const confirmed = await router.handle(
      post('/v1/commerce/catalog/drafts/confirm', { draft_id: draft.draftId }, 'owner'),
    );
    expect(confirmed.status).toBe(409);
    expect((confirmed.body as { error: string }).error).toBe('no_user_presence');
  });

  it('reads drafts back after the client that made them is gone', async () => {
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    const draftId = (created.body as { draft: CatalogDraft }).draft.draftId;

    // A FRESH RUNTIME AND ROUTER over the same database file — the app was
    // killed and relaunched, so every repository object that held the draft in
    // memory is gone. The draft has to be findable, or surviving restart
    // bought nothing.
    installCommerceRuntime(
      createCommerceRuntime({
        adapter,
        supplierDid: () => SUPPLIER,
        currentEpoch: () => '2',
        now: () => 1_800_000_000_000,
        verifyHeldEvidence: () => true,
      }),
    );
    const reopened = new CoreRouter();
    registerCommerceRoutes(reopened, OWNER_CAP);
    const listed = await reopened.handle({
      ...post('/v1/commerce/catalog/drafts', {}, 'owner'),
      method: 'GET',
      query: { catalog_id: CATALOG },
    });
    expect(listed.status).toBe(200);
    const body = listed.body as {
      drafts: CatalogDraft[];
      outstanding: Record<string, string[]>;
    };
    expect(body.drafts.map((d) => d.draftId)).toEqual([draftId]);
    // And it says what the draft is still waiting on, so a client that lost
    // its state knows what to put in front of the seller.
    expect(body.outstanding[draftId]).toContain('0.name');
    expect(body.outstanding[draftId]).not.toContain('0.supplier_did');
  });

  it('refuses to list without a catalog, and to every non-owner', async () => {
    writeSettings();
    const get = (callerType: string | undefined, query: Record<string, string>) => ({
      ...post('/v1/commerce/catalog/drafts', {}, callerType),
      method: 'GET' as const,
      query,
    });
    for (const callerType of NON_OWNER) {
      const resp = await router.handle(get(callerType, { catalog_id: CATALOG }));
      expect(resp.status).toBe(403);
    }
    const noCatalog = await router.handle(get('owner', {}));
    expect(noCatalog.status).toBe(400);
  });

  it('stores the cells the model read, not just the row numbers', async () => {
    // THE ROW SOURCE HANDS EACH ROW A `get(name)` CLOSURE, and a closure does
    // not survive JSON. Storing the source's own shape wrote `{"row":2}` per
    // row and lost every value — with the column populated and the array
    // length right, so nothing looked wrong. §10 item 8 puts the extracted
    // rows first in the draft's durable contents and §5 builds repair from
    // them, so this asserts the CELLS, not the count.
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    const draftId = (created.body as { draft: CatalogDraft }).draft.draftId;

    const stored = draftsNow()[0];
    expect(stored?.rows).toHaveLength(1);
    expect(stored?.rows[0]?.cells.name).toBe('Oak dining chair');
    expect(stored?.rows[0]?.cells.identifier).toBe('CHAIR-1');
    expect(stored?.rows[0]?.row).toBe(2);
    expect(stored?.draftId).toBe(draftId);
  });

  it('keeps the cells through the CSV route too', async () => {
    // Same defect, same shape, different producer: `parseCatalogCsv` returns
    // the identical closure-carrying rows.
    writeSettings();
    await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_file',
        {
          catalog_id: CATALOG,
          default_scheme: 'sku',
          ...EXTRACTION,
          csv: 'identifier,name,pack_size,unit_code\nCHAIR-1,Oak dining chair,1,each\n',
        },
        'owner',
      ),
    );
    expect(draftsNow()[0]?.rows[0]?.cells.name).toBe('Oak dining chair');
  });

  it('lets the seller CORRECT a value the model misread', async () => {
    // §5's repair step. Without it a seller chooses between a wrong price and
    // no catalog: `accept` can only agree with what the model read.
    writeSettings({ tradingCurrency: 'INR' });
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        {
          catalog_id: CATALOG,
          default_scheme: 'sku',
          ...EXTRACTION,
          // 15000 minor units — the model read a decimal point wrongly.
          rows: [{ ...ROW, list_price_minor_units: '150000', currency: 'INR' }],
        },
        'owner',
      ),
    );
    const draft = (created.body as { draft: CatalogDraft }).draft;
    expect(draft.items[0]?.indicative_price?.minor_units).toBe('150000');

    const fixed = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/edit',
        {
          draft_id: draft.draftId,
          field: '0.indicative_price',
          value: { currency: 'INR', minor_units: '15000' },
        },
        'owner',
      ),
    );
    expect(fixed.status).toBe(200);
    const after = (fixed.body as { draft: CatalogDraft }).draft;
    expect(after.items[0]?.indicative_price?.minor_units).toBe('15000');
    // The SELLER wrote this, so it is `edited` — not `accepted`, which records
    // vouching for what a model produced.
    expect(after.provenance['0']?.indicative_price).toBe('edited');
    expect(after.contentRevision).toBe(draft.contentRevision + 1);
  });

  it('refuses to edit a field the seller does not own', async () => {
    // THE REASON THIS ROUTE IS SAFE. `supplier_did` and `catalog_id` are minted
    // by the assembler; an edit route reaching them would let a client publish
    // under another supplier's DID through the one route whose whole job is to
    // take a value from outside.
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    const draftId = (created.body as { draft: CatalogDraft }).draft.draftId;

    for (const field of [
      '0.supplier_did',
      '0.catalog_id',
      '0.item_revision',
      '0.category_ids',
      '0.fulfilment_regions',
      '0.freshness',
    ]) {
      const resp = await router.handle(
        post(
          '/v1/commerce/catalog/drafts/edit',
          { draft_id: draftId, field, value: 'did:plc:someone-else' },
          'owner',
        ),
      );
      expect(resp.status).toBe(409);
      expect((resp.body as { error: string }).error).toBe('immutable_field');
    }

    // And the stored item is untouched by any of it.
    expect(draftsNow()[0]?.items[0]?.supplier_did).toBe(SUPPLIER);
  });

  it('refuses an edit that would leave an item the wire rejects', async () => {
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    const draftId = (created.body as { draft: CatalogDraft }).draft.draftId;

    // A name is required, so emptying it is not a repair.
    const empty = await router.handle(
      post('/v1/commerce/catalog/drafts/edit', { draft_id: draftId, field: '0.name', value: '' }, 'owner'),
    );
    expect(empty.status).toBe(409);
    expect((empty.body as { error: string }).error).toBe('item_rejected');

    // Nor is a pack whose unit is not in the vocabulary.
    const badUnit = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/edit',
        { draft_id: draftId, field: '0.pack', value: { sell_unit: { value: '1', unit_code: 'furlong' } } },
        'owner',
      ),
    );
    expect(badUnit.status).toBe(409);
    expect((badUnit.body as { error: string }).error).toBe('item_rejected');

    expect(draftsNow()[0]?.items[0]?.name).toBe('Oak dining chair');
  });

  it('clears an optional field the model invented, and stops asking about it', async () => {
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        {
          catalog_id: CATALOG,
          default_scheme: 'sku',
          ...EXTRACTION,
          rows: [{ ...ROW, description: 'call 555-0100 for a quote' }],
        },
        'owner',
      ),
    );
    const draft = (created.body as { draft: CatalogDraft }).draft;
    expect(draft.items[0]?.description).toBe('call 555-0100 for a quote');

    const cleared = await router.handle(
      post('/v1/commerce/catalog/drafts/edit', { draft_id: draft.draftId, field: '0.description' }, 'owner'),
    );
    const after = (cleared.body as { draft: CatalogDraft }).draft;
    expect(after.items[0]?.description).toBeUndefined();
    // No provenance row survives for a field the item no longer has, so
    // `confirm` stops waiting on it.
    expect(after.provenance['0']?.description).toBeUndefined();
  });

  it('refuses an edit naming no item, and requires a field', async () => {
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    const draftId = (created.body as { draft: CatalogDraft }).draft.draftId;

    const noField = await router.handle(
      post('/v1/commerce/catalog/drafts/edit', { draft_id: draftId }, 'owner'),
    );
    expect(noField.status).toBe(400);

    for (const field of ['9.name', 'name', '0.no_such_field']) {
      const resp = await router.handle(
        post('/v1/commerce/catalog/drafts/edit', { draft_id: draftId, field, value: 'x' }, 'owner'),
      );
      expect(resp.status).toBe(409);
      expect((resp.body as { error: string }).error).toBe('unknown_field');
    }
  });

  it('refuses ingress when the stored acting business is not this node', async () => {
    // THE SAME RULE THE ACKNOWLEDGEMENT PATH ENFORCES, and it was missing here.
    // `validateSupplierSettings` checks `actingBusinessDid` only for
    // non-emptiness, so a settings row naming another business would have put
    // that DID on every item, on the snapshot and on the pointer — this node
    // publishing a catalog under a supplier it cannot act for.
    writeSettings({ actingBusinessDid: 'did:plc:someone-else' });
    const resp = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    expect(resp.status).toBe(403);
    expect((resp.body as { error: string }).error).toBe('acting_business_mismatch');
    expect(draftsNow()).toEqual([]);
  });

  it('puts THIS node on every assembled item, whatever the settings say', async () => {
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    const draft = (created.body as { draft: CatalogDraft }).draft;
    expect(draft.items[0]?.supplier_did).toBe(SUPPLIER);
    // And the identifier is scoped to that same supplier (§9.3) — `CHAIR-1`
    // means nothing without knowing who issues it.
    expect(draft.items[0]?.product.issuer_did).toBe(SUPPLIER);
  });

  it('refuses an edit that re-scopes an identifier to another issuer', async () => {
    // The field guard alone is not enough. `product` and `identifiers` are
    // row-derived and therefore editable, and both carry an `issuer_did` that
    // `validateCatalogItem` accepts as any well-formed DID — so scoping at
    // field granularity leaves the same hole one level down: a manufacturer-SKU
    // claim attributed to a party that never issued it, published from here.
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_extraction',
        { catalog_id: CATALOG, default_scheme: 'sku', rows: [ROW], ...EXTRACTION },
        'owner',
      ),
    );
    const draftId = (created.body as { draft: CatalogDraft }).draft.draftId;

    const stolen = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/edit',
        {
          draft_id: draftId,
          field: '0.product',
          value: { scheme: 'manufacturer_sku', value: 'CHAIR-1', issuer_did: 'did:plc:someone-else' },
        },
        'owner',
      ),
    );
    expect(stolen.status).toBe(409);
    expect((stolen.body as { error: string }).error).toBe('immutable_field');

    // The same rule on the secondary identifiers, which are lookup keys and so
    // point at the wrong product if they are unscoped.
    const stolenSecondary = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/edit',
        {
          draft_id: draftId,
          field: '0.identifiers',
          value: [{ scheme: 'manufacturer_sku', value: 'X', issuer_did: 'did:plc:someone-else' }],
        },
        'owner',
      ),
    );
    expect(stolenSecondary.status).toBe(409);

    // And an edit that keeps the supplier's own scope is still allowed, so the
    // guard is not simply refusing every edit to these fields.
    const legitimate = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/edit',
        {
          draft_id: draftId,
          field: '0.product',
          value: { scheme: 'manufacturer_sku', value: 'CHAIR-2', issuer_did: SUPPLIER },
        },
        'owner',
      ),
    );
    expect(legitimate.status).toBe(200);
    expect(draftsNow()[0]?.items[0]?.product.value).toBe('CHAIR-2');
  });

  it('produces a draft the state machine accepts — ingress to confirmed', async () => {
    // The exempt class, because `model_derived` stops at presence (§10 item 9)
    // and this is the assertion that the two halves actually fit together.
    writeSettings();
    const created = await router.handle(
      post(
        '/v1/commerce/catalog/drafts/from_file',
        {
          catalog_id: CATALOG,
          default_scheme: 'sku',
          ...EXTRACTION,
          csv: 'identifier,name,pack_size,unit_code\nCHAIR-1,Oak dining chair,1,each\n',
        },
        'owner',
      ),
    );
    const draftId = (created.body as { draft: CatalogDraft }).draft.draftId;

    const confirmed = await router.handle(
      post('/v1/commerce/catalog/drafts/confirm', { draft_id: draftId }, 'owner'),
    );
    expect(confirmed.status).toBe(200);
    expect((confirmed.body as { draft: CatalogDraft }).draft.state).toBe('confirmed');
  });
});
