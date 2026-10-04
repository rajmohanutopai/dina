/**
 * Inbound executor bindings (design §7.3): a lane is executable over A2A
 * only while it is bound to an active paired runner; plugin, A2A, reasoning
 * and Tier 1 lanes are never bound here; every binding write bumps the
 * revision of each listing that names the lane, so a pinned snapshot voids.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { bindRunner, liveRunnerBinding, listRunnerBindings, unbindRunner } from '../../src/a2a/runner_bindings';
import { A2AStore } from '../../src/a2a/store';
import { registerDevice, resetDeviceRegistry, revokeDevice } from '../../src/devices/registry';
import { SQLiteServiceConfigRepository } from '../../src/service/service_config_repository';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const NOW = 1_800_000_000_000;
let dir: string;
let db: NodeSQLiteAdapter;
let store: A2AStore;

beforeEach(() => {
  resetDeviceRegistry();
  dir = mkdtempSync(path.join(tmpdir(), 'a2a-runner-bindings-'));
  db = new NodeSQLiteAdapter({ path: path.join(dir, 'identity.sqlite'), passphraseHex: 'aa'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  store = new A2AStore(db);
});

afterEach(() => {
  resetDeviceRegistry();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const revision = (rkey: string) => db.query<{ revision: number }>('SELECT revision FROM service_configs WHERE rkey = ?', [rkey])[0]?.revision;

async function listings() {
  const repo = new SQLiteServiceConfigRepository(db);
  const listing = (mcpServer: string) =>
    JSON.stringify({ isDiscoverable: true, name: 'S', capabilities: { eta_query: { mcpServer, mcpTool: 'get_eta', responsePolicy: 'auto' } } });
  await repo.put('uses-transit', listing('transit'), 1);
  await repo.put('uses-other', listing('other'), 1);
}

describe('runner bindings', () => {
  it('binds a lane to an active paired runner, and bumps only the listings that name it', async () => {
    await listings();
    const runner = registerDevice('Transit runner', 'z6MkTransitRunner', 'agent', 'runner');
    const out = bindRunner(store, { lane: 'transit', device_did: runner.did }, NOW);
    expect(out.ok).toBe(true);
    expect(liveRunnerBinding(store, 'transit')?.device_did).toBe(runner.did);
    expect(revision('uses-transit')).toBe(2);
    expect(revision('uses-other')).toBe(1);
  });

  it.each([
    ['', 'lane_malformed'],
    ['has space', 'lane_malformed'],
    ['dina.local', 'lane_reserved'],
    ['plugin:inst_1', 'lane_reserved'],
    ['a2a:ra-1', 'lane_reserved'],
    ['reasoning:claude', 'lane_reserved'],
  ])('refuses the lane %j as %s', (lane, reason) => {
    const runner = registerDevice('Runner', 'z6MkRunnerA', 'agent', 'runner');
    expect(bindRunner(store, { lane, device_did: runner.did }, NOW)).toEqual({ ok: false, reason });
  });

  it('refuses a device that is not an active delegation runner', () => {
    const phone = registerDevice('Phone', 'z6MkPhone', 'rich');
    const coder = registerDevice('Coder', 'z6MkCoder', 'agent', 'coding');
    for (const did of [phone.did, coder.did, 'did:key:z6MkNobody']) {
      expect(bindRunner(store, { lane: 'transit', device_did: did }, NOW)).toEqual({ ok: false, reason: 'device_not_runner' });
    }
  });

  it('a revoked device leaves the lane not executable, at once', () => {
    const runner = registerDevice('Runner', 'z6MkRunnerB', 'agent', 'runner');
    bindRunner(store, { lane: 'transit', device_did: runner.did }, NOW);
    revokeDevice(runner.deviceId);
    expect(liveRunnerBinding(store, 'transit')).toBeNull();
    expect(listRunnerBindings(store)[0]?.live).toBe(false);
  });

  it('unbinding ends the binding and bumps the listings; rebinding replaces it', async () => {
    await listings();
    const a = registerDevice('Runner A', 'z6MkRunnerC', 'agent', 'runner');
    const b = registerDevice('Runner B', 'z6MkRunnerD', 'agent', 'runner');
    bindRunner(store, { lane: 'transit', device_did: a.did }, NOW);
    expect(unbindRunner(store, 'transit', NOW + 1)).toEqual({ ok: true });
    expect(liveRunnerBinding(store, 'transit')).toBeNull();
    expect(revision('uses-transit')).toBe(3);
    expect(unbindRunner(store, 'transit', NOW + 2)).toEqual({ ok: false, reason: 'not_found' });
    bindRunner(store, { lane: 'transit', device_did: b.did }, NOW + 3);
    expect(liveRunnerBinding(store, 'transit')?.device_did).toBe(b.did);
    expect(revision('uses-transit')).toBe(4);
  });
});
