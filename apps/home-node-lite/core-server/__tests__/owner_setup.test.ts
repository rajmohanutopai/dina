import Fastify from 'fastify';

import { clearPairingState, getPairingIntent, setNodeDID } from '@dina/core';

const mockGetDevice = jest.fn();
const mockListActiveDevices = jest.fn();
const mockRevokeDeviceDurable = jest.fn();

jest.mock('@dina/core/devices', () => ({
  getDevice: mockGetDevice,
  listActiveDevices: mockListActiveDevices,
  revokeDeviceDurable: mockRevokeDeviceDurable,
}));

import {
  OWNER_SETUP_PREFIX,
  registerOwnerSetupRoutes,
  type PhoneApprovalLifecycle,
} from '../src/server/owner_setup';

const OWNER_CAPABILITY = 'owner-secret-for-test';
const NODE_DID = 'did:plc:owner-setup-test';

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

describe('owner setup routes', () => {
  beforeEach(() => {
    clearPairingState();
    setNodeDID(NODE_DID);
    mockGetDevice.mockReset().mockReturnValue(null);
    mockListActiveDevices.mockReset().mockReturnValue([]);
    mockRevokeDeviceDurable.mockReset();
  });

  afterEach(() => clearPairingState());

  it('mints a coding-scoped one-paste setup code only for the owner', async () => {
    const app = Fastify({ logger: false });
    registerOwnerSetupRoutes(app as never, {
      enabled: true,
      ownerCapability: OWNER_CAPABILITY,
      msgboxURL: 'wss://mailbox.example/ws',
      phoneManager: fakePhone(),
    });
    try {
      const denied = await app.inject({
        method: 'POST',
        url: `${OWNER_SETUP_PREFIX}/coding-agent`,
      });
      expect(denied.statusCode).toBe(403);

      const created = await app.inject({
        method: 'POST',
        url: `${OWNER_SETUP_PREFIX}/coding-agent`,
        headers: { 'x-dina-owner-capability': OWNER_CAPABILITY },
      });
      expect(created.statusCode).toBe(201);
      expect(created.headers['cache-control']).toBe('no-store');
      const body = created.json() as { setup_code: string; expires_at: number };
      expect(body.setup_code).toMatch(/^dina1:/);
      const payload = JSON.parse(
        Buffer.from(body.setup_code.slice('dina1:'.length), 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      expect(payload).toMatchObject({
        v: 1,
        msgbox_url: 'wss://mailbox.example/ws',
        homenode_did: NODE_DID,
        transport: 'msgbox',
        device_name: 'coding-agent',
      });
      expect(typeof payload.code).toBe('string');
    } finally {
      await app.close();
    }
  });

  it('mints a named staff setup code only for the owner; the code pairs role staff under that name (review item 2)', async () => {
    const app = Fastify({ logger: false });
    registerOwnerSetupRoutes(app as never, {
      enabled: true,
      ownerCapability: OWNER_CAPABILITY,
      msgboxURL: 'wss://mailbox.example/ws',
      phoneManager: fakePhone(),
    });
    const mint = (deviceName: unknown, owner = true) =>
      app.inject({
        method: 'POST',
        url: `${OWNER_SETUP_PREFIX}/staff`,
        headers: owner ? { 'x-dina-owner-capability': OWNER_CAPABILITY } : {},
        payload: { device_name: deviceName },
      });
    try {
      expect((await mint('Jiffy till connector', false)).statusCode).toBe(403);
      for (const bad of ['', '   ', 'x'.repeat(65), 'tab\there', 42]) {
        expect((await mint(bad)).statusCode).toBe(400);
      }
      const created = await mint('  Jiffy till connector ');
      expect(created.statusCode).toBe(201);
      expect(created.headers['cache-control']).toBe('no-store');
      const body = created.json() as { setup_code: string; device_name: string };
      expect(body.device_name).toBe('Jiffy till connector');
      const payload = JSON.parse(
        Buffer.from(body.setup_code.slice('dina1:'.length), 'base64url').toString('utf8'),
      ) as { code: string; device_name: string };
      expect(payload.device_name).toBe('Jiffy till connector');
      // The pending code carries role staff and the owner's name; no scope, no install.
      expect(getPairingIntent(payload.code)).toEqual({
        deviceName: 'Jiffy till connector',
        role: 'staff',
        scope: undefined,
      });
    } finally {
      await app.close();
    }
  });

  it('lists staff devices and revokes only a staff device, durably (review item 2)', async () => {
    const staff = {
      deviceId: 'staff-device-1',
      did: 'did:key:z6MkStaff',
      publicKeyMultibase: 'z6MkStaff',
      deviceName: 'Jiffy till connector',
      role: 'staff',
      authType: 'ed25519',
      lastSeen: 200,
      createdAt: 100,
      revoked: false,
    };
    const coding = { ...staff, deviceId: 'coding-device-1', role: 'agent', scope: 'coding' };
    mockListActiveDevices.mockReturnValue([staff, coding]);
    mockGetDevice.mockImplementation((id: string) =>
      id === staff.deviceId ? staff : id === coding.deviceId ? coding : null,
    );
    mockRevokeDeviceDurable.mockResolvedValue({ found: true, revoked: true, durable: true });
    const app = Fastify({ logger: false });
    registerOwnerSetupRoutes(app as never, {
      enabled: true,
      ownerCapability: OWNER_CAPABILITY,
      msgboxURL: 'wss://mailbox.example/ws',
      phoneManager: fakePhone(),
    });
    const owner = { 'x-dina-owner-capability': OWNER_CAPABILITY };
    try {
      const status = await app.inject({
        method: 'GET',
        url: `${OWNER_SETUP_PREFIX}/status`,
        headers: owner,
      });
      expect((status.json() as { staff_devices: unknown[] }).staff_devices).toEqual([
        {
          device_id: 'staff-device-1',
          did: 'did:key:z6MkStaff',
          name: 'Jiffy till connector',
          created_at: 100,
          last_seen: 200,
        },
      ]);
      const denied = await app.inject({
        method: 'DELETE',
        url: `${OWNER_SETUP_PREFIX}/staff/staff-device-1`,
      });
      expect(denied.statusCode).toBe(403);
      const wrongRole = await app.inject({
        method: 'DELETE',
        url: `${OWNER_SETUP_PREFIX}/staff/coding-device-1`,
        headers: owner,
      });
      expect(wrongRole.statusCode).toBe(404);
      expect(mockRevokeDeviceDurable).not.toHaveBeenCalled();
      mockRevokeDeviceDurable.mockResolvedValueOnce({ found: true, revoked: true, durable: false });
      const notDurable = await app.inject({
        method: 'DELETE',
        url: `${OWNER_SETUP_PREFIX}/staff/staff-device-1`,
        headers: owner,
      });
      expect(notDurable.statusCode).toBe(503);
      const revoked = await app.inject({
        method: 'DELETE',
        url: `${OWNER_SETUP_PREFIX}/staff/staff-device-1`,
        headers: owner,
      });
      expect(revoked.statusCode).toBe(204);
      expect(mockRevokeDeviceDurable).toHaveBeenLastCalledWith('staff-device-1');
    } finally {
      await app.close();
    }
  });

  it('keeps phone pair and revoke behind the owner capability', async () => {
    const manager = fakePhone();
    const app = Fastify({ logger: false });
    registerOwnerSetupRoutes(app as never, {
      enabled: true,
      ownerCapability: OWNER_CAPABILITY,
      msgboxURL: 'wss://mailbox.example/ws',
      phoneManager: manager,
    });
    try {
      const paired = await app.inject({
        method: 'POST',
        url: `${OWNER_SETUP_PREFIX}/phone`,
        headers: { 'x-dina-owner-capability': OWNER_CAPABILITY },
        payload: { setup_code: 'dina1:phone-code' },
      });
      expect(paired.statusCode).toBe(200);
      expect(manager.pair).toHaveBeenCalledWith('dina1:phone-code');

      const revoked = await app.inject({
        method: 'DELETE',
        url: `${OWNER_SETUP_PREFIX}/phone`,
        headers: { 'x-dina-owner-capability': OWNER_CAPABILITY },
      });
      expect(revoked.statusCode).toBe(200);
      expect(manager.revoke).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('lists and durably revokes coding devices only for the owner', async () => {
    const codingDevice = {
      deviceId: 'coding-device-1',
      did: 'did:key:z6MkCoding',
      publicKeyMultibase: 'z6MkCoding',
      deviceName: 'coding-agent',
      role: 'agent',
      scope: 'coding',
      authType: 'ed25519',
      lastSeen: 200,
      createdAt: 100,
      revoked: false,
    };
    mockListActiveDevices.mockReturnValue([codingDevice]);
    mockGetDevice.mockReturnValue(codingDevice);
    mockRevokeDeviceDurable.mockResolvedValue({
      found: true,
      revoked: true,
      durable: true,
    });
    const app = Fastify({ logger: false });
    registerOwnerSetupRoutes(app as never, {
      enabled: true,
      ownerCapability: OWNER_CAPABILITY,
      msgboxURL: 'wss://mailbox.example/ws',
      phoneManager: fakePhone(),
    });
    try {
      const status = await app.inject({
        method: 'GET',
        url: `${OWNER_SETUP_PREFIX}/status`,
        headers: { 'x-dina-owner-capability': OWNER_CAPABILITY },
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        home_did: NODE_DID,
        msgbox_url: 'wss://mailbox.example/ws',
        coding_agents: [
          {
            device_id: 'coding-device-1',
            did: 'did:key:z6MkCoding',
            name: 'coding-agent',
          },
        ],
      });

      const denied = await app.inject({
        method: 'DELETE',
        url: `${OWNER_SETUP_PREFIX}/coding-agent/coding-device-1`,
      });
      expect(denied.statusCode).toBe(403);

      const revoked = await app.inject({
        method: 'DELETE',
        url: `${OWNER_SETUP_PREFIX}/coding-agent/coding-device-1`,
        headers: { 'x-dina-owner-capability': OWNER_CAPABILITY },
      });
      expect(revoked.statusCode).toBe(204);
      expect(mockRevokeDeviceDurable).toHaveBeenCalledWith('coding-device-1');
    } finally {
      await app.close();
    }
  });
});
