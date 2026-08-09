/**
 * TWO NODES, ONE TRADE: Sancho's answer comes back (§12.7, §16.2 — §25.3).
 *
 * WHY THIS EXISTS ALONGSIDE THE OTHER JOURNEYS. `procurement_lane_scenario`
 * carries an order into ChairMaker and stops where the response bridge hands
 * bytes to a socket; every buyer-side test then STARTS by handing the executor
 * an answer. Between those two points sat the defect this file was written
 * after finding: nothing on a buyer's node received a supplier's answer at all.
 * A supplier could accept an order, sign the acknowledgement, answer the
 * reconcile — and every one of those reached the D2D ingress and stopped, so
 * the buyer asked for ever. Both halves passed their own tests.
 *
 * So this runs BOTH nodes. Two identity databases, two commerce runtimes, and
 * the bytes ChairMaker's bridge produces are sealed and driven through Sancho's
 * real `receiveD2D`. Nothing here hands anybody an answer.
 *
 * THE ONE HONEST STAND-IN is the socket between them: a jest process has no
 * relay, so the test carries the envelope across by hand. Everything either
 * side does with it is production code — admission, the plugin lane, the
 * runner SDK, `transformInboundOrderResult`, the D2D unseal/verify/bypass
 * chain, and the buyer's own state machine.
 *
 * `installCommerceRuntime` is a module global, so "which node is acting" is
 * explicit: `asChairMaker` and `asSancho` swap it. That is exactly what two
 * separate processes give you for free, written down.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { validatePluginManifest } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { resetAuditState } from '../../src/audit/service';
import {
  SUPPLIER_REFERENCE_MANIFEST,
  createCommerceRuntime,
  getCommerceRuntime,
  installCommerceRuntime,
} from '../../src/commerce';
import {
  buildBuyerApprovalPayload,
  type BuyerApprovalContext,
} from '../../src/commerce/approval_payload';
import { submitApprovedOrder } from '../../src/commerce/buyer_executor';
import { describeOrderForOwner } from '../../src/commerce/buyer_reconciliation';
import { transformInboundOrderResult } from '../../src/commerce/order_decision';
import { askReconcilePolls, installHeldEvidenceReader } from '../../src/commerce/reconcile_poller';
import { getPublicKey } from '../../src/crypto/ed25519';
import { sealMessage, type DinaMessage } from '../../src/d2d/envelope';
import { clearGatesState } from '../../src/d2d/gates';
import { resetQuarantineState } from '../../src/d2d/quarantine';
import { receiveD2D } from '../../src/d2d/receive_pipeline';
import { createProviderIngressTask } from '../../src/plugins/provider_ingress';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
} from '../../src/plugins/registry';
import { PluginRunner } from '../../src/plugins/runner_sdk';
import { resetServiceWindows, setRequesterWindow } from '../../src/service/windows';
import { resetStagingState } from '../../src/staging/service';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { clearReplayCache } from '../../src/transport/adversarial';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { makeServiceResponseBridgeSender } from '../../src/workflow/response_bridge_sender';
import { WorkflowService } from '../../src/workflow/service';

import {
  BUYER_DID,
  SUPPLIER_DID,
  makeHeldEvidence,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
} from './helpers';

import type { CommerceRuntime } from '../../src/commerce/runtime';
import type { PurchaseOrderProposal } from '@dina/commerce-protocol';

// Matches the shared fixtures' quote validity window; a later T0 expires them
// before admission ever sees the order.
const T0 = Date.parse('2026-08-08T09:00:00.000Z');
const RUNNER_DID = 'did:plc:chairmakerrunner';
const MANIFEST_CID = 'bafyreichairmaker1';
const SUBMIT_CAP_ID = 'com.dinakernel.commerce.submit-order';
const SERVICE_RKEY = 'self';

/** ChairMaker signs the envelope; Sancho unseals it. Two real key pairs. */
const chairmakerPriv = new Uint8Array(32).fill(0x11);
const chairmakerPub = getPublicKey(chairmakerPriv);
const sanchoPriv = new Uint8Array(32).fill(0x22);
const sanchoPub = getPublicKey(sanchoPriv);

let dir: string;
/** ChairMaker's node. */
let supplierDb: NodeSQLiteAdapter;
let supplierRuntime: CommerceRuntime;
/** Sancho's node. */
let buyerDb: NodeSQLiteAdapter;
let buyerRuntime: CommerceRuntime;

let installs: SQLitePluginInstallRepository;
let workflowRepo: InMemoryWorkflowRepository;
let workflow: WorkflowService;
let installId: string;
let runner: PluginRunner;
/** What ChairMaker's response bridge put on the wire. */
let outbound: { toDid: string; body: Record<string, unknown> }[];

const request = makeQuoteRequest();

/**
 * ACT AS one node. The commerce runtime is a module global — one per process in
 * production, and here one per act. Naming the switch is the point: a test that
 * left the wrong runtime installed would be asserting a buyer's rule against a
 * supplier's store and would probably still pass.
 */
function asChairMaker<T>(fn: () => T): T {
  installCommerceRuntime(supplierRuntime);
  try {
    return fn();
  } finally {
    installCommerceRuntime(null);
  }
}
function asSancho<T>(fn: () => T): T {
  installCommerceRuntime(buyerRuntime);
  try {
    return fn();
  } finally {
    installCommerceRuntime(null);
  }
}
async function asSanchoAsync<T>(fn: () => Promise<T>): Promise<T> {
  installCommerceRuntime(buyerRuntime);
  try {
    return await fn();
  } finally {
    installCommerceRuntime(null);
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'round-trip-'));
  const open = (name: string): NodeSQLiteAdapter => {
    const a = new NodeSQLiteAdapter({
      path: path.join(dir, `${name}.sqlite`),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(a, IDENTITY_MIGRATIONS);
    return a;
  };
  supplierDb = open('chairmaker');
  buyerDb = open('sancho');

  supplierRuntime = createCommerceRuntime({
    adapter: supplierDb,
    supplierDid: () => SUPPLIER_DID,
    // §16.2 makes the live epoch fail-closed until a PDS publication, which has
    // no place in a jest run. A fixed value stands in for "the fence has been
    // discharged" — the only state in which commerce may sign at all.
    currentEpoch: () => '1',
    now: () => T0,
  });
  buyerRuntime = createCommerceRuntime({
    adapter: buyerDb,
    supplierDid: () => BUYER_DID,
    currentEpoch: () => '1',
    now: () => T0,
  });

  installs = new SQLitePluginInstallRepository(supplierDb);
  setPluginInstallRepository(installs);
  expect(validatePluginManifest(SUPPLIER_REFERENCE_MANIFEST).ok).toBe(true);
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

  outbound = [];
  workflow = new WorkflowService({
    repository: (workflowRepo = new InMemoryWorkflowRepository()),
    nowMsFn: () => T0,
    // The SAME transformer both composition roots wire, so what leaves
    // ChairMaker here is what leaves ChairMaker in production.
    ingressResultTransformer: transformInboundOrderResult,
    // THE REAL BRIDGE SENDER. An earlier version of this file pushed
    // `ctx.resultJSON` straight onto the wire and every delivery silently did
    // nothing, because that is the RESULT and not the `service.response`
    // envelope — the bridge builds the envelope, and skipping it meant testing
    // a wire body production never emits.
    responseBridgeSender: makeServiceResponseBridgeSender({
      sendResponse: async (toDid, body) => {
        outbound.push({ toDid, body: body as unknown as Record<string, unknown> });
      },
    }),
  });
  runner = new PluginRunner({
    workflow,
    repo: workflowRepo,
    install: () => installs.getById(installId),
    deviceDid: RUNNER_DID,
    nowMs: () => T0,
  });

  clearGatesState();
  resetStagingState();
  resetAuditState();
  resetQuarantineState();
  clearReplayCache();
  resetServiceWindows();
});

afterEach(() => {
  installCommerceRuntime(null);
  installHeldEvidenceReader(null);
  setPluginInstallRepository(null);
  resetServiceWindows();
  try {
    supplierDb.close();
    buyerDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The two nodes, and the wire between them
// ---------------------------------------------------------------------------

/** ChairMaker publishes a signed quote Sancho can order against. */
function chairmakerQuotes(): ReturnType<typeof makeSignedQuote> {
  return asChairMaker(() => {
    const runtime = getCommerceRuntime();
    if (runtime === null) throw new Error('commerce runtime missing');
    const quote = makeSignedQuote(request, {});
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
  });
}

const CONTEXT: BuyerApprovalContext = {
  actingBusinessDid: BUYER_DID,
  principal: {
    principalDid: 'did:plc:sanchoowner',
    authorityDomain: 'procurement',
    policyRevision: null,
  },
  serviceUri: `at://${SUPPLIER_DID}/com.dinakernel.service.profile/${SERVICE_RKEY}`,
  displayedLabels: { l1: 'Oak dining chair' },
  productKeys: { l1: 'gtin:05012345678900' },
  linePrices: { l1: { currency: 'INR', minor_units: '500' } },
  charges: [],
  quoteRevision: 1,
  quoteExpiresAt: '2026-08-09T09:00:00.000Z',
  install: {
    installId: 'install-sancho-buyer',
    capabilityId: 'com.dinakernel.commerce.submit-order',
    manifestCid: 'bafyreisanchobuyer',
    installScopeHash: 'q'.repeat(64),
    configRevision: '1',
  },
};

function approvalFor(order: PurchaseOrderProposal): ReturnType<typeof buildBuyerApprovalPayload> {
  return buildBuyerApprovalPayload(order, CONTEXT);
}

/**
 * ChairMaker receives an order and answers it, exactly as production does:
 * compiled-Core admission, then the install's private lane, then the runner,
 * then Core replaces the runner's answer with the acknowledgement IT signed.
 */
async function chairmakerHandles(
  order: PurchaseOrderProposal,
  decision: 'accepted' | 'rejected' = 'accepted',
): Promise<void> {
  await asChairMaker(async () => {
    const created = createProviderIngressTask({
      workflow,
      capabilityConfig: {
        pluginInstallId: installId,
        pluginManifestCid: MANIFEST_CID,
        pluginCapabilityId: SUBMIT_CAP_ID,
      },
      query: {
        fromDid: BUYER_DID,
        queryId: order.purchase_order_id,
        capability: 'submit_order',
        serviceRkey: SERVICE_RKEY,
        params: order,
        ttlSeconds: 300,
        serviceName: 'chairmaker',
      },
      nowMs: T0,
    });
    if (!created.ok) throw new Error(`INGRESS: ${JSON.stringify(created)}`);

    const claimed = runner.claim();
    if (claimed.kind !== 'job') throw new Error(JSON.stringify(claimed));
    expect(claimed.job.capabilityId).toBe(SUBMIT_CAP_ID);
    // The runner decides only whether to take the business. It cannot mint an
    // acknowledgement — Core signs that, which is what makes a plugin safe on
    // this path at all.
    expect(
      runner.answer(claimed.job, {
        kind: 'result',
        result:
          decision === 'accepted'
            ? { kind: 'accepted', supplier_order_id: 'CM-4471' }
            : { kind: 'rejected', reason_code: 'quote_expired' },
      }),
    ).toEqual({ ok: true });
    await workflow.flushBridgeInFlight();
  });
}

/** The socket. Seals what ChairMaker sent and drives Sancho's real ingress. */
function deliverToSancho(index = 0): ReturnType<typeof receiveD2D> {
  const frame = outbound[index];
  if (frame === undefined) throw new Error(`nothing on the wire at ${String(index)}`);
  const body = frame.body as { query_id?: string; capability?: string };
  // The window Sancho's own send opened. Without it the ingress denies the
  // response — correctly — so opening it here is part of modelling the send,
  // not a way around the gate.
  setRequesterWindow(SUPPLIER_DID, String(body.query_id ?? ''), String(body.capability ?? ''), 300);
  const msg: DinaMessage = {
    id: `msg-${String(index)}`,
    type: 'service.response',
    from: SUPPLIER_DID,
    to: BUYER_DID,
    created_time: T0,
    body: JSON.stringify(frame.body),
  };
  return asSancho(() =>
    receiveD2D(
      sealMessage(msg, chairmakerPriv, sanchoPub),
      sanchoPub,
      sanchoPriv,
      [chairmakerPub],
      'unknown',
      {
        authenticatedFromDID: SUPPLIER_DID,
        authenticatedToDID: BUYER_DID,
      },
    ),
  );
}

/** Sancho places an order. The send hands it to ChairMaker and returns. */
async function sanchoOrders(
  order: PurchaseOrderProposal,
  decision: 'accepted' | 'rejected' = 'accepted',
  opts: { deliver?: boolean } = {},
): Promise<void> {
  const built = approvalFor(order);
  if (!built.ok) throw new Error(`fixture missing ${built.missing.join(', ')}`);
  const result = await asSanchoAsync(() =>
    submitApprovedOrder({
      order,
      approved: built.payload,
      context: CONTEXT,
      serviceRkey: SERVICE_RKEY,
      nowMs: T0,
      send: async () => {
        await chairmakerHandles(order, decision);
        // Sent, and no answer yet — the honest description of this lane. The
        // acknowledgement comes back separately, which is the whole point.
        return { kind: 'ambiguous', reason: 'sent; awaiting the supplier acknowledgement' };
      },
    }),
  );
  expect(result.ok).toBe(true);
  if (opts.deliver !== false) deliverToSancho();
}

function sanchoRecord(): ReturnType<typeof describeOrderForOwner> {
  const record = buyerRuntime.buyerOrders.get(SUPPLIER_DID, order().purchase_order_id);
  if (record === null) throw new Error('Sancho has no record of the order');
  return describeOrderForOwner(record);
}

let cachedOrder: PurchaseOrderProposal | null = null;
function order(): PurchaseOrderProposal {
  if (cachedOrder === null) throw new Error('no order in this scenario yet');
  return cachedOrder;
}
const poId = (): string => order().purchase_order_id;


// The HYPHENATED id the reference pack actually publishes. The underscore
// spelling is the wire capability; C7-03's canonicaliser is what makes the two
// compare equal, and using the wrong one here would route the answer straight
// past the status seam.
const STATUS_CAP_ID = 'com.dinakernel.commerce.order-status';

/**
 * ChairMaker signs a status update and answers Sancho's status query with it.
 *
 * DRIVEN THROUGH THE REAL SEAMS on both sides: Core signs, the ingress bridge
 * runs `transformInboundOrderResult` (which is what attaches the catch-up
 * chain), and Sancho's own response bridge verifies it. A test that built the
 * answer by hand would prove the verifier works on input the verifier's own
 * author invented.
 */
async function chairmakerReportsStatus(
  purchaseOrderId: string,
  state: 'preparing' | 'dispatched' | 'cancelled',
  opts: {
    sinceSequence?: string;
    lines?: { lineId: string; fulfilledQuantity: { value: string; unitCode: string } }[];
  } = {},
): Promise<void> {
  await asChairMaker(async () => {
    const signed = supplierRuntime.lifecycle.signStatusUpdate(BUYER_DID, purchaseOrderId, {
      state,
      ...(opts.lines === undefined ? {} : { lines: opts.lines }),
    });
    if ('error' in signed) throw new Error(`SIGN: ${signed.error}`);
    await answerStatusQuery(purchaseOrderId, state, opts.sinceSequence);
  });
}

/** The status query itself, answered by the runner and corrected by Core. */
async function answerStatusQuery(
  purchaseOrderId: string,
  runnerState: string,
  sinceSequence?: string,
): Promise<void> {
  const created = createProviderIngressTask({
    workflow,
    capabilityConfig: {
      pluginInstallId: installId,
      pluginManifestCid: MANIFEST_CID,
      pluginCapabilityId: STATUS_CAP_ID,
    },
    query: {
      fromDid: BUYER_DID,
      queryId: purchaseOrderId,
      capability: 'order_status',
      serviceRkey: SERVICE_RKEY,
      params: {
        purchase_order_id: purchaseOrderId,
        ...(sinceSequence === undefined ? {} : { since_sequence: sinceSequence }),
      },
      ttlSeconds: 300,
      serviceName: 'chairmaker',
    },
    nowMs: T0,
  });
  if (!created.ok) throw new Error(`STATUS INGRESS: ${JSON.stringify(created)}`);
  const claimed = runner.claim();
  if (claimed.kind !== 'job') throw new Error(JSON.stringify(claimed));
  // The runner reports display fields only. Everything checkable is attached
  // by Core after this answer, which is the §9.11 rule under test.
  expect(
    runner.answer(claimed.job, {
      kind: 'result',
      result: { state: runnerState, carrier_reference: 'BLUEDART-9910' },
    }),
  ).toEqual({ ok: true });
  await workflow.flushBridgeInFlight();
}

/** Sancho's verified chain for an order. */
function sanchoChain(purchaseOrderId: string): { state: string; sequence: string }[] {
  return buyerRuntime.buyerStatus
    .chain(SUPPLIER_DID, purchaseOrderId)
    .map((entry) => ({ state: entry.state, sequence: entry.sequence }));
}

// ---------------------------------------------------------------------------

describe('Sancho orders from ChairMaker and hears back', () => {
  beforeEach(() => {
    cachedOrder = null;
  });

  it('settles ACCEPTED when the acknowledgement crosses the wire', async () => {
    const quote = chairmakerQuotes();
    cachedOrder = makeOrder(quote, request.delivery.projection);
    await sanchoOrders(order());

    // ChairMaker's side committed.
    const supplierRef = asChairMaker(() => supplierRuntime.orders.load(BUYER_DID, poId()));
    expect(supplierRef?.ref.state).toBe('decided');

    // Sancho's side settled — on the acknowledgement CORE signed, which is the
    // document that matters, not the runner's own answer.
    const view = sanchoRecord();
    expect(view.state).toBe('accepted');
    expect(view.actions).toEqual(['view_acknowledgement', 'check_status']);
    const stored = buyerRuntime.buyerOrders.get(SUPPLIER_DID, poId());
    // The stored acknowledgement RE-VALIDATES on read: the store runs
    // `rehydrateAcknowledgement`, which re-derives the digest, so a record it
    // hands back with no `protocolFault` is one whose signature-bearing content
    // still matches itself. Asserting the pair is stronger than validating a
    // copy here, because it is the production read path making the claim.
    expect(stored?.acknowledgement).not.toBeNull();
    expect(stored?.protocolFault).toBeNull();
    expect(stored?.acknowledgement?.supplier_did).toBe(SUPPLIER_DID);
  });

  it('settles REJECTED without ever offering to send it again', async () => {
    // The dangerous reading of every non-accepted state is "try again". A
    // rejection is a decision, not a failure to deliver.
    const quote = chairmakerQuotes();
    cachedOrder = makeOrder(quote, request.delivery.projection);
    await sanchoOrders(order(), 'rejected');

    const view = sanchoRecord();
    expect(view.state).toBe('rejected');
    expect(view.actions).not.toContain('resend');
  });

  it('leaves Sancho parked when the answer never arrives', async () => {
    // The state §12.7 was written for. ChairMaker decided; the bytes went
    // nowhere. Sancho must not conclude anything.
    const quote = chairmakerQuotes();
    cachedOrder = makeOrder(quote, request.delivery.projection);
    await sanchoOrders(order(), 'accepted', { deliver: false });

    const view = sanchoRecord();
    expect(view.state).toBe('outcome_unknown');
    expect(view.actions).toEqual(['wait', 'reconcile_now']);
    expect(view.headline.toLowerCase()).not.toContain('fail');
    // And ChairMaker holds a real commitment the whole time.
    expect(asChairMaker(() => supplierRuntime.orders.load(BUYER_DID, poId())?.ref.state)).toBe(
      'decided',
    );
  });
});

describe('the re-poll closes the loop (§12.7)', () => {
  beforeEach(() => {
    cachedOrder = null;
  });

  it('asks ChairMaker again, and settles on the answer', async () => {
    const quote = chairmakerQuotes();
    cachedOrder = makeOrder(quote, request.delivery.projection);
    await sanchoOrders(order(), 'accepted', { deliver: false });
    expect(sanchoRecord().state).toBe('outcome_unknown');

    // The sweep fires the question. It leaves the node; the answer comes back
    // on its own schedule, exactly as the submission's did.
    const asked: Record<string, unknown>[] = [];
    const swept = await asSanchoAsync(() =>
      askReconcilePolls({
        nowMs: T0 + 60_000,
        send: async ({ request: reconcileRequest }) => {
          asked.push(reconcileRequest as unknown as Record<string, unknown>);
          return { sent: true };
        },
      }),
    );
    expect(swept).toMatchObject({ asked: 1 });
    // Asked WITH the digest the order was sent under. A reconcile that could
    // not name the order is a question whose honest answer is `never_received`.
    expect(asked[0]?.order_digest).toBe(order().order_digest);

    // ChairMaker answers from its durable record, through the real engine.
    const answer = asChairMaker(() => supplierRuntime.lifecycle.reconcile(asked[0], BUYER_DID));
    expect(answer).toMatchObject({ outcome: 'received_accepted' });

    // And the answer comes back over the same lane the submission's did.
    outbound.push({
      toDid: BUYER_DID,
      body: {
        query_id: poId(),
        capability: 'order_reconcile',
        status: 'success',
        result: answer,
        ttl_seconds: 300,
      },
    });
    deliverToSancho(outbound.length - 1);

    expect(sanchoRecord().state).toBe('accepted');
  });

  it('stays parked when ChairMaker denies an order it signed for (§16.2)', async () => {
    // The legality rule with teeth. A supplier that lost state and answers
    // `never_received` against evidence the buyer holds must RE-ADOPT; a buyer
    // that resent here would place a second real order.
    const quote = chairmakerQuotes();
    cachedOrder = makeOrder(quote, request.delivery.projection);
    await sanchoOrders(order(), 'accepted', { deliver: false });

    // Installed on the NODE, so the ask and the apply read the SAME evidence.
    // The first version of this test passed a reader to the ask alone, and the
    // apply — which runs in the D2D ingress and had no way to obtain one —
    // judged the denial against an empty question and authorized a resend. That
    // asymmetry was the defect this journey was written to find.
    installHeldEvidenceReader(() => ({
      held_acknowledgement: makeHeldEvidence({ kind: 'accepted' }) as never,
    }));
    const asked: Record<string, unknown>[] = [];
    await asSanchoAsync(() =>
      askReconcilePolls({
        nowMs: T0 + 60_000,
        send: async ({ request: reconcileRequest }) => {
          asked.push(reconcileRequest as unknown as Record<string, unknown>);
          return { sent: true };
        },
      }),
    );
    expect(asked[0]?.held_acknowledgement).toBeDefined();

    outbound.push({
      toDid: BUYER_DID,
      body: {
        query_id: poId(),
        capability: 'order_reconcile',
        status: 'success',
        result: { outcome: 'never_received' },
        ttl_seconds: 300,
      },
    });
    installCommerceRuntime(buyerRuntime);
    try {
      const frame = outbound[outbound.length - 1];
      if (frame === undefined) throw new Error('nothing on the wire');
      setRequesterWindow(SUPPLIER_DID, poId(), 'order_reconcile', 300);
      const msg: DinaMessage = {
        id: 'msg-denial',
        type: 'service.response',
        from: SUPPLIER_DID,
        to: BUYER_DID,
        created_time: T0,
        body: JSON.stringify(frame.body),
      };
      // Delivered WITH the evidence reader, so the buyer judges the answer
      // against what it presented rather than against an empty question.
      receiveD2D(
        sealMessage(msg, chairmakerPriv, sanchoPub),
        sanchoPub,
        sanchoPriv,
        [chairmakerPub],
        'unknown',
        {
          authenticatedFromDID: SUPPLIER_DID,
          authenticatedToDID: BUYER_DID,
        },
      );
    } finally {
      installCommerceRuntime(null);
    }

    const stored = buyerRuntime.buyerOrders.get(SUPPLIER_DID, poId());
    // The one thing that must never happen here.
    expect(stored?.resubmissionAuthorized).toBe(false);
  });
});

describe('what a stranger cannot do', () => {
  beforeEach(() => {
    cachedOrder = null;
  });

  it('cannot settle Sancho’s order by relaying ChairMaker’s acknowledgement', async () => {
    // The record is keyed on the AUTHENTICATED sender. A peer holding a window
    // of its own — a legitimate one, for its own query — must not be able to
    // close somebody else's business by echoing their paperwork.
    const quote = chairmakerQuotes();
    cachedOrder = makeOrder(quote, request.delivery.projection);
    await sanchoOrders(order(), 'accepted', { deliver: false });

    const frame = outbound[0];
    if (frame === undefined) throw new Error('nothing on the wire');
    const IMPOSTOR = 'did:plc:impostor';
    installCommerceRuntime(buyerRuntime);
    try {
      setRequesterWindow(IMPOSTOR, poId(), 'submit_order', 300);
      const msg: DinaMessage = {
        id: 'msg-relayed',
        type: 'service.response',
        from: IMPOSTOR,
        to: BUYER_DID,
        created_time: T0,
        body: JSON.stringify(frame.body),
      };
      const result = receiveD2D(
        sealMessage(msg, chairmakerPriv, sanchoPub),
        sanchoPub,
        sanchoPriv,
        [chairmakerPub],
        'unknown',
        { authenticatedFromDID: IMPOSTOR, authenticatedToDID: BUYER_DID },
      );
      // The ingress accepts it — the impostor's own window is real — and the
      // commerce seam still refuses, because it binds to who SENT it.
      expect(result.action).toBe('bypassed');
    } finally {
      installCommerceRuntime(null);
    }

    expect(buyerRuntime.buyerOrders.get(SUPPLIER_DID, poId())?.state).toBe('outcome_unknown');
  });
});

/**
 * §9.11 — Sancho VERIFIES what ChairMaker reports, rather than believing it.
 *
 * The whole point of the receiver-side check. ChairMaker runs a compare-and-
 * swap over its own status head, and that protects Sancho from nothing: the
 * party running it is the party he is trusting. These drive the real signing,
 * the real ingress bridge and the real response bridge, so what Sancho checks
 * is what ChairMaker actually put on the wire.
 */
describe('Sancho verifies ChairMaker’s fulfilment chain (§9.11)', () => {
  beforeEach(() => {
    cachedOrder = null;
  });

  async function acceptedOrder(): Promise<string> {
    const quote = chairmakerQuotes();
    cachedOrder = makeOrder(quote, request.delivery.projection);
    await sanchoOrders(order());
    expect(sanchoRecord().state).toBe('accepted');
    return poId();
  }

  it('catches up from GENESIS and records the whole chain', async () => {
    const po = await acceptedOrder();
    // Sancho holds nothing, so he asks from the start and ChairMaker sends the
    // acceptance genesis together with the new record. Without that catch-up
    // the successor would arrive unlinkable and read as a fork.
    await chairmakerReportsStatus(po, 'preparing');
    deliverToSancho(1);

    expect(sanchoChain(po)).toEqual([
      { state: 'accepted', sequence: '0' },
      { state: 'preparing', sequence: '1' },
    ]);
    // And no fault: this is an honest supplier reporting honest progress.
    expect(buyerRuntime.buyerOrders.get(SUPPLIER_DID, po)?.protocolFault).toBeNull();
  });

  it('extends the chain on the next report, asking from where it left off', async () => {
    const po = await acceptedOrder();
    await chairmakerReportsStatus(po, 'preparing');
    deliverToSancho(1);

    await chairmakerReportsStatus(po, 'dispatched', {
      sinceSequence: '1',
      lines: [{ lineId: 'l1', fulfilledQuantity: { unitCode: 'each', value: '2' } }],
    });
    deliverToSancho(2);

    expect(sanchoChain(po).map((entry) => entry.state)).toEqual([
      'accepted',
      'preparing',
      'dispatched',
    ]);
  });

  it('is idempotent: the same answer twice leaves one chain', async () => {
    const po = await acceptedOrder();
    await chairmakerReportsStatus(po, 'preparing');
    deliverToSancho(1);
    // The identical frame again — a relay retry, or an owner tapping twice.
    deliverToSancho(1);
    expect(sanchoChain(po)).toHaveLength(2);
    expect(buyerRuntime.buyerOrders.get(SUPPLIER_DID, po)?.protocolFault).toBeNull();
  });

  it('REFUSES a chain tampered with in flight, and moves nothing', async () => {
    // Re-pointing the records at another purchase order on the wire. This
    // test originally expected a BINDING refusal and got none: the order id is
    // inside `status_digest`, so a rewritten field breaks the record's own
    // digest and it is refused as unreadable a layer earlier. The digest is
    // doing the work the binding check would otherwise have to.
    //
    // Which leaves the binding check for the case only it can catch — a
    // supplier SIGNING a valid record for somebody else's order — and that is
    // where `buyer_status_chain.test.ts` tests it.
    const po = await acceptedOrder();
    await chairmakerReportsStatus(po, 'preparing');
    const frame = outbound[1];
    if (frame === undefined) throw new Error('no status frame');
    const body = frame.body as { result: Record<string, unknown> };
    const chain = body.result.signed_status_chain as Record<string, unknown>[];
    expect(chain.length).toBeGreaterThan(0);
    body.result.signed_status_chain = chain.map((entry) => ({
      ...entry,
      purchase_order_id: 'po-somebody-elses',
    }));

    deliverToSancho(1);
    expect(sanchoChain(po)).toHaveLength(0);
    // No fault recorded, and that is right: an unreadable frame does not
    // establish that the SUPPLIER misbehaved. Anything on the path could have
    // mangled it, and marking a counterparty on that evidence would be an
    // accusation this node cannot support.
    expect(buyerRuntime.buyerOrders.get(SUPPLIER_DID, po)?.protocolFault).toBeNull();
  });

  it('REFUSES a state the chain does not carry, however the runner words it', async () => {
    // ChairMaker's runner claims `dispatched` while Core has signed nothing
    // past acceptance. Core corrects the display field on the way out, and
    // Sancho's chain records only what was signed — so the two agree, and
    // neither is the runner's opinion.
    const po = await acceptedOrder();
    await asChairMaker(() => answerStatusQuery(po, 'dispatched'));
    deliverToSancho(1);
    expect(sanchoChain(po)).toEqual([{ state: 'accepted', sequence: '0' }]);
    const answered = outbound[1]?.body as { result: Record<string, unknown> };
    expect(answered.result.state).toBe('accepted');
    expect(answered.result.carrier_reference).toBe('BLUEDART-9910');
  });
});
