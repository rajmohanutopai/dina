/**
 * The integration surface through the REAL commerce routes
 * (JIFFY_MERCHANT_INTEGRATION_PLAN §3.2, Piece B): the owner and a granted
 * staff device reach a door; an ungranted, wrong-scope, buyer-only or
 * revoked device does not; Brain, a plain device and an agent receive the
 * owner guard's own refusal; the export pages replay exactly and refuses a
 * malformed cursor or limit.
 */

import {
  InMemoryCatalogDraftRepository,
  type CatalogDraft,
} from '../../../src/commerce/catalog_draft_store';
import { InMemoryCatalogPointerRepository } from '../../../src/commerce/catalog_pointer_store';
import { buildCatalogSnapshot } from '../../../src/commerce/catalog_publisher';
import { InMemoryCatalogRefreshCommandRepository } from '../../../src/commerce/catalog_refresh_commands';
import { InMemoryCatalogSourceBindingRepository } from '../../../src/commerce/catalog_source_bindings';
import { CommerceOrderStore } from '../../../src/commerce/commerce_order';
import { encodeOrdersCursor } from '../../../src/commerce/integration';
import { InMemoryCommerceOrderRefRepository } from '../../../src/commerce/order_refs';
import { InMemoryCommerceReceiptRepository } from '../../../src/commerce/receipts';
import {
  getCommerceRuntime,
  installCommerceRuntime,
  type CommerceRuntime,
} from '../../../src/commerce/runtime';
import { InMemoryCommerceSettingsRepository } from '../../../src/commerce/settings_store';
import { InMemoryStaffGrantRepository, type StaffScope } from '../../../src/commerce/staff_grants';
import { registerDevice, resetDeviceRegistry } from '../../../src/devices/registry';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../../src/workflow/service';
import {
  BUYER_DID,
  SUPPLIER_DID,
  hash,
  makeAcknowledgement,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
} from '../../commerce/helpers';

import type { CatalogItem, ProductRef } from '@dina/commerce-protocol';

const OWNER_CAP = 'test-owner-capability-secret';
const DEVICE = 'did:key:zJiffyIntegration';
const T0 = 1_800_000_000_000;

let router: CoreRouter;
let staffGrants: InMemoryStaffGrantRepository;
let receipts: InMemoryCommerceReceiptRepository;
let catalogPointers: InMemoryCatalogPointerRepository;
let catalogDrafts: InMemoryCatalogDraftRepository;
let catalogSourceBindings: InMemoryCatalogSourceBindingRepository;
let orders: CommerceOrderStore;
let settings: InMemoryCommerceSettingsRepository;
let workflow: WorkflowService;

function request(
  path: string,
  caller: Partial<CoreRequest>,
  query: Record<string, string> = {},
): CoreRequest {
  return {
    method: 'GET',
    path,
    query,
    headers: {},
    body: {},
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...caller,
  } as CoreRequest;
}
const owner = (path: string, query?: Record<string, string>): CoreRequest =>
  request(
    path,
    { callerType: 'owner', callerDID: 'did:key:owner', ownerCapability: OWNER_CAP },
    query,
  );
const device = (path: string, query?: Record<string, string>): CoreRequest =>
  request(path, { callerType: 'staff', callerDID: DEVICE }, query);

function grant(scope: StaffScope, installs: 'buyer' | 'supplier' | 'both' = 'supplier'): void {
  staffGrants.put({
    deviceDid: DEVICE,
    scope,
    maxOrderMinorUnits: '',
    currency: '',
    installs,
    createdAt: T0,
    revokedAt: null,
  });
}

/** A live catalogue with one item naming `product`, as the publisher leaves it. */
function publishCatalogNaming(product: ProductRef | undefined, name: string): void {
  if (product === undefined) throw new Error('test: no product');
  const item: CatalogItem = {
    product,
    supplier_did: SUPPLIER_DID,
    catalog_id: 'main',
    item_revision: 'rev-1',
    name,
    category_ids: ['food.bakery'],
    pack: { sell_unit: { value: '1', unit_code: 'each' } },
    fulfilment_regions: [{ scheme: 'admin_area', value: 'US-CA' }],
    freshness: { generated_at: '2026-08-08T08:00:00.000Z' },
  };
  const built = buildCatalogSnapshot({
    supplierDid: SUPPLIER_DID,
    catalogId: 'main',
    protocolVersion: '1.0',
    publishedAt: '2026-08-08T08:00:00.000Z',
    items: [item],
    previous: null,
    sha256: hash,
  });
  if (!built.ok || built.snapshot === undefined || built.pages === undefined) {
    throw new Error('test: snapshot did not build');
  }
  catalogDrafts.put({
    draftId: 'cdr-1',
    catalogId: 'main',
    state: 'published',
    held: { snapshot: built.snapshot, pages: built.pages, pointer: built.pointer },
    createdAtMs: T0,
    updatedAtMs: T0,
  } as unknown as CatalogDraft);
  catalogPointers.put({
    catalogId: 'main',
    pointer: built.pointer,
    pointerCid: 'bafy-live',
    snapshotDigest: built.snapshot.snapshot_digest,
    withdrawn: false,
    publishedAtMs: T0,
  });
}

function decided(
  purchaseOrderId: string,
  orderDigest: string,
  decidedAt: number,
  quote: { id: string; digest: string } = { id: 'q-1', digest: 'b'.repeat(64) },
): void {
  expect(
    orders.createReserved({
      buyerDid: BUYER_DID,
      purchaseOrderId,
      idempotencyKey: `idem-${purchaseOrderId}`,
      orderDigest,
      quoteId: quote.id,
      quoteDigest: quote.digest,
      pinnedVersion: '1.0',
      servingManifestCid: '',
      servingInstallId: '',
      admittedEpoch: '1',
      reconciliationRequired: false,
      decisionDeadlineAt: null,
      createdAt: T0,
    }),
  ).toBe(true);
  const ack = JSON.stringify(
    makeAcknowledgement({
      purchase_order_id: purchaseOrderId,
      order_digest: orderDigest,
      kind: 'accepted',
      supplier_order_id: `so-${purchaseOrderId}`,
    }),
  );
  const order = orders.load(BUYER_DID, purchaseOrderId);
  if (order === null) throw new Error(`test: ${purchaseOrderId} was not reserved`);
  expect(order.decide({ acknowledgementJson: ack, decidedAt }).ok).toBe(true);
}

beforeEach(() => {
  setNodeDID(SUPPLIER_DID);
  staffGrants = new InMemoryStaffGrantRepository();
  receipts = new InMemoryCommerceReceiptRepository();
  catalogPointers = new InMemoryCatalogPointerRepository();
  catalogDrafts = new InMemoryCatalogDraftRepository();
  catalogSourceBindings = new InMemoryCatalogSourceBindingRepository();
  orders = new CommerceOrderStore({
    refs: new InMemoryCommerceOrderRefRepository(),
    now: () => T0,
  });
  settings = new InMemoryCommerceSettingsRepository();
  installCommerceRuntime({
    staffGrants,
    orders,
    receipts,
    catalogPointers,
    catalogDrafts,
    catalogSourceBindings,
    catalogRefreshCommands: new InMemoryCatalogRefreshCommandRepository(),
    settings,
    nodeDid: () => SUPPLIER_DID,
    now: () => T0,
    runInTransaction: (body: () => void) => body(),
  } as unknown as CommerceRuntime);
  workflow = new WorkflowService({
    repository: new InMemoryWorkflowRepository(),
    nowMsFn: () => T0,
  });
  setWorkflowService(workflow);
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  resetDeviceRegistry();
  installCommerceRuntime(null);
  setWorkflowService(null);
});

const STATUS = '/v1/commerce/integration/status';
const ORDERS = '/v1/commerce/integration/orders';
const SETTINGS = '/v1/commerce/integration/settings';
const PROPOSAL = '/v1/commerce/integration/settings/proposal';

function post(
  path: string,
  caller: Partial<CoreRequest>,
  body: Record<string, unknown>,
): CoreRequest {
  return { ...request(path, caller), method: 'POST', body } as CoreRequest;
}
const deviceSettings = (): CoreRequest =>
  request(SETTINGS, { callerType: 'staff', callerDID: DEVICE });
const devicePropose = (body: Record<string, unknown>): CoreRequest =>
  post(PROPOSAL, { callerType: 'staff', callerDID: DEVICE }, body);

const SUPPLIER_SETTINGS = {
  actingBusinessDid: SUPPLIER_DID,
  catalogSource: { kind: 'inline', lastHealthyAtIso: null },
  publicRegions: [{ scheme: 'admin_area', value: 'US-CA' }],
  publishIndicativePrice: true,
  quoteAccess: 'anyone',
  responsePolicy: {},
  customerPricingSource: null,
  orderAcceptance: 'review',
  listingState: 'live',
  connectors: [],
} as const;

describe('who reaches the integration surface', () => {
  it('the owner reaches both doors', async () => {
    expect((await router.handle(owner(STATUS))).status).toBe(200);
    expect((await router.handle(owner(ORDERS))).status).toBe(200);
  });

  it('a staff device reaches a door only on a live grant for THAT scope on the supplier install', async () => {
    expect((await router.handle(device(STATUS))).status).toBe(403);
    grant('integration_orders_export');
    expect((await router.handle(device(STATUS))).status).toBe(403); // wrong scope
    expect((await router.handle(device(ORDERS))).status).toBe(200);
    grant('integration_status', 'buyer');
    expect((await router.handle(device(STATUS))).status).toBe(403); // wrong install
    grant('integration_status', 'supplier');
    const ok = await router.handle(device(STATUS));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      integration_api_version: 1,
      business_did: SUPPLIER_DID,
      device_did: DEVICE,
    });
    // Both live grants, with their install scope; the buyer-install status grant was replaced by the supplier one (one row per device+scope).
    expect((ok.body as { grants: unknown[] }).grants).toEqual([
      {
        device_did: DEVICE,
        scope: 'integration_orders_export',
        installs: 'supplier',
        created_at: T0,
      },
      { device_did: DEVICE, scope: 'integration_status', installs: 'supplier', created_at: T0 },
    ]);
    staffGrants.revokeDevice(DEVICE, T0 + 1);
    expect((await router.handle(device(STATUS))).status).toBe(403);
    expect((await router.handle(device(ORDERS))).status).toBe(403);
  });

  it('Brain, a plain device, an agent and a plugin receive the owner guard’s refusal, whatever grants exist', async () => {
    grant('integration_status');
    grant('integration_orders_export');
    for (const callerType of ['brain', 'device', 'agent', 'plugin', 'admin'] as const) {
      for (const path of [STATUS, ORDERS]) {
        const res = await router.handle(request(path, { callerType, callerDID: DEVICE }));
        expect([callerType, path, res.status]).toEqual([callerType, path, 403]);
        expect((res.body as { error: string }).error).toBe('access_denied');
      }
    }
  });

  it('the refusal for a device names the reason and discloses nothing else', async () => {
    const res = await router.handle(device(ORDERS));
    expect(res.body).toEqual({
      error: 'access_denied',
      reason: 'no live staff grant for this scope',
    });
  });
});

describe('the orders export door', () => {
  beforeEach(() => grant('integration_orders_export'));

  it('pages decided orders in snake_case with a cursor; the same cursor replays the same page', async () => {
    decided('po-1', 'c'.repeat(64), T0 + 1);
    decided('po-2', 'd'.repeat(64), T0 + 2);
    decided('po-3', 'e'.repeat(64), T0 + 3);
    const first = await router.handle(device(ORDERS, { limit: '2' }));
    expect(first.status).toBe(200);
    const body = first.body as {
      events: { purchase_order_id: string; event_id: string; order: unknown }[];
      next_cursor: string;
      unreadable: number;
    };
    expect(body.events.map((e) => e.purchase_order_id)).toEqual(['po-1', 'po-2']);
    expect(body.events[0]).toMatchObject({
      decision: 'accepted',
      supplier_order_id: 'so-po-1',
      buyer_did: BUYER_DID,
      order: null,
    });
    expect(body.next_cursor).toBe(
      encodeOrdersCursor({ decidedAt: T0 + 2, orderDigest: 'd'.repeat(64) }),
    );
    expect(body.unreadable).toBe(0);
    const replay = await router.handle(device(ORDERS, { limit: '2' }));
    expect(replay.body).toEqual(first.body);
    const second = await router.handle(device(ORDERS, { cursor: body.next_cursor, limit: '2' }));
    expect(
      (second.body as { events: { purchase_order_id: string }[] }).events.map(
        (e) => e.purchase_order_id,
      ),
    ).toEqual(['po-3']);
    const third = await router.handle(
      device(ORDERS, { cursor: (second.body as { next_cursor: string }).next_cursor }),
    );
    expect(third.body).toEqual({ events: [], next_cursor: null, unreadable: 0 });
  });

  it('an accepted event carries the retained order in snake_case: totals, lines with unit prices, the delivery projection', async () => {
    const request = makeQuoteRequest();
    const quote = makeSignedQuote(request);
    const order = makeOrder(quote, request.delivery.projection);
    receipts.put({
      recordDigest: order.order_digest,
      domain: 'order',
      buyerDid: BUYER_DID,
      quoteId: quote.quote_id,
      purchaseOrderId: order.purchase_order_id,
      recordJson: JSON.stringify(order),
      evidenceJson: '{}',
      createdAt: T0,
    });
    receipts.put({
      recordDigest: quote.quote_digest,
      domain: 'quote',
      buyerDid: BUYER_DID,
      quoteId: quote.quote_id,
      purchaseOrderId: '',
      recordJson: JSON.stringify(quote),
      evidenceJson: '{}',
      createdAt: T0,
    });
    decided(order.purchase_order_id, order.order_digest, T0 + 1, {
      id: quote.quote_id,
      digest: quote.quote_digest,
    });
    const res = await router.handle(device(ORDERS));
    expect(res.status).toBe(200);
    const event = (res.body as { events: { order: unknown }[] }).events[0];
    expect(event?.order).toEqual({
      totals: quote.total,
      lines: [
        {
          line_id: 'l1',
          // The product rides on every line; with no published item, no name.
          product: order.accepted_lines[0]?.product,
          quantity: order.accepted_lines[0]?.quantity,
          unit_price: quote.lines[0]?.unit_price,
        },
      ],
      // The projection travels whole: the connector exists to deliver.
      delivery_projection: order.delivery,
    });

    // Once the catalogue naming that product is live, the line carries its name.
    publishCatalogNaming(order.accepted_lines[0]?.product, 'Birthday cake');
    const named = await router.handle(device(ORDERS));
    const line = (named.body as { events: { order: { lines: unknown[] } }[] }).events[0]?.order
      .lines[0];
    expect(line).toMatchObject({ line_id: 'l1', name: 'Birthday cake' });
  });

  it('refuses a malformed cursor or limit before touching the store', async () => {
    const malformed: Record<string, string>[] = [
      { cursor: 'nope' },
      { cursor: `v1.${T0}.short` },
      { limit: '0' },
      { limit: '201' },
      { limit: 'ten' },
      { limit: '-1' },
    ];
    for (const query of malformed) {
      const res = await router.handle(device(ORDERS, query));
      expect([query, res.status]).toEqual([query, 400]);
    }
    expect((await router.handle(device(ORDERS, { cursor: '' }))).status).toBe(200);
    expect((await router.handle(device(ORDERS, { limit: '200' }))).status).toBe(200);
  });
});

describe('the catalogues door', () => {
  it('lists published pointers with their binding, and bound catalogues that never published', async () => {
    grant('integration_catalog_refresh');
    catalogPointers.put({
      catalogId: 'cat-a',
      pointer: {
        supplier_did: SUPPLIER_DID,
        catalog_id: 'cat-a',
        snapshot_sequence: 2,
        protocol_version: '1.0',
        published_at: '2026-09-23T00:00:00.000Z',
      } as never,
      pointerCid: 'bafy-a',
      snapshotDigest: 'a'.repeat(64),
      withdrawn: false,
      publishedAtMs: T0,
    });
    catalogSourceBindings.put({
      catalogId: 'cat-b',
      kind: 'rest',
      credentialResource: 'catalog.source',
      operation: 'read_catalog',
      defaultScheme: 'sku',
      serviceRkey: null,
      boundAt: T0,
    });
    const res = await router.handle(device('/v1/commerce/integration/catalogs'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      catalogs: [
        {
          catalog_id: 'cat-a',
          state: 'published',
          snapshot_sequence: 2,
          snapshot_digest: 'a'.repeat(64),
          published_at: T0,
          bound: false,
        },
        {
          catalog_id: 'cat-b',
          state: 'unpublished',
          snapshot_sequence: null,
          snapshot_digest: null,
          published_at: null,
          bound: true,
        },
      ],
    });
  });
});

describe('the settings doors', () => {
  beforeEach(() => {
    grant('integration_settings_propose');
    expect(settings.writeSupplier(SUPPLIER_SETTINGS as never).ok).toBe(true);
  });

  it('GET names the revision, the proposable controls and no proposal yet; every other scope’s grant admits nothing here', async () => {
    const res = await router.handle(deviceSettings());
    expect(res.status).toBe(200);
    const body = res.body as {
      settings_revision: { supplier: string; business: string | null };
      proposable_controls: string[];
      proposals: unknown[];
    };
    expect(body.settings_revision.supplier).toMatch(/^[0-9a-f]{64}$/);
    expect(body.settings_revision.business).toBeNull();
    expect(body.proposable_controls).toContain('orderAcceptance');
    expect(body.proposals).toEqual([]);
    staffGrants.revokeDevice(DEVICE, T0 + 1);
    grant('integration_status');
    expect((await router.handle(deviceSettings())).status).toBe(403);
  });

  it('a proposal is validated at the door, becomes an owner card, is idempotent by command, and reads back with its state', async () => {
    const revision = (
      (await router.handle(deviceSettings())).body as { settings_revision: { supplier: string } }
    ).settings_revision.supplier;
    expect(
      (
        await router.handle(
          devicePropose({
            command_id: 'bad id!',
            kind: 'supplier',
            expected_revision: revision,
            controls: { orderAcceptance: 'auto' },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await router.handle(
          devicePropose({
            command_id: 'c1',
            kind: 'buyer',
            expected_revision: revision,
            controls: { orderAcceptance: 'auto' },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await router.handle(
          devicePropose({
            command_id: 'c1',
            kind: 'supplier',
            expected_revision: 'short',
            controls: { orderAcceptance: 'auto' },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await router.handle(
          devicePropose({
            command_id: 'c1',
            kind: 'supplier',
            expected_revision: revision,
            controls: {},
          }),
        )
      ).status,
    ).toBe(400);
    const unsupported = await router.handle(
      devicePropose({
        command_id: 'c1',
        kind: 'supplier',
        expected_revision: revision,
        controls: { connectors: [] },
      }),
    );
    expect(unsupported.status).toBe(400);
    expect(unsupported.body).toEqual({ error: 'unsupported_control', controls: ['connectors'] });
    const stale = await router.handle(
      devicePropose({
        command_id: 'c1',
        kind: 'supplier',
        expected_revision: 'f'.repeat(64),
        controls: { orderAcceptance: 'auto' },
      }),
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: 'revision_conflict', current_revision: revision });

    const pending = await router.handle(
      devicePropose({
        command_id: 'c1',
        kind: 'supplier',
        expected_revision: revision,
        controls: { orderAcceptance: 'auto' },
      }),
    );
    expect(pending.status).toBe(202);
    const taskId = (pending.body as { task_id: string }).task_id;
    expect(pending.body).toEqual({ state: 'pending_owner_approval', task_id: taskId });
    expect(
      (
        await router.handle(
          devicePropose({
            command_id: 'c1',
            kind: 'supplier',
            expected_revision: revision,
            controls: { orderAcceptance: 'auto' },
          }),
        )
      ).body,
    ).toEqual(pending.body);
    const conflict = await router.handle(
      devicePropose({
        command_id: 'c1',
        kind: 'supplier',
        expected_revision: revision,
        controls: { orderAcceptance: 'review' },
      }),
    );
    expect(conflict.status).toBe(409);
    expect((conflict.body as { error: string }).error).toBe('command_conflict');
    const listed = (await router.handle(deviceSettings())).body as {
      proposals: { command_id: string; task_id: string; state: string; proposed_by: string }[];
    };
    expect(listed.proposals).toEqual([
      expect.objectContaining({
        command_id: 'c1',
        task_id: taskId,
        state: 'pending_approval',
        proposed_by: DEVICE,
      }),
    ]);
    // Nothing applied: the revision stands until the owner decides.
    expect(
      ((await router.handle(deviceSettings())).body as { settings_revision: { supplier: string } })
        .settings_revision.supplier,
    ).toBe(revision);
  });

  it('the card and the listing name the proposing device by the name the owner gave it (review item 3)', async () => {
    const paired = registerDevice('Jiffy till connector', 'zJiffyIntegration', 'staff');
    expect(paired.did).toBe(DEVICE);
    const revision = (
      (await router.handle(deviceSettings())).body as { settings_revision: { supplier: string } }
    ).settings_revision.supplier;
    const res = await router.handle(
      devicePropose({
        command_id: 'c-named',
        kind: 'supplier',
        expected_revision: revision,
        controls: { orderAcceptance: 'auto' },
      }),
    );
    expect(res.status).toBe(202);
    const task = workflow.store().getById((res.body as { task_id: string }).task_id);
    expect(task?.description).toBe(
      'Apply 1 supplier setting change(s) proposed by "Jiffy till connector"?',
    );
    expect(JSON.parse(task?.payload ?? '{}')).toMatchObject({
      proposed_by: DEVICE,
      proposed_by_name: 'Jiffy till connector',
    });
    const listed = (await router.handle(deviceSettings())).body as {
      proposals: { proposed_by: string; proposed_by_name?: string }[];
    };
    expect(listed.proposals[0]).toMatchObject({
      proposed_by: DEVICE,
      proposed_by_name: 'Jiffy till connector',
    });
  });

  it('a null revision answers supplier_settings_absent before the owner saves settings, and names the live revision after (review item 4)', async () => {
    const withSettings = await router.handle(
      devicePropose({
        command_id: 'c-null',
        kind: 'supplier',
        expected_revision: null,
        controls: { orderAcceptance: 'auto' },
      }),
    );
    const revision = (
      (await router.handle(deviceSettings())).body as { settings_revision: { supplier: string } }
    ).settings_revision.supplier;
    expect(withSettings.status).toBe(409);
    expect(withSettings.body).toEqual({ error: 'revision_conflict', current_revision: revision });

    settings = new InMemoryCommerceSettingsRepository();
    installCommerceRuntime({ ...getCommerceRuntime(), settings } as unknown as CommerceRuntime);
    expect(
      ((await router.handle(deviceSettings())).body as { settings_revision: { supplier: unknown } })
        .settings_revision.supplier,
    ).toBeNull();
    const absent = await router.handle(
      devicePropose({
        command_id: 'c-null',
        kind: 'supplier',
        expected_revision: null,
        controls: { orderAcceptance: 'auto' },
      }),
    );
    expect(absent.status).toBe(409);
    expect(absent.body).toEqual({ error: 'supplier_settings_absent' });
  });

  it('the owner may propose on the same door, attributed as owner', async () => {
    const revision = (
      (await router.handle(deviceSettings())).body as { settings_revision: { supplier: string } }
    ).settings_revision.supplier;
    const res = await router.handle(
      post(
        PROPOSAL,
        { callerType: 'owner', callerDID: 'did:key:owner', ownerCapability: OWNER_CAP },
        {
          command_id: 'c2',
          kind: 'supplier',
          expected_revision: revision,
          controls: { listingState: 'paused' },
        },
      ),
    );
    expect(res.status).toBe(202);
    const listed = (await router.handle(owner(SETTINGS))).body as {
      proposals: { proposed_by: string }[];
    };
    expect(listed.proposals[0].proposed_by).toBe('owner');
  });
});
