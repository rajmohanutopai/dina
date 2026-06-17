/**
 * `/api/v1/personas` Fastify routes — thin proxy over the CoreClient the
 * SPA uses to render the persona switcher + per-persona status (mobile
 * reads the registry in-process). Driven with a MockCoreClient.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { MockCoreClient } from '@dina/test-harness';

import { registerPersonaApiRoutes } from '../src/routes/personas';

function makeApp(core: MockCoreClient): FastifyInstance {
  const app = Fastify({ logger: false });
  registerPersonaApiRoutes(app, { core });
  return app;
}

describe('Brain server — /api/v1/personas HTTP wiring', () => {
  it('list returns { personas } from CoreClient.personasList', async () => {
    const core = new MockCoreClient();
    core.personasListResult = [
      { name: 'general', tier: 'default', isOpen: true },
      { name: 'health', tier: 'sensitive', isOpen: false },
    ] as never;
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/personas' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { personas: unknown[] }).personas).toHaveLength(2);
      expect(core.callCountOf('personasList')).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('maps a CoreClient failure to 502', async () => {
    const core = new MockCoreClient();
    core.throwOn.personasList = new Error('core unreachable');
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/personas' });
      expect(res.statusCode).toBe(502);
      expect((res.json() as { error: string }).error).toMatch(/core unreachable/);
    } finally {
      await app.close();
    }
  });
});
