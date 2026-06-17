/**
 * `/api/v1/policy/actions` Fastify routes — thin proxy over the CoreClient
 * the SPA's Settings → Policy screen uses. Driven with a MockCoreClient.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { MockCoreClient } from '@dina/test-harness';

import { registerPolicyApiRoutes } from '../src/routes/policy';

function makeApp(core: MockCoreClient): FastifyInstance {
  const app = Fastify({ logger: false });
  registerPolicyApiRoutes(app, { core });
  return app;
}

describe('Brain server — /api/v1/policy/actions HTTP wiring', () => {
  it('GET returns the action policy', async () => {
    const core = new MockCoreClient();
    core.actionPolicyResult = { actions: [{ action: 'send_email', risk: 'moderate' }] } as never;
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/policy/actions' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { actions: unknown[] }).actions).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('PUT sets an action risk (forwards action + risk)', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/policy/actions/send_email',
        payload: { risk: 'high' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ action: 'send_email', risk: 'high' });
      const call = core.calls.find((c) => c.method === 'setActionRisk');
      expect(call?.args).toEqual(['send_email', 'high']);
    } finally {
      await app.close();
    }
  });

  it('PUT 400s when risk is missing', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/policy/actions/send_email',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('DELETE removes an override', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/policy/actions/send_email',
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { deleted: boolean }).deleted).toBe(true);
      const call = core.calls.find((c) => c.method === 'deleteActionOverride');
      expect(call?.args).toEqual(['send_email']);
    } finally {
      await app.close();
    }
  });

  it('maps a CoreClient failure to 502', async () => {
    const core = new MockCoreClient();
    core.throwOn.getActionPolicy = new Error('core unreachable');
    const app = makeApp(core);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/policy/actions' });
      expect(res.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });
});
