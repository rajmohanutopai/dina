/**
 * The dispatch producer's gate, pinned on the cases the shipped country packs
 * cannot reach (PLUGIN_ARCHITECTURE §8, §9.1, §11.5): a `payment` capability
 * is blocked at every ring; a SAFE floor (canonical id, verified publisher,
 * params clear egress) runs with no grant and no provenance; a standing grant
 * whose constraints refuse THIS invocation cards instead of failing; a
 * provider-only capability is not a tool; a params-schema violation gives a
 * reserved grant use back; the owner's approve-body grant block parses
 * strictly; and the §8 first-N counter reads the owner's own decision log.
 *
 * `evaluatePluginIntent`, `assessParamsEgress`, `decideDispatch` and
 * `buildPluginEnvelope` have their own suites; this one drives them through
 * the producer with real repositories and the in-memory workflow store.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PLUGIN_NSIDS, pluginLane, type PluginManifest } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { SQLitePluginDecisionRepository, setPluginDecisionRepository } from '../../src/plugins/decisions';
import { SQLitePluginGrantRepository, setPluginGrantRepository } from '../../src/plugins/grants';
import {
  approvedInvocationCount,
  invokeToolCapability,
  isPluginInvocationTask,
  parseApprovalGrantRequest,
  readInvocationCardPolicy,
  type InvokeToolCapabilityResult,
} from '../../src/plugins/invoke';
import { SQLitePluginInstallRepository, setPluginInstallRepository } from '../../src/plugins/registry';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { parsePluginEnvelope } from '../../src/workflow/plugin_envelope';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService } from '../../src/workflow/service';

const T0 = 1_800_000_000_000;
const RUNNER_DID = 'did:key:zrunner';
const SCOPE = 'c'.repeat(64);

const CAPS = {
  read: 'com.acme.rails.read-status',
  pay: 'com.acme.rails.pay',
  provider: 'com.acme.rails.answer-peer',
  // A canonical catalog id: the one shape that can floor at SAFE (§8 rule 5).
  eta: 'eta_query',
} as const;

const MANIFEST: PluginManifest = {
  $type: PLUGIN_NSIDS.release,
  plugin_id: 'com.acme.rails',
  version: '1.0.0',
  display_name: 'Rails',
  execution: { mode: 'runner' },
  capabilities: [
    {
      id: CAPS.read,
      display_name: 'Read a status',
      interaction: 'query',
      action_class: 'read',
      privacy_class: 'public',
      kinds: ['tool'],
      effects: { idempotency: 'supported' },
      data_scope: { categories: ['reference'] },
      params_schema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' } } },
      result_schema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } },
    },
    {
      id: CAPS.pay,
      display_name: 'Pay someone',
      interaction: 'query',
      action_class: 'payment',
      privacy_class: 'regulated',
      kinds: ['tool'],
      effects: { idempotency: 'supported' },
      data_scope: { categories: ['payment'] },
    },
    {
      id: CAPS.provider,
      display_name: 'Answer a peer',
      interaction: 'query',
      action_class: 'read',
      privacy_class: 'public',
      kinds: ['provider'],
      effects: { idempotency: 'supported' },
    },
    {
      id: CAPS.eta,
      display_name: 'When does it arrive',
      interaction: 'query',
      action_class: 'read',
      privacy_class: 'public',
      kinds: ['tool'],
      effects: { idempotency: 'supported' },
      data_scope: { categories: ['transit'] },
    },
  ],
} as PluginManifest;

let dir: string;
let adapter: NodeSQLiteAdapter;
let installs: SQLitePluginInstallRepository;
let grants: SQLitePluginGrantRepository;
let decisions: SQLitePluginDecisionRepository;
let workflowRepo: InMemoryWorkflowRepository;
let workflow: WorkflowService;
let installId: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'plugin-invoke-unit-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  installs = new SQLitePluginInstallRepository(adapter);
  setPluginInstallRepository(installs);
  grants = new SQLitePluginGrantRepository(adapter);
  setPluginGrantRepository(grants);
  decisions = new SQLitePluginDecisionRepository(adapter);
  setPluginDecisionRepository(decisions);
  workflowRepo = new InMemoryWorkflowRepository();
  workflow = new WorkflowService({ repository: workflowRepo, nowMsFn: () => T0 });
  installId = installs.createPending({
    publisherDid: 'did:plc:acme',
    pluginId: MANIFEST.plugin_id,
    label: '',
    executionMode: 'runner',
    currentCid: 'bafyreicid1',
    currentVersion: '1.0.0',
    manifest: MANIFEST,
    installScopeHash: 's'.repeat(64),
    capabilityHashes: { [CAPS.read]: SCOPE, [CAPS.pay]: SCOPE, [CAPS.provider]: SCOPE, [CAPS.eta]: SCOPE },
    behaviorHash: 'b'.repeat(64),
    presentationHash: 'p'.repeat(64),
    trustAnchor: { kind: 'repo_proof' },
    pendingExpiresAtSec: Math.floor(T0 / 1000) + 900,
    nowMs: T0,
  });
  installs.activate(installId, RUNNER_DID, T0);
});

afterEach(() => {
  setPluginInstallRepository(null);
  setPluginGrantRepository(null);
  setPluginDecisionRepository(null);
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

function invoke(
  capabilityId: string,
  params: unknown,
  extra: Partial<Parameters<typeof invokeToolCapability>[0]> = {},
  policy: Parameters<typeof invokeToolCapability>[1]['policy'] = {},
): InvokeToolCapabilityResult {
  return invokeToolCapability(
    { installId, capabilityId, params, paramCategories: ['reference'], nowMs: T0, ...extra },
    { workflow, policy },
  );
}

describe('invokeToolCapability — the gate (§8 / §11.5)', () => {
  it('a payment-class capability is BLOCKED at every ring: no task, a typed refusal', () => {
    const res = invoke(CAPS.pay, { to: 'x', amount: 1 }, { paramCategories: ['payment'] }, { publisherRing: () => 'verified_actioned' });
    expect(res).toMatchObject({ ok: false, code: 'blocked' });
    expect((res as { message: string }).message).toMatch(/BLOCKED at every trust ring/);
    expect(workflowRepo.listNonTerminalByRunner(pluginLane(installId))).toEqual([]);
  });

  it('a custom read cards on first use (MODERATE floor) and the task is pending_approval, never queued', () => {
    const res = invoke(CAPS.read, { ref: 'r-1' });
    expect(res).toMatchObject({ ok: true, mode: 'approval_required', card: { riskLevel: 'MODERATE' } });
    if (!res.ok || res.mode !== 'approval_required') throw new Error('unreachable');
    expect(res.card.paramsText).toContain('r-1');
    const task = workflowRepo.getById(res.taskId);
    expect(task?.status).toBe('pending_approval');
    expect(task?.description).toBe(`plugin invocation ${CAPS.read}`);
    expect(parsePluginEnvelope(task?.payload ?? '')?.authorization_kind).toBe('card');
    expect(isPluginInvocationTask(task ?? { payload: '' })).toBe(true);
  });

  it('SAFE floor (canonical id, verified publisher, params clear egress) runs with no grant and no provenance', () => {
    const res = invoke(
      CAPS.eta,
      { stop: '42' },
      { paramCategories: ['transit'] },
      { capabilityKind: () => 'canonical', publisherRing: () => 'verified' },
    );
    expect(res).toMatchObject({ ok: true, mode: 'dispatched' });
    if (!res.ok || res.mode !== 'dispatched') throw new Error('unreachable');
    expect(res.grantId).toBeUndefined();
    const task = workflowRepo.getById(res.taskId);
    expect(task?.status).toBe('queued');
    const envelope = parsePluginEnvelope(task?.payload ?? '');
    expect(envelope?.authorization_kind).toBeUndefined();
    expect(envelope?.grant_id).toBeUndefined();
  });

  it('a SAFE floor still cards when the params do not clear egress (an out-of-scope category)', () => {
    const res = invoke(
      CAPS.eta,
      { stop: '42' },
      { paramCategories: ['health'] },
      { capabilityKind: () => 'canonical', publisherRing: () => 'verified' },
    );
    expect(res).toMatchObject({ ok: true, mode: 'approval_required' });
    if (!res.ok || res.mode !== 'approval_required') throw new Error('unreachable');
    expect(res.card.reasons.join(' ')).toMatch(/sensitive|out-of-scope/);
  });

  it('a standing grant silences a MODERATE read, is CHARGED, and pins its provenance', () => {
    const grantId = grants.create(
      { installId, capability: CAPS.read, approvedScopeHash: SCOPE, grantType: 'standing', constraints: { version: 1, max_count: 2 } },
      'read',
      T0,
    );
    const res = invoke(CAPS.read, { ref: 'r-2' }, { resource: 'r-2' });
    expect(res).toMatchObject({ ok: true, mode: 'dispatched', grantId });
    if (!res.ok || res.mode !== 'dispatched') throw new Error('unreachable');
    const envelope = parsePluginEnvelope(workflowRepo.getById(res.taskId)?.payload ?? '');
    expect(envelope?.authorization_kind).toBe('grant');
    expect(envelope?.grant_id).toBe(grantId);
    expect(envelope?.resource).toBe('r-2');
    expect(envelope?.invocation_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(grants.getUse(grantId, res.executionId)).not.toBeNull();
  });

  it('a grant whose constraints refuse THIS invocation cards with the refusal as the reason — it does not fail', () => {
    grants.create(
      { installId, capability: CAPS.read, approvedScopeHash: SCOPE, grantType: 'standing', constraints: { version: 1, resources: ['allowed'] } },
      'read',
      T0,
    );
    const res = invoke(CAPS.read, { ref: 'r-3' }, { resource: 'forbidden' });
    expect(res).toMatchObject({ ok: true, mode: 'approval_required' });
    if (!res.ok || res.mode !== 'approval_required') throw new Error('unreachable');
    expect(res.card.reasons.join(' ')).toMatch(/refused this invocation: resource_not_allowed/);
    expect(workflowRepo.getById(res.taskId)?.status).toBe('pending_approval');
  });

  it('a capability consented only as `provider` is not a tool', () => {
    expect(invoke(CAPS.provider, {})).toMatchObject({ ok: false, code: 'not_a_tool' });
  });

  it('a params-schema violation is a typed refusal and gives the reserved grant use back', () => {
    const grantId = grants.create(
      { installId, capability: CAPS.read, approvedScopeHash: SCOPE, grantType: 'standing', constraints: { version: 1, max_count: 1 } },
      'read',
      T0,
    );
    // `ref` is required by the consented params_schema.
    expect(invoke(CAPS.read, { nope: 1 })).toMatchObject({ ok: false, code: 'params_invalid' });
    // The single use was released: the next valid ask can still ride the grant.
    expect(invoke(CAPS.read, { ref: 'ok' })).toMatchObject({ ok: true, mode: 'dispatched', grantId });
  });

  it('a create that FAULTS (not a dedup conflict) rethrows — and gives the charged use back when no row landed', () => {
    const grantId = grants.create(
      { installId, capability: CAPS.read, approvedScopeHash: SCOPE, grantType: 'standing', constraints: { version: 1, max_count: 1 } },
      'read',
      T0,
    );
    const faulting = {
      create: () => {
        throw new Error('SQLITE_FULL: database or disk is full');
      },
      store: () => workflowRepo,
    };
    expect(() =>
      invokeToolCapability(
        { installId, capabilityId: CAPS.read, params: { ref: 'r-9' }, paramCategories: ['reference'], nowMs: T0 },
        { workflow: faulting },
      ),
    ).toThrow(/SQLITE_FULL/);
    // The single use is free again: the next ask still rides the grant.
    expect(invoke(CAPS.read, { ref: 'r-10' })).toMatchObject({ ok: true, mode: 'dispatched', grantId });
  });

  it('a create that faults AFTER the row landed keeps the use — the task exists and may run', () => {
    const grantId = grants.create(
      { installId, capability: CAPS.read, approvedScopeHash: SCOPE, grantType: 'standing', constraints: { version: 1, max_count: 1 } },
      'read',
      T0,
    );
    const landedThenFaulted = {
      create: (input: Parameters<typeof workflow.create>[0]) => {
        workflow.create(input);
        throw new Error('event append failed after insert');
      },
      store: () => workflowRepo,
    };
    expect(() =>
      invokeToolCapability(
        { installId, capabilityId: CAPS.read, params: { ref: 'r-11' }, paramCategories: ['reference'], nowMs: T0 },
        { workflow: landedThenFaulted },
      ),
    ).toThrow(/event append/);
    const [task] = workflowRepo.listNonTerminalByRunner(pluginLane(installId));
    const executionId = parsePluginEnvelope(task?.payload ?? '')?.execution_id ?? '';
    expect(grants.getUse(grantId, executionId)).not.toBeNull();
    // The grant's one use is spent by the task that exists — the next ask cards.
    expect(invoke(CAPS.read, { ref: 'r-12' })).toMatchObject({ ok: true, mode: 'approval_required' });
  });

  it('a carded task carries Core-owned card facts in `policy` and names the capability by id, never by the plugin’s words', () => {
    const res = invoke(CAPS.read, { ref: 'r-13' });
    if (!res.ok || res.mode !== 'approval_required') throw new Error('unreachable');
    const task = workflowRepo.getById(res.taskId);
    expect(task?.description).toBe(`plugin invocation ${CAPS.read}`);
    expect(task?.description).not.toContain('Read a status');
    expect(task?.description).not.toContain('Rails');
    expect(readInvocationCardPolicy(task ?? { policy: '' })).toEqual({
      type: 'plugin_invocation_card',
      risk_level: 'MODERATE',
      reasons: res.card.reasons,
      // A public read: a standing approval could silence it (§8).
      grant_can_silence: true,
      // §11 — what Core's own projection added, as metadata. This capability
      // declares no data_scope, so it is the honest empty answer.
      context: { categories: [], item_count: 0 },
    });
    // A silent task carries no card facts.
    const grantId = grants.create(
      { installId, capability: CAPS.read, approvedScopeHash: SCOPE, grantType: 'standing', constraints: { version: 1, max_count: 5 } },
      'read',
      T0,
    );
    const silent = invoke(CAPS.read, { ref: 'r-14' });
    expect(silent).toMatchObject({ ok: true, mode: 'dispatched', grantId });
    if (!silent.ok) throw new Error('unreachable');
    expect(readInvocationCardPolicy(workflowRepo.getById(silent.taskId) ?? { policy: '' })).toBeNull();
  });

  it('refuses a paused install and an unknown one', () => {
    installs.pause(installId, T0);
    expect(invoke(CAPS.read, { ref: 'r' })).toMatchObject({ ok: false, code: 'install_not_active' });
    expect(invokeToolCapability({ installId: 'nope', capabilityId: CAPS.read, params: {}, nowMs: T0 }, { workflow })).toMatchObject({
      ok: false,
      code: 'install_unknown',
    });
  });

  it('with no registry wired the door is closed', () => {
    setPluginInstallRepository(null);
    expect(invoke(CAPS.read, { ref: 'r' })).toMatchObject({ ok: false, code: 'registry_unavailable' });
  });

  it('a task is a plugin invocation only by its pinned payload type', () => {
    expect(isPluginInvocationTask({ payload: JSON.stringify({ type: 'intent_validation' }) })).toBe(false);
    expect(isPluginInvocationTask({ payload: 'not json' })).toBe(false);
  });
});

describe('the §8 first-N counter reads the decision log', () => {
  it('counts only this capability’s approved invocations', () => {
    const nowSec = Math.floor(T0 / 1000);
    decisions.record({ installId, capability: CAPS.read, decision: 'invocation_approved', nowSec });
    decisions.record({ installId, capability: CAPS.read, decision: 'invocation_denied', nowSec });
    decisions.record({ installId, capability: CAPS.eta, decision: 'invocation_approved', nowSec });
    decisions.record({ installId, capability: CAPS.read, decision: 'invocation_approved', nowSec });
    expect(approvedInvocationCount(installId, CAPS.read)).toBe(2);
    expect(approvedInvocationCount(installId, CAPS.eta)).toBe(1);
    expect(approvedInvocationCount('other', CAPS.read)).toBe(0);
  });
});

describe('parseApprovalGrantRequest — the approve body’s grant block (§15.5)', () => {
  it('accepts a window of at most 24 hours and a bounded standing grant; refuses everything else', () => {
    expect(parseApprovalGrantRequest(undefined)).toBeNull();
    expect(parseApprovalGrantRequest({ type: 'window' })).toEqual({ type: 'window' });
    expect(parseApprovalGrantRequest({ type: 'window', hours: 2 })).toEqual({ type: 'window', hours: 2 });
    expect(parseApprovalGrantRequest({ type: 'window', hours: 25 })).toBe('invalid');
    expect(parseApprovalGrantRequest({ type: 'window', hours: 0 })).toBe('invalid');
    expect(parseApprovalGrantRequest({ type: 'standing', constraints: { version: 1, max_count: 5 }, expires_in_hours: 48 })).toEqual({
      type: 'standing',
      constraints: { version: 1, max_count: 5 },
      expires_in_hours: 48,
    });
    expect(parseApprovalGrantRequest({ type: 'standing', constraints: { version: 9 } })).toBe('invalid');
    expect(parseApprovalGrantRequest({ type: 'standing', expires_in_hours: -1 })).toBe('invalid');
    expect(parseApprovalGrantRequest({ type: 'forever' })).toBe('invalid');
    expect(parseApprovalGrantRequest('window')).toBe('invalid');
  });
});
