import { createCoreRouter } from '../../../src/server/core_server';
import {
  REMOTE_APPROVAL_API_PREFIX,
  REMOTE_APPROVAL_PAYLOAD_TYPE,
} from '../../../src/server/routes/remote_approval';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import {
  WorkflowService,
  getWorkflowService,
  setWorkflowService,
} from '../../../src/workflow/service';

import type { CoreRequest } from '../../../src/server/router';

const DEVICE = 'did:key:z6MkRemoteLaptop';
const OTHER = 'did:key:z6MkOtherLaptop';
const HASH = 'a'.repeat(64);

function request(
  method: CoreRequest['method'],
  path: string,
  body: unknown,
  callerDID = DEVICE,
): CoreRequest {
  return {
    method,
    path,
    query: {},
    headers: {},
    body,
    rawBody: new TextEncoder().encode(body === undefined ? '' : JSON.stringify(body)),
    params: {},
    trustedInProcess: true,
    callerType: 'agent',
    callerDID,
  };
}

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_task_id: 'coding-gate-local-1',
    source_payload_hash: HASH,
    agent_did: 'did:key:z6MkCodingAgent',
    action: 'filesystem.write',
    risk_level: 'HIGH',
    tool_name: 'Write',
    expires_at: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
}

describe('remote approval synchronization routes', () => {
  beforeEach(() => {
    setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
  });

  afterEach(() => setWorkflowService(null));

  it('creates one phone-owned approval without storing source-supplied free text', async () => {
    const router = createCoreRouter();
    const res = await router.handle(
      request(
        'POST',
        `${REMOTE_APPROVAL_API_PREFIX}/proposals`,
        proposal({
          description: 'SECRET raw command --token=hunter2',
          raw_tool_input: { command: 'curl --token=hunter2' },
          session_id: 'private-project-name',
        }),
      ),
    );

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body.decision).toBe('pending');
    const task = getTask(String(body.proposal_id));
    const payload = JSON.parse(task.payload) as Record<string, unknown>;
    expect(payload.type).toBe(REMOTE_APPROVAL_PAYLOAD_TYPE);
    expect(payload.source_device_did).toBe(DEVICE);
    expect(task.description).toContain('filesystem.write via Write');
    expect(task.description).not.toContain('SECRET');
    expect(task.payload).not.toContain('private-project-name');
    expect(task.payload).not.toContain('hunter2');
    expect(task.payload).not.toContain('raw_tool_input');
  });

  it('deduplicates an identical retry and rejects a changed immutable proposal', async () => {
    const router = createCoreRouter();
    const first = await router.handle(
      request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, proposal()),
    );
    const second = await router.handle(
      request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, proposal()),
    );
    const conflict = await router.handle(
      request(
        'POST',
        `${REMOTE_APPROVAL_API_PREFIX}/proposals`,
        proposal({ source_payload_hash: 'b'.repeat(64) }),
      ),
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((second.body as Record<string, unknown>).deduped).toBe(true);
    expect(conflict.status).toBe(409);
  });

  it('binds status reads to the authenticated source device', async () => {
    const router = createCoreRouter();
    const created = await router.handle(
      request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, proposal()),
    );
    const id = String((created.body as Record<string, unknown>).proposal_id);

    const hidden = await router.handle(
      request('GET', `${REMOTE_APPROVAL_API_PREFIX}/proposals/${id}/status`, undefined, OTHER),
    );
    expect(hidden.status).toBe(404);

    const approved = await router.handle({
      ...request('POST', `/v1/workflow/tasks/${id}/approve`, {}),
      callerType: undefined,
      callerDID: undefined,
    });
    expect(approved.status).toBe(200);

    const status = await router.handle(
      request('GET', `${REMOTE_APPROVAL_API_PREFIX}/proposals/${id}/status`, undefined),
    );
    expect(status.status).toBe(200);
    expect((status.body as Record<string, unknown>).decision).toBe('approved');
  });

  it('withdraws only the authenticated source device proposal and is idempotent', async () => {
    const router = createCoreRouter();
    const created = await router.handle(
      request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, proposal()),
    );
    const id = String((created.body as Record<string, unknown>).proposal_id);

    const hidden = await router.handle(
      request('DELETE', `${REMOTE_APPROVAL_API_PREFIX}/proposals/${id}`, undefined, OTHER),
    );
    expect(hidden.status).toBe(404);
    expect(getTask(id).status).toBe('pending_approval');

    const withdrawn = await router.handle(
      request('DELETE', `${REMOTE_APPROVAL_API_PREFIX}/proposals/${id}`, undefined),
    );
    expect(withdrawn.status).toBe(204);
    expect(getTask(id).status).toBe('cancelled');

    const replay = await router.handle(
      request('DELETE', `${REMOTE_APPROVAL_API_PREFIX}/proposals/${id}`, undefined),
    );
    expect(replay.status).toBe(204);
  });

  it('fails closed for non-HIGH, malformed hashes, excessive TTL, and non-device callers', async () => {
    const router = createCoreRouter();
    const badRisk = await router.handle(
      request(
        'POST',
        `${REMOTE_APPROVAL_API_PREFIX}/proposals`,
        proposal({ risk_level: 'MODERATE' }),
      ),
    );
    const badHash = await router.handle(
      request(
        'POST',
        `${REMOTE_APPROVAL_API_PREFIX}/proposals`,
        proposal({ source_payload_hash: 'x' }),
      ),
    );
    const badTTL = await router.handle(
      request(
        'POST',
        `${REMOTE_APPROVAL_API_PREFIX}/proposals`,
        proposal({ expires_at: Math.floor(Date.now() / 1000) + 3600 }),
      ),
    );
    const brain = await router.handle({
      ...request('POST', `${REMOTE_APPROVAL_API_PREFIX}/proposals`, proposal()),
      callerType: 'brain',
    });
    expect([badRisk.status, badHash.status, badTTL.status, brain.status]).toEqual([
      400, 400, 400, 403,
    ]);
  });
});

function getTask(id: string) {
  const task = getWorkflowService()?.store().getById(id) ?? null;
  if (task === null) throw new Error(`missing task ${id}`);
  return task;
}
