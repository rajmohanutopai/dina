import { InMemoryAgentGrantRepository, setAgentGrantRepository } from '../../../src/agent/grant_repository';
import { resetCallerTypeState } from '../../../src/auth/caller_type';
import {
  getDevice,
  registerDevice,
  resetDeviceRegistry,
} from '../../../src/devices/registry';
import {
  setDeviceRepository,
  type DeviceRepository,
} from '../../../src/devices/repository';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerDevicesRoutes } from '../../../src/server/routes/devices';

const rows = new Map<string, ReturnType<typeof registerDevice>>();

const repo: DeviceRepository = {
  async register(device) {
    rows.set(device.deviceId, { ...device });
  },
  async get(deviceId) {
    return rows.get(deviceId) ?? null;
  },
  async getByPublicKey(publicKeyMultibase) {
    return [...rows.values()].find((d) => d.publicKeyMultibase === publicKeyMultibase) ?? null;
  },
  async getByDID(did) {
    return [...rows.values()].find((d) => d.did === did) ?? null;
  },
  async list() {
    return [...rows.values()];
  },
  async revoke(deviceId) {
    const row = rows.get(deviceId);
    if (row === undefined) return false;
    rows.set(deviceId, { ...row, revoked: true });
    return true;
  },
  async touch() {},
};

function request(callerDID?: string): CoreRequest {
  return {
    method: 'DELETE',
    path: '/v1/devices/self',
    query: {},
    headers: {},
    body: undefined,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'agent',
    callerDID,
  };
}

describe('DELETE /v1/devices/self', () => {
  beforeEach(() => {
    rows.clear();
    resetDeviceRegistry();
    resetCallerTypeState();
    setDeviceRepository(repo);
    setAgentGrantRepository(new InMemoryAgentGrantRepository());
  });

  afterEach(() => {
    setAgentGrantRepository(null);
    setDeviceRepository(null);
    resetDeviceRegistry();
    resetCallerTypeState();
  });

  it('durably revokes the authenticated device without accepting a target id', async () => {
    const device = registerDevice('Claude Code', 'z6MkSelfRevokeFixture', 'agent', 'coding');
    await repo.register(device);
    const router = new CoreRouter();
    registerDevicesRoutes(router);

    const response = await router.handle(request(device.did));

    expect(response.status).toBe(204);
    expect(getDevice(device.deviceId)?.revoked).toBe(true);
    expect((await repo.get(device.deviceId))?.revoked).toBe(true);
  });

  it('does not expose whether another device exists', async () => {
    const router = new CoreRouter();
    registerDevicesRoutes(router);

    const response = await router.handle(request('did:key:z6MkUnknown'));

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'device not found' });
  });

  it('fails closed when durable revocation cannot be confirmed', async () => {
    const device = registerDevice('Claude Code', 'z6MkSelfRevokeFailure', 'agent', 'coding');
    await repo.register(device);
    setDeviceRepository({ ...repo, revoke: async () => false });
    const router = new CoreRouter();
    registerDevicesRoutes(router);

    const response = await router.handle(request(device.did));

    expect(response.status).toBe(503);
    expect(getDevice(device.deviceId)?.revoked).toBe(true);
  });
});
