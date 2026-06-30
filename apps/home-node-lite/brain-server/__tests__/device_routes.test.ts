/**
 * `/api/v1/devices/list` + `/api/v1/pair/initiate` Fastify routes — thin proxy
 * over the CoreClient device methods the SPA's Paired Devices screen uses.
 * Driven with a (stateful) MockCoreClient. core-server owns the registry +
 * pairing ceremony; device revoke/register stay admin-only and are not proxied.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { MockCoreClient } from '@dina/test-harness';

import { registerDeviceApiRoutes } from '../src/routes/devices';

function makeApp(core: MockCoreClient): FastifyInstance {
  const app = Fastify({ logger: false });
  registerDeviceApiRoutes(app, { core });
  return app;
}

describe('Brain server — /api/v1/devices + /pair HTTP wiring', () => {
  it('GET /devices/list → { devices } from CoreClient.listPairedDevices', async () => {
    const core = new MockCoreClient();
    core.pairedDevicesResult = [
      {
        deviceId: 'd1',
        did: 'did:key:dev',
        publicKeyMultibase: 'z123',
        deviceName: 'Laptop',
        role: 'rich',
        authType: 'ed25519',
        lastSeen: 0,
        createdAt: 0,
        revoked: false,
      },
    ];
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/devices/list' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { devices: { deviceName: string }[] }).devices[0]?.deviceName).toBe(
        'Laptop',
      );
    } finally {
      await app.close();
    }
  });

  it('POST /pair/initiate → forwards device_name/role → PairInitiateResult', async () => {
    const core = new MockCoreClient();
    core.pairInitiateResult = {
      code: 'ABCD1234',
      expiresAt: 9999,
      deviceName: '',
      role: 'agent',
    };
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/pair/initiate',
        payload: { device_name: 'CLI agent', role: 'agent' },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { code: string }).code).toBe('ABCD1234');
      const call = core.calls.find((c) => c.method === 'pairInitiate');
      expect(call?.args).toEqual(['CLI agent', 'agent']);
    } finally {
      await app.close();
    }
  });

  it('POST /pair/initiate → 400 on missing device_name / invalid role (never reaches Core)', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const noName = await app.inject({
        method: 'POST',
        url: '/api/v1/pair/initiate',
        payload: { role: 'cli' },
      });
      expect(noName.statusCode).toBe(400);

      const badRole = await app.inject({
        method: 'POST',
        url: '/api/v1/pair/initiate',
        payload: { device_name: 'X', role: 'superuser' },
      });
      expect(badRole.statusCode).toBe(400);

      expect(core.calls.some((c) => c.method === 'pairInitiate')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('maps a pairInitiate failure to 502 (mutation throws in production)', async () => {
    const core = new MockCoreClient();
    core.throwOn.pairInitiate = new Error('core unreachable');
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/pair/initiate',
        payload: { device_name: 'X', role: 'cli' },
      });
      expect(res.statusCode).toBe(502);
      expect((res.json() as { error: string }).error).toMatch(/core unreachable/);
    } finally {
      await app.close();
    }
  });
});
