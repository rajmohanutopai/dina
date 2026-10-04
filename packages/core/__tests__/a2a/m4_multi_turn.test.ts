/**
 * M4 inbound multi-turn (design §7.3, §7.7; notes M4 step 2): the rules the
 * plan's area D listed with no test of their own. Who may ask; a runner
 * whose lease lapsed cannot ask; a parked round takes no report from its
 * runner; subscribing to an asking task; the checks an answer passes before
 * it moves a round (the webhook cap, the budget, a strict body); an answer
 * after the call lost its authority; an answer past the deadline, taken
 * until the expiry sweep runs; the old round after an answer has no
 * authority left; minting refuses while an earlier round's permit is
 * live; a listing deleted while asking.
 */

import { A2A_EVENT_SEQ_HEADER } from '@dina/a2a';

import {
  A2A_RPC_PATH,
  INBOUND_INPUT_DEADLINE_SECONDS,
  MAX_PUSH_CONFIGS_PER_TASK,
  PrincipalBudgets,
  admitInboundClaimWith,
  authorizeInboundEffectWith,
  inboundExecutionTaskId,
  ingressCreatePushConfig,
  ingressGetTask,
  ingressSendMessage,
  ingressSubscribeToTask,
  issueA2AGrant,
  mintExecutionChild,
  readInboundSnapshot,
  requestInboundInputWith,
  sweepA2AInbound,
  type InboundRuntime,
  type InputRequest,
} from '../../src/a2a';
import { isAuthorized, type CallerType } from '../../src/auth/authz';
import { CoreRouter, type CoreRequest, type CoreResponse } from '../../src/server/router';
import { registerWorkflowRoutes } from '../../src/server/routes/workflow';
import { clearServiceConfigDurable } from '../../src/service/service_config';
import { CapabilityInputRequired, LocalDelegationRunner } from '../../src/workflow/local_delegation_runner';

import { InboundWorld, bookingListing, errorOf, listing, resultOf, save, sentTask } from './inbound_fixture';

import type { CapabilityTurn } from '../../src/workflow/local_delegation_runner';

const STOP_SCHEMA = {
  type: 'object',
  required: ['stop'],
  properties: { stop: { type: 'string', minLength: 1 } },
};
const ASK: InputRequest = { prompt: 'Which stop are you waiting at?', input_schema: STOP_SCHEMA };

let iw: InboundWorld;
beforeEach(async () => {
  iw = await InboundWorld.create();
});
afterEach(() => iw.close());

let callNo = 0;
/** A fresh read call through `rt` (the world's own by default); its task id. */
const eta = (rt: InboundRuntime = iw.rt) => {
  callNo += 1;
  const message = iw.message({ skill: 'eta_query', params: { route_id: '42' } }, { messageId: `m4-turn-${callNo}` });
  return sentTask(ingressSendMessage(rt, iw.request('SendMessage', message))).id as string;
};
const view = (id: string) => resultOf(ingressGetTask(iw.rt, iw.request('GetTask', { id }), id));
const stateOf = (id: string) => (view(id).status as { state: string }).state;
const claimIdOf = (taskId: string) => iw.world.workflow.store().getById(taskId)?.claim_id;

/** Claim the current round as its pinned runner would, and ask. */
function claimAndAsk(id: string, ask: unknown = ASK) {
  const { verdict, taskId } = iw.claimChild(id);
  if (verdict !== 'admitted') throw new Error(`claim ${verdict}`);
  const claimId = claimIdOf(taskId);
  const out = requestInboundInputWith(iw.rt, { taskId, claimantDid: iw.runnerDid, claimId, request: ask });
  if (out.kind !== 'parked') throw new Error(`ask ${JSON.stringify(out)}`);
  return { taskId, claimId };
}

let answerNo = 0;
/** The caller's answer: a SendMessage naming the task, one data part. */
function answer(id: string, data: unknown, over: { rt?: InboundRuntime; params?: Record<string, unknown> } = {}) {
  answerNo += 1;
  return ingressSendMessage(
    over.rt ?? iw.rt,
    iw.request('SendMessage', {
      message: { messageId: `m4-ans-${answerNo}`, role: 'ROLE_USER', taskId: id, parts: [{ data }] },
      ...over.params,
    }),
  );
}

/** Where the call stands: still asking round `round`, its waiting child untouched. */
function stillAsking(id: string, waiting: string, round = 0): void {
  expect(stateOf(id)).toBe('TASK_STATE_INPUT_REQUIRED');
  expect(iw.opOf(id)).toEqual(expect.objectContaining({ continuation_generation: round, internal_id: waiting }));
  expect(iw.world.workflow.store().getById(waiting)?.status).toBe('awaiting');
}

/** The executor verbs, as a paired runner reaches them (the route's own guards run). */
const router = new CoreRouter();
registerWorkflowRoutes(router);
const verb = (taskId: string, name: string, did: string, body: Record<string, unknown>): Promise<CoreResponse> =>
  router.handle({
    method: 'POST',
    path: `/v1/workflow/tasks/${taskId}/${name}`,
    query: {},
    headers: { 'x-did': did },
    body,
    rawBody: new Uint8Array(),
    params: { id: taskId },
    trustedInProcess: true,
    callerType: 'agent',
    callerDID: did,
  } as CoreRequest);

describe('who may ask (§7.7: the runner holding the claim)', () => {
  // Plan D82
  it('opens the ask route to paired runners alone in the authorization matrix', () => {
    const path = '/v1/workflow/tasks/t-1/input-required';
    expect(isAuthorized('agent', 'POST', path)).toBe(true);
    for (const other of ['owner', 'brain', 'admin', 'connector', 'device', 'plugin', 'staff', 'owner_device', 'gateway'] as CallerType[]) {
      expect(isAuthorized(other, 'POST', path)).toBe(false);
    }
  });

  // Plan D83
  it('a runner whose lease lapsed cannot ask with its old claim; the round waits for the next claim', () => {
    const id = eta();
    const { taskId } = iw.claimChild(id, 1_000);
    const stale = claimIdOf(taskId);
    iw.world.clock += 5_000;
    expect(iw.world.repo.expireLeasedTasks(iw.world.clock)).toHaveLength(1);
    expect(requestInboundInputWith(iw.rt, { taskId, claimantDid: iw.runnerDid, claimId: stale, request: ASK })).toEqual({
      kind: 'refused',
      reason: 'claim_lost',
    });
    expect(iw.world.workflow.store().getById(taskId)?.status).toBe('queued');
    expect(iw.opOf(id).input_required_json).toBeNull();
    expect(stateOf(id)).toBe('TASK_STATE_SUBMITTED');
    // Claimed again, under a new token, the round may ask.
    const again = iw.claimChild(id);
    expect(again.taskId).toBe(taskId);
    const fresh = claimIdOf(taskId);
    expect(fresh).not.toBe(stale);
    expect(requestInboundInputWith(iw.rt, { taskId, claimantDid: iw.runnerDid, claimId: fresh, request: ASK }).kind).toBe('parked');
  });
});

describe('a parked round waits for its caller (§7.7)', () => {
  // Plan D84, D129
  it.each([
    ['complete', { result: JSON.stringify({ eta_minutes: 1 }) }, 403],
    ['fail', { error: 'gave up' }, 403],
    ['heartbeat', {}, 409],
    ['progress', { message: 'still here' }, 409],
  ] as const)('refuses %s from its own runner under its claim token, and keeps asking', async (name, body, status) => {
    const id = eta();
    const { taskId, claimId } = claimAndAsk(id);
    const out = await verb(taskId, name, iw.runnerDid, { ...body, claim_id: claimId });
    expect(out.status).toBe(status);
    stillAsking(id, taskId);
    expect(iw.opOf(id).result_json).toBeNull();
    // The caller's answer still moves the call on.
    expect(answer(id, { stop: 'Elm' }).status).toBe(200);
    expect(stateOf(id)).toBe('TASK_STATE_WORKING');
  });

  // Plan D82
  it('refuses an ask from anyone but the pinned runner, at the route', async () => {
    const id = eta();
    const { taskId } = iw.claimChild(id);
    const claimId = claimIdOf(taskId);
    const out = await verb(taskId, 'input-required', 'did:key:z6MkSomeOtherAgent', { claim_id: claimId, ...ASK });
    expect(out).toEqual(
      expect.objectContaining({
        status: 403,
        body: { error: 'access_denied', reason: 'only the runner this call is pinned to may act on it' },
      }),
    );
    expect(iw.opOf(id).input_required_json).toBeNull();
    expect(stateOf(id)).toBe('TASK_STATE_WORKING');
    // The pinned runner, under the same claim token, may ask at the same route.
    const own = await verb(taskId, 'input-required', iw.runnerDid, { claim_id: claimId, ...ASK });
    expect(own.status).toBe(200);
    expect(iw.opOf(id).input_required_json).not.toBeNull();
    expect(stateOf(id)).toBe('TASK_STATE_INPUT_REQUIRED');
  });
});

describe('subscribing to an asking task (§7.5, notes M4 step 2)', () => {
  // Plan D91
  it('answers the asking task and its event cursor, since asking is not an end', () => {
    const id = eta();
    claimAndAsk(id);
    const out = ingressSubscribeToTask(iw.rt, iw.request('SubscribeToTask', { id }), id);
    expect(out.status).toBe(200);
    const task = resultOf(out).task as { id: string; status: { state: string; message?: { messageId: string } } };
    expect(task.id).toBe(id);
    expect(task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(task.status.message?.messageId).toBe(`${id}-input-0`);
    expect(out.headers?.[A2A_EVENT_SEQ_HEADER]).toBe(String(iw.opOf(id).event_seq));
    // The same task, polled.
    expect(view(id).status).toEqual(task.status);
  });
});

describe('what an answer must pass before it moves a round (notes M4 step 2, in order)', () => {
  // Plan D101
  it('refuses an inline webhook past the task’s cap, before the commit: nothing moves', () => {
    const id = eta();
    const { taskId } = claimAndAsk(id);
    for (let i = 0; i < MAX_PUSH_CONFIGS_PER_TASK; i++) {
      const made = ingressCreatePushConfig(
        iw.rt,
        iw.request('CreateTaskPushNotificationConfig', { taskId: id, url: `https://hooks.example.test/${i}` }),
        id,
      );
      expect(made.status).toBe(200);
    }
    const out = answer(id, { stop: 'Elm' }, { params: { configuration: { taskPushNotificationConfig: { url: 'https://hooks.example.test/one-more' } } } });
    expect(errorOf(out)).toEqual({ code: -32602, reason: 'too_many_push_configs' });
    stillAsking(id, taskId);
    expect(iw.world.store.pushConfigsOf(iw.opOf(id).id)).toHaveLength(MAX_PUSH_CONFIGS_PER_TASK);
  });

  // Plan D102
  it('charges a new round to the caller’s new-call budget: over it, 429 and the round stays', () => {
    const tight: InboundRuntime = {
      ...iw.rt,
      budgets: new PrincipalBudgets({ perMinute: 1, replayPerMinute: 10, readPerMinute: 100 }),
    };
    const id = eta(tight);
    const { taskId } = claimAndAsk(id);
    const over = answer(id, { stop: 'Elm' }, { rt: tight });
    expect(over.status).toBe(429);
    expect(over.headers?.['retry-after']).toBe('60');
    stillAsking(id, taskId);
    iw.world.clock += 60_000;
    const next = answer(id, { stop: 'Elm' }, { rt: tight });
    expect(next.status).toBe(200);
    expect(iw.opOf(id).continuation_generation).toBe(1);
  });

  // Plan D103
  it('refuses an answer whose data holds a __proto__ member, and the round stays', () => {
    const id = eta();
    const { taskId } = claimAndAsk(id);
    const body =
      `{"jsonrpc":"2.0","id":77,"method":"SendMessage","params":{"message":{"messageId":"m4-proto","role":"ROLE_USER",` +
      `"taskId":"${id}","parts":[{"data":{"__proto__":{"stop":"Oak"},"stop":"Elm"}}]}}}`;
    const out = ingressSendMessage(iw.rt, {
      request: { method: 'POST', path: A2A_RPC_PATH, query: '', body, version: '1.0' },
      client_auth: { authorization: `Bearer ${iw.token}` },
    });
    expect(errorOf(out)).toEqual({ code: -32600, reason: 'malformed_body' });
    stillAsking(id, taskId);
  });
});

describe('an answer after the call can no longer run (§7.3, §7.7)', () => {
  /**
   * After an answer to a call that lost its authority: whatever the answer
   * was told, no round runs, and the call reads FAILED with nothing from the
   * agent.
   */
  function neverRuns(id: string): void {
    const next = iw.world.repo.claimDelegationTask(iw.runnerDid, iw.world.clock, 60_000, 'transit');
    const verdict = next === null ? 'nothing to claim' : admitInboundClaimWith(iw.rt, next, iw.runnerDid);
    expect(['nothing to claim', 'refused']).toContain(verdict);
    // A round the claim found ends there, unrun.
    if (next !== null) expect(['failed', 'cancelled']).toContain(iw.world.workflow.store().getById(next.id)?.status);
    expect(iw.opOf(id)).toEqual(
      expect.objectContaining({ state: 'failed', reason_code: 'authority_revoked', result_json: null, input_required_json: null }),
    );
    const status = view(id).status as { state: string; message?: unknown };
    expect(status.state).toBe('TASK_STATE_FAILED');
    expect(status.message).toBeUndefined();
    expect(view(id).artifacts).toBeUndefined();
  }

  // Plan D105: an answer is a read, so it ends a call that lost its authority
  it('an answer that comes after the grant was revoked, with no read between, ends the call and is refused', async () => {
    await save(listing({ discoverability: 'known_only', isDiscoverable: false }), 'private');
    const issued = issueA2AGrant(
      iw.world.store,
      iw.grants,
      { client_id: iw.clientId, service_rkey: 'private', capability: 'eta_query' },
      iw.world.clock,
    );
    if (!issued.ok) throw new Error(issued.reason);
    const id = sentTask(
      iw.call({ skill: 'eta_query@private', params: { route_id: '42' }, grant_id: issued.grant.grantId }, { messageId: 'm4-granted' }),
    ).id as string;
    claimAndAsk(id);
    iw.grants.revoke(issued.grant.grantId, Math.floor(iw.world.clock / 1000));
    // The answer reads the call, so it ends it: the caller hears it is no longer asking, and no round starts.
    expect(errorOf(answer(id, { stop: 'Elm' }))).toEqual({ code: -32004, reason: 'task_not_awaiting_input' });
    expect(iw.opOf(id).continuation_generation).toBe(0);
    neverRuns(id);
  });

  // Plan D105, the race: authority lost after the answer's first check, before its commit
  it('a grant revoked while the answer is on its way in still ends the call in the answer’s own commit', async () => {
    await save(listing({ discoverability: 'known_only', isDiscoverable: false }), 'private');
    const issued = issueA2AGrant(
      iw.world.store,
      iw.grants,
      { client_id: iw.clientId, service_rkey: 'private', capability: 'eta_query' },
      iw.world.clock,
    );
    if (!issued.ok) throw new Error(issued.reason);
    const id = sentTask(
      iw.call({ skill: 'eta_query@private', params: { route_id: '42' }, grant_id: issued.grant.grantId }, { messageId: 'm4-race' }),
    ).id as string;
    claimAndAsk(id);
    // The budget is charged after the first check and before the commit: revoke there.
    const charge = iw.rt.budgets.chargeMiss.bind(iw.rt.budgets);
    const spy = jest.spyOn(iw.rt.budgets, 'chargeMiss').mockImplementation((principal, now) => {
      iw.grants.revoke(issued.grant.grantId, Math.floor(iw.world.clock / 1000));
      return charge(principal, now);
    });
    try {
      expect(errorOf(answer(id, { stop: 'Elm' }))).toEqual({ code: -32004, reason: 'task_not_awaiting_input' });
    } finally {
      spy.mockRestore();
    }
    expect(iw.opOf(id).continuation_generation).toBe(0);
    neverRuns(id);
  });

  // Plan D105 (the listing half)
  it('an answer that comes after the listing was deleted, with no read or sweep between, ends the call and is refused', async () => {
    const id = eta();
    claimAndAsk(id);
    await clearServiceConfigDurable('bus');
    expect(errorOf(answer(id, { stop: 'Elm' }))).toEqual({ code: -32004, reason: 'task_not_awaiting_input' });
    expect(iw.opOf(id).continuation_generation).toBe(0);
    neverRuns(id);
  });

  // Plan D108 (notes M4 step 2: the expiry sweep enforces the 24-hour deadline, so the
  // question stays open past it until the sweep runs; a change to that window shows here)
  it('an answer after the 24-hour deadline, before the expiry sweep runs, is taken and starts the next round', () => {
    const id = eta();
    const { taskId } = claimAndAsk(id);
    iw.world.clock += (INBOUND_INPUT_DEADLINE_SECONDS + 1) * 1000;
    expect(answer(id, { stop: 'Elm' }).status).toBe(200);
    expect(stateOf(id)).toBe('TASK_STATE_WORKING');
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'open', continuation_generation: 1 }));
    expect(iw.world.workflow.store().getById(taskId)?.status).toBe('cancelled');
    // The sweep that comes next finds no question left to end; the new round runs.
    iw.world.workflow.store().expireTasks(Math.floor(iw.world.clock / 1000), iw.world.clock);
    expect(stateOf(id)).toBe('TASK_STATE_WORKING');
    const next = iw.claimChild(id);
    expect(next.verdict).toBe('admitted');
    expect(next.taskId).toBe(inboundExecutionTaskId(id, 1));
  });

  // Plan D107, D121 (an answer after the call ended; the sweep ends an unanswered question)
  it('an answer after the expiry sweep ended an unanswered question is refused, and no round starts', () => {
    const id = eta();
    const { taskId } = claimAndAsk(id);
    iw.world.clock += (INBOUND_INPUT_DEADLINE_SECONDS + 1) * 1000;
    iw.world.workflow.store().expireTasks(Math.floor(iw.world.clock / 1000), iw.world.clock);
    expect(errorOf(answer(id, { stop: 'Elm' }))).toEqual({ code: -32004, reason: 'task_not_awaiting_input' });
    expect(stateOf(id)).toBe('TASK_STATE_FAILED');
    expect(iw.opOf(id)).toEqual(
      expect.objectContaining({ state: 'failed', reason_code: 'input_not_received', continuation_generation: 0, internal_id: taskId }),
    );
    expect(iw.world.workflow.store().getById(inboundExecutionTaskId(id, 1))).toBeNull();
  });

  // Plan D125
  it('a listing deleted while its call asks: the sweep ends the call and retires the waiting round', async () => {
    const id = eta();
    const { taskId } = claimAndAsk(id);
    await clearServiceConfigDurable('bus');
    expect(sweepA2AInbound(iw.rt)).toEqual(expect.objectContaining({ settled: 1 }));
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'authority_revoked' }));
    expect(iw.world.workflow.store().getById(taskId)?.status).toBe('cancelled');
    const status = view(id).status as { state: string; message?: unknown };
    expect([status.state, status.message]).toEqual(['TASK_STATE_FAILED', undefined]);
    expect(errorOf(answer(id, { stop: 'Elm' }))).toEqual({ code: -32004, reason: 'task_not_awaiting_input' });
  });
});

describe('the old round has no authority once the caller answers (§7.3 claim tokens, §7.7 generations)', () => {
  // Plan D120
  it('a stale report from the earlier round lands nowhere; the call finishes on the new round', async () => {
    const id = eta();
    const old = claimAndAsk(id);
    expect(answer(id, { stop: 'Elm' }).status).toBe(200);
    const oldChild = () => iw.world.workflow.store().getById(old.taskId);
    expect(oldChild()?.status).toBe('cancelled');
    // The runner reports on the round it asked from, under that round's claim token.
    expect(await verb(old.taskId, 'complete', iw.runnerDid, { result: '{"eta_minutes":99}', claim_id: old.claimId })).toEqual(
      expect.objectContaining({
        status: 403,
        body: { error: 'access_denied', reason: 'agent may only complete/fail a running delegation task it currently holds' },
      }),
    );
    expect(oldChild()?.status).toBe('cancelled');
    expect(oldChild()?.result).toBeUndefined();
    expect(await verb(old.taskId, 'input-required', iw.runnerDid, { claim_id: old.claimId, ...ASK })).toEqual(
      expect.objectContaining({ status: 409, body: { error: 'operation_settled' } }),
    );
    expect(oldChild()?.status).toBe('cancelled');
    expect(oldChild()?.result).toBeUndefined();
    expect(iw.opOf(id).input_required_json).toBeNull();
    expect(admitInboundClaimWith(iw.rt, { id: old.taskId }, iw.runnerDid)).toBe('refused');
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'open', continuation_generation: 1 }));
    // The new round runs and its result is the call's.
    const next = iw.claimChild(id);
    expect(next.verdict).toBe('admitted');
    expect(next.taskId).not.toBe(old.taskId);
    expect(
      (await verb(next.taskId, 'complete', iw.runnerDid, { result: '{"eta_minutes":4}', claim_id: claimIdOf(next.taskId) })).status,
    ).toBe(200);
    await Promise.resolve();
    expect(stateOf(id)).toBe('TASK_STATE_COMPLETED');
    expect(view(id).artifacts).toEqual([
      { artifactId: 'result', parts: [{ data: { eta_minutes: 4 }, mediaType: 'application/json' }] },
    ]);
  });

  /** A review-gated booking Dina runs herself (Tier 1), approved: its round 0 permit is minted. */
  async function approvedTier1Booking(): Promise<string> {
    await save(
      listing({
        capabilities: {
          appointment_book: { instruction: 'Book the slot.', responsePolicy: 'review', category: 'appointments' },
        },
        capabilitySchemas: bookingListing().capabilitySchemas,
      }),
      'bus',
    );
    const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } }, { messageId: 'm4-book' })).id as string;
    iw.world.workflow.approve(iw.childOf(id).id);
    return id;
  }

  const NODE = 'did:key:z6MkNodeItselfM4';
  type Step = (turn: CapabilityTurn) => Promise<unknown>;
  function runner(steps: Step[]) {
    const queue = [...steps];
    return new LocalDelegationRunner({
      repository: iw.world.repo,
      workflowService: iw.world.workflow,
      agentDID: NODE,
      effectAuthorizingCapabilities: new Set(['appointment_book']),
      nowMsFn: () => iw.world.clock,
      setInterval: () => 0,
      clearInterval: () => undefined,
      runner: async (_cap, _params, _task, turn) => {
        const step = queue.shift();
        if (step === undefined || turn === undefined) throw new Error('no step left, or no turn');
        return step(turn);
      },
    });
  }

  // Plan D112
  it('the round that asked cannot authorize an effect or be claimed after the answer; its permit stays void', async () => {
    const id = await approvedTier1Booking();
    const r = runner([
      async () => new CapabilityInputRequired('Which name is the booking under?', { type: 'object', properties: { name: { type: 'string' } } }),
      async (turn) => (turn.authorizeEffect() ? { booked: true } : { booked: false }),
    ]);
    await r.runTick();
    const old = iw.childOf(id).id;
    expect(answer(id, { name: 'Ada' }).status).toBe(200);
    const permits = () => iw.world.store.permitsOf(iw.opOf(id).id).map((p) => [p.execution_child_id === old ? 'old' : 'new', p.state]);
    expect(permits()).toEqual([
      ['old', 'void'],
      ['new', 'minted'],
    ]);
    expect(authorizeInboundEffectWith(iw.rt, { id: old }, NODE)).toBe('refused');
    expect(admitInboundClaimWith(iw.rt, { id: old }, NODE, 'deferred')).toBe('refused');
    expect(permits()).toEqual([
      ['old', 'void'],
      ['new', 'minted'],
    ]);
    // The new round crosses its own boundary, once.
    await r.runTick();
    expect(stateOf(id)).toBe('TASK_STATE_COMPLETED');
    expect(permits()).toEqual([
      ['old', 'void'],
      ['new', 'consumed'],
    ]);
  });

  // Plan D113
  it.each([
    ['minted', false],
    ['consumed', true],
  ] as const)('minting a later round refuses, and rolls back, while an earlier round’s permit is %s', async (_state, claimFirst) => {
    await save(bookingListing(), 'bus');
    const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } }, { messageId: 'm4-mint' })).id as string;
    iw.world.workflow.approve(iw.childOf(id).id);
    if (claimFirst) expect(iw.claimChild(id).verdict).toBe('admitted');
    const op = iw.opOf(id);
    const snapshot = readInboundSnapshot(op);
    if (snapshot === null) throw new Error('snapshot');
    const before = iw.world.store.permitsOf(op.id).map((p) => [p.permit_id, p.state]);
    expect(() =>
      iw.world.store.transaction(() =>
        mintExecutionChild(iw.rt, iw.opOf(id), snapshot, 1, {
          turns: [{ prompt: 'Name?', input_schema: { type: 'object' }, input: { name: 'Ada' } }],
        }),
      ),
    ).toThrow(/still live/);
    expect(iw.world.store.permitsOf(op.id).map((p) => [p.permit_id, p.state])).toEqual(before);
    expect(iw.opOf(id).internal_id).toBe(op.internal_id);
    // No second round exists, on either side.
    const next = inboundExecutionTaskId(id, 1);
    expect(iw.world.store.getChild(next)).toBeNull();
    expect(iw.world.workflow.store().getById(next)).toBeNull();
  });
});
