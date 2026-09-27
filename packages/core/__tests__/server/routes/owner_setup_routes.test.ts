/**
 * WEB_OWNER_SURFACE_PLAN §3.5, §3.8 — the owner's devices on Core's router:
 * one set of routes for the phone (in-process), the web app and the server
 * console. Driven through `createCoreRouter` with the real device registry
 * and pairing ceremony.
 *
 * Pinned: only the owner reaches them; minting needs a person present,
 * revoking does not; each code pairs exactly the role and name it says; a
 * typed revoke touches only its kind; the Agents list sees every device,
 * revoked ones included; a revoke that did not persist says so.
 */

import {
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  proveOwnerPresence,
  OWNER_IN_PROCESS_PRINCIPAL,
} from '../../../src/commerce/owner_presence';
import { getPublicKey } from '../../../src/crypto/ed25519';
import { getDevice, resetDeviceRegistry, type PairedDevice } from '../../../src/devices/registry';
import { setDeviceRepository, type DeviceRepository } from '../../../src/devices/repository';
import { publicKeyToMultibase } from '../../../src/identity/did';
import {
  clearPairingState,
  completePairing,
  generatePairingCode,
  getPairingIntent,
  setNodeDID,
  setNodeSigningPublicKey,
} from '../../../src/pairing/ceremony';
import { parseAgentSetupCode } from '../../../src/pairing/setup_code';
import { createCoreRouter } from '../../../src/server/core_server';

import type { CoreRequest, CoreResponse } from '../../../src/server/router';

const CAP = 'owner-capability-for-owner-setup-0123456789';
const NODE_DID = 'did:plc:owner-setup-routes';
const NODE_PUB = new Uint8Array(32).fill(7);
const RELAY = 'wss://mailbox.example/ws';

const router = createCoreRouter({
  ownerCapability: CAP,
  ownerSetup: { msgboxURL: () => RELAY, extraStatus: () => ({ phone: { state: 'unpaired' } }) },
});

function request(
  method: CoreRequest['method'],
  path: string,
  body: Record<string, unknown> | undefined,
  as: 'owner' | 'unstamped' | 'wrong-capability',
): CoreRequest {
  return {
    method,
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(as === 'owner' ? { callerType: 'owner', ownerCapability: CAP } : {}),
    ...(as === 'wrong-capability' ? { callerType: 'owner', ownerCapability: `${CAP}x` } : {}),
  };
}

const owner = (method: CoreRequest['method'], path: string, body?: Record<string, unknown>) =>
  router.handle(request(method, `/v1/owner/setup${path}`, body, 'owner'));

function errorOf(res: CoreResponse): string {
  return (res.body as { error?: string } | undefined)?.error ?? '';
}

/** An in-memory store, so pairing persists and a revoke can report durable. */
let persistRevokes = true;
function memoryRepository(): DeviceRepository {
  const rows = new Map<string, PairedDevice>();
  return {
    register: async (d) => void rows.set(d.deviceId, { ...d }),
    get: async (id) => rows.get(id) ?? null,
    getByPublicKey: async (k) => [...rows.values()].find((d) => d.publicKeyMultibase === k) ?? null,
    getByDID: async (did) => [...rows.values()].find((d) => d.did === did) ?? null,
    list: async () => [...rows.values()],
    revoke: async (id) => {
      if (!persistRevokes) throw new Error('disk full');
      const row = rows.get(id);
      if (row === undefined) return false;
      row.revoked = true;
      return true;
    },
    touch: async () => undefined,
  };
}

let seedByte = 1;
async function pairDevice(
  role: PairedDevice['role'],
  name: string,
  scope?: 'coding' | 'runner',
): Promise<PairedDevice> {
  const seed = new Uint8Array(32).fill(seedByte++);
  const { code } = generatePairingCode({ deviceName: name, role, ...(scope ? { scope } : {}) });
  const result = await completePairing(
    code,
    name,
    publicKeyToMultibase(getPublicKey(seed)),
    role,
    scope,
  );
  const device = getDevice(result.deviceId);
  if (device === null) throw new Error('pairing did not register');
  return device;
}

beforeEach(() => {
  resetDeviceRegistry();
  clearPairingState();
  setDeviceRepository(memoryRepository());
  persistRevokes = true;
  setNodeDID(NODE_DID);
  setNodeSigningPublicKey(NODE_PUB);
  installOwnerPresenceVerifier(async (p) => p === 'correct horse');
});

afterEach(() => {
  clearOwnerPresence();
  installOwnerPresenceVerifier(null);
  setNodeSigningPublicKey(null);
  setDeviceRepository(null);
  resetDeviceRegistry();
  clearPairingState();
});

async function present(): Promise<void> {
  expect(await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL)).toBe(
    true,
  );
}

describe('only the owner', () => {
  it.each([
    ['GET', '/status', undefined],
    ['POST', '/coding-agent', {}],
    ['POST', '/staff', { device_name: 'till' }],
    ['POST', '/owner-device', { device_name: 'laptop' }],
    ['DELETE', '/staff/x', undefined],
    ['DELETE', '/device/x', undefined],
  ] as const)('%s %s refuses an unstamped or mis-stamped caller', async (method, path, body) => {
    for (const as of ['unstamped', 'wrong-capability'] as const) {
      const res = await router.handle(request(method, `/v1/owner/setup${path}`, body, as));
      expect([as, res.status, errorOf(res)]).toEqual([as, 403, 'access_denied']);
    }
  });

  it('a router built without the option has no such routes (Brain’s own router)', async () => {
    const bare = createCoreRouter({ ownerCapability: CAP });
    const res = await bare.handle(request('GET', '/v1/owner/setup/status', undefined, 'owner'));
    expect(res.status).toBe(404);
  });
});

describe('minting needs a person present', () => {
  it.each([
    ['/coding-agent', {}],
    ['/staff', { device_name: 'Clerk phone' }],
    ['/owner-device', { device_name: 'Office laptop' }],
  ] as const)('%s: refused until presence is proven, then minted', async (path, body) => {
    const refused = await owner('POST', path, body);
    expect([refused.status, errorOf(refused)]).toEqual([403, 'no_user_presence']);
    await present();
    expect((await owner('POST', path, body)).status).toBe(201);
  });
});

describe('each code pairs exactly what it says', () => {
  beforeEach(present);

  it('a coding agent: default name, or the owner’s; coding scope; the node’s relay', async () => {
    const plain = await owner('POST', '/coding-agent', {});
    expect(plain.headers?.['cache-control']).toBe('no-store');
    const named = await owner('POST', '/coding-agent', { device_name: '  Laptop Claude ' });
    for (const [res, name] of [
      [plain, 'coding-agent'],
      [named, 'Laptop Claude'],
    ] as const) {
      const body = res.body as { setup_code: string; device_name: string };
      expect(body.device_name).toBe(name);
      const parsed = parseAgentSetupCode(body.setup_code);
      expect(parsed).toMatchObject({ msgboxUrl: RELAY, homenodeDid: NODE_DID, deviceName: name });
      expect(getPairingIntent(parsed.code)).toEqual({
        deviceName: name,
        role: 'agent',
        scope: 'coding',
      });
    }
  });

  it('a staff phone: the owner names it; the code carries the node’s signing key', async () => {
    for (const bad of ['', '   ', 'x'.repeat(65), 'tab\there', 42]) {
      expect((await owner('POST', '/staff', { device_name: bad })).status).toBe(400);
    }
    const res = await owner('POST', '/staff', { device_name: ' Jiffy till ' });
    expect(res.status).toBe(201);
    const body = res.body as { setup_code: string; device_name: string };
    expect(body.device_name).toBe('Jiffy till');
    const parsed = parseAgentSetupCode(body.setup_code);
    expect(parsed.nodeSigningPubHex).toBe('07'.repeat(32));
    expect(getPairingIntent(parsed.code)).toEqual({
      deviceName: 'Jiffy till',
      role: 'staff',
      scope: undefined,
    });
  });

  it('no staff code while the node’s signing key is unknown: the phone could not use it', async () => {
    setNodeSigningPublicKey(null);
    const res = await owner('POST', '/staff', { device_name: 'till' });
    expect(res.status).toBe(503);
  });

  it('an owner device: a bare pairing code carrying role owner', async () => {
    const res = await owner('POST', '/owner-device', { device_name: 'Office laptop' });
    const body = res.body as { code: string; device_name: string };
    expect(getPairingIntent(body.code)).toEqual({
      deviceName: 'Office laptop',
      role: 'owner',
      scope: undefined,
    });
  });
});

describe('the list and the revokes', () => {
  it('status lists each kind, and every device (revoked included) for the Agents list', async () => {
    const agent = await pairDevice('agent', 'Claude', 'coding');
    const clerk = await pairDevice('staff', 'Clerk phone');
    const laptop = await pairDevice('owner', 'Office laptop');
    const cli = await pairDevice('cli', 'Old CLI');
    expect((await owner('DELETE', `/device/${cli.deviceId}`)).status).toBe(204);

    const res = await owner('GET', '/status');
    const body = res.body as Record<string, { device_id: string; revoked?: boolean }[] | unknown>;
    expect(body.home_did).toBe(NODE_DID);
    expect(body.msgbox_url).toBe(RELAY);
    expect(body.phone).toEqual({ state: 'unpaired' });
    const ids = (key: string) => (body[key] as { device_id: string }[]).map((d) => d.device_id);
    expect(ids('coding_agents')).toEqual([agent.deviceId]);
    expect(ids('staff_devices')).toEqual([clerk.deviceId]);
    expect(ids('owner_devices')).toEqual([laptop.deviceId]);
    const all = body.devices as {
      device_id: string;
      role: string;
      revoked: boolean;
      scope?: string;
    }[];
    expect(all.map((d) => [d.device_id, d.role, d.revoked])).toEqual(
      expect.arrayContaining([
        [agent.deviceId, 'agent', false],
        [clerk.deviceId, 'staff', false],
        [laptop.deviceId, 'owner', false],
        [cli.deviceId, 'cli', true],
      ]),
    );
    expect(all.find((d) => d.device_id === agent.deviceId)?.scope).toBe('coding');
  });

  it('a typed revoke touches only its kind, and needs no presence', async () => {
    const clerk = await pairDevice('staff', 'Clerk phone');
    const laptop = await pairDevice('owner', 'Office laptop');
    // Presence can be established but was never proven: revoking still works.
    expect((await owner('DELETE', `/staff/${laptop.deviceId}`)).status).toBe(404);
    expect((await owner('DELETE', `/owner-device/${clerk.deviceId}`)).status).toBe(404);
    expect(getDevice(laptop.deviceId)?.revoked).toBe(false);
    expect((await owner('DELETE', `/owner-device/${laptop.deviceId}`)).status).toBe(204);
    expect(getDevice(laptop.deviceId)?.revoked).toBe(true);
    // Gone is gone: a second revoke finds nothing.
    expect(errorOf(await owner('DELETE', `/owner-device/${laptop.deviceId}`))).toBe(
      'owner_device_not_found',
    );
  });

  it('a revoke that did not persist says so, and access is cut anyway', async () => {
    const laptop = await pairDevice('owner', 'Office laptop');
    persistRevokes = false;
    const res = await owner('DELETE', `/owner-device/${laptop.deviceId}`);
    expect([res.status, errorOf(res)]).toEqual([503, 'owner_device_revoke_not_durable']);
    expect(getDevice(laptop.deviceId)?.revoked).toBe(true);
  });

  it('a staff phone’s revoke must also end its grants: with nothing to end them, it is not durable', async () => {
    // This harness wires no commerce runtime, so the staff-grant cascade
    // cannot run; the route reports it rather than claiming a clean revoke.
    const clerk = await pairDevice('staff', 'Clerk phone');
    const res = await owner('DELETE', `/staff/${clerk.deviceId}`);
    expect([res.status, errorOf(res)]).toEqual([503, 'staff_device_revoke_not_durable']);
    expect(getDevice(clerk.deviceId)?.revoked).toBe(true);
  });

  it('the generic revoke takes any device, and 404s an unknown one', async () => {
    const cli = await pairDevice('cli', 'Old CLI');
    expect((await owner('DELETE', '/device/no-such')).status).toBe(404);
    expect((await owner('DELETE', `/device/${cli.deviceId}`)).status).toBe(204);
  });
});
