/**
 * Provider-ingress bridge (§11.2a, CMC-5): inbound service query →
 * plugin task on the install's lane → provider-kind claim → completion
 * → response bridge answers the querying peer. Plus every typed
 * unavailable path and the kind-separation rules.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { pluginLane, type PluginManifest } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  InMemoryCommerceOrderRefRepository,
} from '../../src/commerce/order_refs';
import {
  CommerceOrderStore,
  installCommerceRuntime,
  type CommerceRuntime,
} from '../../src/commerce';
import { claimPluginTask } from '../../src/plugins/claim_guard';
import { buildPluginEnvelope } from '../../src/plugins/dispatch';
import { createProviderIngressTask } from '../../src/plugins/provider_ingress';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
} from '../../src/plugins/registry';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { parsePluginEnvelope } from '../../src/workflow/plugin_envelope';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, type ServiceQueryBridgeContext } from '../../src/workflow/service';

const CAP = 'com.acme.commerce.request_quote';
const PLUGIN_DID = 'did:plc:plugindevice';
const BUYER_DID = 'did:plc:buyer1234';
const T0 = 1_700_000_000_000;

const RESULT_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

function makeManifest(kinds: string[]): PluginManifest {
  return {
    $type: 'com.dinakernel.plugin.release',
    plugin_id: 'com.acme.commerce.supplier',
    version: '0.1.0',
    display_name: 'Supplier',
    execution: { mode: 'runner' },
    capabilities: [
      {
        id: CAP,
        display_name: 'Request quote',
        interaction: 'query',
        action_class: 'quote',
        privacy_class: 'personal',
        kinds,
        result_schema: RESULT_SCHEMA,
      },
    ],
  } as unknown as PluginManifest;
}

describe('provider ingress bridge (§11.2a)', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  let installs: SQLitePluginInstallRepository;
  let workflowRepo: InMemoryWorkflowRepository;
  let workflow: WorkflowService;
  let bridged: ServiceQueryBridgeContext[];
  let installId: string;

  function seedInstall(kinds: string[], deviceDid = PLUGIN_DID): string {
    const id = installs.createPending({
      publisherDid: 'did:plc:acme',
      pluginId: 'com.acme.commerce.supplier',
      label: '',
      executionMode: 'runner',
      currentCid: 'bafyreicid1',
      currentVersion: '0.1.0',
      manifest: makeManifest(kinds),
      installScopeHash: 's'.repeat(64),
      capabilityHashes: { [CAP]: 'h'.repeat(64) },
      behaviorHash: 'b'.repeat(64),
      presentationHash: 'p'.repeat(64),
      trustAnchor: { kind: 'repo_proof' },
      pendingExpiresAtSec: Math.floor(T0 / 1000) + 900,
      nowMs: T0,
    });
    installs.activate(id, deviceDid, T0);
    return id;
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cmc5-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    installs = new SQLitePluginInstallRepository(adapter);
    setPluginInstallRepository(installs);

    workflowRepo = new InMemoryWorkflowRepository();
    bridged = [];
    workflow = new WorkflowService({
      repository: workflowRepo,
      nowMsFn: () => T0,
      responseBridgeSender: async (ctx) => {
        bridged.push(ctx);
      },
    });
    installId = seedInstall(['provider']);
  });

  afterEach(() => {
    setPluginInstallRepository(null);
    try {
      adapter.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function binding(overrides: Record<string, string> = {}) {
    return {
      pluginInstallId: installId,
      pluginManifestCid: 'bafyreicid1',
      pluginCapabilityId: CAP,
      ...overrides,
    };
  }

  function query(queryId = 'q-100') {
    return {
      fromDid: BUYER_DID,
      queryId,
      capability: 'request_quote',
      serviceRkey: 'self',
      params: { productRef: 'gtin:09506000134352' },
      ttlSeconds: 120,
      serviceName: 'acme-dairy',
      schemaSnapshot: {
        params: { type: 'object' } as Record<string, unknown>,
        result: RESULT_SCHEMA as unknown as Record<string, unknown>,
        schema_hash: 'a'.repeat(64),
      },
    };
  }

  it('runs the full loop: task on the lane, provider claim, completion, bridge', async () => {
    const created = createProviderIngressTask({
      workflow,
      capabilityConfig: binding(),
      query: query(),
      nowMs: T0,
    });
    // The id is a sender+install-scoped digest, not a concatenation of
    // peer-supplied values (see the cross-peer test below).
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('ingress task not created');
    expect(created.taskId).toMatch(/^svcq:[0-9a-f]{32}$/);

    // The task rides the install's exact lane with the ingress envelope.
    const install = installs.getById(installId);
    if (!install) throw new Error('install missing');
    const claim = claimPluginTask({
      repo: workflowRepo,
      install,
      deviceDid: PLUGIN_DID,
      nowMs: T0 + 1000,
      leaseMs: 60_000,
    });
    expect(claim.terminalized).toEqual([]);
    const claimed = claim.task;
    if (!claimed) throw new Error('claim returned no task');
    expect(claimed.requested_runner).toBe(pluginLane(installId));

    // Runner completes; the response bridge answers the peer.
    workflow.complete(
      claimed.id,
      JSON.stringify({ answer: 'quote attached' }),
      'answered',
      PLUGIN_DID,
      claimed.claim_id,
    );
    await workflow.flushBridgeInFlight();
    expect(bridged).toHaveLength(1);
    expect(bridged[0]).toMatchObject({
      fromDID: BUYER_DID,
      queryId: 'q-100',
      capability: 'request_quote',
      serviceName: 'acme-dairy',
      resultJSON: JSON.stringify({ answer: 'quote attached' }),
    });
    expect(bridged[0]?.schemaSnapshot?.schema_hash).toBe('a'.repeat(64));
  });

  it('two peers reusing the same query_id do NOT collide (§11.2a sender scoping)', () => {
    // query_id is a peer-CHOSEN body field. An unscoped dedup key would
    // let peer B's query silently vanish into peer A's task — answered
    // to the wrong from_did, or pre-registered by a hostile peer to deny
    // service to a competitor on the same supplier node.
    const first = createProviderIngressTask({
      workflow,
      capabilityConfig: binding(),
      query: { ...query('shared-id'), fromDid: BUYER_DID },
      nowMs: T0,
    });
    const second = createProviderIngressTask({
      workflow,
      capabilityConfig: binding(),
      query: { ...query('shared-id'), fromDid: 'did:plc:otherbuyer' },
      nowMs: T0,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('both peers must get a task');
    expect(second.taskId).not.toBe(first.taskId);

    // Each task answers ITS OWN peer.
    const firstTask = workflowRepo.getById(first.taskId);
    const secondTask = workflowRepo.getById(second.taskId);
    const ingressOf = (payload: string | undefined) =>
      payload === undefined ? undefined : parsePluginEnvelope(payload)?.service_ingress;
    expect(ingressOf(firstTask?.payload)?.from_did).toBe(BUYER_DID);
    expect(ingressOf(secondTask?.payload)?.from_did).toBe('did:plc:otherbuyer');
  });

  it('a replayed query dedups onto the same task', () => {
    const first = createProviderIngressTask({
      workflow,
      capabilityConfig: binding(),
      query: query('q-dup'),
      nowMs: T0,
    });
    const replay = createProviderIngressTask({
      workflow,
      capabilityConfig: binding(),
      query: query('q-dup'),
      nowMs: T0 + 5,
    });
    expect(first.ok && replay.ok).toBe(true);
    if (first.ok && replay.ok) expect(replay.taskId).toBe(first.taskId);
  });

  it('answers typed-unavailable for missing/paused installs and stale bindings', () => {
    const missing = createProviderIngressTask({
      workflow,
      capabilityConfig: binding({ pluginInstallId: 'inst-nope' }),
      query: query('q-1'),
      nowMs: T0,
    });
    expect(!missing.ok && missing.code).toBe('install_unavailable');

    installs.pause(installId, T0 + 1, 'manual');
    const paused = createProviderIngressTask({
      workflow,
      capabilityConfig: binding(),
      query: query('q-2'),
      nowMs: T0,
    });
    expect(!paused.ok && paused.code).toBe('install_unavailable');
    installs.resume(installId, T0 + 2);

    const stale = createProviderIngressTask({
      workflow,
      capabilityConfig: binding({ pluginManifestCid: 'bafyreiother' }),
      query: query('q-3'),
      nowMs: T0,
    });
    expect(!stale.ok && stale.code).toBe('binding_stale');

    const partial = createProviderIngressTask({
      workflow,
      capabilityConfig: { pluginInstallId: installId },
      query: query('q-4'),
      nowMs: T0,
    });
    expect(!partial.ok && partial.code).toBe('no_plugin_binding');
  });

  it('refuses a capability not consented as provider', () => {
    setPluginInstallRepository(null);
    setPluginInstallRepository(installs);
    const toolOnly = seedInstall(['tool'], 'did:plc:plugindevice2');
    const result = createProviderIngressTask({
      workflow,
      capabilityConfig: binding({ pluginInstallId: toolOnly }),
      query: query('q-5'),
      nowMs: T0,
    });
    expect(!result.ok && result.code).toBe('capability_not_provider');
  });

  it('claim guard: an ingress envelope terminalizes on a tool-only consent', () => {
    const toolOnlyId = seedInstall(['tool'], 'did:plc:plugindevice2');
    const toolOnly = installs.getById(toolOnlyId);
    if (!toolOnly) throw new Error('install missing');
    // Craft the ingress envelope directly (a faulty producer): the
    // capability exists in the manifest but is consented as TOOL only.
    const envelope = buildPluginEnvelope({
      install: toolOnly,
      capabilityId: CAP,
      params: { productRef: 'x' },
      context: [],
      executionId: 'svcq:q-neg',
      idempotencyKey: 'svcq:q-neg',
      serviceIngress: {
        from_did: BUYER_DID,
        query_id: 'q-neg',
        capability: 'request_quote',
        service_rkey: 'self',
      },
    });
    workflow.create({
      id: 'task-neg-1',
      kind: 'delegation',
      description: 'crafted ingress on tool-only consent',
      payload: JSON.stringify(envelope),
      idempotencyKey: envelope.idempotency_key,
      initialState: 'queued' as never,
      requestedRunner: pluginLane(toolOnlyId),
    });
    const claim = claimPluginTask({
      repo: workflowRepo,
      install: toolOnly,
      deviceDid: 'did:plc:plugindevice2',
      nowMs: T0 + 1000,
      leaseMs: 60_000,
    });
    expect(claim.task).toBeNull();
    expect(claim.terminalized).toEqual(['task-neg-1']);
  });

  it('claim guard: a plain tool envelope terminalizes on a provider-only consent', () => {
    const providerOnly = installs.getById(installId);
    if (!providerOnly) throw new Error('install missing');
    const envelope = buildPluginEnvelope({
      install: providerOnly,
      capabilityId: CAP,
      params: { productRef: 'x' },
      context: [],
      executionId: 'exec-tool-1',
      idempotencyKey: 'exec-tool-1',
    });
    workflow.create({
      id: 'task-neg-2',
      kind: 'delegation',
      description: 'tool dispatch on provider-only consent',
      payload: JSON.stringify(envelope),
      idempotencyKey: envelope.idempotency_key,
      initialState: 'queued' as never,
      requestedRunner: pluginLane(installId),
    });
    const claim = claimPluginTask({
      repo: workflowRepo,
      install: providerOnly,
      deviceDid: PLUGIN_DID,
      nowMs: T0 + 1000,
      leaseMs: 60_000,
    });
    expect(claim.task).toBeNull();
    expect(claim.terminalized).toEqual(['task-neg-2']);
  });

  /**
   * §11.2 subject authorization. Before this gate existed, ANY peer
   * could name ANY purchase_order_id on an order-scoped capability and
   * have it dispatched to the supplier's runner — the bridge checked
   * only the plugin binding, and used from_did for correlation alone.
   * That leaks order state to strangers and lets them drive
   * cancel_order against orders they do not own.
   */
  describe('order-subject authorization (§11.2)', () => {
    const OTHER_BUYER = 'did:plc:stranger99';
    const PO = 'po-owned-by-buyer';

    function orderQuery(capability: string, fromDid: string, poId: string = PO) {
      return { ...query(`q-${capability}-${fromDid}`), capability, fromDid, params: { purchase_order_id: poId } };
    }

    beforeEach(() => {
      const orders = new InMemoryCommerceOrderRefRepository();
      orders.createReserved({
        buyerDid: BUYER_DID,
        purchaseOrderId: PO,
        idempotencyKey: 'idem-1',
        orderDigest: 'd'.repeat(64),
        quoteId: 'q-1',
        quoteDigest: 'e'.repeat(64),
        pinnedMajor: '1',
      admittedEpoch: '1',
      reconciliationRequired: false,
        decisionDeadlineAt: T0 + 60_000,
        createdAt: T0,
      });
      installCommerceRuntime({
        orders: new CommerceOrderStore({ refs: orders, now: () => Date.now() }),
      } as unknown as CommerceRuntime);
    });

    afterEach(() => installCommerceRuntime(null));

    it.each(['order_status', 'order_reconcile', 'cancel_order'])(
      'denies %s from a peer who does not own the order',
      (capability) => {
        const q = orderQuery(capability, OTHER_BUYER);
        const result = createProviderIngressTask({
          workflow,
          capabilityConfig: binding(),
          query: q,
          nowMs: T0,
        });
        expect(result.ok).toBe(false);
        expect(!result.ok && result.code).toBe('order_subject_denied');
        // Nothing reached the runner lane: the ingress task correlates
        // on the query id, so no task under it means no dispatch.
        expect(workflow.store().getByCorrelationId(q.queryId)).toEqual([]);
      },
    );

    it('admits the same capability for the order OWNER', () => {
      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: orderQuery('order_status', BUYER_DID),
        nowMs: T0,
      });
      expect(result.ok).toBe(true);
    });

    it('gives ONE non-disclosing answer for unknown, unowned, and missing ids', () => {
      const unknown = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: orderQuery('order_status', BUYER_DID, 'po-does-not-exist'),
        nowMs: T0,
      });
      const unowned = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: orderQuery('order_status', OTHER_BUYER),
        nowMs: T0,
      });
      const missing = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: { ...query('q-missing'), capability: 'order_status', params: {} },
        nowMs: T0,
      });
      // Identical code AND identical message: the error must not become
      // an oracle for enumerating which order ids this supplier holds.
      for (const r of [unknown, unowned, missing]) {
        expect(r.ok).toBe(false);
        expect(!r.ok && r.code).toBe('order_subject_denied');
      }
      const messages = new Set(
        [unknown, unowned, missing].map((r) => (!r.ok ? r.error : 'ok')),
      );
      expect(messages.size).toBe(1);
    });

    it('fails CLOSED when no order store is wired', () => {
      installCommerceRuntime(null);
      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: orderQuery('order_status', BUYER_DID),
        nowMs: T0,
      });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe('order_subject_denied');
    });

    it('leaves non-order capabilities ungated', () => {
      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: query('q-unrelated'),
        nowMs: T0,
      });
      expect(result.ok).toBe(true);
    });
  });

});
