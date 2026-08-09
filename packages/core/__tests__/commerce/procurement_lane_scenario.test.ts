/**
 * A retailer buying from a manufacturer, THROUGH THE PLUGIN LANE (§25.3).
 *
 * WHY THIS EXISTS ALONGSIDE `procurement_scenario.test.ts`. That one walks the
 * commerce spine by calling the engines directly, which is the right way to
 * test the spine and says nothing about whether production can reach it. This
 * one goes the way a real order goes: an inbound query hits provider ingress,
 * Core admits it in compiled code, a task lands on the install's private lane,
 * the supplier's runner claims it through the SDK and answers, and Core
 * replaces that answer with the acknowledgement IT signed before the buyer
 * ever sees it.
 *
 * Every seam here is the production one — `createProviderIngressTask`,
 * `claimPluginTask` via `PluginRunner`, `WorkflowService.complete`, the
 * response bridge, and the real `CommerceAdmissionEngine`. The only stubs are
 * the two things a unit test cannot own: the D2D socket (the bridge sender
 * collects instead of sending) and the epoch, which §16.2 makes fail-closed
 * until a PDS publication that has no place in a jest run.
 *
 * Cast follows house convention: ChairMaker manufactures, Sancho retails.
 */

import { randomBytes } from 'node:crypto';

import { sha256 } from '@noble/hashes/sha2.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { commerceRecordDigest, validateOrderAcknowledgement } from '@dina/commerce-protocol';
import { pluginLane, validatePluginManifest } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  SUPPLIER_REFERENCE_MANIFEST,
  createCommerceRuntime,
  getCommerceRuntime,
  installCommerceRuntime,
} from '../../src/commerce';
import { transformInboundOrderResult } from '../../src/commerce/order_decision';
import { uninstall } from '../../src/plugins/install_service';
import { createProviderIngressTask } from '../../src/plugins/provider_ingress';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
} from '../../src/plugins/registry';
import { PluginRunner } from '../../src/plugins/runner_sdk';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { clearPairingState, setNodeDID } from '../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerCommerceRoutes } from '../../src/server/routes/commerce';
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

import type { ServiceQueryBridgeContext } from '../../src/workflow/service';

const T0 = Date.parse('2026-08-08T09:00:00.000Z');
const RUNNER_DID = 'did:plc:chairmakerrunner';
const MANIFEST_CID = 'bafyreichairmaker1';
/** §5 ids are reverse-DNS with hyphens; wire capability names are snake_case. */
const SUBMIT_CAP_ID = 'com.dinakernel.commerce.submit-order';
const CANCEL_CAP_ID = 'com.dinakernel.commerce.cancel-order';

describe('procurement through the plugin lane: Sancho orders from ChairMaker', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  let installs: SQLitePluginInstallRepository;
  let workflowRepo: InMemoryWorkflowRepository;
  let workflow: WorkflowService;
  let bridged: ServiceQueryBridgeContext[];
  let sent: { to: string; body: Record<string, unknown> }[];
  let installId: string;
  let runner: PluginRunner;

  const request = makeQuoteRequest();

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'proc-lane-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);

    installs = new SQLitePluginInstallRepository(adapter);
    setPluginInstallRepository(installs);

    // The REFERENCE manifest, not a fixture. If WS-3.9's pack could not be
    // installed, this journey could not start — which is the point of using
    // it here rather than a hand-rolled stand-in.
    const verdict = validatePluginManifest(SUPPLIER_REFERENCE_MANIFEST);
    expect(verdict.ok).toBe(true);

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
        // §16.2 makes the live epoch fail-closed until a PDS publication. A
        // fixed value here stands in for "the fence has been discharged",
        // which is the only state in which commerce may sign at all.
        currentEpoch: () => '1',
        now: () => T0,
      }),
    );

    bridged = [];
    sent = [];
    workflow = new WorkflowService({
      repository: (workflowRepo = new InMemoryWorkflowRepository()),
      nowMsFn: () => T0,
      // The SAME transformer the composition root wires, so what a buyer
      // receives here is what a buyer receives in production.
      ingressResultTransformer: transformInboundOrderResult,
      responseBridgeSender: async (ctx) => {
        bridged.push(ctx);
        sent.push({ to: ctx.fromDID, body: JSON.parse(ctx.resultJSON) as Record<string, unknown> });
      },
    });

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
    try {
      adapter.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** ChairMaker signs a quote and retains the request Sancho sent. */
  function chairmakerQuotes(overrides: Record<string, unknown> = {}) {
    const runtime = getCommerceRuntime();
    if (runtime === null) throw new Error('commerce runtime missing');
    const quote = makeSignedQuote(request, overrides);
    runtime.receipts.put({
      recordDigest: request.request_digest,
      domain: 'request',
      buyerDid: request.buyer_did,
      quoteId: quote.quote_id,
      purchaseOrderId: '',
      recordJson: JSON.stringify(request),
      evidenceJson: '{}',
      createdAt: T0,
    });
    expect(runtime.admission.registerSignedQuote(quote)).toBeNull();
    return quote;
  }

  function submitOrder(order: unknown, queryId = 'q-order-1') {
    return createProviderIngressTask({
      workflow,
      capabilityConfig: {
        pluginInstallId: installId,
        pluginManifestCid: MANIFEST_CID,
        pluginCapabilityId: SUBMIT_CAP_ID,
      },
      query: {
        fromDid: BUYER_DID,
        queryId,
        capability: 'submit_order',
        serviceRkey: 'self',
        params: order,
        ttlSeconds: 300,
        serviceName: 'chairmaker',
      },
      nowMs: T0,
    });
  }

  /**
   * A REAL cancellation request, digested by the real producer.
   *
   * The first version of this helper invented a `cancellation_digest` of
   * `'d'.repeat(64)`, and Core correctly refused it and withheld — which is
   * the behaviour working, and a fixture that proved nothing. Hand-built
   * stand-ins that contradict the protocol have produced a false result at
   * every turn in this effort.
   */
  function cancellationFor(
    order: { purchase_order_id: string; order_digest: string },
    id: string,
  ): Record<string, unknown> {
    const draft = {
      protocol_version: '1.0',
      cancellation_id: id,
      purchase_order_id: order.purchase_order_id,
      order_digest: order.order_digest,
      idempotency_key: `idem-${id}`,
      issued_at: '2026-08-09T10:00:00.000Z',
    };
    return {
      ...draft,
      cancellation_digest: commerceRecordDigest('cancellation', draft, (d: Uint8Array) =>
        sha256(d),
      ),
    };
  }

  function cancelOrder(request: unknown, queryId = 'q-cancel-1') {
    return createProviderIngressTask({
      workflow,
      capabilityConfig: {
        pluginInstallId: installId,
        pluginManifestCid: MANIFEST_CID,
        pluginCapabilityId: CANCEL_CAP_ID,
      },
      query: {
        fromDid: BUYER_DID,
        queryId,
        capability: 'cancel_order',
        serviceRkey: 'self',
        params: request,
        ttlSeconds: 300,
        serviceName: 'chairmaker',
      },
      nowMs: T0,
    });
  }

  /** Sancho orders and ChairMaker accepts, so there is something to cancel. */
  async function acceptedOrder(quoteId = 'q-cancel-src') {
    const quote = chairmakerQuotes({ quote_id: quoteId });
    const order = makeOrder(quote, request.delivery.projection, {
      purchase_order_id: `po-${quoteId}`,
      idempotency_key: `idem-${quoteId}`,
    });
    expect(submitOrder(order, `q-sub-${quoteId}`).ok).toBe(true);
    const claimed = runner.claim();
    if (claimed.kind !== 'job') throw new Error(JSON.stringify(claimed));
    runner.answer(claimed.job, {
      kind: 'result',
      result: { kind: 'accepted', supplier_order_id: `CM-${quoteId}` },
    });
    await workflow.flushBridgeInFlight();
    return order;
  }

  describe('ChairMaker reviews an order by hand before accepting it (§15.2b)', () => {
    const OWNER_CAP = 'test-owner-capability-secret';

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
        callerDID: SUPPLIER_DID,
        ownerCapability: OWNER_CAP,
      };
    }

    /** ChairMaker's policy: a person sees every acceptance before it is signed. */
    function requireHumanReview(): void {
      const written = getCommerceRuntime()?.settings.writeSupplier({
        actingBusinessDid: SUPPLIER_DID,
        catalogSource: { kind: 'inline', lastHealthyAtIso: '2026-08-08T09:00:00.000Z' },
        publicRegions: [],
        publishIndicativePrice: true,
        quoteAccess: 'anyone',
        responsePolicy: {},
        customerPricingSource: null,
        orderAcceptance: 'review',
        listingState: 'live',
        connectors: [],
      } as never);
      // `review` must be SAVEABLE. It was refused outright while the lane did
      // not exist, and this whole journey depends on that having changed.
      expect(written).toEqual({ ok: true });
    }

    it('holds the order, tells nobody but the owner, and signs only once they agree', async () => {
      setNodeDID(SUPPLIER_DID);
      const router = new CoreRouter();
      registerCommerceRoutes(router, OWNER_CAP);
      requireHumanReview();

      const quote = chairmakerQuotes({ quote_id: 'q-review' });
      const order = makeOrder(quote, request.delivery.projection, {
        purchase_order_id: 'po-review',
        idempotency_key: 'idem-review',
      });

      // 1. Sancho orders. ChairMaker's pack says yes.
      expect(submitOrder(order, 'q-sub-review').ok).toBe(true);
      const claimed = runner.claim();
      if (claimed.kind !== 'job') throw new Error(JSON.stringify(claimed));
      runner.answer(claimed.job, {
        kind: 'result',
        result: { kind: 'accepted', supplier_order_id: 'CM-review' },
      });
      await workflow.flushBridgeInFlight();

      // 2. NOTHING GOES TO SANCHO. Before this lane the pack's `accepted`
      //    would have been signed without anyone seeing it; after the
      //    withhold fix but before the card, it vanished and the order lapsed.
      expect(sent).toEqual([]);

      // 3. The OWNER is told, and the raw runner answer is not projected to
      //    them — it is an unsigned proposal, not a decision.
      const listed = await router.handle({
        ...ownerPost('/v1/commerce/orders/pending-decisions', {}),
        method: 'GET',
      });
      expect(listed.status).toBe(200);
      const pending = (listed.body as { pending: Record<string, unknown>[] }).pending;
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        buyerDid: BUYER_DID,
        purchaseOrderId: 'po-review',
      });
      expect(JSON.stringify(pending[0])).not.toContain('CM-review');

      // 4. ChairMaker agrees. NOW the decision is recorded.
      const decided = await router.handle(
        ownerPost('/v1/commerce/orders/decide', {
          buyer_did: BUYER_DID,
          purchase_order_id: 'po-review',
          approve: true,
        }),
      );
      expect(decided.status).toBe(200);
      expect(decided.body).toMatchObject({ ok: true, decided: true });

      // 5. The card is gone and the order is decided — so §12.7 reconcile has
      //    something to tell Sancho, which is how he learns the outcome of a
      //    submission that was deliberately never answered.
      const after = await router.handle({
        ...ownerPost('/v1/commerce/orders/pending-decisions', {}),
        method: 'GET',
      });
      expect((after.body as { pending: unknown[] }).pending).toEqual([]);
      expect(getCommerceRuntime()?.orders.load(BUYER_DID, 'po-review')?.ref.state).not.toBe(
        'reserved',
      );

      clearPairingState();
    });

    it('declining clears the card and signs nothing', async () => {
      setNodeDID(SUPPLIER_DID);
      const router = new CoreRouter();
      registerCommerceRoutes(router, OWNER_CAP);
      requireHumanReview();

      const quote = chairmakerQuotes({ quote_id: 'q-decline' });
      const order = makeOrder(quote, request.delivery.projection, {
        purchase_order_id: 'po-decline',
        idempotency_key: 'idem-decline',
      });
      expect(submitOrder(order, 'q-sub-decline').ok).toBe(true);
      const claimed = runner.claim();
      if (claimed.kind !== 'job') throw new Error(JSON.stringify(claimed));
      runner.answer(claimed.job, {
        kind: 'result',
        result: { kind: 'accepted', supplier_order_id: 'CM-decline' },
      });
      await workflow.flushBridgeInFlight();

      const declined = await router.handle(
        ownerPost('/v1/commerce/orders/decide', {
          buyer_did: BUYER_DID,
          purchase_order_id: 'po-decline',
          approve: false,
        }),
      );
      expect(declined.body).toMatchObject({ ok: true, decided: false });

      // The order is UNTOUCHED and will lapse at its deadline. Core does not
      // invent a rejection the owner never worded, and it does not sign the
      // acceptance they refused.
      expect(getCommerceRuntime()?.orders.load(BUYER_DID, 'po-decline')?.ref.state).toBe(
        'reserved',
      );
      expect(sent).toEqual([]);

      clearPairingState();
    });
  });

  describe('Sancho cancels an order he placed with ChairMaker (§12.5, §12.8)', () => {
    it('answers with the cancellation CORE recorded, not the runner’s verdict', async () => {
      const order = await acceptedOrder();
      sent.length = 0;

      const created = cancelOrder(
        cancellationFor(order as { purchase_order_id: string; order_digest: string }, 'cx-1'),
      );
      expect(created.ok).toBe(true);

      // ChairMaker's pack is asked whether it WANTS to allow this. Its answer
      // is a policy opinion; Core decides the race against dispatch.
      const claimed = runner.claim();
      if (claimed.kind !== 'job') throw new Error(JSON.stringify(claimed));
      expect(claimed.job.capabilityId).toBe(CANCEL_CAP_ID);
      runner.answer(claimed.job, { kind: 'result', result: { verdict: 'cancelled' } });
      await workflow.flushBridgeInFlight();

      // WHAT SANCHO ACTUALLY RECEIVES. Before the seam was wired this was the
      // runner's `{verdict:'cancelled'}` — a claim no order, status head or
      // hold had moved for. It is now Core's persisted CancellationResult.
      expect(sent).toHaveLength(1);
      const answer = sent[0].body;
      // Not the runner's shape at all: `verdict` is what the PACK said, and
      // it never reaches the wire.
      expect(answer.verdict).toBeUndefined();
      expect(answer).toMatchObject({
        result: 'cancelled',
        purchase_order_id: order.purchase_order_id,
        cancellation_id: 'cx-1',
      });
      // THE TWO BINDINGS THAT MAKE IT EVIDENCE rather than a claim: the record
      // digests itself, and it names the status head the ruling was made
      // against — so a resolution decided at one chain position cannot later
      // be replayed at another.
      expect(answer.result_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(answer.status_digest_at_resolution).toMatch(/^[0-9a-f]{64}$/);
    });

    it('does not let a stranger cancel Sancho’s order', async () => {
      const order = await acceptedOrder('q-cancel-theft');
      sent.length = 0;

      // Same request, a different authenticated sender. The buyer identity
      // Core binds to comes from the transport, never from the body — so this
      // must not resolve Sancho's cancellation.
      const created = createProviderIngressTask({
        workflow,
        capabilityConfig: {
          pluginInstallId: installId,
          pluginManifestCid: MANIFEST_CID,
          pluginCapabilityId: CANCEL_CAP_ID,
        },
        query: {
          fromDid: 'did:plc:competitor',
          queryId: 'q-cancel-theft',
          capability: 'cancel_order',
          serviceRkey: 'self',
          params: cancellationFor(
            order as { purchase_order_id: string; order_digest: string },
            'cx-theft',
          ),
          ttlSeconds: 300,
          serviceName: 'chairmaker',
        },
        nowMs: T0,
      });

      // Refused at the subject gate before any runner is asked — §11.2's
      // "no such order for this sender".
      expect(created.ok).toBe(false);
      expect(workflow.store().getByCorrelationId('q-cancel-theft')).toEqual([]);
    });
  });

  it('carries an order from Sancho to ChairMaker’s runner and back, signed by Core', async () => {
    const quote = chairmakerQuotes();
    const order = makeOrder(quote, request.delivery.projection);

    // 1. Sancho submits. Core ADMITS in compiled code before any runner is
    //    asked: idempotency, quote capacity and the reservation are its
    //    authority, not the plugin's.
    const created = submitOrder(order);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(JSON.stringify(created));

    const runtime = getCommerceRuntime();
    if (runtime === null) throw new Error('commerce runtime missing');
    const ref = runtime.orders.load(BUYER_DID, order.purchase_order_id);
    expect(ref?.ref.state).toBe('reserved');
    // The reservation records WHICH manifest is serving it, which is what
    // makes §9.13 lifecycle routing reachable in production rather than
    // test-only.
    expect(ref?.ref.servingManifestCid).toBe(MANIFEST_CID);

    // 2. ChairMaker's runner claims it off its own private lane.
    const claimed = runner.claim();
    expect(claimed.kind).toBe('job');
    if (claimed.kind !== 'job') throw new Error(JSON.stringify(claimed));
    expect(claimed.job.capabilityId).toBe(SUBMIT_CAP_ID);
    expect(claimed.job.ingress?.fromDid).toBe(BUYER_DID);
    expect(workflowRepo.getById(claimed.job.taskId)?.requested_runner).toBe(pluginLane(installId));

    // 3. The runner decides only whether to take the business.
    expect(
      runner.answer(claimed.job, {
        kind: 'result',
        result: { kind: 'accepted', supplier_order_id: 'CM-4471' },
      }),
    ).toEqual({ ok: true });
    await workflow.flushBridgeInFlight();

    // 4. What reaches Sancho is the acknowledgement CORE signed, not the
    //    runner's answer. This is the property that makes a plugin safe to
    //    put on this path at all: a runner cannot mint an acknowledgement,
    //    so it cannot commit this business to terms Core never recorded.
    expect(sent).toHaveLength(1);
    const answered = sent[0]?.body;
    expect(answered).toBeDefined();
    expect(validateOrderAcknowledgement(answered, hash)).toBeNull();
    expect(answered?.kind).toBe('accepted');
    expect(answered?.supplier_did).toBe(SUPPLIER_DID);
    expect(answered?.buyer_did).toBe(BUYER_DID);
    expect(answered?.order_digest).toBe(order.order_digest);
    // The runner contributed ONE field — its own order reference, which
    // §9.10 carries because only the supplier knows it. Every field that
    // carries AUTHORITY came from Core's record: the counterparty identities,
    // the order digest, the quote this was accepted against, and the
    // acknowledgement digest itself, which `validateOrderAcknowledgement`
    // above re-derived. A runner cannot fabricate that digest, which is what
    // makes it safe to let one answer on this path at all.
    expect(answered?.supplier_order_id).toBe('CM-4471');
    expect(answered?.accepted_quote_digest).toBe(quote.quote_digest);
    expect(answered?.acknowledgement_digest).toEqual(expect.any(String));

    // 5. The order is decided, the quote capacity is committed, and the
    //    status chain has its genesis — the durable half of the journey.
    expect(runtime.orders.load(BUYER_DID, order.purchase_order_id)?.ref.state).toBe('decided');
    const chain = runtime.chains.load(BUYER_DID, order.purchase_order_id);
    expect(chain.exists).toBe(true);
    expect(chain.head.state).toBe('accepted');
  });

  it('lets ChairMaker decline without Core inventing an acceptance', async () => {
    const quote = chairmakerQuotes({ quote_id: 'q-decline', max_uses: '1' });
    const order = makeOrder(quote, request.delivery.projection, {
      purchase_order_id: 'po-decline',
      idempotency_key: 'idem-decline',
    });
    expect(submitOrder(order, 'q-decline-1').ok).toBe(true);

    const claimed = runner.claim();
    if (claimed.kind !== 'job') throw new Error(JSON.stringify(claimed));
    expect(
      runner.answer(claimed.job, {
        kind: 'result',
        result: { kind: 'rejected', reason_code: 'out_of_stock' },
      }),
    ).toEqual({ ok: true });
    await workflow.flushBridgeInFlight();

    const answered = sent[0]?.body;
    expect(answered?.kind).toBe('rejected');
    expect(answered?.reason_code).toBe('out_of_stock');

    // §9.11 — THE REJECTION HAS A CHAIN, opened and closed in one record.
    //
    // Genesis used to run for `accepted` ONLY, so a declined order had no
    // head at all. Two things follow from a missing head, and both are
    // silent: `countUnfinishedByServingManifest` reads NULL as unfinished, so
    // every rejected order held this manifest's lifecycle authority open and
    // blocked uninstall for ever; and Sancho had nothing to verify — the
    // rejection existed only inside an acknowledgement he was handed.
    const rejectedChain = getCommerceRuntime()?.chains.load(BUYER_DID, order.purchase_order_id);
    expect(rejectedChain?.exists).toBe(true);
    expect(rejectedChain?.head.state).toBe('rejected');
    // And the order no longer counts as work this manifest owes.
    expect(
      getCommerceRuntime()?.orders.countUnfinishedByServingManifest(MANIFEST_CID, T0),
    ).toBe(0);
    // A refusal REFUNDS the hold, and the proof reads only the PUBLIC
    // surface: the runtime hides the quote ledger on purpose (ARCH-0a), so
    // "did capacity come back" is answered by whether a second order can be
    // admitted against a one-use quote — not by peeking at a counter.
    const runtime = getCommerceRuntime();
    const again = makeOrder(quote, request.delivery.projection, {
      purchase_order_id: 'po-decline-2',
      idempotency_key: 'idem-decline-2',
    });
    expect(submitOrder(again, 'q-decline-2').ok).toBe(true);
    expect(runtime?.orders.load(BUYER_DID, 'po-decline-2')?.ref.state).toBe('reserved');
    // And the declined order carries a genesis of its OWN state, never
    // `accepted`.
    const chain = runtime?.chains.load(BUYER_DID, 'po-decline');
    expect(chain?.exists === false || chain?.head.state === 'rejected').toBe(true);
  });

  it('answers a REPLAYED submission from Core, without troubling the runner twice', async () => {
    const quote = chairmakerQuotes({ quote_id: 'q-replay', max_uses: '2' });
    const order = makeOrder(quote, request.delivery.projection, {
      purchase_order_id: 'po-replay',
      idempotency_key: 'idem-replay',
    });
    expect(submitOrder(order, 'q-replay-1').ok).toBe(true);

    const claimed = runner.claim();
    if (claimed.kind !== 'job') throw new Error(JSON.stringify(claimed));
    runner.answer(claimed.job, {
      kind: 'result',
      result: { kind: 'accepted', supplier_order_id: 'CM-auto' },
    });
    await workflow.flushBridgeInFlight();

    // Sancho's transport retries. §9.9: Core answers from its own record —
    // and ANSWERS is the word. This used to assert `ok:false` with
    // `order_settled_by_core`, which meant Sancho heard `unavailable` and had
    // to open a reconcile to learn something ChairMaker's node was holding.
    // §9.9's idempotency guarantee is that asking twice yields the SAME SIGNED
    // ANSWER; returning it is what makes that true.
    const replay = submitOrder(order, 'q-replay-2');
    expect(replay.ok).toBe(true);
    const replayed = JSON.parse(
      (replay as { ok: true; coreAnswerJson: string }).coreAnswerJson,
    ) as Record<string, unknown>;
    expect(replayed.kind).toBe('accepted');
    expect(replayed.purchase_order_id).toBe(order.purchase_order_id);
    // The critical half is unchanged: NOTHING new reached the lane, so a retry
    // storm cannot become a dispatch storm and the runner cannot accept twice.
    expect(runner.claim().kind).toBe('idle');
  });

  it('refuses an order against a quote whose capacity is spent', async () => {
    const quote = chairmakerQuotes({ quote_id: 'q-once', max_uses: '1' });
    const first = makeOrder(quote, request.delivery.projection, {
      purchase_order_id: 'po-first',
      idempotency_key: 'idem-first',
    });
    expect(submitOrder(first, 'q-cap-1').ok).toBe(true);
    const claimed = runner.claim();
    if (claimed.kind !== 'job') throw new Error(JSON.stringify(claimed));
    runner.answer(claimed.job, {
      kind: 'result',
      result: { kind: 'accepted', supplier_order_id: 'CM-auto' },
    });
    await workflow.flushBridgeInFlight();

    // A SECOND order on a one-use quote. Core refuses in compiled code; the
    // runner never sees it, so a plugin cannot accept against capacity the
    // ledger does not have.
    const second = makeOrder(quote, request.delivery.projection, {
      purchase_order_id: 'po-second',
      idempotency_key: 'idem-second',
    });
    // A SIGNED REJECTION, not a service error. "Declined" is a commercial
    // outcome Sancho is owed evidence of, and it is the same reading Core
    // already applies to a runner's rejection — the two paths disagreed, and
    // the buyer could not tell "you declined" from "your node is broken",
    // which are opposite next steps.
    const refused = submitOrder(second, 'q-cap-2');
    expect(refused.ok).toBe(true);
    const ack = JSON.parse(
      (refused as { ok: true; coreAnswerJson: string }).coreAnswerJson,
    ) as Record<string, unknown>;
    expect(ack.kind).toBe('rejected');
    expect(ack.purchase_order_id).toBe('po-second');
    // The operator-only detail (§14.2) must NOT be on the wire: `quote_unknown`
    // covers three situations and naming which one discloses catalog state.
    expect(JSON.stringify(ack)).not.toMatch(/capacity|max_uses|spent/i);
    expect(runner.claim().kind).toBe('idle');
  });

  it('still answers Sancho when ChairMaker’s runner cannot say what happened', async () => {
    // §12.7. A socket can die after the bytes left. The runner says so rather
    // than guessing, and Sancho must still stop waiting.
    const quote = chairmakerQuotes({ quote_id: 'q-unknown' });
    const order = makeOrder(quote, request.delivery.projection, {
      purchase_order_id: 'po-unknown',
      idempotency_key: 'idem-unknown',
    });
    expect(submitOrder(order, 'q-unknown-1').ok).toBe(true);

    const claimed = runner.claim();
    if (claimed.kind !== 'job') throw new Error(JSON.stringify(claimed));
    expect(runner.answer(claimed.job, { kind: 'outcome_unknown', reason: 'erp timeout' })).toEqual({
      ok: true,
    });
    await workflow.flushBridgeInFlight();

    const task = workflowRepo.getById(claimed.job.taskId);
    expect(task?.status).toBe('failed');
    expect(task?.error).toMatch(/^outcome_unknown: /);
    // The order stays UNDECIDED for the sweeper and for reconcile. Deciding
    // it here on the strength of a report that says "I do not know" is the
    // one thing §12.7 forbids.
    const runtime = getCommerceRuntime();
    expect(runtime?.orders.load(BUYER_DID, 'po-unknown')?.ref.state).toBe('reserved');
  });

  it('refuses a runner answer the pack’s own result schema rejects', () => {
    const quote = chairmakerQuotes({ quote_id: 'q-badshape' });
    const order = makeOrder(quote, request.delivery.projection, {
      purchase_order_id: 'po-badshape',
      idempotency_key: 'idem-badshape',
    });
    expect(submitOrder(order, 'q-badshape-1').ok).toBe(true);
    const claimed = runner.claim();
    if (claimed.kind !== 'job') throw new Error(JSON.stringify(claimed));

    // `decision` is required by the SUPPLIER pack's own manifest.
    const bad = runner.answer(claimed.job, { kind: 'result', result: { note: 'sure, fine' } });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/violates the pinned schema/);
    // Nothing went to Sancho, and the job is still answerable.
    expect(sent).toHaveLength(0);
    expect(
      runner.answer(claimed.job, {
        kind: 'result',
        result: { kind: 'accepted', supplier_order_id: 'CM-auto' },
      }),
    ).toEqual({ ok: true });
  });

  it('refuses a stranger’s order for an order Sancho owns', async () => {
    const quote = chairmakerQuotes({ quote_id: 'q-stranger' });
    const order = makeOrder(quote, request.delivery.projection, {
      purchase_order_id: 'po-stranger',
      idempotency_key: 'idem-stranger',
    });
    expect(submitOrder(order, 'q-stranger-1').ok).toBe(true);
    const claimed = runner.claim();
    if (claimed.kind !== 'job') throw new Error(JSON.stringify(claimed));
    runner.answer(claimed.job, {
      kind: 'result',
      result: { kind: 'accepted', supplier_order_id: 'CM-auto' },
    });
    await workflow.flushBridgeInFlight();

    // A different peer asks about Sancho's order. §11.2: the order-ref store
    // is keyed by (buyer, order), so the lookup under the AUTHENTICATED
    // sender IS the ownership test.
    const probe = createProviderIngressTask({
      workflow,
      capabilityConfig: {
        pluginInstallId: installId,
        pluginManifestCid: MANIFEST_CID,
        pluginCapabilityId: 'com.dinakernel.commerce.order-status',
      },
      query: {
        fromDid: 'did:plc:nosystranger',
        queryId: 'q-probe',
        capability: 'order_status',
        serviceRkey: 'self',
        params: { purchase_order_id: 'po-stranger' },
        ttlSeconds: 60,
      },
      nowMs: T0,
    });
    expect(probe.ok).toBe(false);
    expect(!probe.ok && probe.code).toBe('order_subject_denied');
    // And nothing was dispatched, so the runner never learns the id exists.
    expect(runner.claim().kind).toBe('idle');
  });

  /**
   * §16.4 — UNINSTALL, and the claim the manual acceptance journey (§25.6)
   * makes about it: "revoke and prove no further work".
   *
   * These drive the REAL `uninstall`, not the registry's `remove`. That
   * distinction is the whole value: `remove` is one step of the teardown and
   * reaching for it directly skips the two rules that matter — the refusal
   * while obligations are open, and the device revocation that fences the
   * runner. A test that called `remove` would report a revoked pack while the
   * production path would have refused the operation outright.
   */
  describe('the owner uninstalls ChairMaker', () => {
    /** Place one live order and leave it open. */
    function openOrder(id = 'po-open', queryId = 'q-open') {
      const quote = chairmakerQuotes({ quote_id: `q-${id}`, max_uses: '1' });
      const order = makeOrder(quote, request.delivery.projection, {
        purchase_order_id: id,
        idempotency_key: `idem-${id}`,
      });
      expect(submitOrder(order, queryId).ok).toBe(true);
      return order;
    }

    /** ChairMaker declines, which closes the obligation terminally. */
    async function chairmakerDeclines(): Promise<void> {
      const claimed = runner.claim();
      if (claimed.kind !== 'job') throw new Error('expected a job');
      expect(
        runner.answer(claimed.job, {
          kind: 'result',
          result: { kind: 'rejected', reason_code: 'out_of_stock' },
        }),
      ).toEqual({ ok: true });
      await workflow.flushBridgeInFlight();
    }

    it('REFUSES the uninstall while Sancho’s order is still open', async () => {
      // §16.4: every lifecycle capability a buyer needs — `order_status`,
      // `cancel_order`, `order_reconcile` — answers through THIS install's
      // binding. Tearing it down mid-order leaves the records intact and
      // unreachable, which is not what "business records survive" promises.
      const order = openOrder();

      await expect(uninstall(installId, T0)).rejects.toThrow(/still open/);
      // The install is untouched, so the order can still be answered.
      expect(installs.getById(installId)?.status).toBe('active');
      expect(getCommerceRuntime()?.orders.load(BUYER_DID, order.purchase_order_id)?.ref.state).toBe(
        'reserved',
      );
    });

    it('still refuses after DELIVERY, because the dispute window is an obligation', async () => {
      // A recorded design decision, asserted rather than trusted: `delivered`
      // is deliberately NOT terminal. A buyer inside the dispute window can
      // still dispute, and those are exactly the orders an uninstall would
      // most damage by removing the only binding that can answer them.
      openOrder('po-delivered', 'q-delivered');
      const claimed = runner.claim();
      if (claimed.kind !== 'job') throw new Error('expected a job');
      runner.answer(claimed.job, {
        kind: 'result',
        result: { kind: 'accepted', supplier_order_id: 'CM-DELIVERED' },
      });
      await workflow.flushBridgeInFlight();

      await expect(uninstall(installId, T0)).rejects.toThrow(/still open/);
    });

    it('lets the uninstall through once nothing is open, and FENCES the runner', async () => {
      openOrder('po-closing', 'q-closing');
      await chairmakerDeclines();

      const revoked: string[] = [];
      const teardown = await uninstall(installId, T0, async (did) => {
        revoked.push(did);
        return { durable: true };
      });
      expect(teardown).not.toBeNull();
      // The FENCE (§16.4 step 2). The runner's paired DEVICE is revoked, and
      // that is what stops it acting — not the row's absence. A teardown that
      // deleted the row and left the device paired would leave a runner that
      // still authenticates.
      expect(revoked).toEqual([RUNNER_DID]);
      expect(installs.getById(installId)).toBeNull();
    });

    it('refuses a NEW order once the install is gone, and reserves nothing', async () => {
      openOrder('po-before', 'q-before');
      await chairmakerDeclines();
      await uninstall(installId, T0);

      const quote = chairmakerQuotes({ quote_id: 'q-after', max_uses: '1' });
      const after = makeOrder(quote, request.delivery.projection, {
        purchase_order_id: 'po-after-uninstall',
        idempotency_key: 'idem-after',
      });
      const created = submitOrder(after, 'q-after-uninstall');
      expect(created.ok).toBe(false);
      // `install_unavailable`, not `no_plugin_binding`: the listing still
      // NAMES this install — a teardown does not rewrite the service config —
      // so the honest report is that the named install is gone, not that the
      // listing was never bound. The two send an operator to different places.
      expect(!created.ok && created.code).toBe('install_unavailable');
      // Nothing reached a lane, and no reservation holds Sancho's capacity
      // against a supplier who can no longer answer.
      expect(runner.claim().kind).toBe('idle');
      expect(getCommerceRuntime()?.orders.load(BUYER_DID, after.purchase_order_id)).toBeNull();
    });

    it('holds a PAUSED install’s queued order rather than refusing it', async () => {
      // Pause and uninstall are different facts and §16.3 keeps them
      // different: a pause is a hold the owner can lift, so the queued task
      // WAITS. Reading a pause as a teardown would lose orders an owner meant
      // to resume.
      openOrder('po-paused', 'q-paused');

      installs.pause(installId, T0, 'manual');
      expect(runner.claim().kind).toBe('idle');

      installs.resume(installId, T0);
      const claimed = runner.claim();
      expect(claimed.kind).toBe('job');
      if (claimed.kind !== 'job') throw new Error('expected a job');
      expect(
        runner.answer(claimed.job, {
          kind: 'result',
          result: { kind: 'accepted', supplier_order_id: 'CM-RESUMED' },
        }),
      ).toEqual({ ok: true });
      await workflow.flushBridgeInFlight();
      expect(sent).toHaveLength(1);
      expect(sent[0]?.body.supplier_order_id).toBe('CM-RESUMED');
    });
  });
});
