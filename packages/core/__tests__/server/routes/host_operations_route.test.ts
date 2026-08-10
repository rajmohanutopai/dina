/**
 * §3.4 — the owner can SEE a parked host-operation proposal and answer it.
 *
 * Until these routes existed the lane was inert in the most complete way: a
 * runner's proposal that the gatekeeper carded was recorded durably, the
 * decision engines were built and tested, and nothing joined them. No surface
 * listed a parked proposal, so an owner could not learn they were being asked;
 * no surface answered one, so nothing could move. A Buyer or Supplier runner
 * could never perform an AppView search, a D2D send, or a connector call.
 *
 * These cases drive the ROUTES rather than the engines beneath them, because
 * the engines already had tests and were never the problem.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { pluginLane } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { buildPluginEnvelope } from '../../../src/plugins/dispatch';
import { ExtensionOperationBroker } from '../../../src/plugins/extension_broker';
import {
  createPluginHostRuntime,
  installPluginHostRuntime,
  type HostOperationDispatcher,
} from '../../../src/plugins/host_operations';
import { ExtensionOperationRegistry } from '../../../src/plugins/extension_ops';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
} from '../../../src/plugins/registry';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerHostOperationRoutes } from '../../../src/server/routes/host_operations';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';
import { SQLiteWorkflowRepository } from '../../../src/workflow/repository';
import { setWorkflowService, WorkflowService } from '../../../src/workflow/service';

import type { PluginInstall } from '../../../src/plugins/registry';

const OP = 'appview_search';
const CAP = 'com.acme.commerce.request_quote';
const RUNNER_DID = 'did:plc:chairrunner00000000';

let dir: string;
let adapter: NodeSQLiteAdapter;
let router: CoreRouter;
let broker: ExtensionOperationBroker;
let dispatcher: HostOperationDispatcher;
let registry: ExtensionOperationRegistry;
let workflowRepo: SQLiteWorkflowRepository;
let install: PluginInstall;

const OWNER_CAP = 'owner-cap-hostops';

/**
 * An OWNER request. The guard refuses anything else, which is the point: a
 * proposal is a request for authority the runner does not have, so letting the
 * runner's own lane answer it would make the card a formality.
 */
function ownerReq(over: Partial<CoreRequest> = {}): CoreRequest {
  return {
    method: 'GET',
    path: '/',
    headers: {},
    query: {},
    body: {},
    rawBody: new Uint8Array(),
    params: {},
    // The owner's own in-app call. Without this the router's auth layer
    // answers 401 before the owner guard is ever consulted.
    trustedInProcess: true,
    callerType: 'owner',
    callerDID: 'did:key:owner',
    ownerCapability: OWNER_CAP,
    ...over,
  } as CoreRequest;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-hostop-route-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);

  registry = new ExtensionOperationRegistry();
  registry.register({
    operationName: OP,
    paramsSchema: { type: 'object' },
    resultSchema: { type: 'object' },
    adapterVersion: '1',
    requiredFeature: 'commerce-host-ops-v1',
    actionClass: 'read',
  });
  const runtime = createPluginHostRuntime({
    db: adapter,
    registry,
    validate: () => null,
  });
  installPluginHostRuntime(runtime);
  broker = runtime.broker;
  dispatcher = runtime.dispatcher;
  dispatcher.register(OP, async () => ({
    kind: 'completed',
    result: { hits: ['oak chair', 'ash chair'] },
  }));

  // The REAL install row and the REAL workflow store, not stubs: the decide
  // route reads the install through the registry and hands the settlement a
  // workflow service, and a fixture that faked either would prove the route
  // works against a world that does not exist.
  const installs = new SQLitePluginInstallRepository(adapter);
  setPluginInstallRepository(installs);
  const installId = installs.createPending({
    publisherDid: 'did:plc:chairmaker00000000',
    pluginId: 'com.acme.commerce',
    label: 'ChairMaker',
    executionMode: 'runner',
    currentCid: 'bafy-current',
    currentVersion: '1.0.0',
    // `plugin_id` / `version` / `execution.mode` must AGREE with the scalar
    // columns — the hydrator quarantines an internally inconsistent row, so a
    // manifest carrying only `capabilities` yields an install that reads back
    // as null.
    manifest: {
      plugin_id: 'com.acme.commerce',
      version: '1.0.0',
      execution: { mode: 'runner' },
      capabilities: [
        {
          id: CAP,
          host_operations: [OP],
          action_class: 'read',
          effects_idempotency: 'unsupported',
        },
      ],
    } as unknown as Parameters<typeof installs.createPending>[0]['manifest'],
    installScopeHash: 'scope',
    capabilityHashes: { [CAP]: 'cap-scope-hash' },
    behaviorHash: 'behaviour',
    presentationHash: 'presentation',
    trustAnchor: { kind: 'repo_proof' },
    pendingExpiresAtSec: Math.floor(Date.now() / 1000) + 3600,
    nowMs: Date.now(),
  });
  installs.activate(installId, RUNNER_DID, Date.now());
  const activated = installs.getById(installId);
  if (activated === null) throw new Error('the install did not land');
  install = activated;

  workflowRepo = new SQLiteWorkflowRepository(adapter);
  setWorkflowService(new WorkflowService({ repository: workflowRepo }));

  router = new CoreRouter();
  registerHostOperationRoutes(router, OWNER_CAP);
});

afterEach(() => {
  installPluginHostRuntime(null);
  setPluginInstallRepository(null);
  setWorkflowService(null);
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Park a proposal the way the completion handler does: propose, then retain. */
function parkProposal(retainSource = true): string {
  const proposed = broker.propose({
    installId: install.installId,
    capability: { id: CAP, host_operations: [OP] },
    operationName: OP,
    params: { query: 'oak chairs' },
    registry,
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
  });
  if (!proposed.ok) throw new Error(`propose refused: ${proposed.refusal}`);
  if (retainSource) {
    // The envelope of the claim that proposed this — a real one, because the
    // route re-parses it and `parsePluginEnvelope` rejects anything less.
    const envelope = buildPluginEnvelope({
      install,
      capabilityId: CAP,
      params: { query: 'oak chairs' },
      context: [],
      executionId: proposed.value.proposalId,
      idempotencyKey: proposed.value.proposalId,
    });
    broker.retainSource(proposed.value.proposalId, JSON.stringify(envelope));
  }
  return proposed.value.proposalId;
}

describe('the owner can see what a runner is asking for', () => {
  it('lists a parked proposal with the params the decision turns on', async () => {
    const proposalId = parkProposal();

    const res = await router.handle(
      ownerReq({ method: 'GET', path: '/v1/plugins/host-operations' }),
    );

    expect(res.status).toBe(200);
    const body = res.body as { proposals: Record<string, unknown>[] };
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0].proposal_id).toBe(proposalId);
    expect(body.proposals[0].operation_name).toBe(OP);
    // An owner cannot judge "may this plugin search" without seeing WHAT it
    // wants to search for.
    expect(body.proposals[0].params_json).toContain('oak chairs');
    expect(body.proposals[0].resolvable).toBe(true);
  });

  it('says plainly when a proposal cannot be answered', async () => {
    // Parked before the envelope was retained: settling it could never deliver
    // the result, so the surface must not offer a button that fails.
    parkProposal(false);

    const res = await router.handle(
      ownerReq({ method: 'GET', path: '/v1/plugins/host-operations' }),
    );
    const body = res.body as { proposals: { resolvable: boolean }[] };
    expect(body.proposals[0].resolvable).toBe(false);
  });

  it('answers empty rather than failing on a node with no plugin lane', async () => {
    installPluginHostRuntime(null);
    const res = await router.handle(
      ownerReq({ method: 'GET', path: '/v1/plugins/host-operations' }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ proposals: [], host_operations_available: false });
  });
});

describe('answering a proposal', () => {
  it('refuses a decision for a proposal that does not exist', async () => {
    const res = await router.handle(
      ownerReq({
        method: 'POST',
        path: '/v1/plugins/host-operations/decide',
        body: { proposal_id: 'nope', approved: true },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('requires both the id and an explicit decision', async () => {
    const proposalId = parkProposal();
    // `approved` omitted — an absent decision is not a rejection, and guessing
    // either way would answer for the owner.
    const res = await router.handle(
      ownerReq({
        method: 'POST',
        path: '/v1/plugins/host-operations/decide',
        body: { proposal_id: proposalId },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('refuses a proposal parked with no retained source', async () => {
    // Permitting an effect whose result can never be delivered would spend the
    // authority and tell nobody.
    const proposalId = parkProposal(false);
    const res = await router.handle(
      ownerReq({
        method: 'POST',
        path: '/v1/plugins/host-operations/decide',
        body: { proposal_id: proposalId, approved: true },
      }),
    );
    expect(res.status).toBe(409);
  });

  it('records a REFUSAL, and refuses to answer the same proposal twice', async () => {
    // Declining needs no dispatcher and no follow-up, so it exercises the
    // route's own discipline: one card, one decision.
    const proposalId = parkProposal();

    const first = await router.handle(
      ownerReq({
        method: 'POST',
        path: '/v1/plugins/host-operations/decide',
        body: { proposal_id: proposalId, approved: false, reason: 'not this vendor' },
      }),
    );
    expect(first.status).toBe(200);
    expect(broker.get(proposalId)?.state).not.toBe('proposed');

    const second = await router.handle(
      ownerReq({
        method: 'POST',
        path: '/v1/plugins/host-operations/decide',
        body: { proposal_id: proposalId, approved: true },
      }),
    );
    // One card must not spend two permits.
    expect(second.status).toBe(409);
  });

  it('refuses when nothing can carry the answer back, and spends no decision', async () => {
    // Both answers — a verified result and a refusal — reach the runner as its
    // next task. With no workflow store there is nothing to enqueue, so
    // settling would spend the decision and leave the runner waiting.
    const proposalId = parkProposal();
    setWorkflowService(null);

    const res = await router.handle(
      ownerReq({
        method: 'POST',
        path: '/v1/plugins/host-operations/decide',
        body: { proposal_id: proposalId, approved: true },
      }),
    );

    expect(res.status).toBe(503);
    // Still answerable once the node is whole again.
    expect(broker.get(proposalId)?.state).toBe('proposed');
  });

  it('APPROVED means executed, and the result comes back on the plugin’s own lane', async () => {
    // The whole point of the lane. Before these routes a runner could ask and
    // nothing could answer, so an approved AppView search never ran and no
    // result ever reached the runner.
    const proposalId = parkProposal();

    const res = await router.handle(
      ownerReq({
        method: 'POST',
        path: '/v1/plugins/host-operations/decide',
        body: { proposal_id: proposalId, approved: true },
      }),
    );

    expect(res.status).toBe(200);
    expect(broker.get(proposalId)?.state).toBe('completed');
    expect(broker.get(proposalId)?.resultJson).toContain('oak chair');

    // A follow-up task, forced to this install's lane — the runner learns the
    // outcome the same way it learns anything, by claiming its next task.
    const followUp = workflowRepo.claimDelegationTask(
      RUNNER_DID,
      Date.now(),
      60_000,
      pluginLane(install.installId),
    );
    expect(followUp).not.toBeNull();
    expect(followUp?.payload).toContain('oak chair');
  });

  it('drops a settled proposal off the owner’s list', async () => {
    const proposalId = parkProposal();
    await router.handle(
      ownerReq({
        method: 'POST',
        path: '/v1/plugins/host-operations/decide',
        body: { proposal_id: proposalId, approved: false },
      }),
    );

    const res = await router.handle(
      ownerReq({ method: 'GET', path: '/v1/plugins/host-operations' }),
    );
    // A surface that kept showing answered work would ask for decisions
    // nobody needs to make.
    expect((res.body as { proposals: unknown[] }).proposals).toEqual([]);
  });
});

describe('only the owner may answer', () => {
  it('refuses a non-owner caller on both routes', async () => {
    const proposalId = parkProposal();
    const asAgent = { callerType: 'agent', callerDID: 'did:key:agent' } as Partial<CoreRequest>;

    const list = await router.handle(
      ownerReq({ method: 'GET', path: '/v1/plugins/host-operations', ...asAgent, ownerCapability: undefined }),
    );
    expect(list.status).toBe(403);

    const decide = await router.handle(
      ownerReq({
        method: 'POST',
        path: '/v1/plugins/host-operations/decide',
        body: { proposal_id: proposalId, approved: true },
        ...asAgent,
        ownerCapability: undefined,
      }),
    );
    expect(decide.status).toBe(403);
    // And nothing moved.
    expect(broker.get(proposalId)?.state).toBe('proposed');
  });
});
