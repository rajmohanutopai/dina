import Fastify from 'fastify';

import { clearPairingState, setNodeDID } from '@dina/core';

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
