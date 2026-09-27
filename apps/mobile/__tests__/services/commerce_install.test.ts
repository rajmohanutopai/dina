/**
 * The buyer pack's ceremony (§18.1 / PC-9a) on every owner surface
 * (WEB_OWNER_SURFACE_PLAN §3.5): begin → Core mints and binds the pack's
 * first-party runner → consent, all through Core's owner routes over the
 * phone's in-process owner dispatcher (the same routes a browser connected as
 * the owner reaches). Binding and consent need a person present (§3.8).
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  applyMigrations,
  BUYER_REFERENCE_MANIFEST,
  clearOwnerPresence,
  clearPairingState,
  createCoreRouter,
  getPluginInstallRepository,
  IDENTITY_MIGRATIONS,
  inProcessOwnerDispatcher,
  installOwnerPresenceVerifier,
  OwnerPluginsHttpError,
  proveOwnerPresence,
  resetCallerTypeState,
  setNodeDID,
  setPluginDeviceVerifier,
  setPluginGrantRepository,
  setPluginInstallRepository,
  SQLitePluginGrantRepository,
  SQLitePluginInstallRepository,
  OWNER_IN_PROCESS_PRINCIPAL,
} from '@dina/core';
import { getDeviceByDID, resetDeviceRegistry } from '@dina/core/devices';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { SQLiteDeviceRepository, setDeviceRepository } from '../../../core/src/devices/repository';
import {
  activateBuyerInstall,
  buyerInstallConsentSummary,
  buyerInstallStatus,
} from '../../src/services/commerce_install';
import { setOwnerDispatcher } from '../../src/services/owner_dispatcher';

const OWNER_CAP = 'owner-capability-for-commerce-install-test';
const router = createCoreRouter({
  ownerCapability: OWNER_CAP,
  ownerSetup: { msgboxURL: () => 'wss://relay/ws' },
});

let dir: string;
let adapter: NodeSQLiteAdapter;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mobile-commerce-install-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  setPluginInstallRepository(new SQLitePluginInstallRepository(adapter));
  setPluginGrantRepository(new SQLitePluginGrantRepository(adapter));
  setDeviceRepository(new SQLiteDeviceRepository(adapter));
  setPluginDeviceVerifier((did) => {
    const device = getDeviceByDID(did);
    return device !== null && !device.revoked && device.role === 'plugin';
  });
  setNodeDID('did:plc:buyer-owner');
  setOwnerDispatcher(inProcessOwnerDispatcher(router, OWNER_CAP));
});

afterEach(() => {
  setOwnerDispatcher(null);
  clearOwnerPresence();
  installOwnerPresenceVerifier(null);
  setPluginInstallRepository(null);
  setPluginGrantRepository(null);
  setPluginDeviceVerifier(null);
  setDeviceRepository(null);
  clearPairingState();
  resetDeviceRegistry();
  resetCallerTypeState();
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

it('the consent card names the pack and what it may do, from the compiled-in manifest', () => {
  const consent = buyerInstallConsentSummary();
  expect(consent.name).toBe(BUYER_REFERENCE_MANIFEST.display_name);
  expect(consent.capabilities.length).toBe(BUYER_REFERENCE_MANIFEST.capabilities.length);
});

it('activates the pack on a runner Core minted and bound; a second tap answers without a second consent', async () => {
  expect(await buyerInstallStatus()).toEqual({ state: 'absent' });
  const first = await activateBuyerInstall();
  if (!first.ok) throw new Error(first.error);
  expect(await buyerInstallStatus()).toEqual({ state: 'active', installId: first.installId });

  const again = await activateBuyerInstall();
  expect(again).toEqual({ ok: true, installId: first.installId });
});

it('with presence establishable and not proven, activation raises for the sheet; after a proof it completes', async () => {
  installOwnerPresenceVerifier(async (p) => p === 'correct horse');
  await expect(activateBuyerInstall()).rejects.toMatchObject({ errorKey: 'no_user_presence' });
  await expect(activateBuyerInstall()).rejects.toBeInstanceOf(OwnerPluginsHttpError);
  expect((await buyerInstallStatus()).state).toBe('absent');
  // A refused attempt leaves nothing staged: no pending row, no runner device.
  expect(getPluginInstallRepository()?.list() ?? []).toEqual([]);

  await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
  const done = await activateBuyerInstall();
  expect(done.ok).toBe(true);
  expect((await buyerInstallStatus()).state).toBe('active');
});

it('with no dispatcher yet (still booting) it says so rather than guessing', async () => {
  setOwnerDispatcher(null);
  expect(await buyerInstallStatus()).toEqual({
    state: 'unavailable',
    reason: 'Dina is still starting up.',
  });
  expect(await activateBuyerInstall()).toEqual({ ok: false, error: 'Dina is still starting up.' });
});
