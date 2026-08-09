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
  CommerceOrderStore,
  installCommerceRuntime,
  type CommerceRuntime,
} from '../../src/commerce';
import { InMemoryCommerceOrderRefRepository } from '../../src/commerce/order_refs';
import { InMemoryCommerceSettingsRepository } from '../../src/commerce/settings_store';
import { installQuoteAttemptLedger, QuoteAttemptLedger } from '../../src/commerce/probing_ledger';
import { DEFAULT_PROBING_POLICY } from '../../src/commerce/probing_resistance';
import { claimPluginTask } from '../../src/plugins/claim_guard';
import { buildPluginEnvelope } from '../../src/plugins/dispatch';
import {
  SQLiteDrainAuthorizationRepository,
  setDrainAuthorizationRepository,
} from '../../src/plugins/drain_authorizations';
import {
  createProviderIngressTask,
  type ProviderIngressResult,
} from '../../src/plugins/provider_ingress';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
} from '../../src/plugins/registry';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { parsePluginEnvelope } from '../../src/workflow/plugin_envelope';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { makeServiceResponseBridgeSender } from '../../src/workflow/response_bridge_sender';
import { WorkflowService, type ServiceQueryBridgeContext } from '../../src/workflow/service';

/**
 * Name which success a test expects. Since WS-4.6 there are two: a task was
 * dispatched to a runner, or compiled Core answered and no runner was asked.
 * Reading `.taskId` off the union no longer compiles, which is the point —
 * "a task exists" and "an answer exists" are different claims about what
 * happened, and a test that means the first must say so.
 */
function dispatchedTaskId(outcome: ProviderIngressResult): string {
  if (!outcome.ok) throw new Error(`ingress refused: ${outcome.code}`);
  if (!('taskId' in outcome)) throw new Error('Core answered; no task was dispatched');
  return outcome.taskId;
}

/** What Core's reconcile was asked, recorded by the stub runtimes below. */
let reconcileCalls: { params: unknown; buyerDid: string }[] = [];

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
    // §20.10 — the probing window. Production installs it with the commerce
    // runtime; an unwired ledger fails CLOSED, so without this every pricing
    // capability in this file refuses. Installed here so the tests exercise
    // the same posture a booted node has.
    installQuoteAttemptLedger(new QuoteAttemptLedger(DEFAULT_PROBING_POLICY.windowMs));
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
    installQuoteAttemptLedger(null);
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

  /**
   * §9.9 / §11.2 — THE GATES MUST NOT DEPEND ON HOW A CAPABILITY IS SPELLED.
   *
   * The listing key is free-form, and the reference manifests spell their
   * capability ids with HYPHENS (`com.dinakernel.commerce.submit-order`), which
   * is the natural thing for a supplier to publish under. The gates used to
   * match hand-listed spellings that omitted that form, so a CONFORMING
   * supplier could create an order with no admission at all and expose
   * `order_status` / `cancel_order` with no subject authorization — any peer
   * reading or cancelling another buyer's order.
   *
   * Driven under every spelling a real listing could carry, and the
   * order-scoped ones must be REFUSED for a sender with no such order.
   */
  it.each([
    ['bare', 'order_status'],
    ['underscore NSID', 'com.dinakernel.commerce.order_status'],
    ['hyphen NSID, as the manifests spell it', 'com.dinakernel.commerce.order-status'],
    ['bare cancel', 'cancel_order'],
    ['hyphen NSID cancel', 'com.dinakernel.commerce.cancel-order'],
  ])('gates an order-scoped capability spelled as %s', (_name, capability) => {
    const created = createProviderIngressTask({
      workflow,
      capabilityConfig: binding(),
      query: { ...query('q-spelling'), capability, params: {} },
      nowMs: T0,
    });
    expect(created).toMatchObject({ ok: false, code: 'order_subject_denied' });
  });

  it('gates an order-scoped capability the listing published under a LOCAL name', () => {
    // The wire key is whatever the supplier called their listing. The bound
    // manifest capability is what the owner consented to, and either naming a
    // gated commerce capability must gate the call — over-gating costs a
    // needless check, under-gating is the defect above.
    const created = createProviderIngressTask({
      workflow,
      capabilityConfig: binding({ pluginCapabilityId: 'com.dinakernel.commerce.cancel-order' }),
      query: { ...query('q-local-name'), capability: 'chairs-cancel', params: {} },
      nowMs: T0,
    });
    expect(created).toMatchObject({ ok: false, code: 'order_subject_denied' });
  });

  it('runs the full loop: task on the lane, provider claim, completion, bridge', async () => {
    const created = createProviderIngressTask({
      workflow,
      capabilityConfig: binding(),
      query: query(),
      nowMs: T0,
    });
    // The id is a sender+install-scoped digest, not a concatenation of
    // peer-supplied values (see the cross-peer test below).
    expect(dispatchedTaskId(created)).toMatch(/^svcq:[0-9a-f]{32}$/);

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

  /**
   * The loop above stops at the bridge CONTEXT, because the harness stubs
   * `responseBridgeSender`. That proves the correlation survives the plugin
   * lane, and nothing about what the peer actually receives — so the half of
   * §11.2a step 4 that matters to a buyer (a `service.response` whose result
   * was checked against the schema the buyer was shown) went unexercised.
   *
   * These drive the REAL sender.
   */
  describe('completion → service.response (§11.2a step 4)', () => {
    let sent: { to: string; body: Record<string, unknown> }[];

    function withRealBridge(): WorkflowService {
      sent = [];
      return new WorkflowService({
        repository: workflowRepo,
        nowMsFn: () => T0,
        responseBridgeSender: makeServiceResponseBridgeSender({
          sendResponse: async (to, body) => {
            sent.push({ to, body: body as unknown as Record<string, unknown> });
          },
          // The bootstrap injects the validator so Core carries no schema
          // library. A bridge wired WITHOUT it silently forwards drift.
          validateResult: (value, schema) => {
            const shape = schema as { required?: string[]; additionalProperties?: boolean };
            if (value === null || typeof value !== 'object') return 'result must be an object';
            const record = value as Record<string, unknown>;
            for (const key of shape.required ?? []) {
              if (!(key in record)) return `missing required property "${key}"`;
            }
            if (shape.additionalProperties === false) {
              const allowed = new Set(
                Object.keys((schema as { properties?: Record<string, unknown> }).properties ?? {}),
              );
              for (const key of Object.keys(record)) {
                if (!allowed.has(key)) return `unexpected property "${key}"`;
              }
            }
            return null;
          },
        }),
      });
    }

    /** Create the ingress task, claim it, and finish it with `result`. */
    async function runToCompletion(service: WorkflowService, result: string): Promise<void> {
      const created = createProviderIngressTask({
        workflow: service,
        capabilityConfig: binding(),
        query: query(),
        nowMs: T0,
      });
      if (!created.ok) throw new Error(`ingress task not created: ${created.code}`);
      const install = installs.getById(installId);
      if (!install) throw new Error('install missing');
      const claim = claimPluginTask({
        repo: workflowRepo,
        install,
        deviceDid: PLUGIN_DID,
        nowMs: T0 + 1000,
        leaseMs: 60_000,
      });
      const claimed = claim.task;
      if (!claimed) throw new Error('claim returned no task');
      service.complete(claimed.id, result, 'answered', PLUGIN_DID, claimed.claim_id);
      await service.flushBridgeInFlight();
    }

    it('answers the BUYER, correlated to its own query', async () => {
      const service = withRealBridge();
      await runToCompletion(service, JSON.stringify({ answer: 'quote attached' }));

      expect(sent).toHaveLength(1);
      // Addressed to the authenticated requester, not to the runner and not
      // broadcast: the plugin never learns who else this node serves.
      expect(sent[0]?.to).toBe(BUYER_DID);
      expect(sent[0]?.body).toMatchObject({
        query_id: 'q-100',
        capability: 'request_quote',
        status: 'success',
        result: { answer: 'quote attached' },
      });
    });

    it('refuses to forward a result the PINNED schema rejects', async () => {
      // The buyer chose this supplier against a published schema hash. A
      // runner that drifts must not have its drift relayed as a success —
      // the buyer would parse a shape it never agreed to.
      const service = withRealBridge();
      await runToCompletion(service, JSON.stringify({ answer: 'ok', secret_margin: '0.42' }));

      expect(sent).toHaveLength(1);
      expect(sent[0]?.body).toMatchObject({ query_id: 'q-100', status: 'error' });
      expect(String(sent[0]?.body.error)).toContain('result_schema_violation');
      // The drifted payload itself never travels.
      expect(JSON.stringify(sent[0]?.body)).not.toContain('0.42');
    });

    it('a missing required field is a violation, not a partial success', async () => {
      const service = withRealBridge();
      await runToCompletion(service, JSON.stringify({ note: 'no answer field' }));

      expect(String(sent[0]?.body.error)).toContain('result_schema_violation');
      expect(sent[0]?.body.status).toBe('error');
    });

    it('unparseable runner output still answers, so the buyer stops waiting', async () => {
      // Silence here is the worst outcome: the buyer waits out its TTL and
      // cannot tell a broken supplier from a slow one.
      const service = withRealBridge();
      await runToCompletion(service, 'not json at all');

      expect(sent).toHaveLength(1);
      expect(sent[0]?.body.status).toBe('error');
      expect(String(sent[0]?.body.error)).toContain('malformed_result');
    });

    it('forwards an explicit unavailable verbatim rather than faking success', async () => {
      const service = withRealBridge();
      await runToCompletion(
        service,
        JSON.stringify({ status: 'unavailable', error: 'out_of_stock' }),
      );

      expect(sent[0]?.body).toMatchObject({ status: 'unavailable', error: 'out_of_stock' });
    });
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
    const firstId = dispatchedTaskId(first);
    const secondId = dispatchedTaskId(second);
    expect(secondId).not.toBe(firstId);

    // Each task answers ITS OWN peer.
    const firstTask = workflowRepo.getById(firstId);
    const secondTask = workflowRepo.getById(secondId);
    const ingressOf = (payload: string | undefined) =>
      payload === undefined ? undefined : parsePluginEnvelope(payload)?.service_ingress;
    expect(ingressOf(firstTask?.payload)?.from_did).toBe(BUYER_DID);
    expect(ingressOf(secondTask?.payload)?.from_did).toBe('did:plc:otherbuyer');
  });

  it('two CAPABILITIES with the same params do NOT collide', () => {
    // Commerce uses the purchase order id as the correlation id on every lane,
    // deliberately — two dispatches about one order must not look like two
    // questions. But "will you take this order" and "where has it got to" ARE
    // two questions, and with the capability out of the dedup key the second
    // collided with the first: a buyer's `order_status` was refused
    // `ingress_key_conflict` for ever and the status lane never ran.
    //
    // Params alone do not cover this. Two order-scoped reads can take
    // literally the same body, which is why this is its own dimension and its
    // own test rather than something the params hash happens to catch.
    const first = createProviderIngressTask({
      workflow,
      capabilityConfig: binding(),
      query: { ...query('same-order'), capability: 'request_quote' },
      nowMs: T0,
    });
    const second = createProviderIngressTask({
      workflow,
      capabilityConfig: binding(),
      // A second WIRE capability on the same binding. Deliberately not
      // `order_status`: that one routes into the commerce lifecycle lane and
      // is refused here for want of an order, which would make this test
      // about admission rather than about the dedup key.
      query: { ...query('same-order'), capability: 'price_check' },
      nowMs: T0,
    });
    expect(dispatchedTaskId(second)).not.toBe(dispatchedTaskId(first));
  });

  it('the same question asked with DIFFERENT params does not collide', () => {
    // A status poll carries the buyer's position in the chain. Two polls are
    // two questions, and an idempotency key that ignores the body answers the
    // second by replaying the first — so a buyer that polled twice was told
    // once and then silently never again.
    const first = createProviderIngressTask({
      workflow,
      capabilityConfig: binding(),
      query: { ...query('same-order'), params: { purchase_order_id: 'po-1' } },
      nowMs: T0,
    });
    const second = createProviderIngressTask({
      workflow,
      capabilityConfig: binding(),
      query: {
        ...query('same-order'),
        params: { purchase_order_id: 'po-1', since_sequence: '1' },
      },
      nowMs: T0,
    });
    expect(dispatchedTaskId(second)).not.toBe(dispatchedTaskId(first));
  });

  it('dedups a repeat whose params differ only in KEY ORDER', () => {
    // The other half of the params dimension: `{a,b}` and `{b,a}` are one
    // request, and hashing them differently would turn every retry into a new
    // task — the opposite failure, and the one that costs money on an
    // effectful lane.
    const first = createProviderIngressTask({
      workflow,
      capabilityConfig: binding(),
      query: { ...query('same-order'), params: { a: '1', b: '2' } },
      nowMs: T0,
    });
    const reordered = createProviderIngressTask({
      workflow,
      capabilityConfig: binding(),
      query: { ...query('same-order'), params: { b: '2', a: '1' } },
      nowMs: T0 + 5,
    });
    expect(dispatchedTaskId(reordered)).toBe(dispatchedTaskId(first));
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
    expect(dispatchedTaskId(replay)).toBe(dispatchedTaskId(first));
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
      return {
        ...query(`q-${capability}-${fromDid}`),
        capability,
        fromDid,
        params: { purchase_order_id: poId },
      };
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
        pinnedVersion: '1.0',
        servingManifestCid: '',
        servingInstallId: '',
        admittedEpoch: '1',
        reconciliationRequired: false,
        decisionDeadlineAt: T0 + 60_000,
        createdAt: T0,
      });
      reconcileCalls = [];
      installCommerceRuntime({
        // A double that omits a field the type promises is a lie the cast
        // hides. §18.3's listing policy is read on the quote path, so the
        // double carries a real (empty) settings store rather than leaving
        // production to guard against a shape only tests produce.
        settings: new InMemoryCommerceSettingsRepository(),
        orders: new CommerceOrderStore({ refs: orders, now: () => Date.now() }),
        // WS-4.6: reconcile is answered by Core, so the stub runtime has to
        // carry a lifecycle. Recording the arguments is the assertion that
        // matters — the buyer Core is told about must be the AUTHENTICATED
        // sender, never a field from the payload.
        lifecycle: {
          reconcile: (params: unknown, buyerDid: string) => {
            reconcileCalls.push({ params, buyerDid });
            return { outcome: 'never_received' };
          },
        },
      } as unknown as CommerceRuntime);
    });

    afterEach(() => installCommerceRuntime(null));

    /**
     * `order_reconcile` is NOT in this list, and its absence is the rule.
     *
     * Status and cancellation are entitlement-by-EXISTENCE: they act on an
     * order, so the sender must own one. Reconcile is entitlement-by-EVIDENCE
     * — it asks "do you have my order?", and for a peer who owns nothing the
     * honest answer is `never_received`, which the sibling test below pins.
     * Denying it would make §12.7's disaster-recovery path unanswerable
     * exactly when a buyer needs it.
     *
     * It sat in this list because the gate demanded a `buyer_did` the
     * protocol has never carried, so EVERY reconcile was denied and the
     * grouping looked right.
     */
    it.each(['order_status', 'cancel_order'])(
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

    it('ADMITS order_reconcile for an order this supplier has no record of (§12.7/§16.2)', () => {
      // The disaster-recovery case, and the one an earlier version of this
      // gate silently disabled. Reconcile exists to resolve outcome_unknown:
      // the buyer submitted an order and never learned whether it landed. The
      // case that matters most is the one where this supplier holds NO
      // reference — it crashed before the durable write, or restored a backup
      // taken before the order arrived. Requiring an existing reference makes
      // exactly that unanswerable.
      //
      // Absence is the ANSWER (never_received), not the denial.
      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: {
          ...query('q-reconcile-unknown'),
          capability: 'order_reconcile',
          fromDid: BUYER_DID,
          params: { purchase_order_id: 'po-never-arrived', buyer_did: BUYER_DID },
        },
        nowMs: T0,
      });
      // Core ANSWERED it — `never_received` is a real outcome, and no runner
      // was asked, because no runner could know.
      expect(result).toEqual({
        ok: true,
        coreAnswerJson: JSON.stringify({ outcome: 'never_received' }),
      });
      expect(workflow.store().getByCorrelationId('q-reconcile-unknown')).toEqual([]);
    });

    it('ADMITS a reconcile in the shape the BUYER actually sends', () => {
      // `OrderReconcileRequest` carries no `buyer_did` — the protocol type has
      // none and `buildReconcileRequest` sends none. The gate demanded one, so
      // every CONFORMING reconcile was denied, and the tests around it passed
      // because they invented the field.
      //
      // Built here from the real request fields rather than hand-shaped, so a
      // future field the buyer starts sending arrives through this test too.
      const request = {
        protocol_version: '1.0',
        purchase_order_id: 'po-conforming',
        order_digest: 'a'.repeat(64),
        idempotency_key: 'idem-1',
      };
      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: {
          ...query('q-reconcile-conforming'),
          capability: 'order_reconcile',
          fromDid: BUYER_DID,
          params: request,
        },
        nowMs: T0,
      });
      expect(result).toEqual({
        ok: true,
        coreAnswerJson: JSON.stringify({ outcome: 'never_received' }),
      });
      // And Core was told the AUTHENTICATED sender, not a body field.
      expect(reconcileCalls.at(-1)?.buyerDid).toBe(BUYER_DID);
    });

    it('still denies order_reconcile whose payload names a DIFFERENT buyer', () => {
      // Authorization without existence is not authorization without proof:
      // the buyer-bound payload must name the authenticated sender.
      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: {
          ...query('q-reconcile-spoof'),
          capability: 'order_reconcile',
          fromDid: OTHER_BUYER,
          params: { purchase_order_id: PO, buyer_did: BUYER_DID },
        },
        nowMs: T0,
      });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe('order_subject_denied');
    });

    /**
     * WS-4.6 — the reason reconcile must never reach a runner.
     *
     * `never_received` is the ONE outcome that authorizes the buyer to
     * resubmit, and §16.2 makes it illegal against a held supplier-signed
     * acknowledgement. A plugin able to answer could make this supplier
     * repudiate an order it signed, then be billed for the buyer's honest
     * resubmission. Every input to the real answer — the order reference, the
     * receipt store, this supplier's own signature — lives in Core.
     */
    it('answers reconcile from CORE and dispatches nothing to the runner', () => {
      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: {
          ...query('q-reconcile-core'),
          capability: 'order_reconcile',
          fromDid: BUYER_DID,
          params: { purchase_order_id: PO, buyer_did: BUYER_DID },
        },
        nowMs: T0,
      });
      expect(result.ok && 'coreAnswerJson' in result).toBe(true);
      expect(reconcileCalls).toHaveLength(1);
      expect(workflow.store().getByCorrelationId('q-reconcile-core')).toEqual([]);
    });

    it('answers under the buyer the GATE authorized', () => {
      // A mutation that read the payload's `buyer_did` here instead of the
      // authenticated sender SURVIVED this test, and no test could have
      // killed it: the gate above requires the two to be equal, so through
      // this entry point they are never distinguishable.
      //
      // The fix was structural rather than another assertion. The gate now
      // HANDS OVER the DID it authorized and the answer takes it as an
      // argument, so there is one value and no second read to get wrong.
      // What this test pins is that the handover happens at all.
      createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: {
          ...query('q-reconcile-auth'),
          capability: 'order_reconcile',
          fromDid: BUYER_DID,
          params: { purchase_order_id: PO, buyer_did: BUYER_DID },
        },
        nowMs: T0,
      });
      expect(reconcileCalls[0]?.buyerDid).toBe(BUYER_DID);
    });

    it('answers nobody when a capability joins the Core-answered set with no gate branch', () => {
      // `authorizedBuyerDid` is set only on the self-authorizing branch. A
      // capability added to ANSWERED_BY_CORE without a matching gate branch
      // would otherwise be answered under whatever DID happened to be handy.
      // Here `order_status` takes the existence branch, which authorizes but
      // hands over no buyer — so a hypothetical addition refuses.
      const subject = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: orderQuery('order_status', BUYER_DID),
        nowMs: T0,
      });
      // It dispatches today because it is NOT in the set; the guarantee is
      // that the gate gave it no buyer to be answered under.
      expect(subject.ok && 'taskId' in subject).toBe(true);
      expect(reconcileCalls).toHaveLength(0);
    });

    it('answers reconcile even when the plugin binding is missing entirely', () => {
      // Reconcile is the disaster-recovery path. A supplier whose plugin was
      // paused, updated, or uninstalled must still answer for orders it
      // holds — gating it behind an install makes the lane go dark exactly
      // when it is needed.
      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: { pluginInstallId: '', pluginManifestCid: '', pluginCapabilityId: '' },
        query: {
          ...query('q-reconcile-nobinding'),
          capability: 'order_reconcile',
          fromDid: BUYER_DID,
          params: { purchase_order_id: PO, buyer_did: BUYER_DID },
        },
        nowMs: T0,
      });
      expect(result.ok && 'coreAnswerJson' in result).toBe(true);
    });

    it('refuses reconcile rather than dispatching it when commerce is unavailable', () => {
      // The failure that must NOT be "ask the runner instead". With no
      // runtime there is no record to answer from, and the answer a runner
      // would invent is the one that authorizes resubmission.
      installCommerceRuntime(null);
      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: {
          ...query('q-reconcile-noruntime'),
          capability: 'order_reconcile',
          fromDid: BUYER_DID,
          params: { purchase_order_id: PO, buyer_did: BUYER_DID },
        },
        nowMs: T0,
      });
      expect(result.ok).toBe(false);
      expect(workflow.store().getByCorrelationId('q-reconcile-noruntime')).toEqual([]);
    });

    it('order_status for an unknown order stays DENIED, so absence is not an oracle', () => {
      // The contrast that makes the split safe. Reconcile is answerable
      // without a reference; status is not — it would turn "does this order
      // exist" into a question a stranger can ask.
      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: orderQuery('order_status', BUYER_DID, 'po-never-arrived'),
        nowMs: T0,
      });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe('order_subject_denied');
    });

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
      const messages = new Set([unknown, unowned, missing].map((r) => (!r.ok ? r.error : 'ok')));
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

  /**
   * §9.9 — the submit_order wire path: Core admits BEFORE the runner is asked.
   *
   * This is the seam that makes §9.13 real in production. Until it existed the
   * order reference was only ever written by tests, so `serving_manifest_cid`
   * was always empty and no lifecycle request could ever route to a prior
   * manifest. It also draws the authority line: idempotency, quote capacity and
   * the reservation are Core's; whether to take the business is the plugin's.
   */
  describe('order admission before dispatch (§9.9)', () => {
    let admitted: { params: unknown; buyer: string; ctx?: { servingManifestCid?: string } }[];
    let outcome: { kind: string; retryAfterSeconds?: number; error?: string };

    function submitQuery() {
      return {
        ...query('q-submit'),
        capability: 'submit_order',
        params: { purchase_order_id: 'po-new-1', buyer_did: BUYER_DID },
      };
    }

    function installRuntime(): void {
      installCommerceRuntime({
        // A double that omits a field the type promises is a lie the cast
        // hides. §18.3's listing policy is read on the quote path, so the
        // double carries a real (empty) settings store rather than leaving
        // production to guard against a shape only tests produce.
        settings: new InMemoryCommerceSettingsRepository(),
        admission: {
          admitOrder: (params: unknown, buyer: string, ctx?: { servingManifestCid?: string }) => {
            admitted.push({ params, buyer, ...(ctx === undefined ? {} : { ctx }) });
            return outcome;
          },
        },
      } as unknown as CommerceRuntime);
    }

    beforeEach(() => {
      admitted = [];
      outcome = { kind: 'reserved' };
    });

    afterEach(() => installCommerceRuntime(null));

    it('admits under the SERVING manifest, then dispatches to the runner', () => {
      installRuntime();

      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: submitQuery(),
        nowMs: T0,
      });

      expect(result.ok).toBe(true);
      expect(admitted).toHaveLength(1);
      expect(admitted[0].buyer).toBe(BUYER_DID);
      // The install's CURRENT manifest is what served this order — the value
      // §9.13 later routes lifecycle requests by.
      // BOTH identifiers. §9.13 routes lifecycle requests by the manifest;
      // §16.4 scopes an uninstall's obligation count by the install, and a
      // plugin update moves the first while keeping the second.
      expect(admitted[0].ctx).toEqual({
        servingManifestCid: 'bafyreicid1',
        servingInstallId: expect.stringMatching(/^pli_/) as unknown as string,
      });
      expect(workflow.store().getByCorrelationId('q-submit')).toHaveLength(1);
    });

    it('fails closed when this node cannot admit orders at all', () => {
      // No commerce runtime. Dispatching anyway would let the plugin accept an
      // order Core never reserved.
      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: submitQuery(),
        nowMs: T0,
      });

      expect(!result.ok && result.code).toBe('commerce_unavailable');
      expect(workflow.store().getByCorrelationId('q-submit')).toEqual([]);
    });

    it.each([
      ['processing', { kind: 'processing', retryAfterSeconds: 5 }, 'order_processing'],
      ['conflict', { kind: 'conflict', error: 'keys cannot alias' }, 'order_conflict'],
    ])('does not dispatch, and has no record to give, when admission answers %s', (
      _label,
      admissionOutcome,
      code,
    ) => {
      // These two genuinely have nothing signed to return: `processing` means
      // the answer does not exist YET, `conflict` means the request cannot be
      // admitted at all. A typed refusal is the honest reply.
      outcome = admissionOutcome as typeof outcome;
      installRuntime();

      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: submitQuery(),
        nowMs: T0,
      });

      expect(!result.ok && result.code).toBe(code);
      expect(workflow.store().getByCorrelationId('q-submit')).toEqual([]);
    });

    it.each([
      ['replay', 'accepted'],
      ['rejected', 'rejected'],
    ])('RETURNS the recorded acknowledgement when admission answers %s', (kind, ackKind) => {
      // THE FIXTURES USED TO BE `{kind:'replay'}` AND `{kind:'rejected'}` WITH
      // NO ACKNOWLEDGEMENT — a shape `AdmissionOutcome` cannot hold, cast into
      // place. That is what hid the defect: the production code dropped a
      // field the test had never supplied, so nothing could notice it was
      // gone. Both arms carry a real acknowledgement now.
      //
      // Both are SUCCESSES at this layer. A replay must yield the same signed
      // answer as the original (§9.9 idempotency), and a rejection is a
      // commercial outcome the buyer is owed evidence of. Returning
      // `order_settled_by_core` for either meant the buyer heard `unavailable`
      // and had to reconcile to learn something this node was holding.
      outcome = {
        kind,
        acknowledgement: {
          kind: ackKind,
          purchase_order_id: 'po-1',
          ...(ackKind === 'rejected' ? { reason_code: 'quote_unknown' } : {}),
        },
        ...(kind === 'rejected' ? { detail: 'operator-only: capacity spent on q-once' } : {}),
      } as unknown as typeof outcome;
      installRuntime();

      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: submitQuery(),
        nowMs: T0,
      });

      expect(result.ok).toBe(true);
      const answered = JSON.parse(
        (result as { ok: true; coreAnswerJson: string }).coreAnswerJson,
      ) as Record<string, unknown>;
      expect(answered.kind).toBe(ackKind);
      expect(answered.purchase_order_id).toBe('po-1');
      // §14.2 — the operator-only detail never reaches the wire.
      expect(JSON.stringify(answered)).not.toContain('operator-only');
      // Unchanged and still the point: neither reaches the runner, so a retry
      // storm cannot become a dispatch storm.
      expect(workflow.store().getByCorrelationId('q-submit')).toEqual([]);
    });

    it('sends the TRANSFORMED result to the buyer, not the runner answer', async () => {
      // §9.9 — the last hop. Whatever a runner returns for an order, the buyer
      // must receive what Core signed. This drives the real completion path
      // rather than calling the transformer directly, because the defect worth
      // catching is the seam being built and never invoked.
      const seen: { capability: string; fromDid: string; params: unknown }[] = [];
      const transforming = new WorkflowService({
        repository: workflowRepo,
        nowMsFn: () => T0,
        responseBridgeSender: async (ctx) => {
          bridged.push(ctx);
        },
        ingressResultTransformer: (a) => {
          seen.push({ capability: a.capability, fromDid: a.fromDid, params: a.params });
          return a.capability === 'submit_order'
            ? { kind: 'replace' as const, json: JSON.stringify({ signed: 'ack' }) }
            : { kind: 'passthrough' as const };
        },
      });
      installRuntime();

      const created = createProviderIngressTask({
        workflow: transforming,
        capabilityConfig: binding(),
        query: submitQuery(),
        nowMs: T0,
      });
      if (!created.ok) throw new Error(JSON.stringify(created));

      const install = installs.getById(installId);
      if (!install) throw new Error('install missing');
      const claim = claimPluginTask({
        repo: workflowRepo,
        install,
        deviceDid: PLUGIN_DID,
        nowMs: T0 + 1000,
        leaseMs: 60_000,
      });
      const claimed = claim.task;
      if (!claimed) throw new Error('claim returned no task');

      transforming.complete(
        claimed.id,
        JSON.stringify({ kind: 'accepted', supplier_order_id: 'CM-1' }),
        'answered',
        PLUGIN_DID,
        claimed.claim_id,
      );
      await transforming.flushBridgeInFlight();

      // The seam saw the authenticated sender and the dispatched params.
      expect(seen).toEqual([
        { capability: 'submit_order', fromDid: BUYER_DID, params: submitQuery().params },
      ]);
      // And the buyer got Core's answer, not the runner's.
      expect(bridged).toHaveLength(1);
      expect(bridged[0].resultJSON).toBe(JSON.stringify({ signed: 'ack' }));
    });

    it('sends the buyer NOTHING when the seam withholds', async () => {
      // THE DEFECT THIS PINS. `null` from the seam used to mean two different
      // things — "not mine to transform" and "I refuse to let this out" — and
      // the bridge read both as the first, falling back to `?? resultJSON`.
      // So a supplier whose policy demands human review, or whose settings did
      // not validate, shipped the RUNNER's raw unsigned answer to the buyer as
      // though Core had signed it: an order reported as accepted when no
      // decision existed anywhere.
      //
      // Withholding is the honest answer. §12.7's buyer reconcile is built for
      // exactly the unanswered submission.
      const withholding = new WorkflowService({
        repository: workflowRepo,
        nowMsFn: () => T0,
        responseBridgeSender: async (ctx) => {
          bridged.push(ctx);
        },
        ingressResultTransformer: () => ({
          kind: 'withhold' as const,
          reason: 'approval_required',
        }),
      });
      installRuntime();

      const created = createProviderIngressTask({
        workflow: withholding,
        capabilityConfig: binding(),
        query: submitQuery(),
        nowMs: T0,
      });
      if (!created.ok) throw new Error(JSON.stringify(created));

      const install = installs.getById(installId);
      if (!install) throw new Error('install missing');
      const claim = claimPluginTask({
        repo: workflowRepo,
        install,
        deviceDid: PLUGIN_DID,
        nowMs: T0 + 1000,
        leaseMs: 60_000,
      });
      const claimed = claim.task;
      if (!claimed) throw new Error('claim returned no task');

      const RUNNER_ANSWER = JSON.stringify({ kind: 'accepted', supplier_order_id: 'CM-1' });
      withholding.complete(claimed.id, RUNNER_ANSWER, 'answered', PLUGIN_DID, claimed.claim_id);
      await withholding.flushBridgeInFlight();

      // Nothing on the wire at all — and in particular NOT the runner's
      // unsigned acceptance.
      expect(bridged).toEqual([]);
    });

    it('WITHHOLDS from the buyer when the transform throws', async () => {
      // THIS ASSERTION IS INVERTED, and the reasoning it replaces was mine.
      // It read: "A completion that already landed must not be lost because
      // the seam failed; the runner's own answer goes out instead."
      //
      // The completion is not lost — it is CAS-confirmed in the workflow store
      // whatever happens here. What went out was the runner's unsigned JSON in
      // reply to `submit_order`, which tells the buyer their order was decided
      // at exactly the moment Core failed to decide it. §9.12: a supplier
      // plugin emits an unsigned candidate and cannot make it authoritative.
      // A throw is not a licence to promote one.
      const throwing = new WorkflowService({
        repository: workflowRepo,
        nowMsFn: () => T0,
        responseBridgeSender: async (ctx) => {
          bridged.push(ctx);
        },
        ingressResultTransformer: () => {
          throw new Error('seam exploded');
        },
      });
      installRuntime();

      const created = createProviderIngressTask({
        workflow: throwing,
        capabilityConfig: binding(),
        query: submitQuery(),
        nowMs: T0,
      });
      if (!created.ok) throw new Error(JSON.stringify(created));

      const install = installs.getById(installId);
      if (!install) throw new Error('install missing');
      const claim = claimPluginTask({
        repo: workflowRepo,
        install,
        deviceDid: PLUGIN_DID,
        nowMs: T0 + 1000,
        leaseMs: 60_000,
      });
      const claimed = claim.task;
      if (!claimed) throw new Error('claim returned no task');

      const runnerAnswer = JSON.stringify({ kind: 'accepted', supplier_order_id: 'CM-2' });
      throwing.complete(claimed.id, runnerAnswer, 'answered', PLUGIN_DID, claimed.claim_id);
      await throwing.flushBridgeInFlight();

      // Nothing on the wire, and in particular NOT the runner's acceptance.
      expect(bridged).toEqual([]);
      // The completion itself survived: the task is terminal in the store, so
      // what was withheld is the response and not the work.
      expect(workflowRepo.getById(claimed.id)?.status).not.toBe('claimed');
    });

    /**
     * §14.2 — the buyer hears a non-disclosing CODE; the operator hears why.
     *
     * `quote_unknown` covers an expired quote, one this node never held, and a
     * retained record it could not read back. Flattening them is right on the
     * wire and wrong in a log: an operator debugging a live refusal would have
     * exactly as much to go on as an attacker probing the ledger.
     */
    it('tells the OPERATOR why admission refused, without widening the wire code', () => {
      outcome = {
        kind: 'rejected',
        acknowledgement: { kind: 'rejected', reason_code: 'quote_unknown' },
        detail: 'retained request receipt missing for request_digest "req-77"',
      } as unknown as typeof outcome;
      installRuntime();

      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: submitQuery(),
        nowMs: T0,
      });

      // THE REJECTION IS NOW ANSWERED, so what this test guards has changed
      // shape: the operator-only detail must be DROPPED rather than carried in
      // a refusal message. §14.2's rule is the same either way — `req-77`
      // names a retained receipt, and disclosing which of three situations
      // produced `quote_unknown` tells a stranger about catalog state.
      expect(result.ok).toBe(true);
      const answered = (result as { ok: true; coreAnswerJson: string }).coreAnswerJson;
      expect(JSON.parse(answered)).toMatchObject({ reason_code: 'quote_unknown' });
      expect(answered).not.toContain('req-77');
    });

    /**
     * §14.3 / §20.10 (WS-2.11) — probing resistance, driven through the real
     * ingress. The pure check was built and gated and NOTHING CALLED IT: a
     * competitor could draw a supplier's price curve by asking a hundred
     * times, and every individual answer would have been legitimate.
     */
    it('spends probing budget and refuses once an unknown peer exhausts it', () => {
      installRuntime();
      const stranger = 'did:plc:competitor1';
      const ask = (id: string) =>
        createProviderIngressTask({
          workflow,
          capabilityConfig: binding(),
          query: { ...query(id), capability: 'request_quote', fromDid: stranger },
          nowMs: T0,
        });

      // The unknown budget is small but NOT zero — a stranger has to be able
      // to become a customer, and §20.10's concern is the curve.
      const admitted: boolean[] = [];
      for (let i = 0; i < DEFAULT_PROBING_POLICY.unknownBudget; i += 1) {
        admitted.push(ask(`q-probe-${String(i)}`).ok);
      }
      expect(admitted.every(Boolean)).toBe(true);

      const overBudget = ask('q-probe-over');
      expect(overBudget.ok).toBe(false);
      expect(!overBudget.ok && overBudget.code).toBe('probing_refused');
      // Nothing reached the runner: the whole point is that the supplier does
      // not pay for the answer.
      expect(workflow.store().getByCorrelationId('q-probe-over')).toEqual([]);
    });

    it('gives ONE refusal code whatever the reason', () => {
      // A prober who can tell "budget spent" from "we don't quote you" learns
      // the catalog by watching which requests get a different shape of no.
      installRuntime();
      installQuoteAttemptLedger(new QuoteAttemptLedger(DEFAULT_PROBING_POLICY.windowMs));
      const exhausted = 'did:plc:competitor2';
      for (let i = 0; i <= DEFAULT_PROBING_POLICY.unknownBudget; i += 1) {
        createProviderIngressTask({
          workflow,
          capabilityConfig: binding(),
          query: { ...query(`q-x-${String(i)}`), capability: 'request_quote', fromDid: exhausted },
          nowMs: T0,
        });
      }
      const spent = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: { ...query('q-x-last'), capability: 'request_quote', fromDid: exhausted },
        nowMs: T0,
      });

      // With no ledger at all the node fails CLOSED, under the SAME code.
      installQuoteAttemptLedger(null);
      const unwired = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: { ...query('q-x-unwired'), capability: 'request_quote', fromDid: 'did:plc:other9' },
        nowMs: T0,
      });

      expect(!spent.ok && spent.code).toBe('probing_refused');
      expect(!unwired.ok && unwired.code).toBe('probing_refused');
    });

    it('an unreadable listing policy closes quoting, rather than answering freely', () => {
      // THE REGRESSION THIS PINS, and it was introduced by the fix for the
      // field-validation gap rather than exposed by it.
      //
      // The listing gate was guarded on `configured.ok` with no else-branch,
      // so an invalid settings row fell through to `admitQuoteRequest` and the
      // node answered. That was already wrong. Then the validator started
      // refusing unknown enum values and an unsupported `review` acceptance
      // policy — which means a stored row carrying a WITHDRAWN listing plus
      // any one of those faults stopped validating, and a withdrawal that used
      // to be honoured began being ignored. The owner closed their shop and
      // the node resumed quoting.
      //
      // Driven through `createProviderIngressTask` rather than
      // `quoteAdmissibility`, because the defect lives in the wiring between
      // them: the helper was always right and nothing asked it.
      const settings = new InMemoryCommerceSettingsRepository();
      installCommerceRuntime({
        settings: {
          ...settings,
          // Exactly what the store returns for a row that exists and does not
          // validate. `absent` stays false: this node HAS a listing policy, it
          // just cannot be read.
          readSupplier: () => ({
            ok: false,
            absent: false,
            findings: [
              { refusal: 'unknown_listing_state', field: 'listingState', detail: 'found "Paused"' },
            ],
          }),
          readBuyer: () => ({ ok: false, absent: true }),
        },
        admission: { admitOrder: () => outcome },
      } as unknown as CommerceRuntime);
      installQuoteAttemptLedger(new QuoteAttemptLedger(DEFAULT_PROBING_POLICY.windowMs));

      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: { ...query('q-unreadable'), capability: 'request_quote' },
        nowMs: T0,
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe('probing_refused');
      // No task reached the runner: a node that cannot read its own listing
      // policy must not spend a plugin dispatch deciding it either.
      expect(workflow.store().getByCorrelationId('q-unreadable')).toEqual([]);
    });

    it('still answers when no supplier settings exist at all', () => {
      // ABSENT IS NOT UNREADABLE. A node that never configured a supplier has
      // no listing to close, and refusing here would break every install that
      // has not visited the settings screen. The empty store in
      // `installRuntime` returns `{ok:false, absent:true}`.
      installRuntime();
      installQuoteAttemptLedger(new QuoteAttemptLedger(DEFAULT_PROBING_POLICY.windowMs));
      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: { ...query('q-noconfig'), capability: 'request_quote' },
        nowMs: T0,
      });
      expect(result.ok).toBe(true);
    });

    it('fails CLOSED when the ledger is unwired, rather than answering freely', () => {
      // An unwired probing defence that silently permits is invisible: every
      // request succeeds, which is what success looks like.
      installRuntime();
      installQuoteAttemptLedger(null);
      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: { ...query('q-no-ledger'), capability: 'request_quote' },
        nowMs: T0,
      });
      expect(result.ok).toBe(false);
    });

    it('charges an ADMITTED request only, so a refused peer can recover', () => {
      // Charging a refusal would mean each refusal extends the window that
      // caused it, and a peer past their limit could never come back.
      installRuntime();
      const ledger = new QuoteAttemptLedger(DEFAULT_PROBING_POLICY.windowMs);
      installQuoteAttemptLedger(ledger);
      const peer = 'did:plc:competitor3';
      for (let i = 0; i < DEFAULT_PROBING_POLICY.unknownBudget + 3; i += 1) {
        createProviderIngressTask({
          workflow,
          capabilityConfig: binding(),
          query: { ...query(`q-c-${String(i)}`), capability: 'request_quote', fromDid: peer },
          nowMs: T0,
        });
      }
      // Exactly the budget was spent, not one per attempt.
      expect(ledger.recent(peer, T0)).toHaveLength(DEFAULT_PROBING_POLICY.unknownBudget);
    });

    it('leaves a NON-pricing capability out of the budget entirely', () => {
      installRuntime();
      const ledger = new QuoteAttemptLedger(DEFAULT_PROBING_POLICY.windowMs);
      installQuoteAttemptLedger(ledger);
      createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: { ...query('q-not-pricing'), capability: 'order_status', fromDid: BUYER_DID },
        nowMs: T0,
      });
      expect(ledger.recent(BUYER_DID, T0)).toEqual([]);
    });

    it('leaves non-order capabilities out of admission entirely', () => {
      installRuntime();

      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: binding(),
        query: query('q-plain'),
        nowMs: T0,
      });

      expect(result.ok).toBe(true);
      expect(admitted).toEqual([]);
    });
  });

  /**
   * §9.13 prior-major lifecycle continuity (WS-3.8).
   *
   * A plugin update rebinds the listing to the new manifest CID. An order
   * opened BEFORE that update must still be answerable — and answerable under
   * the contract it was opened against, never the new one. Routing is pinned
   * by the ORDER, so these tests move the install forward and then ask about
   * an order stamped with the old manifest.
   */
  describe('prior-manifest lifecycle routing (§9.13)', () => {
    const PRIOR_CID = 'bafyreicid1';
    const NEXT_CID = 'bafyreicid2';
    const PO = 'po-opened-under-prior';
    const LIFECYCLE_CAP = 'com.acme.commerce.order_status';
    /** The PRIOR contract: params and result the buyer's order was opened under. */
    const PRIOR_PARAMS_SCHEMA = {
      type: 'object',
      properties: { purchase_order_id: { type: 'string' } },
      required: ['purchase_order_id'],
    };
    const PRIOR_RESULT_SCHEMA = {
      type: 'object',
      properties: { state: { type: 'string' } },
      required: ['state'],
    };
    let drains: SQLiteDrainAuthorizationRepository;

    function lifecycleQuery(poId = PO) {
      return {
        ...query('q-lifecycle'),
        capability: 'order_status',
        params: { purchase_order_id: poId },
      };
    }

    function lifecycleBinding() {
      return {
        pluginInstallId: installId,
        // The listing has ALREADY been rebound by the update coordinator.
        pluginManifestCid: NEXT_CID,
        pluginCapabilityId: LIFECYCLE_CAP,
      };
    }

    function seedContinuity(overrides: Record<string, unknown> = {}): void {
      drains.put({
        installId,
        previousCid: PRIOR_CID,
        capabilityId: LIFECYCLE_CAP,
        kind: 'lifecycle_continuity',
        approvedScopeHash: 'h'.repeat(64),
        configRevision: 1,
        actionClass: 'read',
        effectsIdempotency: 'supported',
        resultSchemaJson: JSON.stringify(PRIOR_RESULT_SCHEMA),
        paramsSchemaJson: JSON.stringify(PRIOR_PARAMS_SCHEMA),
        maxContextItems: null,
        expiresAt: null,
        // §9.13 — which CONTRACT this row speaks, not just which CID.
        priorVersion: '0.1.0',
        createdAt: T0,
        ...overrides,
      });
    }

    /** Seed an order stamped with the manifest that served it. */
    function seedOrder(servingManifestCid: string): void {
      const orders = new InMemoryCommerceOrderRefRepository();
      orders.createReserved({
        buyerDid: BUYER_DID,
        purchaseOrderId: PO,
        idempotencyKey: 'idem-prior',
        orderDigest: 'd'.repeat(64),
        quoteId: 'q-prior',
        quoteDigest: 'e'.repeat(64),
        pinnedVersion: '1.0',
        servingManifestCid,
        servingInstallId: '',
        admittedEpoch: '1',
        reconciliationRequired: false,
        decisionDeadlineAt: T0 + 60_000,
        createdAt: T0,
      });
      reconcileCalls = [];
      installCommerceRuntime({
        // A double that omits a field the type promises is a lie the cast
        // hides. §18.3's listing policy is read on the quote path, so the
        // double carries a real (empty) settings store rather than leaving
        // production to guard against a shape only tests produce.
        settings: new InMemoryCommerceSettingsRepository(),
        orders: new CommerceOrderStore({ refs: orders, now: () => Date.now() }),
        // WS-4.6: reconcile is answered by Core, so the stub runtime has to
        // carry a lifecycle. Recording the arguments is the assertion that
        // matters — the buyer Core is told about must be the AUTHENTICATED
        // sender, never a field from the payload.
        lifecycle: {
          reconcile: (params: unknown, buyerDid: string) => {
            reconcileCalls.push({ params, buyerDid });
            return { outcome: 'never_received' };
          },
        },
      } as unknown as CommerceRuntime);
    }

    beforeEach(() => {
      drains = new SQLiteDrainAuthorizationRepository(adapter);
      setDrainAuthorizationRepository(drains);
      // The update landed: the install now runs a manifest that no longer
      // declares the lifecycle capability at all.
      // `current_version` and the pinned manifest's own `version` must agree —
      // `rowToInstall` quarantines a row where they disagree, so the install
      // would read back as missing rather than updated.
      const updated = {
        ...(makeManifest(['provider']) as unknown as Record<string, unknown>),
        version: '0.2.0',
      } as unknown as PluginManifest;
      installs.applyUpdate(
        installId,
        {
          cid: NEXT_CID,
          version: '0.2.0',
          manifest: updated,
          installScopeHash: 's'.repeat(64),
          capabilityHashes: { [CAP]: 'h'.repeat(64) },
          behaviorHash: 'b2'.repeat(32),
          presentationHash: 'p2'.repeat(32),
        },
        T0 + 10,
      );
    });

    afterEach(() => {
      setDrainAuthorizationRepository(null);
      installCommerceRuntime(null);
    });

    it('answers a prior-manifest order under the PRIOR contract', () => {
      seedOrder(PRIOR_CID);
      seedContinuity();

      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: lifecycleBinding(),
        query: lifecycleQuery(),
        nowMs: T0 + 100,
      });

      expect(result).toEqual({ ok: true, taskId: expect.any(String) });
      const tasks = workflow.store().getByCorrelationId('q-lifecycle');
      expect(tasks).toHaveLength(1);
      const envelope = parsePluginEnvelope(tasks[0].payload ?? '');
      expect(envelope).not.toBeNull();
      // Pinned to the PRIOR manifest — this is what makes the claim guard take
      // the §9.13 drain lane rather than terminalizing the task.
      expect(envelope?.manifest_cid).toBe(PRIOR_CID);
      // And the PRIOR result schema travels with it, so the runner's answer is
      // judged against the shape the buyer's order was opened under.
      expect(envelope?.schema_snapshot).toEqual(PRIOR_RESULT_SCHEMA);
      expect(envelope?.capability_id).toBe(LIFECYCLE_CAP);
    });

    it('refuses when no continuity lane was retained for that manifest', () => {
      seedOrder(PRIOR_CID);
      // No seedContinuity(): the update dropped the lane.

      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: lifecycleBinding(),
        query: lifecycleQuery(),
        nowMs: T0 + 100,
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe('lifecycle_continuity_unavailable');
      // Answering under the CURRENT manifest would parse the buyer's request
      // against a contract their order was never opened under, so nothing
      // reaches the runner.
      expect(workflow.store().getByCorrelationId('q-lifecycle')).toEqual([]);
    });

    it('refuses once the continuity lane has been released', () => {
      seedOrder(PRIOR_CID);
      seedContinuity();
      // §9.13: released per manifest once its last order is terminal.
      expect(drains.release(installId, PRIOR_CID, LIFECYCLE_CAP, 'lifecycle_continuity')).toBe(
        true,
      );

      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: lifecycleBinding(),
        query: lifecycleQuery(),
        nowMs: T0 + 100,
      });

      expect(!result.ok && result.code).toBe('lifecycle_continuity_unavailable');
    });

    it('does not take the continuity lane on a `drain` entry alone', () => {
      seedOrder(PRIOR_CID);
      // A `drain` entry covers tasks that ALREADY existed at the rebind. It
      // must not admit a NEW lifecycle request — only continuity does.
      seedContinuity({ kind: 'drain', expiresAt: T0 + 86_400_000 });

      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: lifecycleBinding(),
        query: lifecycleQuery(),
        nowMs: T0 + 100,
      });

      expect(!result.ok && result.code).toBe('lifecycle_continuity_unavailable');
    });

    it('rejects params that violate the PRIOR params schema', () => {
      seedOrder(PRIOR_CID);
      seedContinuity({
        paramsSchemaJson: JSON.stringify({
          type: 'object',
          properties: { purchase_order_id: { type: 'number' } },
        }),
      });

      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: lifecycleBinding(),
        query: lifecycleQuery(),
        nowMs: T0 + 100,
      });

      // The prior schema is what judges the request, and it is unsatisfiable
      // here — so the envelope is refused rather than silently re-validated
      // against the new manifest.
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe('envelope_rejected');
    });

    it('leaves a current-manifest order on the ordinary path', () => {
      // Same install, same update — but this order was opened AFTER it, so no
      // continuity entry is needed and none is consulted.
      seedOrder(NEXT_CID);

      const result = createProviderIngressTask({
        workflow,
        capabilityConfig: { ...lifecycleBinding(), pluginCapabilityId: CAP },
        query: lifecycleQuery(),
        nowMs: T0 + 100,
      });

      expect(result.ok).toBe(true);
      const tasks = workflow.store().getByCorrelationId('q-lifecycle');
      const envelope = parsePluginEnvelope(tasks[0].payload ?? '');
      expect(envelope?.manifest_cid).toBe(NEXT_CID);
    });
  });
});
