/**
 * The server's owner-setup surface, as boot wires it (WEB_OWNER_SURFACE_PLAN
 * §3.5): the owner's devices are Core routes bound through the adapter, and
 * the approval phone is a server-only Fastify route whose state joins their
 * status. The device routes themselves are pinned in @dina/core
 * (`owner_setup_routes.test.ts`); this pins the wiring and the phone.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import {
  clearOwnerPresence,
  clearPairingState,
  createCoreRouter,
  getPairingIntent,
  installOwnerPresenceVerifier,
  OWNER_SETUP_PREFIX,
  proveOwnerPresence,
  setNodeDID,
  setNodeSigningPublicKey,
  OWNER_CAPABILITY_PRINCIPAL,
} from '@dina/core';

import {
  phoneStatusForOwnerSetup,
  registerApprovalPhoneRoutes,
  type PhoneApprovalLifecycle,
} from '../src/server/approval_phone_routes';
import { bindCoreRouter, type OwnerDeviceAuth } from '../src/server/bind_core_router';

const CAP = 'owner-secret-for-approval-phone-test';
const OWNER = { 'x-dina-owner-capability': CAP };

function fakePhone(): PhoneApprovalLifecycle {
  let state: 'unpaired' | 'active' | 'revoking' = 'unpaired';
  return {
    status: () => ({ configured: state === 'active', state }),
    pair: jest.fn(async () => {
      state = 'active';
      return {
        configured: true,
        state,
        phoneDid: 'did:plc:phone',
        deviceDid: 'did:key:approval-child',
      };
    }),
    revoke: jest.fn(async () => {
      state = 'unpaired';
      return { configured: false, state };
    }),
  };
}

/** Core's router + the adapter + the phone route, as boot builds them. */
async function server(
  phone: PhoneApprovalLifecycle | null,
  ownerDeviceAuth?: OwnerDeviceAuth,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  bindCoreRouter({
    coreRouter: createCoreRouter({
      ownerCapability: CAP,
      ownerSetup: {
        msgboxURL: () => 'wss://mailbox.example/ws',
        extraStatus: () => phoneStatusForOwnerSetup(phone),
      },
    }),
    app: app as never,
    ownerCapability: CAP,
    ...(ownerDeviceAuth === undefined ? {} : { ownerDeviceAuth }),
  });
  registerApprovalPhoneRoutes(app as never, {
    enabled: true,
    ownerCapability: CAP,
    phoneManager: phone,
    ...(ownerDeviceAuth === undefined ? {} : { ownerDeviceAuth }),
  });
  await app.ready();
  return app;
}

beforeEach(() => {
  clearPairingState();
  setNodeDID('did:plc:approval-phone-test');
  setNodeSigningPublicKey(new Uint8Array(32).fill(7));
  installOwnerPresenceVerifier(async (p) => p === 'correct horse');
});

afterEach(() => {
  clearOwnerPresence();
  installOwnerPresenceVerifier(null);
  setNodeSigningPublicKey(null);
  clearPairingState();
});

describe('the owner-setup surface over HTTP', () => {
  it('status is Core’s answer with this node’s approval phone joined in, no-store', async () => {
    const phone = fakePhone();
    const app = await server(phone);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `${OWNER_SETUP_PREFIX}/status`,
        headers: OWNER,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.json()).toMatchObject({
        home_did: 'did:plc:approval-phone-test',
        msgbox_url: 'wss://mailbox.example/ws',
        coding_agents: [],
        staff_devices: [],
        owner_devices: [],
        devices: [],
        phone: { configured: false, state: 'unpaired' },
      });
    } finally {
      await app.close();
    }
  });

  it('a node with no phone bridge reports the phone unpaired', async () => {
    expect(phoneStatusForOwnerSetup(null)).toEqual({
      phone: { configured: false, state: 'unpaired' },
    });
  });

  it('minting through the adapter: the owner, with a person present', async () => {
    const app = await server(fakePhone());
    const mint = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: `${OWNER_SETUP_PREFIX}/owner-device`,
        headers,
        payload: { device_name: 'Office laptop' },
      });
    try {
      expect([401, 403]).toContain((await mint({})).statusCode);
      expect([401, 403]).toContain(
        (await mint({ 'x-dina-owner-capability': `${CAP}x` })).statusCode,
      );
      const refused = await mint(OWNER);
      expect([refused.statusCode, (refused.json() as { error: string }).error]).toEqual([
        403,
        'no_user_presence',
      ]);
      await proveOwnerPresence('correct horse', Date.now(), OWNER_CAPABILITY_PRINCIPAL);
      const minted = await mint(OWNER);
      expect(minted.statusCode).toBe(201);
      expect(getPairingIntent((minted.json() as { code: string }).code)?.role).toBe('owner');
    } finally {
      await app.close();
    }
  });
});

describe('the approval phone', () => {
  it('pair and revoke stay behind the owner', async () => {
    const phone = fakePhone();
    const app = await server(phone);
    await proveOwnerPresence('correct horse', Date.now(), OWNER_CAPABILITY_PRINCIPAL);
    try {
      const bare = await app.inject({
        method: 'POST',
        url: `${OWNER_SETUP_PREFIX}/phone`,
        payload: { setup_code: 'dina1:phone-code' },
      });
      expect(bare.statusCode).toBe(403);
      expect(phone.pair).not.toHaveBeenCalled();

      const paired = await app.inject({
        method: 'POST',
        url: `${OWNER_SETUP_PREFIX}/phone`,
        headers: OWNER,
        payload: { setup_code: 'dina1:phone-code' },
      });
      expect(paired.statusCode).toBe(200);
      expect(phone.pair).toHaveBeenCalledWith('dina1:phone-code');
      const status = await app.inject({
        method: 'GET',
        url: `${OWNER_SETUP_PREFIX}/status`,
        headers: OWNER,
      });
      expect((status.json() as { phone: { state: string } }).phone.state).toBe('active');

      const revoked = await app.inject({
        method: 'DELETE',
        url: `${OWNER_SETUP_PREFIX}/phone`,
        headers: OWNER,
      });
      expect(revoked.statusCode).toBe(200);
      expect(phone.revoke).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('pairing needs a person present; unpairing does not', async () => {
    const phone = fakePhone();
    const app = await server(phone);
    try {
      const refused = await app.inject({
        method: 'POST',
        url: `${OWNER_SETUP_PREFIX}/phone`,
        headers: OWNER,
        payload: { setup_code: 'dina1:phone-code' },
      });
      expect([refused.statusCode, (refused.json() as { error: string }).error]).toEqual([
        403,
        'no_user_presence',
      ]);
      expect(phone.pair).not.toHaveBeenCalled();
      const unpaired = await app.inject({
        method: 'DELETE',
        url: `${OWNER_SETUP_PREFIX}/phone`,
        headers: OWNER,
      });
      expect(unpaired.statusCode).toBe(200);
      await proveOwnerPresence('correct horse', Date.now(), OWNER_CAPABILITY_PRINCIPAL);
      const paired = await app.inject({
        method: 'POST',
        url: `${OWNER_SETUP_PREFIX}/phone`,
        headers: OWNER,
        payload: { setup_code: 'dina1:phone-code' },
      });
      expect(paired.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('pairing needs a setup code; a node with no bridge says so', async () => {
    const withPhone = await server(fakePhone());
    const without = await server(null);
    await proveOwnerPresence('correct horse', Date.now(), OWNER_CAPABILITY_PRINCIPAL);
    try {
      const empty = await withPhone.inject({
        method: 'POST',
        url: `${OWNER_SETUP_PREFIX}/phone`,
        headers: OWNER,
        payload: {},
      });
      expect(empty.statusCode).toBe(400);
      const none = await without.inject({
        method: 'POST',
        url: `${OWNER_SETUP_PREFIX}/phone`,
        headers: OWNER,
        payload: { setup_code: 'dina1:x' },
      });
      expect(none.statusCode).toBe(503);
    } finally {
      await withPhone.close();
      await without.close();
    }
  });

  it('an owner device is the owner here too; a failed owner-device check is refused, not passed', async () => {
    let accept = true;
    const app = await server(fakePhone(), {
      namesOwnerDevice: (req) => req.headers['x-did'] === 'did:key:z6MkLaptop',
      authenticate: () =>
        accept
          ? { authenticated: true }
          : { authenticated: false, rejectedAt: 'signature', reason: 'bad' },
    });
    const revokePhone = (headers: Record<string, string>) =>
      app.inject({ method: 'DELETE', url: `${OWNER_SETUP_PREFIX}/phone`, headers });
    try {
      expect((await revokePhone({ 'x-did': 'did:key:z6MkLaptop' })).statusCode).toBe(200);
      accept = false;
      const refused = await revokePhone({ 'x-did': 'did:key:z6MkLaptop' });
      expect(refused.statusCode).toBe(401);
      expect(refused.json()).toEqual({ error: 'bad', rejected_at: 'signature' });
      expect((await revokePhone({ 'x-did': 'did:key:z6MkClerk' })).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
