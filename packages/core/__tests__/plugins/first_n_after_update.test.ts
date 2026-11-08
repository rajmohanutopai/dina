/**
 * docs/STATE_MACHINES.md PLUGIN-1: an update restarts the first-N cards. The
 * counter that decides them reads the owner's decision log, so the update's
 * reset has to reach that log, in the same transaction as the manifest swap.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PLUGIN_NSIDS, type PluginManifest } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  SQLitePluginDecisionRepository,
  setPluginDecisionRepository,
} from '../../src/plugins/decisions';
import { SQLitePluginGrantRepository, setPluginGrantRepository } from '../../src/plugins/grants';
import {
  approvedInvocationCount,
  createApprovalGrant,
  invokeToolCapability,
  recordInvocationDecision,
} from '../../src/plugins/invoke';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
} from '../../src/plugins/registry';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

const T0 = 1_800_000_000_000;
const CAP = 'com.acme.rails.do-it';
const manifest = (version: string): PluginManifest =>
  ({
    $type: PLUGIN_NSIDS.release,
    plugin_id: 'com.acme.rails',
    version,
    display_name: 'R',
    execution: { mode: 'runner' },
    capabilities: [
      {
        id: CAP,
        display_name: 'Do',
        interaction: 'query',
        action_class: 'write',
        privacy_class: 'public',
        kinds: ['tool', 'provider'],
        effects: { idempotency: 'supported' },
        data_scope: { categories: ['reference'] },
      },
    ],
  }) as unknown as PluginManifest;

let dir: string;
let adapter: NodeSQLiteAdapter;
let installs: SQLitePluginInstallRepository;
let workflow: WorkflowService;
let id: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'first-n-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'i.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  installs = new SQLitePluginInstallRepository(adapter);
  setPluginInstallRepository(installs);
  setPluginGrantRepository(new SQLitePluginGrantRepository(adapter));
  setPluginDecisionRepository(new SQLitePluginDecisionRepository(adapter));
  workflow = new WorkflowService({
    repository: new InMemoryWorkflowRepository(),
    nowMsFn: () => T0,
  });
  setWorkflowService(workflow);
  id = installs.createPending({
    publisherDid: 'did:plc:acme',
    pluginId: 'com.acme.rails',
    label: '',
    executionMode: 'runner',
    currentCid: 'bafy1',
    currentVersion: '1.0.0',
    manifest: manifest('1.0.0'),
    installScopeHash: 's'.repeat(64),
    capabilityHashes: { [CAP]: 'c'.repeat(64) },
    behaviorHash: 'b'.repeat(64),
    presentationHash: 'p'.repeat(64),
    trustAnchor: { kind: 'repo_proof' },
    pendingExpiresAtSec: Math.floor(T0 / 1000) + 900,
    nowMs: T0,
  } as never);
  installs.activate(id, 'did:key:zrunner', T0);
});

afterEach(() => {
  setPluginInstallRepository(null);
  setPluginGrantRepository(null);
  setPluginDecisionRepository(null);
  setWorkflowService(null);
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

const identity = (hash: string) => ({
  installId: id,
  capabilityId: CAP,
  approvedScopeHash: hash,
  actionClass: 'write',
});

function update(cid: string, hash: string, at: number): boolean {
  return installs.applyUpdate(
    id,
    {
      cid,
      version: '1.1.0',
      manifest: manifest('1.1.0'),
      installScopeHash: 's'.repeat(64),
      capabilityHashes: { [CAP]: hash },
      behaviorHash: 'e'.repeat(64),
      presentationHash: 'p'.repeat(64),
    } as never,
    at,
    { currentCid: 'bafy1' },
  );
}

const invoke = (at: number) =>
  invokeToolCapability(
    { installId: id, capabilityId: CAP, params: {}, paramCategories: ['reference'], nowMs: at },
    { workflow },
  );

it('counts only approvals since the last update, even in the same second', () => {
  const old = identity('c'.repeat(64));
  for (let i = 0; i < 3; i++) recordInvocationDecision(old, 'invocation_approved', 'card', T0);
  expect(approvedInvocationCount(id, CAP)).toBe(3);
  expect(update('bafy2', 'd'.repeat(64), T0)).toBe(true);
  expect(approvedInvocationCount(id, CAP)).toBe(0);
  recordInvocationDecision(identity('d'.repeat(64)), 'invocation_approved', 'card', T0);
  expect(approvedInvocationCount(id, CAP)).toBe(1);
});

it('after an update a window grant does not run silently: the next call cards', () => {
  const old = identity('c'.repeat(64));
  for (let i = 0; i < 3; i++) recordInvocationDecision(old, 'invocation_approved', 'card', T0 + i);
  const newHash = 'd'.repeat(64);
  expect(update('bafy2', newHash, T0 + 10_000)).toBe(true);
  createApprovalGrant(identity(newHash), { type: 'window', hours: 24 }, T0 + 20_000);
  expect(invoke(T0 + 30_000)).toMatchObject({ ok: true, mode: 'approval_required' });
  // Three new approvals earn the silent run back.
  for (let i = 0; i < 3; i++) {
    recordInvocationDecision(identity(newHash), 'invocation_approved', 'card', T0 + 40_000 + i * 1000);
  }
  expect(invoke(T0 + 50_000)).toMatchObject({ ok: true, mode: 'dispatched' });
});

it('an update that lost its compare-and-swap leaves the count alone', () => {
  const old = identity('c'.repeat(64));
  recordInvocationDecision(old, 'invocation_approved', 'card', T0);
  const lost = installs.applyUpdate(
    id,
    {
      cid: 'bafy2',
      version: '1.1.0',
      manifest: manifest('1.1.0'),
      installScopeHash: 's'.repeat(64),
      capabilityHashes: { [CAP]: 'd'.repeat(64) },
      behaviorHash: 'e'.repeat(64),
      presentationHash: 'p'.repeat(64),
    } as never,
    T0,
    { currentCid: 'other' },
  );
  expect(lost).toBe(false);
  expect(approvedInvocationCount(id, CAP)).toBe(1);
});
