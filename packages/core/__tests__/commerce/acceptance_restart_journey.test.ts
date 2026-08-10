/**
 * §25.6 steps 13-15: RESTART BOTH SIDES, then prove the trade survived.
 *
 * WHAT NO OTHER JOURNEY REACHES. Every commerce journey in this suite runs
 * inside one process lifetime. `buyer_round_trip_journey` carries a real
 * acknowledgement between two nodes; `procurement_journey` walks import to
 * delivery; `disaster_recovery_journey` restores an archive. None of them ever
 * CLOSES the two databases mid-trade and opens them again — which is step 13 of
 * the acceptance journey and the one step the WBS calls out as unskippable,
 * because a commerce claim that only holds while the process is up is not a
 * commerce claim.
 *
 * The failure this is written against is specific and quiet. Both sides hold a
 * commitment: the buyer holds the supplier's signed acknowledgement, the
 * supplier holds the order it admitted and the receipt it signed. If either
 * side's memory of the trade lives anywhere but its database, a restart makes
 * them disagree — and the first symptom is not an error. It is a buyer
 * resubmitting an order the supplier already accepted, or a supplier accepting
 * it twice.
 *
 * A RESTART HERE IS A REAL RESTART: `close()` on both adapters, then reopen the
 * same files with the same passphrase and rebuild both runtimes from what is on
 * disk. Nothing is carried across in a variable. The workflow store is SQLite
 * rather than the in-memory double the sibling journeys use, so the supplier's
 * plugin lane survives too — an in-memory lane would make the restart look
 * cleaner than it is by losing the evidence that could contradict it.
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
import { installHeldEvidenceReader } from '../../src/commerce/reconcile_poller';
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
import { SQLiteWorkflowRepository } from '../../src/workflow/repository';
import { makeServiceResponseBridgeSender } from '../../src/workflow/response_bridge_sender';
import { WorkflowService } from '../../src/workflow/service';

import {
  BUYER_DID,
  SUPPLIER_DID,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
  registerBuyerPack,
} from './helpers';

import type { CommerceRuntime } from '../../src/commerce/runtime';
import type { PurchaseOrderProposal } from '@dina/commerce-protocol';
import { singleOwnerAuthority } from '../../src/commerce/buyer_authority';

/** The owner this node acts for. §7.3: one grant, evaluated like any other. */
const TEST_OWNER_DID = 'did:plc:testowner00000000';

const T0 = Date.parse('2026-08-08T09:00:00.000Z');
const RUNNER_DID = 'did:plc:chairmakerrunner';
const MANIFEST_CID = 'bafyreichairmaker1';
const SUBMIT_CAP_ID = 'com.dinakernel.commerce.submit-order';
const SERVICE_RKEY = 'self';

const chairmakerPriv = new Uint8Array(32).fill(0x11);
const chairmakerPub = getPublicKey(chairmakerPriv);
const sanchoPriv = new Uint8Array(32).fill(0x22);
const sanchoPub = getPublicKey(sanchoPriv);

let dir: string;
/** Held so a reopen can decrypt what the first boot wrote. This IS the restart. */
let supplierKey: string;
let buyerKey: string;

let supplierDb: NodeSQLiteAdapter;
let supplierRuntime: CommerceRuntime;
let buyerDb: NodeSQLiteAdapter;
let buyerRuntime: CommerceRuntime;

let installs: SQLitePluginInstallRepository;
let workflow: WorkflowService;
let workflowRepo: SQLiteWorkflowRepository;
let installId: string;
let runner: PluginRunner;
let outbound: { toDid: string; body: Record<string, unknown> }[];

const request = makeQuoteRequest();
let quote: ReturnType<typeof makeSignedQuote>;
let theOrder: PurchaseOrderProposal;

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
async function asChairMakerAsync<T>(fn: () => Promise<T>): Promise<T> {
  installCommerceRuntime(supplierRuntime);
  try {
    return await fn();
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

function openDb(name: string, passphraseHex: string): NodeSQLiteAdapter {
  const a = new NodeSQLiteAdapter({
    path: path.join(dir, `${name}.sqlite`),
    passphraseHex,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(a, IDENTITY_MIGRATIONS);
  return a;
}

/**
 * Build everything a booting node builds, from the two open databases.
 *
 * Called at boot AND after the restart, from the same code, so the second boot
 * cannot accidentally be given something the first one had in a closure.
 */
function composeBothNodes(): void {
  supplierRuntime = createCommerceRuntime({
    adapter: supplierDb,
    supplierDid: () => SUPPLIER_DID,
    // §16.2 leaves the live epoch fail-closed until a PDS publication. A fixed
    // value stands in for "the fence has been discharged" — the only state in
    // which commerce may sign at all. It is the SAME value across the restart,
    // which is the point: a node that came back with a new epoch would be
    // fencing itself, and that is a different test (disaster_recovery_journey).
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
  // A REAL buyer install in the SAME registry (NEW-11). `submitApprovedOrder`
  // re-resolves the acting install against the registry immediately before
  // sending, so a journey that registers only the supplier pack and then
  // submits a buyer order under a hand-written id is refused — correctly.
  buyerPack = registerBuyerPack(installs, T0);

  workflowRepo = new SQLiteWorkflowRepository(supplierDb);
  workflow = new WorkflowService({
    repository: workflowRepo,
    nowMsFn: () => T0,
    ingressResultTransformer: transformInboundOrderResult,
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
}

/**
 * Step 13. Both nodes go down and come back up.
 *
 * The databases are CLOSED, not merely re-read. Everything either side knows
 * afterwards came off disk.
 */
function restartBothNodes(): void {
  installCommerceRuntime(null);
  supplierDb.close();
  buyerDb.close();
  supplierDb = openDb('chairmaker', supplierKey);
  buyerDb = openDb('sancho', buyerKey);
  composeBothNodes();
}

let buyerPack: ReturnType<typeof registerBuyerPack>;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'acceptance-restart-'));
  supplierKey = randomBytes(32).toString('hex');
  buyerKey = randomBytes(32).toString('hex');
  supplierDb = openDb('chairmaker', supplierKey);
  buyerDb = openDb('sancho', buyerKey);
  outbound = [];
  composeBothNodes();

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

  quote = makeSignedQuote(request, {});
  theOrder = makeOrder(quote, request.delivery.projection);

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
  } catch {
    // A test that already closed them as part of a restart is not a failure.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Built per test, because the acting install is minted per test (NEW-11).
 * A module const would capture `buyerPack` before `beforeEach` assigns it.
 */
function buildContext(): BuyerApprovalContext {
    return {
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
    install: buyerPack,
  };
}

/** ChairMaker holds the request and registers the quote it signed. */
function chairmakerOffers(): void {
  asChairMaker(() => {
    const runtime = getCommerceRuntime();
    if (runtime === null) throw new Error('commerce runtime missing');
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
  });
}

/** The supplier's whole inbound path: admission, lane, runner, Core signs. */
async function chairmakerHandles(order: PurchaseOrderProposal): Promise<void> {
  await asChairMakerAsync(async () => {
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
    expect(
      runner.answer(claimed.job, {
        kind: 'result',
        result: { kind: 'accepted', supplier_order_id: 'CM-4471' },
      }),
    ).toEqual({ ok: true });
    await workflow.flushBridgeInFlight();
  });
}

/** The socket. Seals ChairMaker's frame and drives Sancho's real ingress. */
function deliverToSancho(index: number): void {
  const frame = outbound[index];
  if (frame === undefined) throw new Error(`nothing on the wire at ${String(index)}`);
  const body = frame.body as { query_id?: string; capability?: string };
  setRequesterWindow(SUPPLIER_DID, String(body.query_id ?? ''), String(body.capability ?? ''), 300);
  const msg: DinaMessage = {
    id: `msg-${String(index)}`,
    type: 'service.response',
    from: SUPPLIER_DID,
    to: BUYER_DID,
    created_time: T0,
    body: JSON.stringify(frame.body),
  };
  asSancho(() =>
    receiveD2D(sealMessage(msg, chairmakerPriv, sanchoPub), sanchoPub, sanchoPriv, [chairmakerPub], 'unknown', {
      authenticatedFromDID: SUPPLIER_DID,
      authenticatedToDID: BUYER_DID,
    }),
  );
}

/** Sancho places the order and receives the answer. Steps 5-12, compressed. */
async function sanchoBuys(): Promise<void> {
  const built = buildBuyerApprovalPayload(theOrder, buildContext());
  if (!built.ok) throw new Error(`fixture missing ${built.missing.join(', ')}`);
  const result = await asSanchoAsync(() =>
    submitApprovedOrder({
      order: theOrder,
      approved: built.payload,
      context: buildContext(),
      serviceRkey: SERVICE_RKEY,
      nowMs: T0,
      send: async () => {
        await chairmakerHandles(theOrder);
        return { kind: 'ambiguous', reason: 'sent; awaiting the supplier acknowledgement' };
      },
    
      // DR-1: authority is REQUIRED now. The single-owner configuration is
      // one grant evaluated like any other — not a branch that skips §7.3.
      authority: singleOwnerAuthority({
        ownerDid: TEST_OWNER_DID,
        order: theOrder,
        context: buildContext(),
        serviceRkey: SERVICE_RKEY,
      }),
    }),
  );
  expect(result.ok).toBe(true);
  deliverToSancho(0);
}

/** What Sancho's own store says the state of the purchase is. */
function sanchoView(): ReturnType<typeof describeOrderForOwner> {
  const record = buyerRuntime.buyerOrders.get(SUPPLIER_DID, theOrder.purchase_order_id);
  if (record === null) throw new Error('Sancho has no record of the order');
  return describeOrderForOwner(record);
}

describe('§25.6 step 13 — both sides restart mid-trade', () => {
  it('the buyer still holds the supplier’s acknowledgement after a restart', async () => {
    chairmakerOffers();
    await sanchoBuys();
    const before = sanchoView();
    expect(before.state).toBe('accepted');

    restartBothNodes();

    // Read from a runtime built after the close, over a file reopened from
    // disk. Nothing about this answer came from the process that made the trade.
    const after = sanchoView();
    expect(after.state).toBe(before.state);
    expect(after.actions).toEqual(before.actions);
  });

  it('the two sides still name the SAME order after a restart', async () => {
    chairmakerOffers();
    await sanchoBuys();

    restartBothNodes();

    // The supplier's own record of what it admitted.
    const admitted = asChairMaker(() => {
      const runtime = getCommerceRuntime();
      if (runtime === null) throw new Error('no runtime');
      return runtime.orders.load(BUYER_DID, theOrder.purchase_order_id)?.ref ?? null;
    });
    expect(admitted).not.toBeNull();
    expect(admitted?.orderDigest).toBe(theOrder.order_digest);
    expect(admitted?.idempotencyKey).toBe(theOrder.idempotency_key);

    // And the buyer's, which was written on the other node and travelled as an
    // envelope. Two databases, one purchase, one digest.
    const held = buyerRuntime.buyerOrders.get(SUPPLIER_DID, theOrder.purchase_order_id);
    expect(held?.orderDigest).toBe(admitted?.orderDigest);
    expect(held?.idempotencyKey).toBe(admitted?.idempotencyKey);
  });

  it('a resubmission after the restart is refused, not accepted a second time', async () => {
    // §12.7 / §15.5. This is the failure a lost restart produces: the buyer
    // taps send again because its screen came back empty, and the supplier
    // ships twice. Both halves have to remember.
    chairmakerOffers();
    await sanchoBuys();

    restartBothNodes();

    const built = buildBuyerApprovalPayload(theOrder, buildContext());
    if (!built.ok) throw new Error('fixture cannot build a payload');
    let sends = 0;
    const again = await asSanchoAsync(() =>
      submitApprovedOrder({
        order: theOrder,
        approved: built.payload,
        context: buildContext(),
        serviceRkey: SERVICE_RKEY,
        nowMs: T0,
        send: async () => {
          sends += 1;
          return { kind: 'ambiguous', reason: 'sent' };
        },
      
        // DR-1: authority is REQUIRED now. The single-owner configuration is
        // one grant evaluated like any other — not a branch that skips §7.3.
        authority: singleOwnerAuthority({
          ownerDid: TEST_OWNER_DID,
          order: theOrder,
          context: buildContext(),
          serviceRkey: SERVICE_RKEY,
        }),
      }),
    );
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.refusal).toBe('already_submitted');
    // Refused at the door — nothing reached the wire.
    expect(sends).toBe(0);
  });

  it('the supplier refuses a replayed order with its ORIGINAL answer', async () => {
    // The mirror of the case above, on the other node: if the buyer's refusal
    // were somehow bypassed, the supplier must still not create a second order.
    chairmakerOffers();
    await sanchoBuys();

    restartBothNodes();

    let replayAnswer = '';
    await asChairMakerAsync(async () => {
      const created = createProviderIngressTask({
        workflow,
        capabilityConfig: {
          pluginInstallId: installId,
          pluginManifestCid: MANIFEST_CID,
          pluginCapabilityId: SUBMIT_CAP_ID,
        },
        query: {
          fromDid: BUYER_DID,
          queryId: theOrder.purchase_order_id,
          capability: 'submit_order',
          serviceRkey: SERVICE_RKEY,
          params: theOrder,
          ttlSeconds: 300,
          serviceName: 'chairmaker',
        },
        nowMs: T0,
      });
      expect(created.ok).toBe(true);
      // THE RETURN TYPE ITSELF says which happened: a queued task or an
      // answer Core already had. A replay must be the second, and narrowing on
      // the union is the assertion — no task id means no plugin work.
      expect(created.ok && 'coreAnswerJson' in created).toBe(true);
      replayAnswer = created.ok && 'coreAnswerJson' in created ? created.coreAnswerJson : '';
      await workflow.flushBridgeInFlight();
    });

    // THE RUNNER IS NEVER ASKED, and the answer does not travel the response
    // bridge either — Core recognises the replay from the receipt it kept and
    // answers INLINE, on the ingress return. That is stronger than "the second
    // answer matches the first": the plugin never gets a second chance to
    // decide differently about a sale already committed, so a supplier pack
    // cannot un-accept and cannot accept twice, even after a restart.
    expect(runner.claim().kind).not.toBe('job');
    expect(replayAnswer).not.toBe('');

    // And it is the SAME commitment, byte for byte on the fields that bind it.
    const served = JSON.parse(replayAnswer) as {
      kind: string;
      order_digest: string;
      acknowledgement_digest: string;
    };
    expect(served.kind).toBe('accepted');
    expect(served.order_digest).toBe(theOrder.order_digest);

    // The buyer, on its own node and its own database, holds that same
    // acknowledgement. Two stores, one restart, one agreed commitment.
    const held = buyerRuntime.buyerOrders.get(SUPPLIER_DID, theOrder.purchase_order_id);
    expect(held?.acknowledgement?.acknowledgement_digest).toBe(served.acknowledgement_digest);

    // Still exactly one order on the supplier's side.
    const ref = asChairMaker(() => {
      const runtime = getCommerceRuntime();
      if (runtime === null) throw new Error('no runtime');
      return runtime.orders.load(BUYER_DID, theOrder.purchase_order_id)?.ref ?? null;
    });
    expect(ref?.orderDigest).toBe(theOrder.order_digest);
  });
});

describe('§25.6 step 15 — revoke, and prove no further work', () => {
  it('a revoked install takes no new order, and its lane goes quiet', async () => {
    chairmakerOffers();
    await sanchoBuys();
    restartBothNodes();

    // The owner uninstalls. Pausing the row is what stops the lane; the
    // runner's device binding is what stops the runner.
    expect(installs.pause(installId, T0)).toBe(true);

    const secondQuote = makeSignedQuote(makeQuoteRequest(), { quote_id: 'q-after-revoke' });
    const secondOrder = makeOrder(secondQuote, request.delivery.projection);
    const refused = asChairMaker(() =>
      createProviderIngressTask({
        workflow,
        capabilityConfig: {
          pluginInstallId: installId,
          pluginManifestCid: MANIFEST_CID,
          pluginCapabilityId: SUBMIT_CAP_ID,
        },
        query: {
          fromDid: BUYER_DID,
          queryId: secondOrder.purchase_order_id,
          capability: 'submit_order',
          serviceRkey: SERVICE_RKEY,
          params: secondOrder,
          ttlSeconds: 300,
          serviceName: 'chairmaker',
        },
        nowMs: T0,
      }),
    );
    expect(refused.ok).toBe(false);

    // NO FURTHER WORK. The runner asks its lane and is given nothing —
    // which is the claim step 15 actually makes.
    const claimed = runner.claim();
    expect(claimed.kind).not.toBe('job');
  });
});
