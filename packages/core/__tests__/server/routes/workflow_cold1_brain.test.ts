/**
 * Item 7 / COLD-1 — Brain must not DECIDE an agent-raised task.
 *
 * On the server split Brain is untrusted; approving/denying an agent-origin task
 * requires the phone-signed OWNER decision (§13). Brain keeps its in-process
 * path for brain-origin tasks. Owner/admin/device are unaffected.
 */

import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerWorkflowRoutes } from '../../../src/server/routes/workflow';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../../src/workflow/service';
import type { WorkflowTask } from '../../../src/workflow/domain';

let repo: InMemoryWorkflowRepository;
let router: CoreRouter;

function makeTask(id: string, origin: string): WorkflowTask {
  const now = Date.now();
  return {
    id,
    kind: 'approval',
    status: 'pending_approval',
    priority: 'normal',
    description: `${origin} task`,
    payload: JSON.stringify({ type: 'intent_validation', action: 'x' }),
    result_summary: '',
    policy: '',
    origin,
    expires_at: Math.floor(now / 1000) + 3600,
    created_at: now,
    updated_at: now,
  } as WorkflowTask;
}

function decideReq(taskId: string, verb: 'approve' | 'cancel', callerType?: string): CoreRequest {
  return {
    method: 'POST',
    path: `/v1/workflow/tasks/${taskId}/${verb}`,
    query: {},
    headers: {},
    body: {},
    rawBody: new Uint8Array(),
    params: { id: taskId },
    trustedInProcess: true,
    ...(callerType !== undefined ? { callerType, callerDID: 'did:key:caller' } : {}),
  } as unknown as CoreRequest;
}

beforeEach(() => {
  repo = new InMemoryWorkflowRepository();
  setWorkflowService(new WorkflowService({ repository: repo }));
  router = new CoreRouter();
  registerWorkflowRoutes(router);
  repo.create(makeTask('task-agent', 'agent'));
  repo.create(makeTask('task-brain', 'brain'));
});
afterEach(() => setWorkflowService(null));

describe('brain deciding an AGENT-raised task', () => {
  it('brain approve → 403 (owner decision required)', async () => {
    const res = await router.handle(decideReq('task-agent', 'approve', 'brain'));
    expect(res.status).toBe(403);
    expect((res.body as { reason?: string }).reason).toMatch(/agent-raised/);
  });

  it('brain cancel → 403', async () => {
    const res = await router.handle(decideReq('task-agent', 'cancel', 'brain'));
    expect(res.status).toBe(403);
  });

  it('AUDIT: brain FAIL (deny) of an agent-origin task → 403 (was a bypass)', async () => {
    const res = await router.handle({
      ...decideReq('task-agent', 'approve', 'brain'),
      path: '/v1/workflow/tasks/task-agent/fail',
      params: { id: 'task-agent' },
      body: { error: 'denied' },
    } as CoreRequest);
    expect(res.status).toBe(403);
  });
});

describe('the guard is scoped to agent-origin tasks only', () => {
  it('brain CAN decide a brain-origin task (in-process /service_approve path)', async () => {
    const res = await router.handle(decideReq('task-brain', 'approve', 'brain'));
    expect(res.status).not.toBe(403); // 200 (or a transition result), never access_denied
  });

  it('the OWNER can still decide an agent-origin task', async () => {
    // owner = trustedInProcess, no callerType
    const res = await router.handle(decideReq('task-agent', 'approve', undefined));
    expect(res.status).not.toBe(403);
  });

  it('device can still decide an agent-origin task (the phone owner-device)', async () => {
    const res = await router.handle(decideReq('task-agent', 'approve', 'device'));
    expect(res.status).not.toBe(403);
  });
});
