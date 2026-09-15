/**
 * §5.C2 — the GENERAL plugin install / consent / uninstall routes (the
 * marketplace path), driven over a real registry on real SQLite. The begin
 * route authenticates a third-party release through the injected repo-proof
 * verifier (§5.C1), so this suite pins: an authentic release stages a pending
 * install and consent activates it; NO verifier fails closed (never TOFU); a
 * verifier rejection maps to a permanent 409; validation + the owner guard hold.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { base32Encode, releaseRkeyFromCid, PLUGIN_NSIDS } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { resetCallerTypeState } from '../../../src/auth/caller_type';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import {
  getDeviceByDID,
  listDevices,
  resetDeviceRegistry,
  revokePluginDeviceForTeardown,
} from '../../../src/devices/registry';
import { SQLiteDeviceRepository, setDeviceRepository } from '../../../src/devices/repository';
import { publicKeyToMultibase } from '../../../src/identity/did';
import { clearPairingState, completePairing, getPairingIntent, setNodeDID } from '../../../src/pairing/ceremony';
import {
  getPluginInstallRepository,
  SQLitePluginGrantRepository,
  SQLitePluginInstallRepository,
  setPluginDeviceVerifier,
  setPluginGrantRepository,
  setPluginInstallRepository,
  setRepoProofVerifier,
  sweepAbandonedInstalls,
} from '../../../src/plugins';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerPluginInstallRoutes } from '../../../src/server/routes/plugin_install';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';

import type { PluginManifest, RepoProofResult, RepoProofVerifier } from '@dina/protocol';

const OWNER_CAP = 'test-owner-capability-secret';
const PUBLISHER = 'did:plc:acmepublisher00000000000';

let dir: string;
let adapter: NodeSQLiteAdapter;
let router: CoreRouter;

function post(routePath: string, body: Record<string, unknown>, caller = 'owner'): CoreRequest {
  return {
    method: 'POST',
    path: routePath,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: caller,
    callerDID: 'did:key:caller',
    ...(caller === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
  } as CoreRequest;
}

const sha256 = (d: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(d).digest());

/** Real CIDv1 (dag-cbor, sha2-256) over a fixed body. */
function cidFor(seed: string): string {
  const digest = sha256(new TextEncoder().encode(seed));
  const bytes = new Uint8Array(36);
  bytes.set([0x01, 0x71, 0x12, 0x20], 0);
  bytes.set(digest, 4);
  return `b${base32Encode(bytes)}`;
}

// P0 ships the runner interpreter only, so a real release is runner-mode.
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

const NODE_DID = 'did:key:z6MkTestNodeDID';

/** The runner side of §15.3: pair with ITS OWN key using the issued code. Role +
 *  scope come from the code's intent, as `/v1/pair/complete` does. */
function runnerPairs(code: string): string {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  const publicKey = ed25519.getPublicKey(seed);
  const intent = getPairingIntent(code);
  completePairing(code, 'runner', publicKeyToMultibase(publicKey), intent?.role, intent?.scope);
  return `did:key:${publicKeyToMultibase(publicKey)}`;
}

/** A verifier returning the given manifest at a content-correct rkey. */
function fakeVerifier(manifest: PluginManifest, seed = 'v1'): { rkey: string; verifier: RepoProofVerifier } {
  const cid = cidFor(seed);
  const rkey = releaseRkeyFromCid(cid) as string;
  const verifier: RepoProofVerifier = async (req) =>
    req.rkey === rkey
      ? ({ ok: true, cid, rev: 'rev1', record: manifest } as RepoProofResult)
      : { ok: false, code: 'not_found', transient: false, message: 'no such release' };
  return { rkey, verifier };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'plugin-install-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  setPluginInstallRepository(new SQLitePluginInstallRepository(adapter));
  // A device revoke cascades into the install's grants and needs the SQL device
  // repository to be durable — wire both, as boot does.
  setPluginGrantRepository(new SQLitePluginGrantRepository(adapter));
  setDeviceRepository(new SQLiteDeviceRepository(adapter));
  // The boot-wired verifier: a REAL, unrevoked, role='plugin' registry entry.
  setPluginDeviceVerifier((did) => {
    const device = getDeviceByDID(did);
    return device !== null && !device.revoked && device.role === 'plugin';
  });
  setNodeDID(NODE_DID);
  router = new CoreRouter();
  registerPluginInstallRoutes(router, OWNER_CAP);
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

describe('POST /v1/plugins/install/* (§5.C2)', () => {
  it('an authentic release stages a pending install; the runner pairs on the issued code, consent activates on THAT device', async () => {
    const { rkey, verifier } = fakeVerifier(runnerManifest());
    setRepoProofVerifier(verifier);

    const begun = await router.handle(post('/v1/plugins/install/begin', {
      publisher_did: PUBLISHER,
      rkey,
    }));
    expect(begun.status).toBe(200);
    const body = begun.body as { ok: boolean; installId: string; consent: { pluginId: string } };
    expect(body.ok).toBe(true);
    expect(body.consent.pluginId).toBe('com.acme.widget');

    // §15.3 — the owner issues a code for THIS install; role/scope fixed at initiate.
    const issued = await router.handle(post('/v1/plugins/install/setup_code', { install_id: body.installId }));
    expect(issued.status).toBe(201);
    const { code } = issued.body as { code: string };
    expect(getPairingIntent(code)).toMatchObject({
      role: 'plugin',
      scope: 'runner',
      pluginInstallId: body.installId,
    });

    // Consent before the runner pairs is refused: nothing to activate on.
    const early = await router.handle(post('/v1/plugins/install/confirm', { install_id: body.installId }));
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ error: 'runner_not_paired' });

    // The runner pairs with its own key; Core binds it to the pending install.
    const runnerDid = runnerPairs(code);
    expect(getPluginInstallRepository()?.getById(body.installId)?.deviceDid).toBe(runnerDid);

    // The client cannot name a device at the final button (§15.4).
    const named = await router.handle(post('/v1/plugins/install/confirm', {
      install_id: body.installId,
      device_did: runnerDid,
    }));
    expect(named.status).toBe(400);

    const confirmed = await router.handle(post('/v1/plugins/install/confirm', { install_id: body.installId }));
    expect(confirmed.status).toBe(200);
    expect((confirmed.body as { status: string }).status).toBe('active');
    expect(getPluginInstallRepository()?.getById(body.installId)?.deviceDid).toBe(runnerDid);
  });

  it('setup_code refuses an unknown, non-pending, or non-runner install', async () => {
    const unknown = await router.handle(post('/v1/plugins/install/setup_code', { install_id: 'nope' }));
    expect(unknown.status).toBe(404);
    const { rkey, verifier } = fakeVerifier(runnerManifest());
    setRepoProofVerifier(verifier);
    const begun = await router.handle(post('/v1/plugins/install/begin', { publisher_did: PUBLISHER, rkey }));
    const installId = (begun.body as { installId: string }).installId;
    const issued = await router.handle(post('/v1/plugins/install/setup_code', { install_id: installId }));
    runnerPairs((issued.body as { code: string }).code);
    await router.handle(post('/v1/plugins/install/confirm', { install_id: installId }));
    const active = await router.handle(post('/v1/plugins/install/setup_code', { install_id: installId }));
    expect(active.status).toBe(409);
    expect(active.body).toMatchObject({ error: 'install_not_pending' });
  });

  it('setup_code refuses an expired pending install (the code would be dead on arrival)', async () => {
    const { rkey, verifier } = fakeVerifier(runnerManifest());
    setRepoProofVerifier(verifier);
    const begun = await router.handle(post('/v1/plugins/install/begin', { publisher_did: PUBLISHER, rkey }));
    const installId = (begun.body as { installId: string }).installId;
    adapter.execute('UPDATE plugin_installs SET pending_expires_at = ? WHERE install_id = ?', [
      Math.floor(Date.now() / 1000) - 1,
      installId,
    ]);
    const issued = await router.handle(post('/v1/plugins/install/setup_code', { install_id: installId }));
    expect(issued.status).toBe(409);
    expect(issued.body).toMatchObject({ error: 'install_expired' });
  });

  it('a runner that pairs after the install was declined is refused and leaves no device', async () => {
    const { rkey, verifier } = fakeVerifier(runnerManifest());
    setRepoProofVerifier(verifier);
    const begun = await router.handle(post('/v1/plugins/install/begin', { publisher_did: PUBLISHER, rkey }));
    const installId = (begun.body as { installId: string }).installId;
    const issued = await router.handle(post('/v1/plugins/install/setup_code', { install_id: installId }));
    const { code } = issued.body as { code: string };

    const declined = await router.handle(post('/v1/plugins/install/decline', { install_id: installId }));
    expect(declined.status).toBe(200);

    expect(() => runnerPairs(code)).toThrow(/no longer pending/);
    // Nothing was registered: no orphan plugin device.
    expect(listPluginDevices()).toEqual([]);
  });

  it('a second code cannot bind a second runner to an install another runner already holds', async () => {
    const { rkey, verifier } = fakeVerifier(runnerManifest());
    setRepoProofVerifier(verifier);
    const begun = await router.handle(post('/v1/plugins/install/begin', { publisher_did: PUBLISHER, rkey }));
    const installId = (begun.body as { installId: string }).installId;
    const first = (await router.handle(post('/v1/plugins/install/setup_code', { install_id: installId }))).body as { code: string };
    const second = (await router.handle(post('/v1/plugins/install/setup_code', { install_id: installId }))).body as { code: string };
    const firstDid = runnerPairs(first.code);
    expect(() => runnerPairs(second.code)).toThrow(/already bound/);
    expect(getPluginInstallRepository()?.getById(installId)?.deviceDid).toBe(firstDid);
    expect(listPluginDevices()).toEqual([firstDid]);
  });

  it('fails CLOSED with no verifier wired — never trust-on-first-use', async () => {
    setRepoProofVerifier(null);
    const { rkey } = fakeVerifier(runnerManifest());
    const res = await router.handle(post('/v1/plugins/install/begin', {
      publisher_did: PUBLISHER,
      rkey,
    }));
    expect(res.status).toBe(503);
  });

  it('maps a verifier rejection to a permanent 409', async () => {
    setRepoProofVerifier(async () => ({
      ok: false,
      code: 'signature_invalid',
      transient: false,
      message: 'bad sig',
    }));
    const res = await router.handle(post('/v1/plugins/install/begin', {
      publisher_did: PUBLISHER,
      rkey: releaseRkeyFromCid(cidFor('x')) as string,
    }));
    expect(res.status).toBe(409);
  });

  it('requires publisher_did and rkey (400)', async () => {
    const res = await router.handle(post('/v1/plugins/install/begin', { rkey: 'r' }));
    expect(res.status).toBe(400);
  });

  it('is owner-only (403 for a non-owner caller)', async () => {
    const res = await router.handle(
      post('/v1/plugins/install/begin', { publisher_did: PUBLISHER, rkey: 'r' }, 'device'),
    );
    expect(res.status).toBe(403);
  });

  it('declining / uninstalling an unknown install is 404', async () => {
    const declined = await router.handle(post('/v1/plugins/install/decline', { install_id: 'nope' }));
    expect(declined.status).toBe(404);
    const removed = await router.handle(post('/v1/plugins/install/uninstall', { install_id: 'nope' }));
    expect(removed.status).toBe(404);
  });
});

/** Every unrevoked plugin-role device DID the registry holds. */
function listPluginDevices(): string[] {
  return listDevices()
    .filter((device) => device.role === 'plugin' && !device.revoked)
    .map((device) => device.did);
}

describe('POST /v1/plugins/install/country_pack — the first-party door (§5.D)', () => {
  it('stages a pending India pack, pairs its runner, and consents; a second call answers the active install', async () => {
    const begun = await router.handle(post('/v1/plugins/install/country_pack', { pack: 'in' }));
    expect(begun.status).toBe(200);
    const body = begun.body as { ok: boolean; installId: string; consent: { pluginId: string } };
    expect(body.consent.pluginId).toBe('com.dinakernel.country.in');
    expect(getPluginInstallRepository()?.getById(body.installId)?.trustAnchor.kind).toBe('local_publisher_key');

    const issued = await router.handle(post('/v1/plugins/install/setup_code', { install_id: body.installId }));
    expect(issued.status).toBe(201);
    runnerPairs((issued.body as { code: string }).code);
    const confirmed = await router.handle(post('/v1/plugins/install/confirm', { install_id: body.installId }));
    expect(confirmed.status).toBe(200);

    const again = await router.handle(post('/v1/plugins/install/country_pack', { pack: 'in' }));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, installId: body.installId, status: 'active' });
  });

  it('refuses an unknown pack and a non-owner', async () => {
    expect((await router.handle(post('/v1/plugins/install/country_pack', { pack: 'uk' }))).status).toBe(400);
    expect((await router.handle(post('/v1/plugins/install/country_pack', { pack: 'in' }, 'device'))).status).toBe(403);
  });

  it('a second begin while the first is still pending stages a NEW consent — a pending row is never reused', async () => {
    const first = await router.handle(post('/v1/plugins/install/country_pack', { pack: 'in' }));
    const second = await router.handle(post('/v1/plugins/install/country_pack', { pack: 'in' }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (first.body as { installId: string }).installId;
    const b = (second.body as { installId: string }).installId;
    expect(a).not.toBe(b);
    const rows = (getPluginInstallRepository()?.list() ?? []).filter((r) => r.pluginId === 'com.dinakernel.country.in');
    expect(rows.map((r) => r.status)).toEqual(['pending', 'pending']);
  });

  it('with no node identity yet the door answers 503 and stages nothing — a retry, not a refusal', async () => {
    clearPairingState();
    const begun = await router.handle(post('/v1/plugins/install/country_pack', { pack: 'us' }));
    expect(begun.status).toBe(503);
    expect(begun.body).toEqual({ error: 'owner_identity_unavailable' });
    expect(getPluginInstallRepository()?.list() ?? []).toEqual([]);
  });

  it('takes neither a manifest nor a publisher from the body — the build vouches for its own pack', async () => {
    const begun = await router.handle(
      post('/v1/plugins/install/country_pack', {
        pack: 'us',
        manifest: { plugin_id: 'com.acme.evil', execution: { mode: 'runner' }, capabilities: [] },
        publisher_did: 'did:plc:stranger',
      }),
    );
    expect(begun.status).toBe(200);
    const row = getPluginInstallRepository()?.getById((begun.body as { installId: string }).installId) ?? null;
    expect(row?.pluginId).toBe('com.dinakernel.country.us');
    expect(row?.publisherDid).toBe(NODE_DID);
    expect(row?.manifest.capabilities.map((c) => c.id)).toContain('com.dinakernel.country.us.settlement-status');
  });
});

describe('POST /v1/plugins/install/{decline,uninstall} — the §15.3 cleanup path', () => {
  /** Stage a pending runner install and pair a runner into it. */
  async function boundPending(): Promise<{ installId: string; runnerDid: string }> {
    const { rkey, verifier } = fakeVerifier(runnerManifest());
    setRepoProofVerifier(verifier);
    const begun = await router.handle(post('/v1/plugins/install/begin', { publisher_did: PUBLISHER, rkey }));
    const installId = (begun.body as { installId: string }).installId;
    const issued = await router.handle(post('/v1/plugins/install/setup_code', { install_id: installId }));
    const runnerDid = runnerPairs((issued.body as { code: string }).code);
    return { installId, runnerDid };
  }

  it('declining a pending install revokes the runner device it paired and removes the row', async () => {
    const revoked: string[] = [];
    router = new CoreRouter();
    registerPluginInstallRoutes(router, OWNER_CAP, async (did) => {
      revoked.push(did);
      return { durable: true };
    });
    const { installId, runnerDid } = await boundPending();

    const res = await router.handle(post('/v1/plugins/install/decline', { install_id: installId }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, removed: true, deviceDid: runnerDid, deviceRevoked: true });
    expect(revoked).toEqual([runnerDid]);
    expect(getPluginInstallRepository()?.getById(installId)).toBeNull();
  });

  it('uninstalling an active runner install revokes its device', async () => {
    const revoked: string[] = [];
    router = new CoreRouter();
    registerPluginInstallRoutes(router, OWNER_CAP, async (did) => {
      revoked.push(did);
      return { durable: true };
    });
    const { installId, runnerDid } = await boundPending();
    const confirmed = await router.handle(post('/v1/plugins/install/confirm', { install_id: installId }));
    expect(confirmed.status).toBe(200);

    const res = await router.handle(post('/v1/plugins/install/uninstall', { install_id: installId }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, removed: true, deviceRevoked: true });
    expect(revoked).toEqual([runnerDid]);
    expect(getPluginInstallRepository()?.getById(installId)).toBeNull();
  });

  it('a teardown whose device revoke is not durable is 409 and keeps the row as the retry anchor', async () => {
    router = new CoreRouter();
    registerPluginInstallRoutes(router, OWNER_CAP, async () => ({ durable: false }));
    const { installId } = await boundPending();

    const res = await router.handle(post('/v1/plugins/install/uninstall', { install_id: installId }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'teardown_incomplete', removed: false, deviceRevoked: false });
    // Authority is gone (tombstoned) but the row stays so the sweeper can retry the revoke.
    expect(getPluginInstallRepository()?.getById(installId)?.status).toBe('revoked');
  });

  it('a non-durable revoke on an ACTIVE install is tombstoned too, so the sweep can finish it', async () => {
    router = new CoreRouter();
    registerPluginInstallRoutes(router, OWNER_CAP, async () => ({ durable: false }));
    const { installId, runnerDid } = await boundPending();
    expect((await router.handle(post('/v1/plugins/install/confirm', { install_id: installId }))).status).toBe(200);

    const res = await router.handle(post('/v1/plugins/install/uninstall', { install_id: installId }));
    expect(res.status).toBe(409);
    expect(getPluginInstallRepository()?.getById(installId)?.status).toBe('revoked');

    // The sweep retries the revoke (durable now) and removes the anchor.
    const swept = await sweepAbandonedInstalls(Math.floor(Date.now() / 1000) + 1, revokePluginDeviceForTeardown);
    expect(swept.map((ref) => ref.installId)).toContain(installId);
    expect(getPluginInstallRepository()?.getById(installId)).toBeNull();
    expect(getDeviceByDID(runnerDid)?.revoked).toBe(true);
  });

  it('with no injected revoker, the production default durably revokes the paired device', async () => {
    // `registerPluginInstallRoutes(router, OWNER_CAP)` in beforeEach = the production default.
    const { installId, runnerDid } = await boundPending();
    expect(getDeviceByDID(runnerDid)?.revoked).toBe(false);
    const res = await router.handle(post('/v1/plugins/install/decline', { install_id: installId }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, removed: true, deviceRevoked: true });
    expect(getPluginInstallRepository()?.getById(installId)).toBeNull();
    expect(getDeviceByDID(runnerDid)?.revoked).toBe(true);
    expect(listPluginDevices()).toEqual([]);
  });

  it('declining an ACTIVE install says it is live (409), not that it is unknown', async () => {
    const { installId, runnerDid } = await boundPending();
    expect((await router.handle(post('/v1/plugins/install/confirm', { install_id: installId }))).status).toBe(200);
    const res = await router.handle(post('/v1/plugins/install/decline', { install_id: installId }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'install_not_pending', status: 'active' });
    expect(getPluginInstallRepository()?.getById(installId)?.status).toBe('active');
    expect(getDeviceByDID(runnerDid)?.revoked).toBe(false);
  });

  it('open commerce obligations refuse the uninstall as 409 obligations_open, never a 500', async () => {
    const { installId } = await boundPending();
    expect((await router.handle(post('/v1/plugins/install/confirm', { install_id: installId }))).status).toBe(200);
    // §16.4 — an order this install is serving is still open.
    installCommerceRuntime({ inFlightCount: () => 1 } as unknown as CommerceRuntime);
    try {
      const res = await router.handle(post('/v1/plugins/install/uninstall', { install_id: installId }));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'obligations_open' });
      expect(getPluginInstallRepository()?.getById(installId)?.status).toBe('active');
    } finally {
      installCommerceRuntime(null);
    }
  });

  it('every route is owner-only', async () => {
    for (const routePath of ['setup_code', 'confirm', 'decline', 'uninstall']) {
      const res = await router.handle(post(`/v1/plugins/install/${routePath}`, { install_id: 'x' }, 'device'));
      expect(res.status).toBe(403);
    }
  });
});
