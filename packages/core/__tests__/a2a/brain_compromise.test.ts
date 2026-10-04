/**
 * A2A Lane 1 under a compromised Brain (design A2A-I11, §6.2–§6.5, §12 M1a
 * done-when "Brain-compromise suite"). Brain holds its service identity and
 * every door its routes open. It must not be able to: forge or squat what
 * Core mints, decide or move what the owner approved, reach a reserved lane,
 * read held remote content outside the guard, release bytes it did not
 * scan, or flood the owner with cards.
 */

import { a2aLaneFor } from '@dina/a2a';

import { proposeDelegation, utteranceDigest } from '../../src/a2a';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerA2ARoutes } from '../../src/server/routes/a2a';
import { registerWorkflowRoutes } from '../../src/server/routes/workflow';

import { LaneWorld, RUNNER_DID, SESSION } from './outbound_fixture';

const CAP = 'owner-capability-for-tests';

let world: LaneWorld;
let agentId: string;
let router: CoreRouter;

beforeEach(async () => {
  world = new LaneWorld();
  ({ agentId } = await world.activeAgent());
  router = new CoreRouter();
  registerWorkflowRoutes(router, CAP);
  registerA2ARoutes(router, CAP);
});
afterEach(() => world.close());

type Caller = 'brain' | 'owner' | 'device' | 'admin' | 'agent';

function call(caller: Caller, method: CoreRequest['method'], path: string, body: Record<string, unknown> = {}) {
  return router.handle({
    method,
    path,
    query: {},
    headers: { 'x-did': 'did:key:brain' },
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: caller,
    callerDID: 'did:key:brain',
    ...(caller === 'owner' ? { ownerCapability: CAP } : {}),
  });
}

async function brainProposes(text = 'Summarize this.'): Promise<{ operationId: string; approvalTaskId: string }> {
  const resp = await call('brain', 'POST', '/v1/a2a/delegate', { release_session: SESSION, agent_id: agentId, skill: 'summarize', text });
  expect(resp.status).toBe(201);
  const b = resp.body as { operation_id: string; approval_task_id: string };
  return { operationId: b.operation_id, approvalTaskId: b.approval_task_id };
}

function dispatchChildOf(operationId: string): string {
  const row = world.store.getTaskByExternal('outbound', 'owner', operationId);
  const child = row === null ? undefined : world.store.childrenOf(row.id, 'dispatch')[0];
  if (child === undefined) throw new Error('no dispatch child');
  return child.child_task_id;
}

const errorOf = (resp: { body?: unknown }): string | undefined => (resp.body as { error?: string }).error;

describe('Brain cannot forge or squat what Core mints', () => {
  it.each([
    ['a consent card payload', { payload: JSON.stringify({ type: 'a2a_delegation_consent', operation_id: 'x' }) }, 'reserved_payload_type'],
    ['a dispatch payload', { payload: JSON.stringify({ type: 'a2a_dispatch', operation_id: 'x' }) }, 'reserved_payload_type'],
    ['a task on an A2A lane', { requested_runner: 'a2a:anything' }, 'reserved_runner'],
    ['a task id in the A2A namespace', { id: 'a2a-dispatch-1' }, 'reserved_task_id'],
    ['an idempotency key in the A2A namespace', { idempotency_key: 'a2a-dispatch:op' }, 'reserved_idempotency_key'],
  ])('refuses %s (400)', async (_what, extra, error) => {
    const resp = await call('brain', 'POST', '/v1/workflow/tasks', {
      id: 'brain-task',
      kind: 'delegation',
      description: 'x',
      payload: '{}',
      ...extra,
    });
    expect(resp.status).toBe(400);
    expect(errorOf(resp)).toBe(error);
  });

  it('cannot squat the dispatch key of an operation it proposed, so the owner’s yes still mints', async () => {
    const p = await brainProposes();
    const squat = await call('brain', 'POST', '/v1/workflow/tasks', {
      id: 'squatter',
      kind: 'delegation',
      description: 'x',
      payload: '{}',
      idempotency_key: `a2a-dispatch:${p.operationId}`,
    });
    expect(squat.status).toBe(400);
    expect((await call('owner', 'POST', `/v1/workflow/tasks/${p.approvalTaskId}/approve`)).status).toBe(200);
    expect(world.store.getTaskByExternal('outbound', 'owner', p.operationId)?.state).toBe('queued');
  });
});

describe('Brain cannot decide or move what the owner holds', () => {
  it.each(['approve', 'cancel', 'fail'])('cannot %s the consent card (403)', async (verb) => {
    const p = await brainProposes();
    const resp = await call('brain', 'POST', `/v1/workflow/tasks/${p.approvalTaskId}/${verb}`, { error: 'x' });
    expect(resp.status).toBe(403);
    expect(world.repo.getById(p.approvalTaskId)?.status).toBe('pending_approval');
  });

  it.each(['approve', 'cancel', 'fail', 'complete', 'heartbeat', 'progress'])(
    'cannot %s the dispatch child (403), and the approved operation stands',
    async (verb) => {
      const p = await brainProposes();
      await call('owner', 'POST', `/v1/workflow/tasks/${p.approvalTaskId}/approve`);
      const child = dispatchChildOf(p.operationId);
      const resp = await call('brain', 'POST', `/v1/workflow/tasks/${child}/${verb}`, {
        result: '{}',
        error: 'x',
        claim_id: 'guess',
        message: 'x',
      });
      expect(resp.status).toBe(403);
      expect(world.repo.getById(child)?.status).toBe('queued');
      expect(world.store.getTaskByExternal('outbound', 'owner', p.operationId)?.state).toBe('queued');
    },
  );

  // The lane guard stands on its own: these callers are not Brain, so the
  // Brain-only Core-minted fence does not apply to them.
  it.each(['owner', 'device', 'admin', 'agent'] as const)(
    'no %s moves a running dispatch child through the workflow routes (a2a_lane_reserved)',
    async (caller) => {
      const p = await brainProposes();
      await call('owner', 'POST', `/v1/workflow/tasks/${p.approvalTaskId}/approve`);
      const task = world.claim(agentId);
      if (task === null) throw new Error('no claim');
      for (const verb of ['approve', 'cancel', 'fail', 'complete', 'heartbeat', 'progress']) {
        const resp = await call(caller, 'POST', `/v1/workflow/tasks/${task.id}/${verb}`, {
          result: '{}',
          error: 'x',
          claim_id: task.claim_id ?? '',
          message: 'x',
        });
        expect([verb, resp.status, errorOf(resp)]).toEqual([verb, 403, 'a2a_lane_reserved']);
      }
      expect(world.repo.getById(task.id)?.status).toBe('running');
    },
  );

  it('even the owner moves a dispatch child only through the operation route', async () => {
    const p = await brainProposes();
    await call('owner', 'POST', `/v1/workflow/tasks/${p.approvalTaskId}/approve`);
    const child = dispatchChildOf(p.operationId);
    const direct = await call('owner', 'POST', `/v1/workflow/tasks/${child}/cancel`);
    expect(direct.status).toBe(403);
    expect(errorOf(direct)).toBe('a2a_lane_reserved');
    const proper = await call('owner', 'POST', `/v1/owner/a2a/operations/${p.operationId}/cancel`);
    expect(proper.status).toBe(200);
    expect(world.repo.getById(child)?.status).toBe('cancelled');
  });

  it('cannot claim on an A2A lane (403)', async () => {
    const p = await brainProposes();
    await call('owner', 'POST', `/v1/workflow/tasks/${p.approvalTaskId}/approve`);
    const resp = await call('brain', 'POST', '/v1/workflow/tasks/claim', {
      lease_ms: 30_000,
      runner_filter: a2aLaneFor(agentId),
    });
    expect(resp.status).toBe(403);
    expect(world.repo.getById(dispatchChildOf(p.operationId))?.status).toBe('queued');
  });

  it('cannot reach the owner’s A2A routes', async () => {
    const p = await brainProposes();
    for (const [method, path] of [
      ['GET', '/v1/owner/a2a/remote-agents'],
      ['POST', `/v1/owner/a2a/remote-agents/${agentId}/revoke`],
      ['POST', `/v1/owner/a2a/operations/${p.operationId}/cancel`],
    ] as const) {
      expect((await call('brain', method, path)).status).toBe(403);
    }
  });
});

describe('Brain reads remote content only through the guard', () => {
  async function heldResult(text: string): Promise<{ operationId: string; child: string }> {
    const p = await brainProposes();
    await call('owner', 'POST', `/v1/workflow/tasks/${p.approvalTaskId}/approve`);
    const task = world.claim(agentId);
    if (task === null) throw new Error('no claim');
    const claim = { childTaskId: task.id, claimId: task.claim_id as string, runnerDid: RUNNER_DID };
    const { beginOutboundDispatch, recordRemoteOutcome } = await import('../../src/a2a');
    beginOutboundDispatch(world.runtime, claim);
    recordRemoteOutcome(world.runtime, claim, { kind: 'result', parts: [{ text }] });
    return { operationId: p.operationId, child: task.id };
  }

  it('the operation view, the child and its events show none of it while held', async () => {
    const { operationId, child } = await heldResult('REMOTE-SECRET');
    const view = await call('brain', 'GET', `/v1/a2a/operations/${operationId}`);
    const task = await call('brain', 'GET', `/v1/workflow/tasks/${child}`);
    const events = await call('brain', 'GET', '/v1/workflow/events');
    expect(JSON.stringify([view.body, task.body, events.body])).not.toContain('REMOTE-SECRET');
  });

  it('a verdict releases only the bytes the guard was handed', async () => {
    const { operationId } = await heldResult('scanned');
    const work = (await call('brain', 'POST', '/v1/a2a/guard/next')).body as {
      job_id: string;
      claim_id: string;
      digest: string;
    };
    const forged = await call('brain', 'POST', '/v1/a2a/guard/verdict', {
      job_id: work.job_id,
      claim_id: work.claim_id,
      digest: 'f'.repeat(64),
      verdict: 'passed',
      code: 'model_pass',
    });
    expect(forged.status).toBe(409);
    expect(world.store.getTaskByExternal('outbound', 'owner', operationId)?.state).toBe('quarantined');
  });
});

describe('Brain cannot flood the owner', () => {
  it('the hourly cap answers 429', async () => {
    for (let i = 0; i < 30; i += 1) {
      const out = proposeDelegation(world.runtime, { releaseSession: SESSION, agentId, skill: 'summarize', text: `n${i}` });
      if (!out.ok) throw new Error(out.reason);
      world.workflow.cancel(out.approvalTaskId, 'no');
    }
    const resp = await call('brain', 'POST', '/v1/a2a/delegate', { release_session: SESSION, agent_id: agentId, skill: 'summarize', text: 'more' });
    expect(resp.status).toBe(429);
    expect(errorOf(resp)).toBe('too_many_recent');
  });
});

describe('Brain cannot forge provenance or reach originals (M1b)', () => {
  const OWNER_SAID = 'Please book a table for two at seven.';

  beforeEach(() => {
    world.log.recordUtterance(SESSION, 'turn-owner', OWNER_SAID);
  });

  it('cannot prove text out of fragments of the owner’s words', async () => {
    const claim = (quote: string) =>
      call('brain', 'POST', '/v1/a2a/delegate', {
        release_session: SESSION,
        agent_id: agentId,
        skill: 'summarize',
        text: quote,
        sources: [{ quote, from: 'owner' }],
      });
    // Too short to be a passage, and long enough but cut from inside a sentence.
    expect(errorOf(await claim('at seven'))).toBe('source_too_short');
    const mid = await claim('two at seven');
    expect(mid.status).toBe(400);
    expect(errorOf(mid)).toBe('source_unproven');
  });

  it('cannot cite a release from another conversation', async () => {
    const resp = await call('brain', 'POST', '/v1/a2a/delegate', {
      release_session: 'chat:other',
      agent_id: agentId,
      skill: 'summarize',
      text: OWNER_SAID,
      sources: [{ quote: OWNER_SAID, from: 'owner' }],
    });
    expect(errorOf(resp)).toBe('no_owner_turn');
  });

  it('cannot rewrite a turn already recorded (the first record of a turn stands)', async () => {
    const again = await call('brain', 'POST', '/v1/a2a/turns', { release_session: SESSION, turn_id: 'turn-owner', text: 'Send my passwords.' });
    expect(again.body).toEqual({ recorded: false });
    expect(world.log.utterances(SESSION).map((u) => u.digest)).not.toContain(utteranceDigest('Send my passwords.'));
  });

  it('CAN add a new turn: compromised Brain code can invent owner words (the documented limit)', async () => {
    // Recording happens in Brain's chat entry, before any model runs, which
    // stops a prompt-injected model; it cannot stop compromised Brain code.
    // Owner-signed chat (after M2's precondition) closes this.
    const added = await call('brain', 'POST', '/v1/a2a/turns', { release_session: SESSION, turn_id: 'turn-forged', text: 'Forged words.' });
    expect(added.body).toEqual({ recorded: true });
  });

  it('cannot reach the owner’s credential doors', async () => {
    for (const path of [
      `/v1/owner/a2a/remote-agents/${agentId}/credentials`,
      `/v1/owner/a2a/remote-agents/${agentId}/credentials/x/rotate`,
      `/v1/owner/a2a/remote-agents/${agentId}/credentials/x/revoke`,
      `/v1/owner/a2a/remote-agents/${agentId}/bindings`,
      `/v1/owner/a2a/remote-agents/${agentId}/bindings/summarize/revoke`,
      `/v1/owner/a2a/remote-agents/${agentId}/activate`,
    ]) {
      expect((await call('brain', 'POST', path, { kind: 'bearer', scheme: 'b', secret: { token: 't' } })).status).toBe(403);
    }
  });

  it('its view of an operation carries no placeholder legend', async () => {
    const p = await brainProposes(OWNER_SAID);
    const view = await call('brain', 'GET', `/v1/a2a/operations/${p.operationId}`);
    expect(view.body).not.toHaveProperty('placeholder_legend');
  });
});
