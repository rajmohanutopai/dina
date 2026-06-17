/**
 * `/api/v1/workflow/tasks` Fastify routes — thin proxy over the CoreClient
 * the SPA's approvals/inbox uses. Driven with a (stateful) MockCoreClient.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { MockCoreClient } from '@dina/test-harness';

import { registerWorkflowApiRoutes } from '../src/routes/workflow';

function makeApp(core: MockCoreClient): FastifyInstance {
  const app = Fastify({ logger: false });
  registerWorkflowApiRoutes(app, { core });
  return app;
}

function seedTask(core: MockCoreClient): void {
  core.workflowTasks.push({
    id: 't1',
    kind: 'service_query',
    status: 'pending_approval',
  } as never);
}

describe('Brain server — /api/v1/workflow/tasks HTTP wiring', () => {
  it('list filters by kind+state and returns { tasks }', async () => {
    const core = new MockCoreClient();
    seedTask(core);
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/workflow/tasks?kind=service_query&state=pending_approval&limit=10',
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { tasks: unknown[] }).tasks).toHaveLength(1);
      const call = core.calls.find((c) => c.method === 'listWorkflowTasks');
      expect(call?.args[0]).toMatchObject({ kind: 'service_query', state: 'pending_approval', limit: 10 });
    } finally {
      await app.close();
    }
  });

  it('list 400s when kind or state is missing', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/workflow/tasks?kind=service_query' }))
          .statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/workflow/tasks?state=pending_approval' }))
          .statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('get :id returns { task }; unknown → 404', async () => {
    const core = new MockCoreClient();
    seedTask(core);
    const app = makeApp(core);
    try {
      const got = await app.inject({ method: 'GET', url: '/api/v1/workflow/tasks/t1' });
      expect(got.statusCode).toBe(200);
      expect((got.json() as { task: { id: string } }).task.id).toBe('t1');

      const miss = await app.inject({ method: 'GET', url: '/api/v1/workflow/tasks/nope' });
      expect(miss.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('approve transitions the task and returns { task }', async () => {
    const core = new MockCoreClient();
    seedTask(core);
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/workflow/tasks/t1/approve',
        payload: { scope: 'single' },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { task: { status: string } }).task.status).toBe('queued');
    } finally {
      await app.close();
    }
  });

  it('cancel transitions the task and forwards the reason', async () => {
    const core = new MockCoreClient();
    seedTask(core);
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/workflow/tasks/t1/cancel',
        payload: { reason: 'changed mind' },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { task: { status: string } }).task.status).toBe('cancelled');
      const call = core.calls.find((c) => c.method === 'cancelWorkflowTask');
      expect(call?.args).toEqual(['t1', 'changed mind']);
    } finally {
      await app.close();
    }
  });

  it('maps a CoreClient failure to 502', async () => {
    const core = new MockCoreClient();
    core.throwOn.listWorkflowTasks = new Error('core unreachable');
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/workflow/tasks?kind=service_query&state=pending_approval',
      });
      expect(res.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });
});
