/**
 * WEB_OWNER_SURFACE_PLAN §3.5 — the owner-setup client against Core's REAL
 * routes (the phone's in-process dispatcher into `createCoreRouter`, the real
 * device registry, pairing route and SQLite device and supervision stores).
 *
 * The client insists on exact status codes (201 for a mint, 204 for a revoke,
 * 201 or 200 for a supervision choice). A route whose code drifted would break
 * the Agents screen while every screen test, which mocks this client, stayed
 * green; this pins the two together.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { setAgentGatingPolicyRepository } from '../../src/agent/gating_policy';
import { SQLiteAgentGatingPolicyRepository } from '../../src/agent/gating_policy_repository';
import {
  SQLiteAgentGrantRepository,
  setAgentGrantRepository,
} from '../../src/agent/grant_repository';
import { inProcessOwnerDispatcher } from '../../src/client/owner-dispatch';
import { OwnerSetupClient, OwnerSetupHttpError } from '../../src/client/owner-setup-client';
import {
  OWNER_IN_PROCESS_PRINCIPAL,
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  proveOwnerPresence,
} from '../../src/commerce/owner_presence';
import { getPublicKey } from '../../src/crypto/ed25519';
import { getDevice, resetDeviceRegistry } from '../../src/devices/registry';
import { SQLiteDeviceRepository, setDeviceRepository } from '../../src/devices/repository';
import { publicKeyToMultibase } from '../../src/identity/did';
import { clearPairingState, setNodeDID, setNodeSigningPublicKey } from '../../src/pairing/ceremony';
import { parseAgentSetupCode } from '../../src/pairing/setup_code';
import { createCoreRouter } from '../../src/server/core_server';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const CAP = 'owner-capability-for-setup-client-0123456789';
const RELAY = 'wss://mailbox.example/ws';

const router = createCoreRouter({ ownerCapability: CAP, ownerSetup: { msgboxURL: () => RELAY } });
const setup = new OwnerSetupClient(inProcessOwnerDispatcher(router, CAP));

let dir: string;
let adapter: NodeSQLiteAdapter;

beforeEach(() => {
  resetDeviceRegistry();
  clearPairingState();
  setNodeDID('did:plc:setup-client-owner');
  setNodeSigningPublicKey(new Uint8Array(32).fill(3));
  installOwnerPresenceVerifier(async (p) => p === 'correct horse');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-setup-client-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  setDeviceRepository(new SQLiteDeviceRepository(adapter));
  setAgentGrantRepository(new SQLiteAgentGrantRepository(adapter));
  setAgentGatingPolicyRepository(new SQLiteAgentGatingPolicyRepository(adapter));
});

afterEach(() => {
  setAgentGatingPolicyRepository(null);
  setAgentGrantRepository(null);
  setDeviceRepository(null);
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
  clearOwnerPresence();
  installOwnerPresenceVerifier(null);
  setNodeSigningPublicKey(null);
  resetDeviceRegistry();
  clearPairingState();
});

/** Complete a minted code the way the device does: the public pairing route, a fresh key. */
async function redeem(setupCode: string): Promise<string> {
  const payload = parseAgentSetupCode(setupCode);
  const seed = new Uint8Array(randomBytes(32));
  const body = {
    code: payload.code,
    public_key_multibase: publicKeyToMultibase(getPublicKey(seed)),
  };
  const res = await router.handle({
    method: 'POST',
    path: '/v1/pair/complete',
    query: {},
    headers: {},
    body,
    rawBody: new TextEncoder().encode(JSON.stringify(body)),
    params: {},
  });
  expect(res.status).toBe(201);
  return (res.body as { device_id: string }).device_id;
}

const present = (): Promise<boolean> =>
  proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);

describe('minting', () => {
  it.each([
    ['a coding agent', () => setup.mintCodingAgentCode('Laptop Claude')],
    ['a staff phone', () => setup.mintStaffCode('Till')],
    ['an owner device', () => setup.mintOwnerDeviceCode('Office laptop')],
  ])('%s: raised with no_user_presence until proven, then 201', async (_label, mint) => {
    const refused = mint();
    await expect(refused).rejects.toBeInstanceOf(OwnerSetupHttpError);
    await expect(mint()).rejects.toMatchObject({ status: 403, errorKey: 'no_user_presence' });
    expect(await present()).toBe(true);
    await expect(mint()).resolves.toMatchObject({ expires_at: expect.any(Number) });
  });

  it('a coding agent with no name is named by the node', async () => {
    await present();
    const minted = await setup.mintCodingAgentCode();
    expect(minted.device_name).toBe('coding-agent');
    expect(parseAgentSetupCode(minted.setup_code).msgboxUrl).toBe(RELAY);
  });
});

describe('status and revoking', () => {
  it('status lists each kind; the typed revoke and the generic one answer 204', async () => {
    await present();
    const first = await redeem((await setup.mintCodingAgentCode('Laptop Claude')).setup_code);
    const second = await redeem((await setup.mintCodingAgentCode('CI runner')).setup_code);
    const staffId = await redeem((await setup.mintStaffCode('Till')).setup_code);
    const status = await setup.status();
    expect(status.coding_agents.map((d) => d.device_id).sort()).toEqual([first, second].sort());
    expect(status.staff_devices.map((d) => d.device_id)).toEqual([staffId]);
    expect(status.devices.map((d) => d.device_id).sort()).toEqual([first, second, staffId].sort());

    // (A staff device's revoke also retires its grants, which needs the
    // commerce runtime; owner_setup_routes.test.ts pins that answer.)
    await setup.revokeCodingAgent(first);
    await setup.revokeDevice(second);
    expect(getDevice(first)?.revoked).toBe(true);
    expect(getDevice(second)?.revoked).toBe(true);
    expect((await setup.status()).devices.filter((d) => d.revoked)).toHaveLength(2);
  });

  it('a typed revoke of the wrong kind is raised with the route’s key', async () => {
    await present();
    const staffId = await redeem((await setup.mintStaffCode('Till')).setup_code);
    await expect(setup.revokeCodingAgent(staffId)).rejects.toMatchObject({
      errorKey: expect.stringMatching(/not_found/),
    });
    expect(getDevice(staffId)?.revoked).toBe(false);
  });
});

describe('supervision', () => {
  it('pairing sets version 1; tightening is 200 with no proof, lowering needs presence, a stale version is 409', async () => {
    await present();
    const agentId = await redeem((await setup.mintCodingAgentCode('Laptop Claude')).setup_code);
    const did = getDevice(agentId)?.did ?? '';
    clearOwnerPresence();

    const paired = (await setup.agentPolicies()).policies.find((p) => p.agent_did === did);
    expect(paired?.policy_version).toBe(1);

    const tightened = await setup.setAgentPolicy(did, 'full_supervision', 1);
    expect(tightened).toMatchObject({ profile: 'full_supervision', policy_version: 2 });
    await expect(setup.setAgentPolicy(did, 'network_protection', 2)).rejects.toMatchObject({
      status: 403,
      errorKey: 'no_user_presence',
    });
    await present();
    const lowered = await setup.setAgentPolicy(did, 'network_protection', 2);
    expect(lowered).toMatchObject({ profile: 'network_protection', policy_version: 3 });
    await expect(setup.setAgentPolicy(did, 'full_supervision', 2)).rejects.toMatchObject({
      status: 409,
    });
    const listed = await setup.agentPolicies();
    expect(listed.policies.find((p) => p.agent_did === did)?.profile).toBe('network_protection');
  });

  it('a first choice for an agent with no policy is 201', async () => {
    await present();
    const agentId = await redeem((await setup.mintCodingAgentCode('Laptop Claude')).setup_code);
    const did = getDevice(agentId)?.did ?? '';
    // An agent paired before policies existed has none.
    adapter.execute('DELETE FROM agent_gating_policies WHERE agent_did = ?', [did]);
    const first = await setup.setAgentPolicy(did, 'full_supervision', null);
    expect(first).toMatchObject({ agent_did: did, profile: 'full_supervision', policy_version: 1 });
  });
});
