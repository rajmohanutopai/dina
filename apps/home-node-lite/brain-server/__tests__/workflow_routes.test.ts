/**
 * `/api/v1/workflow/tasks` Fastify routes — the SPA's approval-inbox data
 * layer, a thin proxy over the CoreClient (mobile hits the in-process client
 * instead). Drives the routes with a MockCoreClient so a handler/path/shape/
 * status-mapping regression fails here without standing up core-server. This
 * proxy fronts the agent-safety approval GATE (approve/cancel), so its guards
 * and error mapping are load-bearing.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { CoreHttpError, type WorkflowTask } from '@dina/core';
import { MockCoreClient } from '@dina/test-harness';

import { registerWorkflowApiRoutes } from '../src/routes/workflow';

function makeApp(core: MockCoreClient): FastifyInstance {
  const app = Fastify({ logger: false });
  registerWorkflowApiRoutes(app, { core });
  return app;
}

function seedTask(core: MockCoreClient, over: Partial<WorkflowTask> = {}): WorkflowTask {
  const now = 1_700_000_000_000;
  const task: WorkflowTask = {
    id: 'task-1',
    kind: 'approval',
    status: 'pending_approval',
    description: 'agent wants to transfer money',
    payload: '{}',
    priority: 'normal',
    origin: 'agent',
    result_summary: '',
    policy: '{}',
    created_at: now,
    updated_at: now,
    ...over,
  };
  core.workflowTasks.push(task);
  return task;
}

describe('Brain server — /api/v1/workflow/tasks HTTP wiring', () => {
  it('GET /tasks requires both kind and state (400), else returns {tasks,count}', async () => {
    const core = new MockCoreClient();
    seedTask(core, { id: 't-a', status: 'pending_approval' });
    const app = makeApp(core);
    try {
      const missing = await app.inject({ method: 'GET', url: '/api/v1/workflow/tasks?kind=approval' });
      expect(missing.statusCode).toBe(400);
      expect((missing.json() as { error: string }).error).toMatch(/kind and state/);

      const ok = await app.inject({
        method: 'GET',
        url: '/api/v1/workflow/tasks?kind=approval&state=pending_approval',
      });
      expect(ok.statusCode).toBe(200);
      const body = ok.json() as { tasks: WorkflowTask[]; count: number };
      expect(body.count).toBe(1);
      expect(body.tasks[0]?.id).toBe('t-a');
    } finally {
      await app.close();
    }
  });

  it('GET /tasks/:id returns the task, or 404 when Core has none', async () => {
    const core = new MockCoreClient();
    seedTask(core, { id: 't-b' });
    const app = makeApp(core);
    try {
      const found = await app.inject({ method: 'GET', url: '/api/v1/workflow/tasks/t-b' });
      expect(found.statusCode).toBe(200);
      expect((found.json() as { task: WorkflowTask }).task.id).toBe('t-b');

      const missing = await app.inject({ method: 'GET', url: '/api/v1/workflow/tasks/nope' });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST /approve forwards scope=single|session, and omits opts when scope invalid/absent', async () => {
    const core = new MockCoreClient();
    seedTask(core, { id: 't-c' });
    seedTask(core, { id: 't-d' });
    seedTask(core, { id: 't-e' });
    const app = makeApp(core);
    try {
      const single = await app.inject({
        method: 'POST',
        url: '/api/v1/workflow/tasks/t-c/approve',
        payload: { scope: 'single' },
      });
      expect(single.statusCode).toBe(200);
      expect((single.json() as { task: WorkflowTask }).task.status).toBe('queued');

      await app.inject({
        method: 'POST',
        url: '/api/v1/workflow/tasks/t-d/approve',
        payload: { scope: 'session' },
      });
      // Garbage scope must be dropped, NOT forwarded as a bogus opt.
      await app.inject({
        method: 'POST',
        url: '/api/v1/workflow/tasks/t-e/approve',
        payload: { scope: 'everything' },
      });

      const approveCalls = core.calls.filter((c) => c.method === 'approveWorkflowTask');
      expect(approveCalls).toHaveLength(3);
      expect(approveCalls[0]?.args).toEqual(['t-c', { scope: 'single' }]);
      expect(approveCalls[1]?.args).toEqual(['t-d', { scope: 'session' }]);
      // Invalid scope → opts undefined → mock records [id] only.
      expect(approveCalls[2]?.args).toEqual(['t-e']);
    } finally {
      await app.close();
    }
  });

  it('POST /cancel forwards the reason', async () => {
    const core = new MockCoreClient();
    seedTask(core, { id: 't-f' });
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/workflow/tasks/t-f/cancel',
        payload: { reason: 'owner declined' },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { task: WorkflowTask }).task.status).toBe('cancelled');
      const cancelCall = core.calls.find((c) => c.method === 'cancelWorkflowTask');
      expect(cancelCall?.args).toEqual(['t-f', 'owner declined']);
    } finally {
      await app.close();
    }
  });

  it('maps Core errors: 4xx forwarded (404/409), everything else → 502', async () => {
    const core = new MockCoreClient();
    seedTask(core, { id: 't-g' });
    const app = makeApp(core);
    try {
      // Core says the task is gone → 404, not a gateway error.
      core.throwOn.approveWorkflowTask = new CoreHttpError('gone', 404);
      const gone = await app.inject({ method: 'POST', url: '/api/v1/workflow/tasks/t-g/approve' });
      expect(gone.statusCode).toBe(404);

      // Core says already-resolved → 409.
      core.throwOn.approveWorkflowTask = new CoreHttpError('already resolved', 409);
      const conflict = await app.inject({ method: 'POST', url: '/api/v1/workflow/tasks/t-g/approve' });
      expect(conflict.statusCode).toBe(409);

      // A genuine transport/unknown failure → 502.
      core.throwOn.approveWorkflowTask = new Error('socket hang up');
      const gateway = await app.inject({ method: 'POST', url: '/api/v1/workflow/tasks/t-g/approve' });
      expect(gateway.statusCode).toBe(502);

      // A Core 5xx is NOT forwarded as-is — it's a gateway failure → 502.
      core.throwOn.approveWorkflowTask = new CoreHttpError('core exploded', 500);
      const upstream5xx = await app.inject({ method: 'POST', url: '/api/v1/workflow/tasks/t-g/approve' });
      expect(upstream5xx.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });

  it('POST /service/respond forwards task_id + response_body to CoreClient.sendServiceRespond', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/service/respond',
        payload: { task_id: 'svc-1', response_body: { status: 'unavailable', error: 'no ETA' } },
      });
      expect(res.statusCode).toBe(200);
      const call = core.calls.find((c) => c.method === 'sendServiceRespond');
      expect(call?.args).toEqual(['svc-1', { status: 'unavailable', error: 'no ETA' }]);
      // Result carries the taskId back for correlation (web resolver depends on it).
      expect((res.json() as { taskId?: string }).taskId).toBe('svc-1');
    } finally {
      await app.close();
    }
  });

  it('POST /service/respond requires task_id AND response_body (400, never reaches Core)', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const noTask = await app.inject({
        method: 'POST',
        url: '/api/v1/service/respond',
        payload: { response_body: { status: 'unavailable' } },
      });
      expect(noTask.statusCode).toBe(400);
      const noBody = await app.inject({
        method: 'POST',
        url: '/api/v1/service/respond',
        payload: { task_id: 'svc-1' },
      });
      expect(noBody.statusCode).toBe(400);
      expect(core.calls.some((c) => c.method === 'sendServiceRespond')).toBe(false);
    } finally {
      await app.close();
    }
  });
});
