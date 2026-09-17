/**
 * `/api/v1/coordination/*` — the web thin client's read path for group plans.
 * Reads go through Brain's own doors; nothing here decides anything, and no
 * owner capability is read or forwarded.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { CoreHttpError, type GroupPlanWire } from '@dina/core';
import { MockCoreClient } from '@dina/test-harness';

import { registerCoordinationApiRoutes } from '../src/routes/coordination';

function makeApp(core: MockCoreClient): FastifyInstance {
  const app = Fastify({ logger: false });
  registerCoordinationApiRoutes(app, { core });
  return app;
}

const PLAN: GroupPlanWire = {
  plan_id: 'gp_1',
  intent: "Emma's birthday",
  state: 'folded',
  window_seconds: 120,
  round: 1,
  round_opened_at: 1,
  window_closes_at: 120_001,
  created_at: 1,
  updated_at: 2,
  candidates: [{ start: 'Sat 26' }],
  chosen: null,
  fold: { state: 'converged', agreed: [{ start: 'Sat 26' }], missing_required: [], emptied_by: [], optional_fit: {}, counters: {}, needs_more_info: [] },
  guests: [{ contact_did: 'did:plc:garcia', required: true, outcome: 'answered', reply: { status: 'accepted', accepted_slots: [{ start: 'Sat 26' }] }, disclosures: [], spokes: [] }],
  requirements: [],
};

describe('/api/v1/coordination — web read path', () => {
  it('reads a plan by id through Brain’s door and answers 404 for an unknown one', async () => {
    const core = new MockCoreClient();
    core.getGroupPlanResult = PLAN;
    const app = makeApp(core);
    const ok = await app.inject({ method: 'GET', url: '/api/v1/coordination/plans/gp_1' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ plan: PLAN });
    expect(core.calls.map((c) => c.method)).toEqual(['getGroupPlan']);
    core.getGroupPlanResult = null;
    const missing = await app.inject({ method: 'GET', url: '/api/v1/coordination/plans/nope' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('lists handles, and forwards Core’s own status on a refusal', async () => {
    const core = new MockCoreClient();
    core.groupPlanHandles = [{ plan_id: 'gp_1', intent: 'x', state: 'settled', round: 2, chosen: { start: 'Sat 26' }, updated_at: 3 }];
    const app = makeApp(core);
    const handles = await app.inject({ method: 'GET', url: '/api/v1/coordination/handles' });
    expect(handles.statusCode).toBe(200);
    expect(handles.json()).toEqual({ plans: core.groupPlanHandles });
    core.throwOn.getGroupPlan = new CoreHttpError('forbidden', 403, {});
    const refused = await app.inject({ method: 'GET', url: '/api/v1/coordination/plans/gp_1' });
    expect(refused.statusCode).toBe(403);
    await app.close();
  });

  it('proxies no decision: choose, widen, optional, abandon and delete are not routes here', async () => {
    const app = makeApp(new MockCoreClient());
    for (const [method, url] of [
      ['POST', '/api/v1/coordination/plans'],
      ['POST', '/api/v1/coordination/plans/gp_1/choose'],
      ['POST', '/api/v1/coordination/plans/gp_1/widen'],
      ['POST', '/api/v1/coordination/plans/gp_1/optional'],
      ['POST', '/api/v1/coordination/plans/gp_1/abandon'],
      ['DELETE', '/api/v1/coordination/plans/gp_1'],
      ['GET', '/api/v1/coordination/plans'],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect([method, url, res.statusCode]).toEqual([method, url, 404]);
    }
    await app.close();
  });
});
