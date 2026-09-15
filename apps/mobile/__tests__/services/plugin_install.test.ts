/**
 * §5.C2 — the phone's general (third-party) plugin install ceremony service.
 * Drives the in-process install machinery through an injected FAKE repo-proof
 * verifier (the real `@atproto` verifier is a boot-time concern, C1): an
 * authentic release stages a pending install with its consent summary; a
 * verifier failure surfaces; NO verifier fails closed.
 *
 * The runner leg is REAL (PLUGIN_ARCHITECTURE §15.3): the service issues a setup
 * code, a simulated runner completes pairing with its OWN key, Core binds that
 * exact device to the pending install, consent activates on it, and every
 * teardown (decline / uninstall) durably revokes the device.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';

import {
  applyMigrations,
  clearPairingState,
  completePairing,
  getPluginInstallRepository,
  IDENTITY_MIGRATIONS,
  publicKeyToMultibase,
  resetCallerTypeState,
  setNodeDID,
  SQLitePluginGrantRepository,
  SQLitePluginInstallRepository,
  setPluginDeviceVerifier,
  setPluginGrantRepository,
  setPluginInstallRepository,
  setRepoProofVerifier,
} from '@dina/core';
import { deviceCount, getDeviceByDID, getPairingIntent, resetDeviceRegistry } from '@dina/core/devices';
import { base32Encode, releaseRkeyFromCid, PLUGIN_NSIDS } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { SQLiteDeviceRepository, setDeviceRepository } from '../../../core/src/devices/repository';
import {
  beginCountryPackInstall,
  beginPluginInstall,
  checkRunnerPairing,
  confirmPluginInstall,
  declinePluginInstall,
  issueRunnerSetupCode,
  listInstalledPlugins,
  pluginInstallAvailable,
  uninstallPlugin,
  type PluginConsentSummary,
} from '../../src/services/plugin_install';

import type { PluginManifest, RepoProofResult, RepoProofVerifier } from '@dina/protocol';

const PUBLISHER = 'did:plc:acmepublisher00000000000';
const NODE_DID = 'did:key:z6MkTestNodeDID';

let dir: string;
let adapter: NodeSQLiteAdapter;

const sha256 = (d: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(d).digest());

function cidFor(seed: string): string {
  const digest = sha256(new TextEncoder().encode(seed));
  const bytes = new Uint8Array(36);
  bytes.set([0x01, 0x71, 0x12, 0x20], 0);
  bytes.set(digest, 4);
  return `b${base32Encode(bytes)}`;
}

function runnerManifest(): PluginManifest {
  return {
    $type: PLUGIN_NSIDS.release,
    plugin_id: 'com.acme.widget',
    version: '1.0.0',
    display_name: 'Widget',
    execution: { mode: 'runner' },
    capabilities: [
      {
        id: 'com.acme.widget.read',
        display_name: 'Read a widget',
        interaction: 'query',
        action_class: 'read',
        privacy_class: 'personal',
        kinds: ['tool'],
        effects: { idempotency: 'unsupported' },
      },
    ],
  } as PluginManifest;
}

function fakeVerifier(manifest: PluginManifest, seed = 'v1'): { rkey: string; verifier: RepoProofVerifier } {
  const cid = cidFor(seed);
  const rkey = releaseRkeyFromCid(cid) as string;
  const verifier: RepoProofVerifier = async (req) =>
    req.rkey === rkey
      ? ({ ok: true, cid, rev: 'rev1', record: manifest } as RepoProofResult)
      : { ok: false, code: 'not_found', transient: false, message: 'no such release' };
  return { rkey, verifier };
}

/** Stage an authentic runner release and return its consent summary. */
async function stagedRunner(): Promise<PluginConsentSummary> {
  const { rkey, verifier } = fakeVerifier(runnerManifest());
  setRepoProofVerifier(verifier);
  const outcome = await beginPluginInstall(PUBLISHER, rkey);
  if (!outcome.ok) throw new Error(`expected a pending install: ${outcome.error}`);
  return outcome.consent;
}

/**
 * The runner side of the ceremony: pair with ITS OWN fresh key using the setup
 * code. Role + scope come from the code's initiate-time intent, exactly as
 * `/v1/pair/complete` does (a client-sent role is ignored there) — the test
 * never supplies them, so "fixed at initiate" is what is asserted.
 */
function runnerPairs(code: string): string {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  const publicKey = ed25519.getPublicKey(seed);
  const intent = getPairingIntent(code);
  completePairing(code, 'com.acme.widget', publicKeyToMultibase(publicKey), intent?.role, intent?.scope);
  return `did:key:${publicKeyToMultibase(publicKey)}`;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mobile-plugin-install-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  setPluginInstallRepository(new SQLitePluginInstallRepository(adapter));
  // Revoking a runner device cascades into its install's grants, and a durable
  // device revoke needs the SQL device repository — wire both, as boot does.
  setPluginGrantRepository(new SQLitePluginGrantRepository(adapter));
  setDeviceRepository(new SQLiteDeviceRepository(adapter));
  // The boot-wired verifier: a real, unrevoked, role='plugin' device.
  setPluginDeviceVerifier((did) => {
    const device = getDeviceByDID(did);
    return device !== null && !device.revoked && device.role === 'plugin';
  });
  setNodeDID(NODE_DID);
});

afterEach(() => {
  setPluginInstallRepository(null);
  setPluginGrantRepository(null);
  setPluginDeviceVerifier(null);
  setRepoProofVerifier(null);
  setDeviceRepository(null);
  clearPairingState();
  resetDeviceRegistry();
  resetCallerTypeState();
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('plugin_install (mobile, §5.C2)', () => {
  it('authenticates a release and returns the consent summary', async () => {
    const consent = await stagedRunner();
    expect(consent.pluginId).toBe('com.acme.widget');
    expect(consent.executionMode).toBe('runner');
    expect(consent.capabilities).toEqual(['Read a widget']);
    // A pending install is now in the registry.
    const listed = listInstalledPlugins();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ pluginId: 'com.acme.widget', status: 'pending', executionMode: 'runner' });
  });

  it('surfaces a verifier failure', async () => {
    setRepoProofVerifier(async () => ({
      ok: false,
      code: 'signature_invalid',
      transient: false,
      message: 'bad sig',
    }));
    const outcome = await beginPluginInstall(PUBLISHER, releaseRkeyFromCid(cidFor('x')) as string);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // A rejected proof is a permanent failure surfaced to the screen (the
      // exact code is mapped by install_service; here we pin the contract).
      expect(outcome.error.length).toBeGreaterThan(0);
      expect(outcome.transient).toBe(false);
    }
  });

  it('with no verifier wired the door is closed and says so — never "check the connection"', async () => {
    expect(pluginInstallAvailable()).toBe(false);
    const outcome = await beginPluginInstall(PUBLISHER, 'somekey');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.unavailable).toBe(true);
      expect(outcome.transient).toBe(false);
    }
    setRepoProofVerifier(fakeVerifier(runnerManifest()).verifier);
    expect(pluginInstallAvailable()).toBe(true);
  });

  it('uninstalling an unknown install says so', async () => {
    expect(await uninstallPlugin('nope')).toEqual({ ok: false, error: 'unknown_install' });
  });
});

describe('runner pairing before authority (PLUGIN_ARCHITECTURE §15.3)', () => {
  it('issues a setup code tied to THIS install with role plugin / scope runner fixed at initiate', async () => {
    const consent = await stagedRunner();
    const setup = issueRunnerSetupCode(consent);
    expect(setup.code).toMatch(/^[0-9A-Z]{8}$/);
    expect(setup.setupCode.startsWith('dina1:')).toBe(true);
    expect(setup.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(getPairingIntent(setup.code)).toEqual({
      deviceName: consent.pluginId,
      role: 'plugin',
      scope: 'runner',
      pluginInstallId: consent.installId,
    });
    // Nobody has paired yet.
    expect(checkRunnerPairing(consent.installId, setup.code)).toEqual({ state: 'waiting' });
  });

  it('refuses to activate a runner before it pairs — the phone never mints a key', async () => {
    const consent = await stagedRunner();
    issueRunnerSetupCode(consent);
    const result = await confirmPluginInstall(consent.installId, 'runner');
    expect(result).toEqual({ ok: false, error: 'the runner has not paired yet' });
    expect(listInstalledPlugins()[0]?.status).toBe('pending');
    // No device of any kind was registered on the phone's side.
    expect(deviceCount()).toBe(0);
  });

  it('Core binds the exact device that used the code; consent activates on it', async () => {
    const consent = await stagedRunner();
    const setup = issueRunnerSetupCode(consent);

    const runnerDid = runnerPairs(setup.code);
    // The phone only READS the bind Core made.
    expect(checkRunnerPairing(consent.installId, setup.code)).toEqual({ state: 'bound', deviceDid: runnerDid });
    expect(getDeviceByDID(runnerDid)?.role).toBe('plugin');

    const confirmed = await confirmPluginInstall(consent.installId, 'runner');
    expect(confirmed).toEqual({ ok: true });
    expect(listInstalledPlugins()[0]?.status).toBe('active');
  });

  it('a second code cannot bind a second runner to an install another runner already holds', async () => {
    const consent = await stagedRunner();
    const first = issueRunnerSetupCode(consent);
    const second = issueRunnerSetupCode(consent);
    const firstDid = runnerPairs(first.code);
    expect(() => runnerPairs(second.code)).toThrow(/already bound/);
    expect(checkRunnerPairing(consent.installId, first.code)).toEqual({ state: 'bound', deviceDid: firstDid });
    expect(deviceCount()).toBe(1);
  });

  it('reports an expired or unknown code so the screen issues a new one', async () => {
    const consent = await stagedRunner();
    expect(checkRunnerPairing(consent.installId, 'NEVERISS')).toEqual({ state: 'expired' });
  });

  it('a runner that pairs after the owner declined is refused by Core and leaves no device', async () => {
    const consent = await stagedRunner();
    const setup = issueRunnerSetupCode(consent);
    expect(await declinePluginInstall(consent.installId)).toEqual({ removed: true });
    expect(() => runnerPairs(setup.code)).toThrow(/no longer pending/);
    expect(deviceCount()).toBe(0);
    expect(checkRunnerPairing(consent.installId, setup.code).state).toBe('refused');
  });

  it('declining after the runner paired revokes that device and removes the row', async () => {
    const consent = await stagedRunner();
    const setup = issueRunnerSetupCode(consent);
    const runnerDid = runnerPairs(setup.code);
    expect(getDeviceByDID(runnerDid)?.revoked).toBe(false);

    expect(await declinePluginInstall(consent.installId)).toEqual({ removed: true });
    expect(listInstalledPlugins()).toEqual([]);
    expect(getDeviceByDID(runnerDid)?.revoked).toBe(true);
  });

  it('uninstalling an active runner install revokes its device and removes the row', async () => {
    const consent = await stagedRunner();
    const setup = issueRunnerSetupCode(consent);
    const runnerDid = runnerPairs(setup.code);
    expect(await confirmPluginInstall(consent.installId, 'runner')).toEqual({ ok: true });

    expect(await uninstallPlugin(consent.installId)).toEqual({ ok: true });
    expect(listInstalledPlugins()).toEqual([]);
    expect(getDeviceByDID(runnerDid)?.revoked).toBe(true);
  });

  it('declining a bare pending install (nothing paired) removes it', async () => {
    const consent = await stagedRunner();
    expect(await declinePluginInstall(consent.installId)).toEqual({ removed: true });
    expect(listInstalledPlugins()).toEqual([]);
  });

  it('a setup code for an install that is no longer a pending runner is refused', async () => {
    const consent = await stagedRunner();
    await declinePluginInstall(consent.installId);
    expect(() => issueRunnerSetupCode(consent)).toThrow(/no longer take a runner/);
  });
});

describe('the country packs enter through the first-party door (§5.D)', () => {
  it('stages a pack with no verifier, anchored on the local publisher key, ready for the runner ceremony', () => {
    expect(pluginInstallAvailable()).toBe(false);
    const outcome = beginCountryPackInstall('in');
    if (outcome.state !== 'staged') throw new Error(`expected staged: ${JSON.stringify(outcome)}`);
    expect(outcome.consent.pluginId).toBe('com.dinakernel.country.in');
    expect(outcome.consent.executionMode).toBe('runner');
    expect(outcome.consent.capabilities).toEqual([
      'Check whether a UPI payment settled',
      'Validate a GSTIN against the GST registry',
      'Generate an e-way bill for a delivery',
      'Send a WhatsApp reminder about a due payment or delivery',
    ]);
    const row = getPluginInstallRepository()?.getById(outcome.consent.installId) ?? null;
    expect(row?.status).toBe('pending');
    expect(row?.trustAnchor.kind).toBe('local_publisher_key');
    expect(row?.publisherDid).toBe(NODE_DID);

    // From here the ceremony is the one every runner plugin runs.
    const { code } = issueRunnerSetupCode(outcome.consent);
    const runnerDid = runnerPairs(code);
    expect(checkRunnerPairing(outcome.consent.installId, code)).toEqual({ state: 'bound', deviceDid: runnerDid });
  });

  it('a pack the owner already activated answers already_active — no second consent', async () => {
    const first = beginCountryPackInstall('us');
    if (first.state !== 'staged') throw new Error('expected staged');
    const runnerDid = runnerPairs(issueRunnerSetupCode(first.consent).code);
    expect(await confirmPluginInstall(first.consent.installId, 'runner')).toEqual({ ok: true });
    expect(getDeviceByDID(runnerDid)?.revoked).toBe(false);

    expect(beginCountryPackInstall('us')).toEqual({ state: 'already_active', installId: first.consent.installId });
    expect(listInstalledPlugins().filter((p) => p.pluginId === 'com.dinakernel.country.us')).toHaveLength(1);
  });

  it('without a node identity the door refuses and says to retry, staging nothing', () => {
    clearPairingState();
    const outcome = beginCountryPackInstall('in');
    expect(outcome).toEqual({ state: 'refused', error: expect.stringMatching(/not ready/), transient: true });
    expect(listInstalledPlugins()).toEqual([]);
  });
});
