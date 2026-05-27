/**
 * SEC (P1.1) — an out-of-process `agent` may only complete/fail a `delegation`
 * task it is CURRENTLY holding (claimed → running, agent_did === its
 * authenticated DID). The repo guards complete/fail on STATE only, so without
 * this an agent could complete/fail (or force-terminate) any non-terminal task
 * by id, with a forged `agent_did`. `agentCompletionGuard` enforces ownership;
 * the recorded completer is the authenticated `callerDID`, never the body.
 */

import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerWorkflowRoutes } from '../../../src/server/routes/workflow';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../../src/workflow/service';

const NOW = 1_800_000_000_000;
const AGENT_A = 'did:key:agentA';
const AGENT_B = 'did:key:agentB';

let repo: InMemoryWorkflowRepository;

function build(): CoreRouter {
  const router = new CoreRouter();
  registerWorkflowRoutes(router);
  return router;
}

/** Seed a queued delegation task and claim it as `agentDID` → running. */
function seedRunningDelegation(id: string, agentDID: string): void {
  repo.create({
    id,
    kind: 'delegation',
    status: 'queued',
    priority: 'normal',
    description: 'service query',
    payload: JSON.stringify({ type: 'service_query_execution' }),
    result_summary: '',
    policy: '{}',
    created_at: NOW,
    updated_at: NOW,
  });
  const claimed = repo.claimDelegationTask(agentDID, NOW, 30_000);
  if (claimed === null || claimed.id !== id) throw new Error('test seed: claim failed');
}

function actionReq(
  id: string,
  action: 'complete' | 'fail',
  body: Record<string, unknown>,
  caller?: { type: string; did: string },
): CoreRequest {
  return {
    method: 'POST',
    path: `/v1/workflow/tasks/${id}/${action}`,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(caller ? { callerType: caller.type, callerDID: caller.did } : {}),
  };
}

describe('workflow complete/fail — agent ownership gate (P1.1)', () => {
  beforeEach(() => {
    repo = new InMemoryWorkflowRepository();
    setWorkflowService(new WorkflowService({ repository: repo }));
  });
  afterEach(() => setWorkflowService(null));

  it('agent completes its OWN running delegation → 200, records the AUTHENTICATED did (body ignored)', async () => {
    const router = build();
    seedRunningDelegation('t1', AGENT_A);
    const resp = await router.handle(
      actionReq(
        't1',
        'complete',
        { result: 'ok', agent_did: 'did:key:forged' },
        {
          type: 'agent',
          did: AGENT_A,
        },
      ),
    );
    expect(resp.status).toBe(200);
    const task = repo.getById('t1');
    expect(task?.status).toBe('completed');
    // The recorded completer is the authenticated caller, NOT the forged body value.
    expect(task?.agent_did).toBe(AGENT_A);
  });

  it('agent CANNOT complete a delegation held by a DIFFERENT agent → 403, task untouched', async () => {
    const router = build();
    seedRunningDelegation('t1', AGENT_A);
    const resp = await router.handle(
      actionReq('t1', 'complete', { result: 'pwned' }, { type: 'agent', did: AGENT_B }),
    );
    expect(resp.status).toBe(403);
    expect((resp.body as { error?: string }).error).toBe('access_denied');
    expect(repo.getById('t1')?.status).toBe('running'); // not completed
  });

  it('agent CANNOT complete a NON-delegation task it does not hold → 403', async () => {
    const router = build();
    repo.create({
      id: 'appr1',
      kind: 'approval',
      status: 'running',
      priority: 'normal',
      description: 'an approval',
      payload: '{}',
      result_summary: '',
      policy: '{}',
      agent_did: AGENT_A,
      created_at: NOW,
      updated_at: NOW,
    });
    const resp = await router.handle(
      actionReq('appr1', 'complete', { result: 'x' }, { type: 'agent', did: AGENT_A }),
    );
    expect(resp.status).toBe(403);
  });

  it('agent CANNOT fail a task it does not hold → 403', async () => {
    const router = build();
    seedRunningDelegation('t1', AGENT_A);
    const resp = await router.handle(
      actionReq('t1', 'fail', { error: 'boom' }, { type: 'agent', did: AGENT_B }),
    );
    expect(resp.status).toBe(403);
    expect(repo.getById('t1')?.status).toBe('running');
  });

  it('agent fails its OWN running delegation → 200', async () => {
    const router = build();
    seedRunningDelegation('t1', AGENT_A);
    const resp = await router.handle(
      actionReq('t1', 'fail', { error: 'provider down' }, { type: 'agent', did: AGENT_A }),
    );
    expect(resp.status).toBe(200);
    expect(repo.getById('t1')?.status).toBe('failed');
  });

  it('owner (in-process, no callerType) is NOT gated — completes a delegation → 200', async () => {
    const router = build();
    seedRunningDelegation('t1', AGENT_A);
    const resp = await router.handle(actionReq('t1', 'complete', { result: 'ok' })); // no caller
    expect(resp.status).toBe(200);
    expect(repo.getById('t1')?.status).toBe('completed');
  });
});
