/**
 * docs/STATE_MACHINES.md PLUGIN-2: a listing whose plugin install is gone or
 * held stops being public. Pausing the row is what the publisher, the query
 * gate and the presence writer all already read.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PLUGIN_NSIDS, type PluginManifest, ServiceConfig } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  registerDevice,
  resetDeviceRegistry,
  revokeDeviceDurable,
} from '../../src/devices/registry';
import {
  SQLitePluginDecisionRepository,
  setPluginDecisionRepository,
} from '../../src/plugins/decisions';
import { SQLitePluginGrantRepository, setPluginGrantRepository } from '../../src/plugins/grants';
import { uninstall } from '../../src/plugins/install_service';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
} from '../../src/plugins/registry';
import {
  getServiceConfig,
  hydrateServiceConfig,
  isCapabilityConfigured,
  onServiceConfigChanged,
  resetServiceConfigState,
  setServiceConfig,
} from '../../src/service/service_config';
import {
  InMemoryServiceConfigRepository,
  setServiceConfigRepository,
} from '../../src/service/service_config_repository';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

const T0 = 1_800_000_000_000;
const CAP = 'com.acme.rails.do-it';
const manifest = {
  $type: PLUGIN_NSIDS.release,
  plugin_id: 'com.acme.rails',
  version: '1.0.0',
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
} as unknown as PluginManifest;

let dir: string;
let adapter: NodeSQLiteAdapter;
let installs: SQLitePluginInstallRepository;
let id: string;
let runner: string;

const listing = (): ServiceConfig =>
  ({
    isDiscoverable: true,
    name: 'L',
    discoverability: 'public',
    status: 'active',
    capabilities: {
      svc: {
        responsePolicy: 'auto',
        pluginInstallId: id,
        pluginManifestCid: 'bafy1',
        pluginCapabilityId: CAP,
      },
    },
  }) as unknown as ServiceConfig;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'listing-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'i.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  installs = new SQLitePluginInstallRepository(adapter);
  setPluginInstallRepository(installs);
  setPluginGrantRepository(new SQLitePluginGrantRepository(adapter));
  setPluginDecisionRepository(new SQLitePluginDecisionRepository(adapter));
  setWorkflowService(
    new WorkflowService({ repository: new InMemoryWorkflowRepository(), nowMsFn: () => T0 }),
  );
  resetDeviceRegistry();
  runner = registerDevice('Runner', `z6MkRunner${randomBytes(4).toString('hex')}`, 'plugin').did;
  id = installs.createPending({
    publisherDid: 'did:plc:acme',
    pluginId: 'com.acme.rails',
    label: '',
    executionMode: 'runner',
    currentCid: 'bafy1',
    currentVersion: '1.0.0',
    manifest,
    installScopeHash: 's'.repeat(64),
    capabilityHashes: { [CAP]: 'c'.repeat(64) },
    behaviorHash: 'b'.repeat(64),
    presentationHash: 'p'.repeat(64),
    trustAnchor: { kind: 'repo_proof' },
    pendingExpiresAtSec: Math.floor(T0 / 1000) + 900,
    nowMs: T0,
  } as never);
  installs.activate(id, runner, T0);
});

afterEach(() => {
  setServiceConfigRepository(null);
  resetServiceConfigState();
  resetDeviceRegistry();
  setPluginInstallRepository(null);
  setPluginGrantRepository(null);
  setPluginDecisionRepository(null);
  setWorkflowService(null);
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

it('uninstall pauses the bound listing and tells the publisher', async () => {
  setServiceConfig(listing());
  expect(isCapabilityConfigured('svc')).toBe(true);
  const heard: (string | undefined)[] = [];
  onServiceConfigChanged((rkey, config) => {
    heard.push(`${rkey}:${config?.status ?? 'gone'}`);
  });
  const r = await uninstall(id, T0 + 1, async () => ({ durable: true }));
  expect(r?.removed).toBe(true);
  expect(getServiceConfig()?.status).toBe('paused');
  expect(isCapabilityConfigured('svc')).toBe(false);
  expect(heard).toContain('self:paused');
});

it('a revoke that is not yet durable still takes the listing down', async () => {
  setServiceConfig(listing());
  const r = await uninstall(id, T0 + 1, async () => ({ durable: false }));
  expect(r?.removed).toBe(false);
  expect(getServiceConfig()?.status).toBe('paused');
});

it('revoking the runner device pauses the listing', async () => {
  setServiceConfig(listing());
  const device = (await import('../../src/devices/registry')).getDeviceByDID(runner);
  await revokeDeviceDurable(device?.deviceId ?? '');
  expect(installs.getById(id)?.status).toBe('paused');
  expect(getServiceConfig()?.status).toBe('paused');
});

it('a stale row found at boot is paused, durably, before anyone can publish it', async () => {
  const repo = new InMemoryServiceConfigRepository();
  setServiceConfigRepository(repo);
  await repo.put('self', JSON.stringify(listing()), T0);
  installs.remove(id);
  await hydrateServiceConfig();
  expect(getServiceConfig()?.status).toBe('paused');
  const rows = await repo.list();
  expect((JSON.parse(rows[0].configJSON) as ServiceConfig).status).toBe('paused');
});

it('a sound listing, and a listing with no binding, are left alone', async () => {
  const repo = new InMemoryServiceConfigRepository();
  setServiceConfigRepository(repo);
  await repo.put('self', JSON.stringify(listing()), T0);
  await repo.put(
    'plain',
    JSON.stringify({
      isDiscoverable: true,
      name: 'P',
      discoverability: 'public',
      status: 'active',
      capabilities: { eta_query: { mcpServer: 'a', mcpTool: 'b', responsePolicy: 'auto' } },
    }),
    T0,
  );
  await hydrateServiceConfig();
  expect(getServiceConfig()?.status).toBe('active');
  expect(getServiceConfig('plain')?.status).toBe('active');
});

it("with no plugin registry wired, boot changes nothing: it can't tell", async () => {
  const repo = new InMemoryServiceConfigRepository();
  setServiceConfigRepository(repo);
  await repo.put('self', JSON.stringify(listing()), T0);
  setPluginInstallRepository(null);
  await hydrateServiceConfig();
  expect(getServiceConfig()?.status).toBe('active');
});

describe('SERVICE-1: the record that a deleted listing is still to be unpublished', () => {
  it('SQLite: remove writes it, put and clear end it, and it survives in the table', async () => {
    const { SQLiteServiceConfigRepository } =
      await import('../../src/service/service_config_repository');
    const repo = new SQLiteServiceConfigRepository(adapter);
    await repo.put('a', '{}', T0);
    expect(await repo.listPendingUnpublish()).toEqual([]);
    await repo.remove('a');
    await repo.remove('b');
    expect(await repo.listPendingUnpublish()).toEqual(['a', 'b']);
    await repo.put('a', '{}', T0);
    expect(await repo.listPendingUnpublish()).toEqual(['b']);
    await repo.clearPendingUnpublish('b');
    expect(await repo.listPendingUnpublish()).toEqual([]);
  });

  it('a host with no retry of its own: a failure stays owed; a live row is skipped', async () => {
    const { drainListingUnpublishes } = await import('../../src/service/service_config');
    const repo = new InMemoryServiceConfigRepository();
    setServiceConfigRepository(repo);
    await repo.remove('gone');
    await repo.remove('down');
    await repo.remove('live');
    setServiceConfig(
      { isDiscoverable: false, name: 'x', capabilities: {} } as unknown as ServiceConfig,
      'live',
    );
    const asked: string[] = [];
    await drainListingUnpublishes(async (rkey) => {
      asked.push(rkey);
      if (rkey === 'down') throw new Error('offline');
    });
    expect(asked.sort()).toEqual(['down', 'gone']);
    expect(await repo.listPendingUnpublish()).toContain('down');
    expect(await repo.listPendingUnpublish()).not.toContain('gone');
  });
});
