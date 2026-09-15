/**
 * `runnerPairingState` — the read-only view both hosts poll during the §15.3
 * ceremony. Every state the card renders is produced here from the install row
 * and the pairing table: waiting, expired (code TTL passed or code burned),
 * bound (Core bound the runner), refused (the install can no longer take one).
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { resetCallerTypeState } from '../../src/auth/caller_type';
import { getPublicKey } from '../../src/crypto/ed25519';
import { resetDeviceRegistry } from '../../src/devices/registry';
import { publicKeyToMultibase } from '../../src/identity/did';
import { clearPairingState, completePairing, setNodeDID } from '../../src/pairing/ceremony';
import { SQLitePluginInstallRepository, setPluginInstallRepository } from '../../src/plugins/registry';
import { issueRunnerPairingCode, runnerPairingState } from '../../src/plugins/runner_pairing';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const NOW = 1_750_000_000_000;
const NOW_SEC = Math.floor(NOW / 1000);
const RUNNER_KEY = publicKeyToMultibase(getPublicKey(new Uint8Array(32).fill(5)));

let dir: string;
let adapter: NodeSQLiteAdapter;
let installs: SQLitePluginInstallRepository;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'runner-pairing-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  installs = new SQLitePluginInstallRepository(adapter);
  setPluginInstallRepository(installs);
  setNodeDID('did:key:z6MkTestNode');
});

afterEach(() => {
  setPluginInstallRepository(null);
  clearPairingState();
  resetDeviceRegistry();
  resetCallerTypeState();
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
  jest.useRealTimers();
});

function pendingRunner(expiresInSec = 900): string {
  return installs.createPending({
    publisherDid: 'did:plc:acme',
    pluginId: 'com.acme.widget',
    label: '',
    executionMode: 'runner',
    currentCid: 'bafyreicid1',
    currentVersion: '1.0.0',
    manifest: {
      $type: 'com.dinakernel.plugin.release',
      plugin_id: 'com.acme.widget',
      version: '1.0.0',
      display_name: 'Widget',
      execution: { mode: 'runner' },
      capabilities: [],
    } as never,
    installScopeHash: 's'.repeat(64),
    capabilityHashes: {},
    behaviorHash: 'b'.repeat(64),
    presentationHash: 'p'.repeat(64),
    trustAnchor: { kind: 'repo_proof' },
    pendingExpiresAtSec: Math.floor(Date.now() / 1000) + expiresInSec,
    nowMs: NOW,
  });
}

describe('runnerPairingState (§15.3)', () => {
  it('waiting → bound as the runner pairs; the code carries the install id', () => {
    const installId = pendingRunner();
    const install = installs.getById(installId);
    if (install === null) throw new Error('expected the pending install');
    const { code } = issueRunnerPairingCode(install);
    expect(runnerPairingState(installId, code, NOW_SEC)).toEqual({ state: 'waiting' });

    completePairing(code, 'runner', RUNNER_KEY, 'plugin', 'runner');
    expect(runnerPairingState(installId, code, NOW_SEC)).toEqual({
      state: 'bound',
      deviceDid: `did:key:${RUNNER_KEY}`,
    });
  });

  it('expired: the code TTL passed, or three bad attempts burned it', () => {
    jest.useFakeTimers({ now: NOW });
    const installId = pendingRunner();
    const install = installs.getById(installId);
    if (install === null) throw new Error('expected the pending install');
    const { code } = issueRunnerPairingCode(install);
    jest.setSystemTime(NOW + 6 * 60 * 1000); // past the 5-minute code TTL
    expect(runnerPairingState(installId, code, NOW_SEC)).toEqual({ state: 'expired' });

    jest.setSystemTime(NOW);
    const { code: burnt } = issueRunnerPairingCode(install);
    for (let i = 0; i < 3; i++) {
      expect(() => completePairing(burnt, 'runner', 'not-a-key', 'plugin', 'runner')).toThrow();
    }
    expect(runnerPairingState(installId, burnt, NOW_SEC)).toEqual({ state: 'expired' });
    // An unknown code reads the same way.
    expect(runnerPairingState(installId, 'NEVERISS', NOW_SEC)).toEqual({ state: 'expired' });
  });

  it('refused: the install is gone, no longer pending, or its own window has passed', () => {
    const gone = pendingRunner();
    const goneInstall = installs.getById(gone);
    if (goneInstall === null) throw new Error('expected the pending install');
    const { code } = issueRunnerPairingCode(goneInstall);
    installs.remove(gone);
    expect(runnerPairingState(gone, code, NOW_SEC)).toMatchObject({ state: 'refused', error: expect.stringMatching(/gone/) });

    const activated = pendingRunner();
    installs.bindPendingDevice(activated, 'did:key:zrunner', NOW);
    installs.activate(activated, 'did:key:zrunner', NOW);
    expect(runnerPairingState(activated, code, NOW_SEC)).toMatchObject({ state: 'refused', error: expect.stringMatching(/active/) });

    const expired = pendingRunner(-1);
    expect(runnerPairingState(expired, code, Math.floor(Date.now() / 1000))).toMatchObject({
      state: 'refused',
      error: expect.stringMatching(/expired/),
    });
  });
});
