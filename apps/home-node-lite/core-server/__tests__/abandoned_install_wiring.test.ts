/**
 * Boot wiring for the abandoned plugin-install sweeper (PLUGIN_ARCHITECTURE
 * §15.3 / RESEARCHER_KERNEL §5.C2). The dangerous case is a runner that paired
 * but whose consent was never confirmed: the sweep must revoke that device, not
 * only delete the pending row — and it must run on the product's server boot,
 * not only in a unit test that calls it by hand. This drives `initializeStorage`
 * for real: a stale pending install bound to a paired plugin device exists
 * before the second boot, and the second boot's sweeper finishes it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';
import { pino } from 'pino';

import {
  completePairing,
  generatePairingCode,
  getPluginInstallRepository,
  publicKeyToMultibase,
  setNodeDID,
} from '@dina/core';
import { getDeviceByDID } from '@dina/core/devices';

import { initializeStorage } from '../src/storage/init';

const logger = pino({ level: 'silent' });

async function settle(until: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !until(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('initializeStorage starts the abandoned-install sweeper with the durable revoker', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'abandoned-install-wiring-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a stale pending install with a paired runner is swept at boot: row gone, device revoked in SQL', async () => {
    const seed = new Uint8Array(32).fill(13);
    const first = await initializeStorage(seed, dir, logger);

    // A pending runner install …
    const installs = getPluginInstallRepository();
    if (installs === null) throw new Error('plugin registry not wired by boot');
    const nowMs = Date.now();
    const installId = installs.createPending({
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
      pendingExpiresAtSec: Math.floor(nowMs / 1000) + 900,
      nowMs,
    });
    // … and a runner that paired into it (role plugin, bound by Core).
    // The pairing table needs the node DID; boot sets it later (in `boot.ts`),
    // outside `initializeStorage`, so this harness sets it as boot would.
    setNodeDID('did:key:z6MkServerNode');
    const privateKey = new Uint8Array(32).fill(21);
    const publicKey = ed25519.getPublicKey(privateKey);
    const { code } = generatePairingCode({ role: 'plugin', scope: 'runner', pluginInstallId: installId });
    completePairing(code, 'runner', publicKeyToMultibase(publicKey), 'plugin', 'runner');
    const runnerDid = `did:key:${publicKeyToMultibase(publicKey)}`;
    expect(installs.getById(installId)?.deviceDid).toBe(runnerDid);
    expect(getDeviceByDID(runnerDid)?.revoked).toBe(false);
    // … whose 15-minute window then passes with no consent (the owner walked away).
    first.identityDB.execute('UPDATE plugin_installs SET pending_expires_at = ? WHERE install_id = ?', [
      Math.floor(nowMs / 1000) - 60,
      installId,
    ]);
    first.identityDB.close();

    // The next boot's sweeper runs its first tick immediately.
    const second = await initializeStorage(seed, dir, logger);
    try {
      await settle(() => getPluginInstallRepository()?.getById(installId) === null);
      expect(getPluginInstallRepository()?.getById(installId)).toBeNull();
      expect(getDeviceByDID(runnerDid)?.revoked).toBe(true);
      const rows = second.identityDB.query('SELECT revoked FROM paired_devices WHERE did = ?', [runnerDid]);
      expect(rows.map((r) => Number(r.revoked))).toEqual([1]);
    } finally {
      second.identityDB.close();
    }
  });
});
