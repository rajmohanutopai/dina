/**
 * The reference supplier runner (review item 5): prices from the published
 * catalogue, declines what it cannot price exactly, answers orders, status
 * and cancellations — and runs through the node's own claim and complete
 * routes, the plugin claim guard included.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  validateOrderAcknowledgement,
  validateSignedQuote,
  type CatalogItem,
  type SignedQuote,
} from '@dina/commerce-protocol';
import { validatePluginManifest } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  InMemoryCatalogDraftRepository,
  type CatalogDraft,
} from '../../src/commerce/catalog_draft_store';
import { InMemoryCatalogPointerRepository } from '../../src/commerce/catalog_pointer_store';
import { buildCatalogSnapshot } from '../../src/commerce/catalog_publisher';
import { CommerceOrderStore } from '../../src/commerce/commerce_order';
import { transformInboundOrderResult } from '../../src/commerce/order_decision';
import { InMemoryCommerceOrderRefRepository } from '../../src/commerce/order_refs';
import { findPublishedItem, publishedCatalogItems } from '../../src/commerce/published_catalog';
import { SUPPLIER_REFERENCE_MANIFEST } from '../../src/commerce/reference_manifests';
import {
  createCommerceRuntime,
  getCommerceRuntime,
  installCommerceRuntime,
} from '../../src/commerce/runtime';
import {
  SupplierReferenceRunner,
  answerCancellation,
  answerOrderStatus,
  answerQuoteRequest,
  answerSubmitOrder,
  rememberReferenceRunnerDevice,
  supplierOrderReference,
} from '../../src/commerce/supplier_runner';
import { resetKVStore } from '../../src/kv/store';
import { createProviderIngressTask } from '../../src/plugins/provider_ingress';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
} from '../../src/plugins/registry';
import { CoreRouter } from '../../src/server/router';
import { registerWorkflowRoutes } from '../../src/server/routes/workflow';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

import {
  BUYER_DID,
  SUPPLIER_DID,
  hash,
  makeAcknowledgement,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
} from './helpers';

const T0 = Date.parse('2026-08-08T09:00:00.000Z');

function item(over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    product: { scheme: 'gtin', value: '09506000134352' },
    supplier_did: SUPPLIER_DID,
    catalog_id: 'main',
    item_revision: 'rev-1',
    name: 'Birthday cake',
    category_ids: ['food.bakery'],
    pack: { sell_unit: { value: '1', unit_code: 'each' } },
    fulfilment_regions: [{ scheme: 'admin_area', value: 'US-CA' }],
    indicative_price: { currency: 'INR', minor_units: '500' },
    freshness: { generated_at: '2026-08-08T08:00:00.000Z' },
    ...over,
  };
}

const request = makeQuoteRequest();

describe('pricing a quote from the published catalogue', () => {
  it('prices every line at the published price per sell unit and quantity asked', () => {
    expect(answerQuoteRequest(request, [item()])).toEqual({
      ok: true,
      result: {
        can_supply: true,
        lines: [
          {
            line_id: 'l1',
            unit_price: { currency: 'INR', minor_units: '500' },
            quantity: { value: '100', unit_code: 'each' },
          },
        ],
      },
    });
  });

  it('matches a shared identifier the item lists, not only its own product ref', () => {
    const own = item({
      product: { scheme: 'manufacturer_sku', value: 'CAKE-1', issuer_did: SUPPLIER_DID },
      identifiers: [{ scheme: 'gtin', value: '09506000134352' }],
    });
    expect(answerQuoteRequest(request, [own])).toMatchObject({
      ok: true,
      result: { can_supply: true },
    });
    expect(
      findPublishedItem([own], {
        scheme: 'manufacturer_sku',
        value: 'CAKE-1',
        issuer_did: SUPPLIER_DID,
      })?.name,
    ).toBe('Birthday cake');
  });

  it('declines the whole request, with the line named, when it cannot price exactly', () => {
    expect(answerQuoteRequest(request, [])).toEqual({
      ok: true,
      result: { can_supply: false, decline_reason: 'not_in_catalog: l1' },
    });
    expect(answerQuoteRequest(request, [item({ indicative_price: undefined })])).toMatchObject({
      result: { decline_reason: 'no_published_price: l1' },
    });
    expect(
      answerQuoteRequest(request, [item({ pack: { sell_unit: { value: '1', unit_code: 'kg' } } })]),
    ).toMatchObject({ result: { decline_reason: 'unit_mismatch: l1' } });
    expect(
      answerQuoteRequest(request, [
        item({ pack: { sell_unit: { value: '6', unit_code: 'each' } } }),
      ]),
    ).toMatchObject({ result: { decline_reason: 'unit_mismatch: l1' } });
    expect(
      answerQuoteRequest(request, [item({ minimum_order: { value: '200', unit_code: 'each' } })]),
    ).toMatchObject({ result: { decline_reason: 'below_minimum_order: l1' } });
    expect(answerQuoteRequest({ request_id: 'r', lines: [] }, [item()])).toEqual({
      ok: false,
      error: 'quote request: lines are unreadable',
    });
  });

  it('gives terms Core turns into a valid signed quote on the production seam', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ref-runner-quote-'));
    const adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    installCommerceRuntime(
      createCommerceRuntime({
        adapter,
        supplierDid: () => SUPPLIER_DID,
        currentEpoch: () => '1',
        now: () => T0,
      }),
    );
    try {
      const terms = answerQuoteRequest(request, [item()]);
      if (!terms.ok) throw new Error('fixture');
      const decision = transformInboundOrderResult({
        capability: 'request_quote',
        fromDid: BUYER_DID,
        params: request,
        resultJSON: JSON.stringify(terms.result),
        nowMs: T0,
      });
      expect(decision.kind).toBe('replace');
      const quote = JSON.parse((decision as { kind: 'replace'; json: string }).json) as SignedQuote;
      expect(validateSignedQuote(quote, hash)).toBeNull();
      expect(quote.total).toEqual({ currency: 'INR', minor_units: '50000' });
    } finally {
      installCommerceRuntime(null);
      adapter.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('orders, status and cancellations', () => {
  it('accepts an order with a stable reference of this business’s own', () => {
    expect(answerSubmitOrder({ purchase_order_id: 'po_1', order_digest: 'a'.repeat(64) })).toEqual({
      ok: true,
      result: { kind: 'accepted', supplier_order_id: supplierOrderReference('po_1') },
    });
    expect(supplierOrderReference('po_1')).toMatch(/^SO-[0-9A-F]{10}$/);
    expect(supplierOrderReference('po_1')).toBe(supplierOrderReference('po_1'));
    expect(answerSubmitOrder({})).toEqual({
      ok: false,
      error: 'order: purchase_order_id is missing',
    });
  });

  it('reports what Core recorded, and nothing it has not', () => {
    const orders = new CommerceOrderStore({
      refs: new InMemoryCommerceOrderRefRepository(),
      now: () => T0,
    });
    const quote = makeSignedQuote(request);
    const order = makeOrder(quote, request.delivery.projection);
    const reserve = (po: string, digest: string, buyerDid = BUYER_DID): void => {
      expect(
        orders.createReserved({
          buyerDid,
          purchaseOrderId: po,
          idempotencyKey: `i-${po}`,
          orderDigest: digest,
          quoteId: quote.quote_id,
          quoteDigest: quote.quote_digest,
          pinnedVersion: '1.0',
          servingManifestCid: '',
          servingInstallId: '',
          admittedEpoch: '1',
          reconciliationRequired: false,
          decisionDeadlineAt: null,
          createdAt: T0,
        }),
      ).toBe(true);
    };
    reserve(order.purchase_order_id, order.order_digest);
    expect(
      answerOrderStatus({ purchase_order_id: order.purchase_order_id }, { orders }, BUYER_DID),
    ).toEqual({
      ok: false,
      error: 'no_status_yet',
    });
    const accepted = makeAcknowledgement({
      purchase_order_id: order.purchase_order_id,
      order_digest: order.order_digest,
      supplier_order_id: 'SO-1',
    });
    expect(
      orders
        .load(BUYER_DID, order.purchase_order_id)
        ?.decide({ acknowledgementJson: JSON.stringify(accepted), decidedAt: T0 + 1 }).ok,
    ).toBe(true);
    expect(
      answerOrderStatus({ purchase_order_id: order.purchase_order_id }, { orders }, BUYER_DID),
    ).toEqual({
      ok: true,
      result: { state: 'accepted', supplier_order_id: 'SO-1' },
    });
    reserve('po-no', 'b'.repeat(64));
    const rejected = makeAcknowledgement({
      purchase_order_id: 'po-no',
      order_digest: 'b'.repeat(64),
      kind: 'rejected',
      reason_code: 'out_of_stock',
    });
    expect(
      orders
        .load(BUYER_DID, 'po-no')
        ?.decide({ acknowledgementJson: JSON.stringify(rejected), decidedAt: T0 + 2 }).ok,
    ).toBe(true);
    expect(answerOrderStatus({ purchase_order_id: 'po-no' }, { orders }, BUYER_DID)).toEqual({
      ok: true,
      result: { state: 'rejected' },
    });
    expect(answerOrderStatus({ purchase_order_id: 'po-unknown' }, { orders }, BUYER_DID)).toEqual({
      ok: false,
      error: 'no_status_yet',
    });
    // Two buyers may choose the same purchase order id: each asks about ITS
    // order, and a third party asking about the id learns nothing.
    const OTHER = 'did:plc:otherbuyer';
    reserve(order.purchase_order_id, 'c'.repeat(64), OTHER);
    const otherRejected = makeAcknowledgement({
      purchase_order_id: order.purchase_order_id,
      order_digest: 'c'.repeat(64),
      kind: 'rejected',
      reason_code: 'out_of_stock',
    });
    expect(
      orders
        .load(OTHER, order.purchase_order_id)
        ?.decide({ acknowledgementJson: JSON.stringify(otherRejected), decidedAt: T0 + 3 }).ok,
    ).toBe(true);
    const status = (buyer: string) =>
      answerOrderStatus({ purchase_order_id: order.purchase_order_id }, { orders }, buyer);
    expect(status(BUYER_DID)).toEqual({
      ok: true,
      result: { state: 'accepted', supplier_order_id: 'SO-1' },
    });
    expect(status(OTHER)).toEqual({ ok: true, result: { state: 'rejected' } });
    expect(status('did:plc:stranger')).toEqual({ ok: false, error: 'no_status_yet' });
    expect(status('')).toEqual({ ok: false, error: 'no_status_yet' });
    expect(answerCancellation()).toEqual({ ok: true, result: { verdict: 'cancelled' } });
  });
});

describe('the published catalogue it reads', () => {
  it('reads the items of the draft whose held snapshot the live pointer names, and nothing from a withdrawn catalogue', () => {
    const built = buildCatalogSnapshot({
      supplierDid: SUPPLIER_DID,
      catalogId: 'main',
      protocolVersion: '1.0',
      publishedAt: '2026-08-08T08:00:00.000Z',
      items: [item()],
      previous: null,
      sha256: hash,
    });
    if (!built.ok || built.snapshot === undefined || built.pages === undefined)
      throw new Error('fixture');
    const catalogDrafts = new InMemoryCatalogDraftRepository();
    const catalogPointers = new InMemoryCatalogPointerRepository();
    const draft = {
      draftId: 'cdr-1',
      catalogId: 'main',
      state: 'published',
      provenanceClass: 'source_parsed',
      defaultScheme: 'gtin',
      extraction: null,
      photoExtraction: null,
      publishClaim: null,
      contentRevision: 1,
      rows: [],
      findings: [],
      provenance: {},
      items: [item()],
      generatedAtIso: '2026-08-08T08:00:00.000Z',
      itemRevision: 'rev-1',
      receipt: null,
      held: {
        snapshot: built.snapshot,
        pages: built.pages,
        pointer: built.pointer,
        expectedPointerCid: '',
        revision: 1,
      },
      approval: { digest: built.snapshot.snapshot_digest, revision: 1 },
      publication: null,
      createdAtMs: T0,
      updatedAtMs: T0,
    } as unknown as CatalogDraft;
    catalogDrafts.put(draft);
    expect(publishedCatalogItems({ catalogDrafts, catalogPointers })).toEqual([]);
    catalogPointers.put({
      catalogId: 'main',
      pointer: built.pointer,
      pointerCid: 'bafy',
      snapshotDigest: built.snapshot.snapshot_digest,
      withdrawn: false,
      publishedAtMs: T0,
    });
    expect(publishedCatalogItems({ catalogDrafts, catalogPointers }).map((i) => i.name)).toEqual([
      'Birthday cake',
    ]);
    catalogPointers.put({
      catalogId: 'main',
      pointer: built.pointer,
      pointerCid: 'bafy2',
      snapshotDigest: '',
      withdrawn: true,
      publishedAtMs: T0 + 1,
    });
    expect(publishedCatalogItems({ catalogDrafts, catalogPointers })).toEqual([]);
  });
});

describe('the loop, through the node’s own routes', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  let installs: SQLitePluginInstallRepository;
  let workflow: WorkflowService;
  let router: CoreRouter;
  let sent: { to: string; body: Record<string, unknown> }[];
  let installId: string;
  const RUNNER = 'did:key:zReferenceRunner';
  const OTHER = 'did:key:zOperatorRunner';

  beforeEach(() => {
    resetKVStore();
    dir = mkdtempSync(path.join(tmpdir(), 'ref-runner-loop-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    installs = new SQLitePluginInstallRepository(adapter);
    setPluginInstallRepository(installs);
    expect(validatePluginManifest(SUPPLIER_REFERENCE_MANIFEST).ok).toBe(true);
    installId = installs.createPending({
      publisherDid: 'did:plc:chairmakerpub',
      pluginId: SUPPLIER_REFERENCE_MANIFEST.plugin_id,
      label: 'Supplier',
      executionMode: 'runner',
      currentCid: 'bafy-sup',
      currentVersion: SUPPLIER_REFERENCE_MANIFEST.version,
      manifest: SUPPLIER_REFERENCE_MANIFEST,
      installScopeHash: 's'.repeat(64),
      capabilityHashes: Object.fromEntries(
        SUPPLIER_REFERENCE_MANIFEST.capabilities.map((c, i) => [c.id, String(i).repeat(64)]),
      ),
      behaviorHash: 'b'.repeat(64),
      presentationHash: 'p'.repeat(64),
      trustAnchor: { kind: 'repo_proof' },
      pendingExpiresAtSec: Math.floor(T0 / 1000) + 900,
      nowMs: T0,
    });
    installs.activate(installId, RUNNER, T0);
    installCommerceRuntime(
      createCommerceRuntime({
        adapter,
        supplierDid: () => SUPPLIER_DID,
        currentEpoch: () => '1',
        now: () => T0,
      }),
    );
    sent = [];
    workflow = new WorkflowService({
      repository: new InMemoryWorkflowRepository(),
      nowMsFn: () => T0,
      ingressResultTransformer: transformInboundOrderResult,
      responseBridgeSender: async (ctx) => {
        sent.push({ to: ctx.fromDID, body: JSON.parse(ctx.resultJSON) as Record<string, unknown> });
      },
    });
    setWorkflowService(workflow);
    router = new CoreRouter();
    registerWorkflowRoutes(router);
  });

  afterEach(() => {
    setWorkflowService(null);
    installCommerceRuntime(null);
    setPluginInstallRepository(null);
    resetKVStore();
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function runner(): SupplierReferenceRunner {
    return new SupplierReferenceRunner({
      dispatch:
        () =>
        async ({ path: p, body, deviceDid }) => {
          const res = await router.handle({
            method: 'POST',
            path: p,
            query: {},
            headers: { 'x-did': deviceDid },
            body,
            rawBody: new Uint8Array(),
            params: {},
            trustedInProcess: true,
            callerType: 'plugin',
            callerDID: deviceDid,
          });
          return { status: res.status, body: res.body ?? null };
        },
    });
  }

  function submit(order: unknown) {
    return createProviderIngressTask({
      workflow,
      capabilityConfig: {
        pluginInstallId: installId,
        pluginManifestCid: 'bafy-sup',
        pluginCapabilityId: 'com.dinakernel.commerce.submit-order',
      },
      query: {
        fromDid: BUYER_DID,
        queryId: 'q-order',
        capability: 'submit_order',
        serviceRkey: 'self',
        params: order,
        ttlSeconds: 300,
        serviceName: 'supplier',
      },
      // The claim route runs on the wall clock, so the task's lease must too.
      nowMs: Date.now(),
    });
  }

  it('idles until the owner pairs it, serves only the install whose device Core minted for it, and never an operator’s runner', async () => {
    const quote = makeSignedQuote(request);
    getCommerceRuntime()?.receipts.put({
      recordDigest: request.request_digest,
      domain: 'request',
      buyerDid: BUYER_DID,
      quoteId: quote.quote_id,
      purchaseOrderId: '',
      recordJson: JSON.stringify(request),
      evidenceJson: '{}',
      createdAt: T0,
    });
    expect(getCommerceRuntime()?.admission.registerSignedQuote(quote)).toBeNull();
    const order = makeOrder(quote, request.delivery.projection);
    expect(submit(order).ok).toBe(true);
    expect(await runner().runTick()).toBe(0);
    // A remembered device that is not this install's runner serves nothing.
    await rememberReferenceRunnerDevice(OTHER);
    expect(await runner().runTick()).toBe(0);
    expect(sent).toEqual([]);
    // The reference device: the order is claimed, accepted, and Core signs.
    await rememberReferenceRunnerDevice(RUNNER);
    expect(await runner().runTick()).toBe(1);
    await workflow.flushBridgeInFlight();
    expect(sent).toHaveLength(1);
    const ack = sent[0]?.body;
    expect(validateOrderAcknowledgement(ack, hash)).toBeNull();
    expect(ack).toMatchObject({
      kind: 'accepted',
      supplier_did: SUPPLIER_DID,
      order_digest: order.order_digest,
      supplier_order_id: supplierOrderReference(order.purchase_order_id),
    });
    // Nothing left on the lane.
    expect(await runner().runTick()).toBe(0);
  });
});
