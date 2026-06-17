/**
 * `/api/v1/service/config[s]` Fastify routes — thin proxy over the
 * CoreClient the SPA's listings form uses. Driven with a (stateful)
 * MockCoreClient so a handler/path/shape regression fails here without
 * standing up core-server.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { MockCoreClient } from '@dina/test-harness';

import { registerServiceConfigApiRoutes } from '../src/routes/service_config';

function makeApp(core: MockCoreClient): FastifyInstance {
  const app = Fastify({ logger: false });
  registerServiceConfigApiRoutes(app, { core });
  return app;
}

describe('Brain server — /api/v1/service/config[s] HTTP wiring', () => {
  it('PUT self → GET self → GET configs round-trip', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/v1/service/config',
        payload: { capabilities: [{ nsid: 'com.x.demo' }] },
      });
      expect(put.statusCode).toBe(200);

      const self = await app.inject({ method: 'GET', url: '/api/v1/service/config' });
      expect(self.statusCode).toBe(200);
      expect((self.json() as { capabilities: unknown[] }).capabilities).toHaveLength(1);

      const list = await app.inject({ method: 'GET', url: '/api/v1/service/configs' });
      expect(list.statusCode).toBe(200);
      expect((list.json() as { listings: unknown[] }).listings).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('GET self → 404 when no config is set', async () => {
    const core = new MockCoreClient();
    core.serviceConfigResult = null;
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/service/config' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('PUT/GET/DELETE per-listing :rkey', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      await app.inject({
        method: 'PUT',
        url: '/api/v1/service/config/rk1',
        payload: { capabilities: [] },
      });
      const got = await app.inject({ method: 'GET', url: '/api/v1/service/config/rk1' });
      expect(got.statusCode).toBe(200);
      const putCall = core.calls.find((c) => c.method === 'putServiceConfig');
      expect(putCall?.args[1]).toBe('rk1');

      const del = await app.inject({ method: 'DELETE', url: '/api/v1/service/config/rk1' });
      expect(del.statusCode).toBe(200);
      expect((del.json() as { deleted: boolean }).deleted).toBe(true);

      const gone = await app.inject({ method: 'GET', url: '/api/v1/service/config/rk1' });
      expect(gone.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('maps a CoreClient failure to 502', async () => {
    const core = new MockCoreClient();
    core.throwOn.listServiceConfigs = new Error('core unreachable');
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/service/configs' });
      expect(res.statusCode).toBe(502);
      expect((res.json() as { error: string }).error).toMatch(/core unreachable/);
    } finally {
      await app.close();
    }
  });
});
