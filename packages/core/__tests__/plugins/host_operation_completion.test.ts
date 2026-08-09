/**
 * The seam that makes §3.4's lane run, driven through the REAL
 * `WorkflowService.complete()` (WS-3.4).
 *
 * The lane's own suite proves the decision and the broker. This proves the
 * thing that suite cannot: that completing a claim with a typed proposal
 * actually reaches them, and that the verified result comes back as the
 * runner's NEXT task on its own lane. Before this, a runner could send a
 * perfectly-formed proposal and Core would file it as an ordinary result.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { pluginLane } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  ExtensionOperationBroker,
  HOST_OPERATION_PROPOSAL_KIND,
  makePluginCompletionHandler,
  settleOwnerDecision,
} from '../../src/plugins';
import { buildPluginEnvelope } from '../../src/plugins/dispatch';
import { ExtensionOperationRegistry } from '../../src/plugins/extension_ops';
import { HostOperationDispatcher } from '../../src/plugins/host_operations';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { parsePluginEnvelope } from '../../src/workflow/plugin_envelope';
import { SQLiteWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService } from '../../src/workflow/service';

import type { ProposalDecision } from '../../src/plugins';
import type { PluginInstall } from '../../src/plugins/registry';

const CAP = 'com.chairmaker.catalog.search';
const OP = 'commerce.appview_search';
const INSTALL = 'install-1';
const RUNNER_DID = 'did:plc:runnerdevice00000';

const OPEN: NodeSQLiteAdapter[] = [];
const DIRS: string[] = [];

afterEach(() => {
  for (const a of OPEN.splice(0)) a.close();
  for (const d of DIRS.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function install(overrides: Partial<PluginInstall> = {}): PluginInstall {
  return {
    installId: INSTALL,
    publisherDid: 'did:plc:chairmaker00000000',
    pluginId: 'com.chairmaker.pack',
    label: 'ChairMaker',
    status: 'active',
    executionMode: 'runner',
    currentCid: 'bafy-current',
    currentVersion: '1.0.0',
    manifest: {
      capabilities: [
        {
          id: CAP,
          host_operations: [OP],
          // `action_class` is REQUIRED by the envelope parser (it is a pinned
          // classification input the claim guard re-derives). A fixture
          // without it produced an envelope that would not parse, which is the
          // parser working — the first version of this suite silently got no
          // follow-up because of it.
          action_class: 'read',
          effects_idempotency: 'unsupported',
        },
      ],
    } as unknown as PluginInstall['manifest'],
    installScopeHash: 'scope',
    capabilityHashes: { [CAP]: 'cap-scope-hash' },
    behaviorHash: 'behaviour',
    presentationHash: 'presentation',
    trustAnchor: { kind: 'publisher' } as unknown as PluginInstall['trustAnchor'],
    configRevision: 1,
    ...overrides,
  } as PluginInstall;
}

function setup(options: { decide?: ProposalDecision; installOverrides?: Partial<PluginInstall> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xop-complete-'));
  DIRS.push(dir);
  const db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  OPEN.push(db);
  applyMigrations(db, IDENTITY_MIGRATIONS);

  const registry = new ExtensionOperationRegistry();
  registry.register({
    operationName: OP,
    paramsSchema: { type: 'object' },
    resultSchema: { type: 'object' },
    adapterVersion: '1',
    requiredFeature: 'commerce-host-ops-v1',
    actionClass: 'read',
  });
  const broker = new ExtensionOperationBroker({ db, now: () => 1_700_000_000_000, validate: () => null });
  const dispatcher = new HostOperationDispatcher({
    broker,
    resultSchemaFor: (name) => registry.get(name)?.resultSchema,
  });
  dispatcher.register(OP, async () => ({
    kind: 'completed',
    result: { hits: ['oak chair', 'ash chair'] },
  }));

  const repository = new SQLiteWorkflowRepository(db);
  const errors: unknown[] = [];
  const theInstall = install(options.installOverrides);
  // A late-bound box: the handler needs the service that is being built here,
  // and TypeScript will not let a `const` reference its own initializer.
  const late: { service: WorkflowService | null } = { service: null };
  const service: WorkflowService = new WorkflowService({
    repository,
    pluginCompletionHandler: makePluginCompletionHandler({
      broker: () => broker,
      dispatcher: () => dispatcher,
      registry: () => registry,
      installs: () => ({ getById: (id) => (id === INSTALL ? theInstall : null) }),
      workflow: () => late.service,
      decide: () => options.decide ?? { kind: 'permit' },
      onError: (e) => errors.push(e),
    }),
  });
  late.service = service;
  return { db, broker, dispatcher, registry, repository, service, errors, install: theInstall };
}

/** Enqueue the claim the runner is about to complete, exactly as dispatch would. */
function enqueueClaim(
  ctx: ReturnType<typeof setup>,
  executionId = 'exec-1',
): { id: string; claimId: string } {
  const envelope = buildPluginEnvelope({
    install: ctx.install,
    capabilityId: CAP,
    params: { query: 'chairs' },
    context: [],
    executionId,
    idempotencyKey: executionId,
  });
  const task = ctx.service.create({
    id: executionId,
    kind: 'delegation',
    description: 'catalog search',
    payload: JSON.stringify(envelope),
    expiresAtSec: Math.floor(Date.now() / 1000) + 600,
    idempotencyKey: executionId,
    initialState: 'queued' as never,
    requestedRunner: pluginLane(INSTALL),
  } as never);
  // A task must be CLAIMED before it can complete, and a plugin completion
  // carries the CLAIM TOKEN — the §9.1 CAS that makes a stale claim's report
  // evidence rather than a state change. That discipline is exactly what §3.4
  // means by "the request rides the existing claim-token discipline".
  const claimed = ctx.repository.claimDelegationTask(
    RUNNER_DID,
    Date.now(),
    60_000,
    pluginLane(INSTALL),
  );
  if (claimed === null || claimed.claim_id === undefined) {
    throw new Error('the claim did not land');
  }
  return { id: task.id, claimId: claimed.claim_id };
}

const proposal = (key = 'k1') =>
  JSON.stringify({
    kind: HOST_OPERATION_PROPOSAL_KIND,
    operation_name: OP,
    params: { query: 'chairs' },
    idempotency_key: key,
  });

/**
 * The handler is DETACHED — `complete()` returns before it runs, which is the
 * point (a completion must not block on a network effect). Give the event loop
 * real turns, not just microtasks: the dispatcher awaits.
 */
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};

describe('completing a claim with a typed proposal', () => {
  it('brokers the operation and delivers the verified result as the next task', async () => {
    const ctx = setup();
    const { id, claimId } = enqueueClaim(ctx);
    ctx.service.complete(id, proposal(), 'proposing a host operation', RUNNER_DID, claimId);
    await settle();

    // The proposal is durable and settled.
    const executing = ctx.broker.listExecuting();
    expect(executing).toHaveLength(0);

    // The follow-up carries the VERIFIED result, on this install's own lane.
    const tasks = ctx.repository.listNonTerminalByRunner(pluginLane(INSTALL));
    expect(tasks).toHaveLength(1);
    const envelope = parsePluginEnvelope(tasks[0].payload);
    expect(envelope?.host_operation).toMatchObject({
      operation_name: OP,
      state: 'completed',
      result: { hits: ['oak chair', 'ash chair'] },
    });
    // Same lane, so nothing else can claim a result meant for this install.
    expect(tasks[0].requested_runner).toBe(pluginLane(INSTALL));
    expect(ctx.errors).toEqual([]);
  });

  it('carries the ORIGINAL params, not the result', async () => {
    // `buildPluginEnvelope` validates params against the consented schema, and
    // an operation's result is not that shape. Putting it there would either
    // fail validation or force the schema wide enough to accept both.
    const ctx = setup();
    const { id, claimId } = enqueueClaim(ctx);
    ctx.service.complete(id, proposal(), 'proposing', RUNNER_DID, claimId);
    await settle();
    const followUp = ctx.repository.listNonTerminalByRunner(pluginLane(INSTALL))[0];
    const envelope = parsePluginEnvelope(followUp?.payload ?? '');
    expect(envelope?.params).toEqual({ query: 'chairs' });
  });

  it('lets an ordinary completion through untouched', async () => {
    const ctx = setup();
    const { id, claimId } = enqueueClaim(ctx);
    ctx.service.complete(id, '{"hits":[]}', 'an ordinary result', RUNNER_DID, claimId);
    await settle();
    expect(ctx.repository.listNonTerminalByRunner(pluginLane(INSTALL))).toEqual([]);
    expect(ctx.errors).toEqual([]);
  });

  it('delivers a refusal too, so the runner is not left waiting', async () => {
    // "We said no" is an answer it is owed; a refusal that produced no task
    // would leave the lane silently empty.
    const ctx = setup({ decide: { kind: 'refuse', reason: 'not this operation' } });
    const { id, claimId } = enqueueClaim(ctx);
    ctx.service.complete(id, proposal(), 'proposing', RUNNER_DID, claimId);
    await settle();
    const followUp = ctx.repository.listNonTerminalByRunner(pluginLane(INSTALL))[0];
    expect(parsePluginEnvelope(followUp?.payload ?? '')?.host_operation).toMatchObject({
      state: 'refused',
      detail: 'not this operation',
    });
  });

  it('parks a card decision and delivers nothing until the owner answers', async () => {
    const ctx = setup({ decide: { kind: 'approval', reason: 'the owner decides' } });
    const { id, claimId } = enqueueClaim(ctx);
    ctx.service.complete(id, proposal(), 'proposing', RUNNER_DID, claimId);
    await settle();
    expect(ctx.repository.listNonTerminalByRunner(pluginLane(INSTALL))).toEqual([]);

    // The owner approves; the SAME follow-up path runs, so the runner cannot
    // tell whether a human was involved.
    const parked = ctx.broker.get(
      ctx.broker.listExecuting()[0]?.proposalId ?? findProposalId(ctx),
    );
    const source = parsePluginEnvelope(ctx.repository.getById(id)?.payload ?? '');
    if (parked === null || source === null) throw new Error('unreachable');
    await settleOwnerDecision({
      proposalId: parked.proposalId,
      approved: true,
      source,
      install: ctx.install,
      broker: ctx.broker,
      dispatcher: ctx.dispatcher,
      workflow: ctx.service,
    });
    const followUp = ctx.repository.listNonTerminalByRunner(pluginLane(INSTALL))[0];
    expect(parsePluginEnvelope(followUp?.payload ?? '')?.host_operation).toMatchObject({
      state: 'completed',
    });
  });

  it('does not reach the handler for a NON-plugin task at all', async () => {
    // The seam sits on every completion, so the overwhelmingly common case is
    // a task that is not a plugin task. A mutation that read the envelope
    // check as `undefined` rather than `null` survived until this existed:
    // nothing completed an ordinary delegation through a service that had a
    // handler installed.
    const ctx = setup();
    let called = 0;
    const service = new WorkflowService({
      repository: ctx.repository,
      pluginCompletionHandler: async () => {
        called += 1;
      },
    });
    const task = service.create({
      id: 'plain-1',
      kind: 'delegation',
      description: 'an ordinary delegation',
      payload: JSON.stringify({ type: 'not_a_plugin_invocation' }),
      expiresAtSec: Math.floor(Date.now() / 1000) + 600,
      idempotencyKey: 'plain-1',
      initialState: 'queued' as never,
    } as never);
    const claimed = ctx.repository.claimDelegationTask(RUNNER_DID, Date.now(), 60_000, undefined);
    expect(claimed?.id).toBe(task.id);
    service.complete(task.id, proposal(), 'even a proposal-shaped result', RUNNER_DID);
    await settle();
    expect(called).toBe(0);
  });

  it('never lets a broker failure unwind a completion that already landed', async () => {
    const ctx = setup();
    const { id, claimId } = enqueueClaim(ctx);
    // No install: the handler reports and returns; the completion stands.
    const service = new WorkflowService({
      repository: ctx.repository,
      pluginCompletionHandler: makePluginCompletionHandler({
        broker: () => ctx.broker,
        dispatcher: () => ctx.dispatcher,
        registry: () => ctx.registry,
        installs: () => ({ getById: () => null }),
        workflow: () => null,
        decide: () => ({ kind: 'permit' }),
        onError: (e) => ctx.errors.push(e),
      }),
    });
    expect(() => service.complete(id, proposal(), 'proposing', RUNNER_DID, claimId)).not.toThrow();
    await settle();
    expect(ctx.repository.getById(id)?.status).toBe('completed');
    expect(ctx.errors).toHaveLength(1);
  });

  it('is a quiet no-op on a node with no host-operation plane', async () => {
    const ctx = setup();
    const { id, claimId } = enqueueClaim(ctx);
    const service = new WorkflowService({
      repository: ctx.repository,
      pluginCompletionHandler: makePluginCompletionHandler({
        broker: () => null,
        dispatcher: () => null,
        registry: () => null,
        installs: () => null,
        workflow: () => null,
        decide: () => ({ kind: 'permit' }),
        onError: (e) => ctx.errors.push(e),
      }),
    });
    service.complete(id, proposal(), 'proposing', RUNNER_DID, claimId);
    await settle();
    // Reported, because a runner is now waiting on something that will not
    // come — a node with no plane must not look like one that refused.
    expect(ctx.errors).toHaveLength(1);
  });
});

/** The proposal id, read back from the table when nothing is executing. */
function findProposalId(ctx: ReturnType<typeof setup>): string {
  const rows = ctx.db.query(
    "SELECT proposal_id FROM plugin_extension_proposals WHERE state = 'proposed'",
    [],
  );
  if (rows.length === 0) throw new Error('no parked proposal');
  return String((rows[0] as Record<string, unknown>).proposal_id);
}
