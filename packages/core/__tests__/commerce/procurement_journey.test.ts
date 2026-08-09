/**
 * THE WHOLE JOURNEY: Sancho discovers ChairMaker and buys from them (§24, §25.6).
 *
 * WHY THIS EXISTS ON TOP OF THE OTHER TWO SCENARIOS. `procurement_scenario`
 * walks the commerce spine by calling engines directly.
 * `procurement_lane_scenario` walks one order through the real plugin lane.
 * Neither touches the parts a BUYER uses before an order exists — catalog
 * import, publication, ingest, fan-out planning, probing admission, hard
 * filters, ranking, evidence composition — every one of which was built and
 * tested in isolation.
 *
 * That is exactly the shape of defect this codebase keeps producing: correct
 * modules that nothing joins up. Each of the last several items was written
 * alone and gated alone; this is the test that makes them meet. It found real
 * mismatches when the same pieces met before, and the only way to know whether
 * they meet now is to run them in one sequence against one set of facts.
 *
 * THE OWNER STEPS GO THROUGH THE ROUTES, not the modules behind them. Once
 * `/v1/commerce/catalog/*` and `/v1/commerce/procurement/*` existed there were
 * two ways to reach the same rule, and a journey that took the shorter one
 * would keep passing while the shipped surface disagreed with it — which is
 * the same defect as an orphan, one layer up. Steps 1, 2, 3 and 6 are
 * therefore HTTP-shaped requests against a real `CoreRouter`.
 *
 * ONE PROCESS, TWO BUSINESSES. A real journey is two nodes; here the buyer's
 * and the supplier's owner calls hit the same router, and `setNodeDID` names
 * the supplier because that is whose catalog is being published. Nothing in
 * the journey depends on the buyer having a node identity.
 *
 * WHAT IT DOES NOT CLAIM. No D2D socket, no AppView, no PDS, no mobile UI. The
 * §25.6 manual journey is two live nodes and stays manual. This is the whole
 * in-process journey, which is a strictly smaller claim and the largest one a
 * jest run can honestly make.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { validateOrderAcknowledgement } from '@dina/commerce-protocol';
import { validatePluginManifest } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  SUPPLIER_REFERENCE_MANIFEST,
  composeProductEvidence,
  createCommerceRuntime,
  getCommerceRuntime,
  headlineEvidence,
  installCommerceRuntime,
  admitQuoteRequest,
  type Offer,
} from '../../src/commerce';
import { buildBuyerApprovalPayload } from '../../src/commerce/approval_payload';
import { submitApprovedOrder } from '../../src/commerce/buyer_executor';
import { describeOrderForOwner } from '../../src/commerce/buyer_reconciliation';
import { transformInboundOrderResult } from '../../src/commerce/order_decision';
import { clearPairingState, setNodeDID } from '../../src/pairing/ceremony';
import { createProviderIngressTask } from '../../src/plugins/provider_ingress';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
} from '../../src/plugins/registry';
import { PluginRunner } from '../../src/plugins/runner_sdk';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerCommerceRoutes } from '../../src/server/routes/commerce';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService } from '../../src/workflow/service';

import {
  BUYER_DID,
  SUPPLIER_DID,
  hash,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
} from './helpers';

const T0 = Date.parse('2026-08-08T09:00:00.000Z');
const NOW_ISO = '2026-08-08T09:00:00.000Z';
const RUNNER_DID = 'did:plc:chairmakerrunner';
const MANIFEST_CID = 'bafyreichairmaker1';
const SUBMIT_CAP_ID = 'com.dinakernel.commerce.submit-order';

/** A rival manufacturer, so the comparison has something to compare. */
const RIVAL_DID = 'did:plc:rivalchairs01';

const OWNER_CAP = 'journey-owner-capability';

/** An owner request, shaped the way the router sees one. */
function ownerPost(path: string, body: Record<string, unknown>): CoreRequest {
  return {
    method: 'POST',
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'owner',
    callerDID: 'did:key:owner',
    ownerCapability: OWNER_CAP,
  };
}

describe('Sancho discovers ChairMaker and buys from them — the whole journey', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  let installs: SQLitePluginInstallRepository;
  let workflowRepo: InMemoryWorkflowRepository;
  let workflow: WorkflowService;
  let sent: Record<string, unknown>[];
  let installId: string;
  let runner: PluginRunner;
  let router: CoreRouter;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'journey-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    installs = new SQLitePluginInstallRepository(adapter);
    setPluginInstallRepository(installs);

    installId = installs.createPending({
      publisherDid: 'did:plc:chairmakerpub',
      pluginId: SUPPLIER_REFERENCE_MANIFEST.plugin_id,
      label: 'ChairMaker',
      executionMode: 'runner',
      currentCid: MANIFEST_CID,
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
    installs.activate(installId, RUNNER_DID, T0);

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
      repository: (workflowRepo = new InMemoryWorkflowRepository()),
      nowMsFn: () => T0,
      ingressResultTransformer: transformInboundOrderResult,
      responseBridgeSender: async (ctx) => {
        sent.push(JSON.parse(ctx.resultJSON) as Record<string, unknown>);
      },
    });
    setNodeDID(SUPPLIER_DID);
    router = new CoreRouter();
    registerCommerceRoutes(router, OWNER_CAP);
    runner = new PluginRunner({
      workflow,
      repo: workflowRepo,
      install: () => installs.getById(installId),
      deviceDid: RUNNER_DID,
      nowMs: () => T0,
    });
  });

  afterEach(() => {
    installCommerceRuntime(null);
    setPluginInstallRepository(null);
    clearPairingState();
    try {
      adapter.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs discovery → fan-out → quotes → ranking → order → delivery in one sequence', async () => {
    // ─── 1. ChairMaker turns its spreadsheet into a catalog ────────────────
    const importResp = await router.handle(
      ownerPost('/v1/commerce/catalog/import', {
        csv: [
          'sku,name,unit_code,pack_size,lead_time_days',
          'CHAIR-1,Oak dining chair,each,1,14',
          'CHAIR-2,Ash dining chair,each,1,21',
        ].join('\n'),
        default_scheme: 'sku',
      }),
    );
    expect(importResp.status).toBe(200);
    const imported = importResp.body as { ok: boolean; items: unknown[]; findings?: unknown };
    if (!imported.ok) throw new Error(JSON.stringify(imported.findings));

    // ─── 2. …and publishes it. The leakage gate runs INSIDE this call. ────
    const publishResp = await router.handle(
      ownerPost('/v1/commerce/catalog/publish', {
        catalog_id: 'chairmaker-main',
        published_at: NOW_ISO,
        items: imported.items,
      }),
    );
    expect(publishResp.status).toBe(200);
    const published = publishResp.body as {
      ok: boolean;
      pointer: { snapshot_sequence: number; supplier_did: string };
      snapshot?: { item_count: number };
    };
    if (!published.ok) throw new Error(JSON.stringify(published));
    expect(published.snapshot?.item_count).toBe(2);
    // The chain starts where a consumer expects it to, under this node's own
    // name — which is the route's doing, not the body's.
    expect(published.pointer.snapshot_sequence).toBe(1);
    expect(published.pointer.supplier_did).toBe(SUPPLIER_DID);

    // ─── 3. Sancho plans who to ask, bounded ───────────────────────────────
    // Discovery returns more suppliers than anyone should be asked at once.
    const planResp = await router.handle(
      ownerPost('/v1/commerce/procurement/plan', {
        candidates: [
          { supplierDid: SUPPLIER_DID, serviceRkey: 'self', trustBp: 7000 },
          { supplierDid: RIVAL_DID, serviceRkey: 'self', trustBp: 6000 },
          ...Array.from({ length: 40 }, (_, i) => ({
            supplierDid: `did:plc:filler${String(i).padStart(6, '0')}`,
            serviceRkey: 'self',
            trustBp: 100,
          })),
        ],
        policy: { buyer_did: BUYER_DID },
      }),
    );
    expect(planResp.status).toBe(200);
    const { plan, askedNobody } = planResp.body as {
      plan: { selected: { supplierDid: string }[]; excluded: unknown[] };
      askedNobody: boolean;
    };
    expect(askedNobody).toBe(false);
    expect(plan.selected.length).toBeLessThanOrEqual(8);
    expect(plan.selected.map((c) => c.supplierDid)).toContain(SUPPLIER_DID);
    // Everyone not asked is accounted for, so Sancho can be told why.
    expect(plan.selected.length + plan.excluded.length).toBe(42);

    // ─── 4. ChairMaker decides whether to answer a stranger at all ─────────
    const admitted = admitQuoteRequest({
      fromDid: BUYER_DID,
      standing: 'unknown',
      recentAttempts: [],
      nowMs: T0,
    });
    expect(admitted.quote).toBe(true);

    // ─── 5. Quotes come back; ChairMaker's is signed and registered ────────
    const request = makeQuoteRequest();
    const runtime = getCommerceRuntime();
    if (runtime === null) throw new Error('commerce runtime missing');
    runtime.receipts.put({
      recordDigest: request.request_digest,
      domain: 'request',
      buyerDid: request.buyer_did,
      quoteId: 'q-chairmaker',
      purchaseOrderId: '',
      recordJson: JSON.stringify(request),
      evidenceJson: '{}',
      createdAt: T0,
    });
    const quote = makeSignedQuote(request, { quote_id: 'q-chairmaker' });
    expect(runtime.admission.registerSignedQuote(quote)).toBeNull();

    // ─── 6. Sancho ranks what came back ────────────────────────────────────
    const offers: Offer[] = [
      {
        supplierDid: SUPPLIER_DID,
        quoteId: 'q-chairmaker',
        totalMinorUnits: '50000',
        currency: 'INR',
        availableQuantity: { value: '100', unit_code: 'each' },
        expiresAt: '2026-08-09T09:00:00.000Z',
        leadTimeDays: 14,
        trustBp: 7000,
      },
      {
        supplierDid: RIVAL_DID,
        quoteId: 'q-rival',
        totalMinorUnits: '48000',
        currency: 'INR',
        // Cheaper — and cannot supply what was asked for. §13.2: a hard
        // requirement is not something a low price may outweigh.
        availableQuantity: { value: '40', unit_code: 'each' },
        expiresAt: '2026-08-09T09:00:00.000Z',
        leadTimeDays: 7,
        trustBp: 9000,
      },
    ];
    const chooseResp = await router.handle(
      ownerPost('/v1/commerce/procurement/choose', {
        offers,
        requirements: { quantity: { value: '100', unit_code: 'each' }, currency: 'INR' },
        at: NOW_ISO,
      }),
    );
    expect(chooseResp.status).toBe(200);
    const {
      ranking,
      best,
      headline: routeHeadline,
    } = chooseResp.body as {
      ranking: {
        ranked: { offer: { supplierDid: string } }[];
        filtered: { reason: string }[];
      };
      best: { offer: { supplierDid: string } } | null;
      headline: unknown;
    };
    expect(ranking.ranked.map((r) => r.offer.supplierDid)).toEqual([SUPPLIER_DID]);
    expect(ranking.filtered[0]).toMatchObject({ reason: 'insufficient_quantity' });
    expect(best?.offer.supplierDid).toBe(SUPPLIER_DID);
    // The route composes no evidence — Core has no PeerLens reader — and says
    // so with null rather than a neutral score. Step 7 is where evidence
    // actually enters, and it enters labelled.
    expect(routeHeadline).toBeNull();

    // ─── 7. What Sancho knows about the product, and about WHICH product ───
    const evidence = composeProductEvidence({
      product: { scheme: 'manufacturer_sku', value: 'CHAIR-1', issuer_did: SUPPLIER_DID },
      ancestors: [{ scheme: 'manufacturer_sku', value: 'SEATING', issuer_did: SUPPLIER_DID }],
      evidence: [
        {
          subject: { scheme: 'manufacturer_sku', value: 'SEATING', issuer_did: SUPPLIER_DID },
          source: 'peer:someone',
          ratingBp: 8000,
          assertedAtMs: T0,
        },
      ],
    });
    const headline = headlineEvidence(evidence);
    // Nothing is known about CHAIR-1 itself, so the headline says INHERITED
    // and names the ancestor rather than passing family reputation off as
    // this product's own.
    expect(headline?.scope).toBe('inherited');
    expect(headline?.inheritedFrom?.value).toBe('SEATING');
    expect(evidence.exact.items).toEqual([]);

    // ─── 8. Sancho places the order, through the BUYER EXECUTOR ────────────
    // Not by hand-building an ingress task any more. The executor is the one
    // place an order leaves a buyer node: it verifies the §15.2 binding,
    // records BEFORE it sends, hands the order to an injected sender, and
    // settles through the §12.7 machine. The sender here delivers into
    // ChairMaker's real ingress, so this is a retailer talking to a
    // manufacturer through both shipped surfaces rather than one test calling
    // both halves.
    const order = makeOrder(quote, request.delivery.projection);
    const approvalContext = {
      actingBusinessDid: BUYER_DID,
      principal: {
        principalDid: 'did:plc:sanchoowner',
        authorityDomain: 'procurement',
        policyRevision: null,
      },
      serviceUri: `at://${SUPPLIER_DID}/com.dinakernel.service.profile/self`,
      displayedLabels: Object.fromEntries(
        order.accepted_lines.map((l) => [l.line_id, 'Oak dining chair']),
      ),
      productKeys: Object.fromEntries(
        order.accepted_lines.map((l) => [l.line_id, 'gtin:05012345678900']),
      ),
      linePrices: Object.fromEntries(order.accepted_lines.map((l) => [l.line_id, null])),
      charges: [],
      quoteRevision: 1,
      quoteExpiresAt: '2026-08-09T09:00:00.000Z',
      install: {
        installId: 'install-buyer',
        capabilityId: SUBMIT_CAP_ID,
        manifestCid: MANIFEST_CID,
        installScopeHash: 's'.repeat(64),
        configRevision: '1',
      },
    };
    const approvedCard = buildBuyerApprovalPayload(order, approvalContext);
    if (!approvedCard.ok) throw new Error(approvedCard.missing.join(', '));

    /**
     * The sender: ChairMaker's ingress, reached the way a real one is.
     *
     * It hands the order to the provider ingress, lets the runner answer, and
     * returns whatever Core SIGNED — never the runner's JSON. `ambiguous` is
     * the honest answer when nothing came back, which is what parks the buyer
     * rather than authorizing a second order.
     */
    const submitted = await submitApprovedOrder({
      order,
      approved: approvedCard.payload,
      context: approvalContext,
      serviceRkey: 'self',
      nowMs: T0,
      send: async ({ order: outbound }) => {
        const created = createProviderIngressTask({
          workflow,
          capabilityConfig: {
            pluginInstallId: installId,
            pluginManifestCid: MANIFEST_CID,
            pluginCapabilityId: SUBMIT_CAP_ID,
          },
          query: {
            fromDid: BUYER_DID,
            queryId: 'q-journey-order',
            capability: 'submit_order',
            serviceRkey: 'self',
            params: outbound,
            ttlSeconds: 300,
          },
          nowMs: T0,
        });
        if (!created.ok) return { kind: 'not_sent', reason: JSON.stringify(created) };

        // ─── 9. ChairMaker's runner takes the business ─────────────────────
        const job = runner.claim();
        if (job.kind !== 'job') return { kind: 'ambiguous', reason: JSON.stringify(job) };
        runner.answer(job.job, {
          kind: 'result',
          result: { kind: 'accepted', supplier_order_id: 'CM-JOURNEY-1' },
        });
        await workflow.flushBridgeInFlight();

        const signed = sent[0];
        return signed === undefined
          ? { kind: 'ambiguous', reason: 'no acknowledgement came back' }
          : { kind: 'acknowledged', acknowledgement: signed as never };
      },
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) throw new Error(submitted.error);
    // The buyer's own record says accepted, and it says so from the SIGNED
    // acknowledgement rather than from the runner's answer.
    expect(submitted.record.state).toBe('accepted');
    expect(describeOrderForOwner(submitted.record).actions).toEqual([
      'view_acknowledgement',
      'check_status',
    ]);
    expect(describeOrderForOwner(submitted.record).actions).not.toContain('resend');

    // ─── 10. Sancho receives the acknowledgement CORE signed ───────────────
    expect(sent).toHaveLength(1);
    expect(validateOrderAcknowledgement(sent[0], hash)).toBeNull();
    expect(sent[0]?.kind).toBe('accepted');

    // ─── 11. ChairMaker reports fulfilment, and the chain moves ────────────
    const chain = runtime.chains.load(BUYER_DID, order.purchase_order_id);
    expect(chain.head.state).toBe('accepted');

    const line = order.accepted_lines[0];
    if (!line) throw new Error('fixture has no order lines');
    const dispatched = runtime.lifecycle.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
      state: 'dispatched',
      lines: [
        {
          lineId: line.line_id,
          fulfilledQuantity: { value: line.quantity.value, unitCode: line.quantity.unit_code },
        },
      ],
    });
    if ('error' in dispatched) throw new Error(dispatched.error);
    expect(dispatched.state).toBe('dispatched');

    const delivered = runtime.lifecycle.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
      state: 'delivered',
      disputeWindowEndsAt: '2026-08-22T09:00:00.000Z',
    });
    if ('error' in delivered) throw new Error(delivered.error);
    expect(delivered.state).toBe('delivered');

    // ─── 12. The order is settled, and both sides agree what happened ──────
    const finalChain = runtime.chains.load(BUYER_DID, order.purchase_order_id);
    expect(finalChain.head.state).toBe('delivered');
    expect(runtime.orders.load(BUYER_DID, order.purchase_order_id)?.ref.state).toBe('decided');
    // Every status record is one Core signed, chained to its predecessor.
    expect(delivered.previous_status_digest).toBe(dispatched.status_digest);
    expect(dispatched.previous_status_digest).toBe(chain.head.headDigest);
  });

  /**
   * The same journey with the buyer's requirement made unmeetable. Written
   * because a happy-path scenario passing tells you the pieces CAN join up,
   * not that a refusal anywhere in the chain still stops the order.
   */
  it('stops at the first honest refusal rather than ordering anyway', async () => {
    const resp = await router.handle(
      ownerPost('/v1/commerce/procurement/choose', {
        offers: [
          {
            supplierDid: SUPPLIER_DID,
            quoteId: 'q-expired',
            totalMinorUnits: '1',
            currency: 'INR',
            availableQuantity: { value: '1000', unit_code: 'each' },
            // Expired before Sancho looked.
            expiresAt: '2026-08-01T00:00:00.000Z',
            leadTimeDays: 1,
            trustBp: 10000,
          },
        ],
        requirements: { quantity: { value: '100', unit_code: 'each' }, currency: 'INR' },
        at: NOW_ISO,
      }),
    );
    // Cheapest, fastest, best-trusted, and plenty of stock — and still not an
    // offer, because the quote is no longer valid. The owner is told NULL, not
    // handed the least-bad thing available.
    const body = resp.body as {
      ranking: { ranked: unknown[]; filtered: { reason: string }[] };
      best: unknown;
    };
    expect(body.ranking.ranked).toEqual([]);
    expect(body.ranking.filtered[0]?.reason).toBe('quote_expired');
    expect(body.best).toBeNull();
  });

  it('refuses to publish a catalog carrying a supplier’s private column', async () => {
    // The leakage gate is inside the publisher, so it applies to whatever the
    // importer produced without the journey needing to remember it — and,
    // driven through the route, without the route being able to route around
    // it. §12.1 is the one gate in this pack where a miss is unrecoverable: a
    // snapshot is published, indexed and content-addressed, and does not
    // un-publish.
    const resp = await router.handle(
      ownerPost('/v1/commerce/catalog/publish', {
        catalog_id: 'chairmaker-main',
        published_at: NOW_ISO,
        items: [{ sku: 'CHAIR-1', description: 'api_key = sk-live-abcdefghijklmnop1234' }],
      }),
    );
    expect(resp.status).toBe(200);
    const body = resp.body as { ok: boolean; refusal?: string; leakage?: { fields?: unknown } };
    expect(body.ok).toBe(false);
    expect(body.refusal).toBe('leakage_refused');
    // The finding names the FIELD, never the value — echoing a secret into an
    // owner's response turns one leak into two.
    expect(JSON.stringify(body)).not.toContain('sk-live-abcdefghijklmnop1234');
  });

  it('installs the reference manifest the journey depends on', () => {
    // Stated as its own claim because step 8 would fail confusingly if the
    // pack stopped validating — and a scenario should say which of its
    // preconditions broke.
    expect(validatePluginManifest(SUPPLIER_REFERENCE_MANIFEST).ok).toBe(true);
    expect(installs.getById(installId)?.status).toBe('active');
  });
});
