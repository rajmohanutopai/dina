/**
 * A2A Lane 1 routes (design §4.3): who may call what, and that every view
 * is owner-safe — Brain proposes and guards; the owner manages agents and
 * operations; quarantined content appears nowhere.
 */

import { getA2ARuntime, installA2A } from '../../src/a2a';
import { isAuthorized } from '../../src/auth/authz';
import { getNodeDID, setNodeDID } from '../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerA2ARoutes } from '../../src/server/routes/a2a';

import { CARD_URL, LaneWorld, RUNNER_DID, agentCard, SESSION } from './outbound_fixture';

const CAP = 'owner-capability-for-tests';

let world: LaneWorld;
let router: CoreRouter;

beforeEach(() => {
  world = new LaneWorld();
  router = new CoreRouter();
  registerA2ARoutes(router, CAP);
});
afterEach(() => world.close());

type Caller = 'brain' | 'owner' | 'agent' | 'in-process';

async function call(caller: Caller, method: CoreRequest['method'], path: string, body: Record<string, unknown> = {}) {
  const req: CoreRequest = {
    method,
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    // Requests as the router sees them after authentication resolved the caller.
    trustedInProcess: true,
    ...(caller === 'brain' || caller === 'agent' ? { callerType: caller, callerDID: 'did:key:caller' } : {}),
    ...(caller === 'owner' ? { callerType: 'owner', ownerCapability: CAP } : {}),
  };
  return router.handle(req);
}

async function ownerRegistersAndActivates(): Promise<string> {
  world.turn(); // the owner's turn the proposals below belong to
  const reg = await call('owner', 'POST', '/v1/owner/a2a/remote-agents', { card_url: CARD_URL });
  expect(reg.status).toBe(201);
  const agentId = (reg.body as { agent_id: string }).agent_id;
  const cred = await call('owner', 'POST', `/v1/owner/a2a/remote-agents/${agentId}/credentials`, { kind: 'none' });
  expect(cred.status).toBe(201);
  const ref = (cred.body as { credential_ref: string }).credential_ref;
  const bind = await call('owner', 'POST', `/v1/owner/a2a/remote-agents/${agentId}/bindings`, {
    skill: 'summarize',
    action_class: 'read',
    credential_ref: ref,
  });
  expect(bind.status).toBe(200);
  expect((await call('owner', 'POST', `/v1/owner/a2a/remote-agents/${agentId}/activate`)).status).toBe(200);
  return agentId;
}

describe('the authorization matrix opens exactly Brain’s doors', () => {
  it.each([
    ['POST', '/v1/a2a/delegate', true],
    ['GET', '/v1/a2a/agents', true],
    ['GET', '/v1/a2a/self', true],
    ['POST', '/v1/a2a/self', false],
    ['GET', '/v1/a2a/self/x', false],
    ['GET', '/v1/a2a/operations/abc', true],
    ['POST', '/v1/a2a/guard/next', true],
    ['POST', '/v1/a2a/guard/verdict', true],
    ['GET', '/v1/a2a/delegate', false],
    ['GET', '/v1/a2a/operations/abc/extra', false],
    ['GET', '/v1/a2a/guard/next', false],
    ['POST', '/v1/a2a/ingress/message', false],
    ['POST', '/v1/owner/a2a/remote-agents', false],
  ])('brain %s %s → %p', (method, path, allowed) => {
    expect(isAuthorized('brain', method, path)).toBe(allowed);
  });

  it.each(['agent', 'device', 'plugin', 'connector', 'admin'] as const)('refuses %s on every A2A door', (caller) => {
    for (const [method, path] of [
      ['POST', '/v1/a2a/delegate'],
      ['POST', '/v1/a2a/guard/next'],
      ['POST', '/v1/a2a/guard/verdict'],
      ['GET', '/v1/a2a/self'],
    ] as const) {
      expect(isAuthorized(caller, method, path)).toBe(false);
    }
  });
});

describe('owner management', () => {
  it('registers, credentials, binds and activates; lists and reads back', async () => {
    const agentId = await ownerRegistersAndActivates();
    const list = await call('owner', 'GET', '/v1/owner/a2a/remote-agents');
    const agents = (list.body as { agents: Record<string, unknown>[] }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ agent_id: agentId, status: 'active', signature_state: 'unsigned' });
    expect((agents[0]?.bindings as unknown[]).length).toBe(1);
    expect(agents[0]?.card_json).toBeUndefined();
    const one = await call('owner', 'GET', `/v1/owner/a2a/remote-agents/${agentId}`);
    expect(one.status).toBe(200);
  });

  it('maps refusals to statuses', async () => {
    const agentId = await ownerRegistersAndActivates();
    expect((await call('owner', 'POST', '/v1/owner/a2a/remote-agents', { card_url: CARD_URL })).status).toBe(409);
    expect((await call('owner', 'POST', '/v1/owner/a2a/remote-agents', { card_url: 'http://x.example/c' })).status).toBe(400);
    expect((await call('owner', 'GET', '/v1/owner/a2a/remote-agents/nope')).status).toBe(404);
    expect((await call('owner', 'POST', `/v1/owner/a2a/remote-agents/${agentId}/activate`)).status).toBe(409);
    expect((await call('owner', 'POST', `/v1/owner/a2a/remote-agents/${agentId}/credentials`, { kind: 'bearer' })).status).toBe(400);
    expect(
      (await call('owner', 'POST', `/v1/owner/a2a/remote-agents/${agentId}/bindings`, { skill: 'summarize', action_class: 'payment', credential_ref: 'x' })).status,
    ).toBe(400);
  });

  it('re-verifies, sees a changed card, and revokes', async () => {
    const agentId = await ownerRegistersAndActivates();
    world.cards.set(CARD_URL, agentCard({ version: '9' }));
    const verified = await call('owner', 'POST', `/v1/owner/a2a/remote-agents/${agentId}/verify`);
    expect(verified.body).toMatchObject({ changed: true, agent: { status: 'changed' } });
    expect((await call('owner', 'POST', `/v1/owner/a2a/remote-agents/${agentId}/revoke`)).status).toBe(200);
    expect((await call('owner', 'POST', `/v1/owner/a2a/remote-agents/${agentId}/verify`)).status).toBe(409);
  });

  it('serves a remote agent’s PeerLens evidence to the owner only (display only, §6.1)', async () => {
    const agentId = await ownerRegistersAndActivates();
    expect(await call('owner', 'GET', `/v1/owner/a2a/remote-agents/${agentId}/evidence`)).toMatchObject({ status: 200, body: { status: 'not_dina' } });
    expect((await call('owner', 'GET', '/v1/owner/a2a/remote-agents/nope/evidence')).status).toBe(404);
    expect((await call('brain', 'GET', `/v1/owner/a2a/remote-agents/${agentId}/evidence`)).status).toBe(403);
    expect(isAuthorized('brain', 'GET', `/v1/owner/a2a/remote-agents/${agentId}/evidence`)).toBe(false);
  });

  it('refuses Brain, and refuses everyone when no owner capability is configured', async () => {
    expect((await call('brain', 'GET', '/v1/owner/a2a/remote-agents')).status).toBe(403);
    const bare = new CoreRouter();
    registerA2ARoutes(bare);
    const resp = await bare.handle({
      method: 'GET',
      path: '/v1/owner/a2a/remote-agents',
      query: {},
      headers: {},
      body: {},
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'owner',
      ownerCapability: CAP,
    });
    expect(resp.status).toBe(403);
  });
});

describe('the runtime follows the current workflow service', () => {
  it('pairs the installed store with whichever service is set, and throws on one on another connection', async () => {
    const first = getA2ARuntime();
    expect(first?.workflow).toBe(world.workflow);
    world.useService(true); // the server swaps its early service for the full plane
    const second = getA2ARuntime();
    expect(second?.workflow).toBe(world.workflow);
    expect(second).not.toBe(first);
    const { WorkflowService, InMemoryWorkflowRepository, setWorkflowService } = await import('../../src');
    setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
    // A split commit is a wiring fault: loud, so the host's boot check stops it.
    expect(() => getA2ARuntime()).toThrow(/A2A/);
    // A route meeting it answers 500, and changes nothing.
    const resp = await call('brain', 'POST', '/v1/a2a/delegate', { release_session: SESSION, agent_id: 'a', skill: 's', text: 'x' });
    expect(resp.status).toBe(500);
    expect(world.store.listTasksInStates('outbound', ['pending_decision'])).toEqual([]);
  });

  it('an approval still commits when the handler meets the fault; the boot check is what stops it', async () => {
    const { WorkflowService, InMemoryWorkflowRepository, setWorkflowService } = await import('../../src');
    const { a2aWorkflowHooks, parseDelegationConsentCard, proposeDelegation } = await import('../../src/a2a');
    // A real consent card, so the handler goes on to ask for the runtime.
    const agentId = await ownerRegistersAndActivates();
    const proposed = proposeDelegation(world.runtime, { releaseSession: SESSION, agentId, skill: 'summarize', text: 'hi' });
    if (!proposed.ok) throw new Error(proposed.reason);
    const payload = world.repo.getById(proposed.approvalTaskId)?.payload ?? '';
    expect(parseDelegationConsentCard(payload)).not.toBeNull();
    const handler = jest.fn(a2aWorkflowHooks(getA2ARuntime).approvalDecisionHandler);
    const service = new WorkflowService({
      repository: new InMemoryWorkflowRepository(),
      approvalDecisionHandler: handler,
    });
    setWorkflowService(service);
    service.create({ id: 'card-1', kind: 'approval', description: 'x', payload, initialState: 'pending_approval' } as never);
    expect(() => service.approve('card-1')).not.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.results[0]?.type).toBe('throw');
    expect(service.store().getById('card-1')?.status).toBe('queued');
  });
});

describe('Brain', () => {
  it('lists callable agents with their bound skills only', async () => {
    const agentId = await ownerRegistersAndActivates();
    const resp = await call('brain', 'GET', '/v1/a2a/agents');
    expect(resp.body).toEqual({
      agents: [
        {
          agent_id: agentId,
          name: 'Summarizer',
          description: 'Summarizes and extracts.',
          skills: [{ skill: 'summarize', name: 'Summarize', description: 'Summarize a text.', action_class: 'read' }],
        },
      ],
    });
  });

  it('proposes; the owner (not Brain) cancels; Brain reads the operation', async () => {
    const agentId = await ownerRegistersAndActivates();
    const proposed = await call('brain', 'POST', '/v1/a2a/delegate', { release_session: SESSION, agent_id: agentId, skill: 'summarize', text: 'hi', reply_to: 'main' });
    expect(proposed.status).toBe(201);
    const { operation_id, labels } = proposed.body as { operation_id: string; labels: string[] };
    expect(labels).toEqual(['may_contain_sensitive', 'unverified']);
    expect((await call('owner', 'POST', '/v1/a2a/delegate', { release_session: SESSION, agent_id: agentId, skill: 'summarize', text: 'x' })).status).toBe(403);
    expect((await call('brain', 'POST', `/v1/owner/a2a/operations/${operation_id}/cancel`)).status).toBe(403);
    expect((await call('owner', 'POST', `/v1/owner/a2a/operations/${operation_id}/cancel`)).body).toEqual({ state: 'cancelled' });
    const read = await call('brain', 'GET', `/v1/a2a/operations/${operation_id}`);
    expect(read.body).toMatchObject({ operation_id, state: 'cancelled', result: null, reply_to: 'main' });
    expect((await call('owner', 'GET', '/v1/owner/a2a/operations')).body).toMatchObject({ operations: [{ operation_id }] });
  });

  // Cold audit C3-5: one cancel request per operation, answered truthfully
  it('a cancel the remote refused: the owner’s next cancel answers 409, and both views show it', async () => {
    const agentId = await ownerRegistersAndActivates();
    const proposed = await call('in-process', 'POST', '/v1/a2a/delegate', { release_session: SESSION, agent_id: agentId, skill: 'summarize', text: 'hi' });
    const { operation_id, approval_task_id } = proposed.body as { operation_id: string; approval_task_id: string };
    world.workflow.approve(approval_task_id);
    const task = world.claim(agentId);
    if (task === null) throw new Error('claim');
    const { beginOutboundDispatch, takeCancelRequest, recordCancelRefused } = await import('../../src/a2a');
    const claim = { childTaskId: task.id, claimId: task.claim_id as string, runnerDid: RUNNER_DID };
    // Dispatched: the operation runs, so a cancel is asked of the remote.
    expect(beginOutboundDispatch(world.runtime, claim)).toMatchObject({ kind: 'send' });
    const cancel = () => call('owner', 'POST', `/v1/owner/a2a/operations/${operation_id}/cancel`);
    expect(await cancel()).toMatchObject({ status: 200, body: { state: 'cancel_requested' } });
    // Asking again before the remote answers is the same request.
    expect(await cancel()).toMatchObject({ status: 200, body: { state: 'cancel_requested' } });
    expect(takeCancelRequest(world.runtime, claim)).toBe(true);
    expect((await call('owner', 'GET', `/v1/owner/a2a/operations/${operation_id}`)).body).toMatchObject({ state: 'running', cancel: 'attempting' });
    expect(recordCancelRefused(world.runtime, claim)).toBe(true);
    expect(await cancel()).toMatchObject({ status: 409, body: { error: 'cancel_refused' } });
    expect((await call('owner', 'GET', `/v1/owner/a2a/operations/${operation_id}`)).body).toMatchObject({ state: 'running', cancel: 'refused' });
    expect((await call('brain', 'GET', `/v1/a2a/operations/${operation_id}`)).body).toMatchObject({ state: 'running', cancel: 'refused' });
  });

  it('runs the guard over the routes, and only Brain may', async () => {
    const agentId = await ownerRegistersAndActivates();
    const proposed = await call('in-process', 'POST', '/v1/a2a/delegate', { release_session: SESSION, agent_id: agentId, skill: 'summarize', text: 'hi' });
    const { operation_id, approval_task_id } = proposed.body as { operation_id: string; approval_task_id: string };
    world.workflow.approve(approval_task_id);
    const task = world.claim(agentId);
    if (task === null) throw new Error('claim');
    const { beginOutboundDispatch, recordRemoteOutcome } = await import('../../src/a2a');
    const claim = { childTaskId: task.id, claimId: task.claim_id as string, runnerDid: RUNNER_DID };
    beginOutboundDispatch(world.runtime, claim);
    recordRemoteOutcome(world.runtime, claim, { kind: 'result', parts: [{ text: 'held text' }] });

    expect((await call('owner', 'POST', '/v1/a2a/guard/next')).status).toBe(403);
    const quarantined = await call('brain', 'GET', `/v1/a2a/operations/${operation_id}`);
    expect(JSON.stringify(quarantined.body)).not.toContain('held text');
    const next = await call('brain', 'POST', '/v1/a2a/guard/next');
    expect(next.status).toBe(200);
    const work = next.body as { job_id: string; claim_id: string; digest: string; content: unknown };
    expect(work.content).toEqual({ version: 1, parts: [{ text: 'held text' }] });
    expect((await call('brain', 'POST', '/v1/a2a/guard/next')).status).toBe(204);
    expect((await call('brain', 'POST', '/v1/a2a/guard/verdict', { job_id: work.job_id, claim_id: work.claim_id, digest: work.digest, verdict: 'passed' })).status).toBe(400);
    expect((await call('brain', 'POST', '/v1/a2a/guard/verdict', { job_id: work.job_id, claim_id: work.claim_id, digest: 'x', verdict: 'passed', code: 'model_pass' })).status).toBe(409);
    const verdict = await call('brain', 'POST', '/v1/a2a/guard/verdict', { job_id: work.job_id, claim_id: work.claim_id, digest: work.digest, verdict: 'passed', code: 'model_pass' });
    expect(verdict.body).toEqual({ state: 'completed' });
    const released = await call('brain', 'GET', `/v1/a2a/operations/${operation_id}`);
    expect(released.body).toMatchObject({ state: 'completed', result: { version: 1, parts: [{ text: 'held text' }] } });
  });

  it('names the node’s own DID, once Core has one, to Brain and the owner only; it needs no Lane 1', async () => {
    // Runs before anything in this file sets the node DID (module state starts null per file).
    expect(getNodeDID()).toBeNull();
    expect(await call('brain', 'GET', '/v1/a2a/self')).toMatchObject({ status: 503, body: { error: 'node_did_unavailable' } });
    setNodeDID('did:plc:ewvi7nxzyoun6zhxrhs64oiz');
    installA2A(null);
    expect(await call('brain', 'GET', '/v1/a2a/self')).toMatchObject({ status: 200, body: { did: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz' } });
    expect((await call('owner', 'GET', '/v1/a2a/self')).status).toBe(200);
    expect((await call('agent', 'GET', '/v1/a2a/self')).status).toBe(403);
  });

  it('answers 503 while no host has installed Lane 1 (the phone)', async () => {
    installA2A(null);
    expect((await call('brain', 'POST', '/v1/a2a/delegate', { release_session: SESSION, agent_id: 'a', skill: 's' })).status).toBe(503);
    expect((await call('brain', 'GET', '/v1/a2a/agents')).status).toBe(503);
  });
});
