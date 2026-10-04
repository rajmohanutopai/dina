/**
 * Lane 1 gaps from consent to the remote's answer (design §6.2–§6.5, plan
 * §3.17): the total pending bound, a lapsed card, data nested too deep,
 * who may decide a card, lanes that only look reserved, the credential the
 * headers were built for, a second dispatch under one claim, repeated mints,
 * result parts Dina refuses, and an unreadable pinned schema.
 */

import { a2aLaneFor, type JsonObject } from '@dina/a2a';

import {
  MAX_PENDING_PER_AGENT,
  MAX_PENDING_TOTAL,
  MAX_PROPOSALS_PER_HOUR,
  activateRemoteAgent,
  beginOutboundDispatch,
  bindRemoteSkill,
  buildOutgoingProjection,
  createNoneCredential,
  mintOutboundPermit,
  proposeDelegation,
  recordRemoteOutcome,
  registerRemoteAgent,
  sweepA2AOutbound,
  type DispatchClaim,
} from '../../src/a2a';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerWorkflowRoutes } from '../../src/server/routes/workflow';

import { LaneWorld, RUNNER_DID, SESSION, agentCard } from './outbound_fixture';

const OWNER_CAP = 'owner-capability-for-tests';

let world: LaneWorld;
let agentId: string;

beforeEach(async () => {
  world = new LaneWorld();
  ({ agentId } = await world.activeAgent());
});
afterEach(() => world.close());

function propose(text = 'Summarize the attached note.', skill = 'summarize', agent = agentId) {
  const out = proposeDelegation(world.runtime, { releaseSession: SESSION, agentId: agent, skill, text, replyTo: 'main' });
  if (!out.ok) throw new Error(`propose: ${out.reason}`);
  return out;
}

function claimDispatch(agent = agentId): DispatchClaim {
  const task = world.claim(agent);
  if (task === null) throw new Error('nothing to claim');
  return { childTaskId: task.id, claimId: task.claim_id as string, runnerDid: RUNNER_DID };
}

function op(operationId: string) {
  const row = world.store.getTaskByExternal('outbound', 'owner', operationId);
  if (row === null) throw new Error('no operation');
  return row;
}

function sending(text = 'go', skill = 'summarize') {
  const p = propose(text, skill);
  world.workflow.approve(p.approvalTaskId);
  const claim = claimDispatch();
  const start = beginOutboundDispatch(world.runtime, claim);
  if (start.kind !== 'send') throw new Error(`expected send, got ${start.kind}`);
  return { p, claim, start };
}

function router(): CoreRouter {
  const r = new CoreRouter();
  registerWorkflowRoutes(r, OWNER_CAP);
  return r;
}

function req(method: CoreRequest['method'], path: string, body: Record<string, unknown>, callerType: string): CoreRequest {
  return {
    method,
    path,
    query: {},
    headers: { 'x-did': 'did:key:caller' },
    ...(callerType === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType,
    callerDID: 'did:key:caller',
  };
}

/** A second active agent on its own card URL, bound to `summarize`. */
async function anotherAgent(n: number): Promise<string> {
  const url = `https://agent${n}.example/.well-known/agent-card.json`;
  world.cards.set(url, agentCard({ supportedInterfaces: [{ url: `https://agent${n}.example/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] }));
  const d = { store: world.store, nowMs: () => world.clock };
  const reg = await registerRemoteAgent(d, url);
  if (!reg.ok) throw new Error(reg.reason);
  const cred = createNoneCredential(d, reg.agent.agent_id);
  if (!cred.ok) throw new Error(cred.reason);
  bindRemoteSkill(d, reg.agent.agent_id, { skill: 'summarize', actionClass: 'read', credentialRef: cred.credential.credential_ref });
  activateRemoteAgent(d, reg.agent.agent_id);
  return reg.agent.agent_id;
}

describe('proposal bounds (design §6.2 step 0)', () => {
  // Plan B75
  it('holds at most 50 cards pending in all, across agents', async () => {
    expect(MAX_PENDING_TOTAL).toBe(50);
    const agents = [agentId];
    for (let n = 2; n <= 6; n += 1) agents.push(await anotherAgent(n));
    // The hourly cap is 30, so the first 30 cards wait unswept past the hour.
    let made = 0;
    for (const agent of agents.slice(0, 3)) {
      for (let i = 0; i < MAX_PENDING_PER_AGENT; i += 1) propose(`message ${made++}`, 'summarize', agent);
    }
    expect(made).toBe(MAX_PROPOSALS_PER_HOUR);
    world.clock += 60 * 60_000 + 1;
    world.turn();
    for (const agent of agents.slice(3, 5)) {
      for (let i = 0; i < MAX_PENDING_PER_AGENT; i += 1) propose(`message ${made++}`, 'summarize', agent);
    }
    expect(world.store.listTasksInStates('outbound', ['pending_decision'])).toHaveLength(MAX_PENDING_TOTAL);
    const sixth = agents[5] ?? '';
    expect(proposeDelegation(world.runtime, { releaseSession: SESSION, agentId: sixth, skill: 'summarize', text: 'one more' })).toEqual({
      ok: false,
      reason: 'too_many_pending',
    });
    expect(world.store.listTasksInStates('outbound', ['pending_decision'])).toHaveLength(MAX_PENDING_TOTAL);
  });

  // Plan B125
  it('refuses data nested deeper than the envelope can carry, and stages nothing', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 64; i += 1) deep = { next: deep };
    expect(buildOutgoingProjection({ text: 'x', data: deep })).toEqual({ ok: false, reason: 'data_too_deep' });
    expect(proposeDelegation(world.runtime, { releaseSession: SESSION, agentId, skill: 'summarize', text: 'x', data: deep })).toEqual({
      ok: false,
      reason: 'data_too_deep',
    });
    expect(world.store.listTasksInStates('outbound', ['pending_decision'])).toEqual([]);
  });
});

describe('a lapsed consent card (design §6.2 step 1 "expiry terminalizes")', () => {
  // Plan B79 (as the verifier read it: a card the expiry sweep has closed)
  it('takes no approval once the expiry sweep has closed it: the approve fails, and Core mints nothing and sends nothing', async () => {
    const p = propose();
    world.clock += 16 * 60_000;
    world.workflow.expireTasks(Math.floor(world.clock / 1000), world.clock);
    expect(op(p.operationId).state).toBe('expired');

    expect(() => world.workflow.approve(p.approvalTaskId)).toThrow(/cannot be approved from state/);
    const owner = await router().handle(req('POST', `/v1/workflow/tasks/${p.approvalTaskId}/approve`, {}, 'owner'));
    expect(owner.status).toBe(409);
    expect(mintOutboundPermit(world.runtime, p.approvalTaskId)).toBe('not_pending');
    expect(sweepA2AOutbound(world.runtime).minted).toBe(0);
    expect(world.store.permitsOf(op(p.operationId).id)).toEqual([]);
    expect(world.store.childrenOf(op(p.operationId).id, 'dispatch')).toEqual([]);
    expect(world.claim(agentId)).toBeNull();
  });
});

describe('who decides a consent card (design §6.2 step 6)', () => {
  // Plan B139
  it.each(['agent', 'plugin'])('refuses %s callers the approve and both denials (cancel and fail)', async (callerType) => {
    const p = propose();
    const r = router();
    const approve = await r.handle(req('POST', `/v1/workflow/tasks/${p.approvalTaskId}/approve`, {}, callerType));
    const deny = await r.handle(req('POST', `/v1/workflow/tasks/${p.approvalTaskId}/cancel`, {}, callerType));
    // A claim token, so the plugin caller passes the shape check and meets the decision rule.
    const fail = await r.handle(req('POST', `/v1/workflow/tasks/${p.approvalTaskId}/fail`, { error: 'no', claim_id: 'claim-1' }, callerType));
    expect([approve.status, deny.status, fail.status]).toEqual([403, 403, 403]);
    expect([approve, deny, fail].map((x) => (x.body as { error: string }).error)).toEqual(['access_denied', 'access_denied', 'access_denied']);
    expect(world.repo.getById(p.approvalTaskId)?.status).toBe('pending_approval');
    expect(op(p.operationId).state).toBe('pending_decision');
    expect(world.store.permitsOf(op(p.operationId).id)).toEqual([]);
  });
});

describe('lanes that only look reserved (design §6.3)', () => {
  const CALLERS = ['device', 'plugin', 'brain'];
  const REFUSED: [string, string][] = [
    ['upper case', 'A2A:x'],
    ['a leading tab', '\ta2a:x'],
    ['a trailing new line', 'a2a:x\n'],
    ['a no-break space', '\u00A0a2a:x'],
  ];
  const rows = (spellings: [string, string][]) =>
    spellings.flatMap(([name, lane]) => CALLERS.map((caller): [string, string, string] => [name, caller, lane]));
  const create = (callerType: string, lane: string) =>
    router().handle(
      req(
        'POST',
        '/v1/workflow/tasks',
        { id: 't-lookalike', kind: 'delegation', description: 'x', payload: '{}', requested_runner: lane, initial_state: 'queued' },
        callerType,
      ),
    );

  // Plan B157
  it.each(rows(REFUSED))('a lane spelt with %s, from a %s caller, is refused as reserved, and no task exists', async (_name, callerType, spelt) => {
    const resp = await create(callerType, spelt.replace('x', agentId));
    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toBe('reserved_runner');
    expect(world.repo.getById('t-lookalike')).toBeNull();
  });

  // Plan B157
  it.each(CALLERS)('a lane spelt with a zero-width space, from a %s caller, is created outside the agent’s lane and never reaches its runner', async (callerType) => {
    const resp = await create(callerType, `\u200Ba2a:${agentId}`);
    expect(resp.status).toBe(201);
    expect(world.repo.getById('t-lookalike')?.requested_runner).toBe(`\u200Ba2a:${agentId}`);
    expect(world.repo.getById('t-lookalike')?.requested_runner).not.toBe(a2aLaneFor(agentId));
    expect(world.claim(agentId)).toBeNull();
  });

  // Plan B157 (control: the refusals above are the lane rule at work)
  it.each(CALLERS)('an ordinary lane from a %s caller is created', async (callerType) => {
    const resp = await create(callerType, 'transit');
    expect(resp.status).toBe(201);
    expect(world.repo.getById('t-lookalike')?.requested_runner).toBe('transit');
  });
});

describe('the dispatch transaction (design §6.3, §5.3)', () => {
  // Plan B52
  it('voids the permit when the runner built its headers for another credential than the one approved', () => {
    const p = propose();
    world.workflow.approve(p.approvalTaskId);
    const claim = claimDispatch();
    const other = createNoneCredential({ store: world.store, nowMs: () => world.clock }, agentId);
    if (!other.ok) throw new Error(other.reason);
    expect(beginOutboundDispatch(world.runtime, claim, { credential: { ref: other.credential.credential_ref, problem: null } })).toEqual({
      kind: 'settled',
      state: 'stale_authority',
      reason: 'credential_changed',
    });
    const row = op(p.operationId);
    expect(row).toMatchObject({ state: 'stale_authority', reason_code: 'credential_changed', message_id: null });
    expect(world.store.permitsOf(row.id).map((x) => [x.state, x.void_reason])).toEqual([['void', 'credential_changed']]);
    expect(world.repo.getById(claim.childTaskId)?.status).toBe('failed');
  });

  // Plan B168
  it('never sends twice under one claim: a second dispatch after transmitting ends outcome_unknown', () => {
    const { p, claim, start } = sending();
    expect(beginOutboundDispatch(world.runtime, claim)).toEqual({ kind: 'settled', state: 'outcome_unknown', reason: 'lease_lost_after_send' });
    const row = op(p.operationId);
    expect(row).toMatchObject({ state: 'outcome_unknown', message_id: start.messageId });
    expect(world.store.permitsOf(row.id).map((x) => x.state)).toEqual(['consumed']);
  });

  // Plan B169
  it('repeated mints and sweeps, across a restart, leave exactly one permit and one dispatch child', () => {
    world.useService(false);
    const p = propose();
    world.workflow.approve(p.approvalTaskId);
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      outcomes.push(mintOutboundPermit(world.runtime, p.approvalTaskId));
      sweepA2AOutbound(world.runtime);
    }
    world.restart();
    for (let i = 0; i < 3; i += 1) {
      sweepA2AOutbound(world.runtime);
      outcomes.push(mintOutboundPermit(world.runtime, p.approvalTaskId));
    }
    expect(outcomes.filter((o) => o === 'minted')).toHaveLength(1);
    const row = op(p.operationId);
    expect(world.store.permitsOf(row.id)).toHaveLength(1);
    expect(world.store.childrenOf(row.id, 'dispatch')).toHaveLength(1);
    const onLane = world.db.query(`SELECT id FROM workflow_tasks WHERE requested_runner = ?`, [a2aLaneFor(agentId)]);
    expect(onLane).toHaveLength(1);
  });
});

describe('result parts Dina refuses (design §6.5; A2A-I8)', () => {
  const REFUSED: [string, JsonObject[], string][] = [
    ['a url part', [{ url: 'https://agent.example/file.pdf' }], 'result_refused:url_part_refused'],
    ['text and data in one part', [{ text: 'a', data: { b: 1 } }], 'result_refused:part_content_not_exactly_one'],
    ['no parts at all', [], 'result_refused:no_parts'],
  ];

  // Plan B200
  it.each(REFUSED)('a read (summarize) refuses %s as a plain failure, and holds nothing for the guard', (_name, parts, reason) => {
    const { p, claim } = sending();
    expect(recordRemoteOutcome(world.runtime, claim, { kind: 'result', parts })).toEqual({ ok: true, state: 'failed' });
    const row = op(p.operationId);
    expect(row).toMatchObject({ state: 'failed', reason_code: reason, result_quarantine: null, result_json: null });
    expect(world.store.getGuardJobForOperation(row.id)).toBeNull();
    expect(world.repo.getById(claim.childTaskId)?.status).toBe('failed');
  });

  it.each(REFUSED)(
    'a write (extract) the remote reported done, refusing %s: outcome unknown, never a plain failure; nothing for the guard',
    (_name, parts, reason) => {
      const { p, claim } = sending('go', 'extract');
      expect(recordRemoteOutcome(world.runtime, claim, { kind: 'result', parts })).toEqual({ ok: true, state: 'outcome_unknown' });
      const row = op(p.operationId);
      expect(row).toMatchObject({ state: 'outcome_unknown', reason_code: reason, result_quarantine: null, result_json: null });
      expect(world.store.getGuardJobForOperation(row.id)).toBeNull();
      expect(world.repo.getById(claim.childTaskId)?.status).toBe('outcome_unknown');
    },
  );

  // Plan B204
  it('refuses a result when the schema pinned at consent cannot be read, and never falls back to the default envelope', () => {
    const { p, claim } = sending('go', 'extract');
    const row = op(p.operationId);
    const snapshot = JSON.parse(row.snapshot_json ?? '{}') as JsonObject;
    expect(typeof snapshot.result_schema_json).toBe('string');
    world.db.run('UPDATE a2a_tasks SET snapshot_json = ? WHERE id = ?', [JSON.stringify({ ...snapshot, result_schema_json: '{' }), row.id]);
    // A result the default envelope would take; the write may have happened.
    expect(recordRemoteOutcome(world.runtime, claim, { kind: 'result', parts: [{ text: 'fine' }] })).toEqual({ ok: true, state: 'outcome_unknown' });
    expect(op(p.operationId)).toMatchObject({ state: 'outcome_unknown', reason_code: 'result_refused:schema_unreadable', result_quarantine: null });
    expect(world.store.getGuardJobForOperation(row.id)).toBeNull();
  });

  it('a snapshot that cannot be read hides the class: the refusal is judged as one that may have acted', () => {
    const { p, claim } = sending();
    world.db.run('UPDATE a2a_tasks SET snapshot_json = ? WHERE id = ?', ['{', op(p.operationId).id]);
    expect(recordRemoteOutcome(world.runtime, claim, { kind: 'result', parts: [{ text: 'fine' }] })).toEqual({ ok: true, state: 'outcome_unknown' });
    expect(op(p.operationId)).toMatchObject({ state: 'outcome_unknown', reason_code: 'result_refused:snapshot_unreadable' });
  });
});
