/**
 * Inbound multi-turn (design §7.7, M4): a runner asks the caller for more
 * input, only before any effect; the caller's answer runs as the next
 * round with a fresh permit. Asking and every refusal; the caller's view
 * and events; answering and every refusal; several rounds; an unanswered
 * question; a cancel while asking; the deferred effect boundary of an
 * in-process round under review (the pre-effect interruption, one fresh
 * permit per round under the same approval, the voided permit never
 * consumed); and the executor route.
 */

import { LOCAL_RUNNER_NAME } from '@dina/protocol';

import {
  INBOUND_INPUT_DEADLINE_SECONDS,
  MAX_INBOUND_ROUNDS,
  admitInboundClaimWith,
  authorizeInboundEffectWith,
  createA2AClient,
  ingressCancelTask,
  ingressGetTask,
  ingressSendMessage,
  inboundRoundHash,
  issueA2AGrant,
  parseInputRequest,
  projectInboundTask,
  readInboundSnapshot,
  requestInboundInputWith,
  revokeA2AClient,
  settleInbound,
  sweepA2AInbound,
  type InputRequest,
} from '../../src/a2a';
import { CoreRouter } from '../../src/server/router';
import { registerWorkflowRoutes } from '../../src/server/routes/workflow';
import { CapabilityInputRequired, LocalDelegationRunner } from '../../src/workflow/local_delegation_runner';

import { InboundWorld, bookingListing, errorOf, listing, resultOf, save, sentTask } from './inbound_fixture';

import type { CoreRequest, CoreResponse } from '../../src/server/router';
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

const eta = () => sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
const view = (id: string) => resultOf(ingressGetTask(iw.rt, iw.request('GetTask', { id }), id));
const stateOf = (id: string) => (view(id).status as { state: string }).state;
/** What each stream event says: a status state, or `artifact`. */
const story = (id: string) =>
  iw.world.store
    .outboxOf(iw.opOf(id).id)
    .filter((r) => r.target_kind === 'sse')
    .map((r) => JSON.parse(r.event_json) as { statusUpdate?: { status: { state: string } } })
    .map((e) => (e.statusUpdate === undefined ? 'artifact' : e.statusUpdate.status.state));

/** Claim the current round as its pinned runner would, and ask. */
function claimAndAsk(id: string, ask: unknown = ASK) {
  const { verdict, taskId } = iw.claimChild(id);
  if (verdict !== 'admitted') throw new Error(`claim ${verdict}`);
  const claimId = iw.world.workflow.store().getById(taskId)?.claim_id;
  return { taskId, claimId, out: requestInboundInputWith(iw.rt, { taskId, claimantDid: iw.runnerDid, claimId, request: ask }) };
}

let msg = 0;
/** The caller's answer: a SendMessage naming the task, one data part. */
function answer(id: string, data: unknown, over: Record<string, unknown> = {}) {
  msg += 1;
  return ingressSendMessage(
    iw.rt,
    iw.request('SendMessage', { message: { messageId: `ans-${msg}`, role: 'ROLE_USER', taskId: id, parts: [{ data }], ...over } }),
  );
}

describe('asking (§7.7): only the round holding the claim, only before any effect', () => {
  it('parks the round, shows INPUT_REQUIRED with the question, and records it as an event', () => {
    const id = eta();
    const { taskId, out } = claimAndAsk(id);
    expect(out).toEqual(expect.objectContaining({ kind: 'parked' }));
    const child = iw.world.workflow.store().getById(taskId);
    expect(child).toEqual(expect.objectContaining({ status: 'awaiting' }));
    expect(child?.lease_expires_at).toBeUndefined();
    expect(child?.expires_at).toBe(Math.floor(iw.world.clock / 1000) + INBOUND_INPUT_DEADLINE_SECONDS);
    const status = view(id).status as Record<string, unknown>;
    expect(status).toEqual(
      expect.objectContaining({
        state: 'TASK_STATE_INPUT_REQUIRED',
        message: {
          messageId: `${id}-input-0`,
          contextId: view(id).contextId,
          taskId: id,
          role: 'ROLE_AGENT',
          parts: [{ text: ASK.prompt }, { data: STOP_SCHEMA, mediaType: 'application/schema+json' }],
        },
      }),
    );
    expect(story(id)).toEqual(['TASK_STATE_WORKING', 'TASK_STATE_INPUT_REQUIRED']);
  });

  it.each([
    ['no prompt', { input_schema: STOP_SCHEMA }],
    ['an extra member', { ...ASK, deadline: 5 }],
    ['an empty prompt', { ...ASK, prompt: '  ' }],
    ['a prompt too long', { ...ASK, prompt: 'x'.repeat(2_001) }],
    ['a control character in the prompt', { ...ASK, prompt: 'stop\u0007' }],
    ['a schema that is not for an object', { ...ASK, input_schema: { type: 'string' } }],
    ['a schema keyword Core cannot enforce', { ...ASK, input_schema: { type: 'object', patternProperties: { '^x': {} } } }],
    [
      'a schema too large',
      { ...ASK, input_schema: { type: 'object', description: 'd'.repeat(17_000) } },
    ],
  ])('refuses a question with %s, leaving the round running', (_name, ask) => {
    const id = eta();
    const { taskId, out } = claimAndAsk(id, ask);
    expect(out).toEqual({ kind: 'refused', reason: 'request_malformed' });
    expect(iw.world.workflow.store().getById(taskId)?.status).toBe('running');
    expect(stateOf(id)).toBe('TASK_STATE_WORKING');
  });

  it('refuses a stale claim token and another runner', () => {
    const id = eta();
    const { taskId } = iw.claimChild(id);
    const ask = (claimantDid: string, claimId: string | undefined) =>
      requestInboundInputWith(iw.rt, { taskId, claimantDid, claimId, request: ASK });
    expect(ask(iw.runnerDid, 'stale-claim')).toEqual({ kind: 'refused', reason: 'claim_lost' });
    expect(ask('did:key:z6MkSomeoneElse', iw.world.workflow.store().getById(taskId)?.claim_id)).toEqual({
      kind: 'refused',
      reason: 'not_the_pinned_runner',
    });
  });

  it('refuses a task that is not an inbound A2A round', () => {
    expect(
      requestInboundInputWith(iw.rt, { taskId: 'no-such-task', claimantDid: iw.runnerDid, claimId: 'c', request: ASK }),
    ).toEqual({ kind: 'not_inbound' });
  });

  it('refuses a round already settled', () => {
    const id = eta();
    const { taskId } = iw.claimChild(id);
    iw.world.workflow.complete(taskId, JSON.stringify({ eta_minutes: 3 }), 'done', iw.runnerDid);
    const claimId = iw.world.workflow.store().getById(taskId)?.claim_id;
    expect(requestInboundInputWith(iw.rt, { taskId, claimantDid: iw.runnerDid, claimId, request: ASK })).toEqual({
      kind: 'refused',
      reason: 'operation_settled',
    });
  });

  it('refuses an external runner of an effectful call: its claim consumed the permit', async () => {
    await save(bookingListing(), 'bus');
    const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    iw.world.workflow.approve(iw.childOf(id).id);
    const { taskId, out } = claimAndAsk(id);
    expect(out).toEqual({ kind: 'refused', reason: 'effect_started' });
    expect(iw.world.workflow.store().getById(taskId)?.status).toBe('running');
    expect(iw.world.store.permitsOf(iw.opOf(id).id)[0]?.state).toBe('consumed');
  });

  it('refuses a round past the last one a call may run', () => {
    const id = eta();
    for (let round = 0; round < MAX_INBOUND_ROUNDS - 1; round++) {
      expect(claimAndAsk(id).out.kind).toBe('parked');
      expect(answer(id, { stop: `s${round}` }).status).toBe(200);
    }
    expect(claimAndAsk(id).out).toEqual({ kind: 'refused', reason: 'too_many_rounds' });
  });

  it('refuses a round run by a plugin: its runner has no way to ask', () => {
    const id = eta();
    const { taskId } = iw.claimChild(id);
    // A plugin round, as the snapshot would pin it (no plugin install is
    // needed to see the refusal: it comes before anything is parked).
    const op = iw.opOf(id);
    const snapshot = readInboundSnapshot(op);
    if (snapshot === null) throw new Error('snapshot');
    const plugin = { kind: 'plugin', installId: 'i', manifestCid: 'c', capabilityId: 'k' };
    iw.world.store.updateTask(op.id, ['open'], { snapshot_json: JSON.stringify({ ...snapshot, executor: plugin }) }, iw.world.clock);
    const claimId = iw.world.workflow.store().getById(taskId)?.claim_id;
    expect(requestInboundInputWith(iw.rt, { taskId, claimantDid: iw.runnerDid, claimId, request: ASK })).toEqual({
      kind: 'refused',
      reason: 'executor_cannot_ask',
    });
    expect(iw.world.workflow.store().getById(taskId)?.status).toBe('running');
  });
});

describe('answering (§7.7): the caller continues its own task', () => {
  it('runs the next round with every answer so far, the original params unchanged', () => {
    const id = eta();
    const first = claimAndAsk(id);
    const answered = answer(id, { stop: 'Elm' });
    expect(answered.status).toBe(200);
    expect((resultOf(answered).task as { status: { state: string } }).status.state).toBe('TASK_STATE_WORKING');
    expect(iw.world.workflow.store().getById(first.taskId)?.status).toBe('cancelled');
    const next = iw.childOf(id);
    expect(next.id).not.toBe(first.taskId);
    expect(iw.world.store.getChild(next.id)?.generation).toBe(1);
    const payload = JSON.parse(next.payload) as Record<string, unknown>;
    expect(payload.params).toEqual({ route_id: '42' });
    expect(payload.continuation).toEqual({ turns: [{ prompt: ASK.prompt, input_schema: STOP_SCHEMA, input: { stop: 'Elm' } }] });
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ continuation_generation: 1, input_required_json: null }));
    // The call goes on to finish on the next round.
    iw.runChild(id, { eta_minutes: 4 });
    expect(stateOf(id)).toBe('TASK_STATE_COMPLETED');
    expect(story(id)).toEqual([
      'TASK_STATE_WORKING',
      'TASK_STATE_INPUT_REQUIRED',
      'TASK_STATE_WORKING',
      'artifact',
      'TASK_STATE_COMPLETED',
    ]);
  });

  it('carries every earlier answer into a later round, and each question is its own event', () => {
    const id = eta();
    claimAndAsk(id);
    answer(id, { stop: 'Elm' });
    expect(claimAndAsk(id, { ...ASK, prompt: 'Which platform?' }).out.kind).toBe('parked');
    expect((view(id).status as { message: { messageId: string } }).message.messageId).toBe(`${id}-input-1`);
    answer(id, { stop: 'Platform 2' });
    const turns = (JSON.parse(iw.childOf(id).payload) as { continuation: { turns: { input: unknown }[] } }).continuation.turns;
    expect(turns.map((t) => t.input)).toEqual([{ stop: 'Elm' }, { stop: 'Platform 2' }]);
    expect(story(id).filter((s) => s === 'TASK_STATE_INPUT_REQUIRED')).toHaveLength(2);
  });

  it('answers the same message again with the same task; one answer moves one round', () => {
    const id = eta();
    claimAndAsk(id);
    const message = { messageId: 'ans-same', role: 'ROLE_USER', taskId: id, parts: [{ data: { stop: 'Elm' } }] };
    const send = () => ingressSendMessage(iw.rt, iw.request('SendMessage', { message }));
    expect(send().status).toBe(200);
    const after = iw.childOf(id).id;
    expect((resultOf(send()).task as { id: string }).id).toBe(id);
    expect(iw.childOf(id).id).toBe(after);
    // The same message id with another answer is a conflict.
    expect(
      errorOf(
        ingressSendMessage(
          iw.rt,
          iw.request('SendMessage', { message: { ...message, parts: [{ data: { stop: 'Oak' } }] } }),
        ),
      ),
    ).toEqual({ code: -32602, reason: 'message_id_reused' });
    // A second answer to the same question finds the task no longer asking.
    expect(errorOf(answer(id, { stop: 'Oak' }))).toEqual({ code: -32004, reason: 'task_not_awaiting_input' });
  });

  it('refuses an answer to a task that is not asking', () => {
    expect(errorOf(answer(eta(), { stop: 'Elm' }))).toEqual({ code: -32004, reason: 'task_not_awaiting_input' });
  });

  it('refuses an answer in another context, and keeps asking', () => {
    const id = eta();
    claimAndAsk(id);
    expect(errorOf(answer(id, { stop: 'Elm' }, { contextId: 'ctx-other' }))).toEqual({
      code: -32602,
      reason: 'context_mismatch',
    });
    expect(stateOf(id)).toBe('TASK_STATE_INPUT_REQUIRED');
    // The task's own context is fine.
    expect(answer(id, { stop: 'Elm' }, { contextId: view(id).contextId }).status).toBe(200);
  });

  it.each([
    ['two parts', { parts: [{ data: { stop: 'a' } }, { data: { stop: 'b' } }] }, 'input_not_one_data_part'],
    ['a text part', { parts: [{ text: 'Elm' }] }, 'input_not_one_data_part'],
    ['data that is not an object', { parts: [{ data: ['Elm'] }] }, 'input_not_one_data_part'],
    ['an answer the schema refuses', { parts: [{ data: { stop: '' } }] }, 'input_invalid'],
  ])('refuses %s, and the task keeps asking', (_name, over, reason) => {
    const id = eta();
    claimAndAsk(id);
    expect(errorOf(answer(id, null, over))).toEqual({ code: -32602, reason });
    expect(stateOf(id)).toBe('TASK_STATE_INPUT_REQUIRED');
  });

  it('refuses an answer to a task another client owns: not found, never revealed', () => {
    const id = eta();
    claimAndAsk(id);
    const other = createA2AClient(iw.world.store, { display_name: 'Other' }, iw.world.clock);
    if (!other.ok) throw new Error(other.reason);
    const foreign = ingressSendMessage(
      iw.rt,
      iw.request(
        'SendMessage',
        { message: { messageId: 'x-1', role: 'ROLE_USER', taskId: id, parts: [{ data: { stop: 'Elm' } }] } },
        {},
        `Bearer ${other.token}`,
      ),
    );
    expect(errorOf(foreign)).toEqual({ code: -32001 });
    expect(stateOf(id)).toBe('TASK_STATE_INPUT_REQUIRED');
  });

  it('adds a webhook set inline with the answer', () => {
    const id = eta();
    claimAndAsk(id);
    const sent = ingressSendMessage(
      iw.rt,
      iw.request('SendMessage', {
        message: { messageId: 'ans-hook', role: 'ROLE_USER', taskId: id, parts: [{ data: { stop: 'Elm' } }] },
        configuration: { taskPushNotificationConfig: { url: 'https://hooks.example/a2a' } },
      }),
    );
    expect(sent.status).toBe(200);
    expect(iw.world.store.pushConfigsOf(iw.opOf(id).id)).toHaveLength(1);
  });
});

describe('the end of a question', () => {
  it('an unanswered question ends the call when its deadline passes', () => {
    const id = eta();
    const { taskId } = claimAndAsk(id);
    iw.world.clock += (INBOUND_INPUT_DEADLINE_SECONDS + 1) * 1000;
    iw.world.workflow.store().expireTasks(Math.floor(iw.world.clock / 1000), iw.world.clock);
    expect(iw.world.workflow.store().getById(taskId)?.status).toBe('failed');
    expect(stateOf(id)).toBe('TASK_STATE_FAILED');
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'input_not_received' }));
  });

  it('the caller may cancel while asked', () => {
    const id = eta();
    const { taskId } = claimAndAsk(id);
    const out = ingressCancelTask(iw.rt, iw.request('CancelTask', { id }), id);
    expect((resultOf(out).status as { state: string }).state).toBe('TASK_STATE_CANCELED');
    expect(iw.world.workflow.store().getById(taskId)?.status).toBe('cancelled');
  });

  it('an answer after the call ended is refused', () => {
    const id = eta();
    claimAndAsk(id);
    ingressCancelTask(iw.rt, iw.request('CancelTask', { id }), id);
    expect(errorOf(answer(id, { stop: 'Elm' }))).toEqual({ code: -32004, reason: 'task_not_awaiting_input' });
  });
});

describe('a question is egress (§7.3): shown only while the call’s authority holds', () => {
  it('a read after the client is revoked ends the call and shows no question', () => {
    const id = eta();
    const { taskId } = claimAndAsk(id);
    revokeA2AClient(iw.world.store, iw.grants, iw.clientId, iw.world.clock);
    // A revoked client cannot read; the owner's console and the sweep can.
    expect(projectInboundTask(iw.rt, iw.opOf(id)).status).toEqual({
      state: 'TASK_STATE_FAILED',
      timestamp: expect.any(String),
    });
    expect(sweepA2AInbound(iw.rt)).toEqual(expect.objectContaining({ settled: 1 }));
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'authority_revoked' }));
    expect(iw.world.workflow.store().getById(taskId)?.status).toBe('cancelled');
  });

  it('a read after the grant is revoked ends the call: FAILED, no question', async () => {
    await save(listing({ discoverability: 'known_only', isDiscoverable: false }), 'private');
    const issued = issueA2AGrant(
      iw.world.store,
      iw.grants,
      { client_id: iw.clientId, service_rkey: 'private', capability: 'eta_query' },
      iw.world.clock,
    );
    if (!issued.ok) throw new Error(issued.reason);
    const id = sentTask(
      iw.call({ skill: 'eta_query@private', params: { route_id: '42' }, grant_id: issued.grant.grantId }),
    ).id as string;
    claimAndAsk(id);
    expect(stateOf(id)).toBe('TASK_STATE_INPUT_REQUIRED');
    iw.grants.revoke(issued.grant.grantId, Math.floor(iw.world.clock / 1000));
    const status = view(id).status as Record<string, unknown>;
    expect(status.state).toBe('TASK_STATE_FAILED');
    expect(status.message).toBeUndefined();
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'authority_revoked' }));
    expect(errorOf(answer(id, { stop: 'Elm' }))).toEqual({ code: -32004, reason: 'task_not_awaiting_input' });
  });
});

describe('which rounds may ask (may_ask on the payload)', () => {
  it('a read round may; an effectful one, whose claim starts its effect, may not', async () => {
    const read = eta();
    expect((JSON.parse(iw.childOf(read).payload) as { may_ask?: boolean }).may_ask).toBe(true);
    await save(bookingListing(), 'bus');
    const booking = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    iw.world.workflow.approve(iw.childOf(booking).id);
    expect('may_ask' in (JSON.parse(iw.childOf(booking).payload) as object)).toBe(false);
  });
});

describe('an in-process round under review, its effect boundary deferred (§7.3, §7.7)', () => {
  /** A review-gated booking run by Dina itself (a Tier 1 instruction, no runner). */
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
    const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    iw.world.workflow.approve(iw.childOf(id).id);
    return id;
  }

  type Step = (turn: CapabilityTurn) => Promise<unknown>;
  /** The in-process runner, `appointment_book` declared as authorizing its own effects unless told otherwise. */
  function runner(steps: Step[], authorizing: ReadonlySet<string> = new Set(['appointment_book'])) {
    const queue = [...steps];
    return new LocalDelegationRunner({
      repository: iw.world.repo,
      workflowService: iw.world.workflow,
      agentDID: NODE,
      effectAuthorizingCapabilities: authorizing,
      nowMsFn: () => iw.world.clock,
      setInterval: () => 0,
      clearInterval: () => undefined,
      runner: async (_cap, _params, _task, turn) => {
        const step = queue.shift();
        // The runner always hands its capability a turn.
        if (step === undefined || turn === undefined) throw new Error('no step left, or no turn');
        return step(turn);
      },
    });
  }
  const permits = (id: string) => iw.world.store.permitsOf(iw.opOf(id).id);
  const NODE = 'did:key:z6MkNodeItself';

  it('asks before its effect, then the next round gets one fresh permit under the same approval', async () => {
    const id = await approvedTier1Booking();
    const r = runner([
      async () => new CapabilityInputRequired('Which name is the booking under?', { type: 'object', required: ['name'], properties: { name: { type: 'string' } } }),
      async (turn) => (turn.authorizeEffect() ? { booked: true } : { booked: false }),
    ]);
    await r.runTick();
    expect(stateOf(id)).toBe('TASK_STATE_INPUT_REQUIRED');
    const [voided] = permits(id);
    expect(voided).toEqual(expect.objectContaining({ state: 'void', void_reason: 'input_required' }));
    expect(iw.opOf(id).effect_phase).toBe('pre_effect');

    expect(answer(id, { name: 'Ada' }).status).toBe(200);
    // A duplicate continuation is refused.
    expect(errorOf(answer(id, { name: 'Ada' }))).toEqual({ code: -32004, reason: 'task_not_awaiting_input' });
    const fresh = permits(id).filter((p) => p.state === 'minted');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toEqual(
      expect.objectContaining({ approval_task_id: voided?.approval_task_id, execution_child_id: iw.childOf(id).id }),
    );
    const snapshot = readInboundSnapshot(iw.opOf(id));
    if (snapshot === null) throw new Error('snapshot');
    expect(fresh[0]?.payload_hash).not.toBe(snapshot.post_hash);

    await r.runTick();
    expect(stateOf(id)).toBe('TASK_STATE_COMPLETED');
    expect(permits(id).map((p) => p.state)).toEqual(['void', 'consumed']);
    // The voided permit was never consumed, and its round cannot cross the boundary now.
    expect(permits(id)[0]?.consumed_at).toBeNull();
  });

  it('a round whose capability never authorizes is authorized before its result goes out', async () => {
    const id = await approvedTier1Booking();
    await runner([async () => ({ booked: true })]).runTick();
    expect(stateOf(id)).toBe('TASK_STATE_COMPLETED');
    expect(permits(id).map((p) => p.state)).toEqual(['consumed']);
  });

  it('a round whose authority is gone is stopped at its boundary, and its result never goes out', async () => {
    const id = await approvedTier1Booking();
    let acted = false;
    await runner([
      async (turn) => {
        revokeA2AClient(iw.world.store, iw.grants, iw.clientId, iw.world.clock);
        if (!turn.authorizeEffect()) return { booked: false };
        acted = true;
        return { booked: true };
      },
    ]).runTick();
    expect(acted).toBe(false);
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'authority_revoked' }));
    expect(permits(id).map((p) => p.state)).toEqual(['void']);
  });

  // Cold audit C4-4: after the effect began, nothing reads it as not having happened
  describe('an authority change after the capability crossed its boundary never reads FAILED', () => {
    it('the boundary authorizes the round again, unjudged, once its permit is consumed', async () => {
      const id = await approvedTier1Booking();
      const child = iw.childOf(id).id;
      iw.world.repo.claimDelegationTask(NODE, iw.world.clock, 30_000, LOCAL_RUNNER_NAME);
      expect(admitInboundClaimWith(iw.rt, { id: child }, NODE, 'deferred')).toBe('admitted');
      expect(authorizeInboundEffectWith(iw.rt, { id: child }, NODE)).toBe('authorized');
      revokeA2AClient(iw.world.store, iw.grants, iw.clientId, iw.world.clock);
      expect(authorizeInboundEffectWith(iw.rt, { id: child }, NODE)).toBe('authorized');
      expect(iw.opOf(id).state).toBe('open');
    });

    it('the client revoked while the booking ran: OUTCOME_UNKNOWN, and the result is kept for the owner', async () => {
      const id = await approvedTier1Booking();
      await runner([
        async (turn) => {
          if (!turn.authorizeEffect()) return { booked: false };
          revokeA2AClient(iw.world.store, iw.grants, iw.clientId, iw.world.clock);
          return { booked: true };
        },
      ]).runTick();
      settleInbound(iw.rt, iw.opOf(id));
      const op = iw.opOf(id);
      expect([op.state, op.effect_phase]).toEqual(['outcome_unknown', 'effect_started']);
      expect(JSON.parse(op.result_json ?? 'null')).toEqual({ booked: true });
    });

    it('the listing edited while the booking ran: the call completes, as the claim judged it', async () => {
      const id = await approvedTier1Booking();
      await runner([
        async (turn) => {
          if (!turn.authorizeEffect()) return { booked: false };
          await save(
            listing({
              name: 'Bus 42, renamed',
              capabilities: { appointment_book: { instruction: 'Book the slot.', responsePolicy: 'review', category: 'appointments' } },
              capabilitySchemas: bookingListing().capabilitySchemas,
            }),
            'bus',
          );
          return { booked: true };
        },
      ]).runTick();
      settleInbound(iw.rt, iw.opOf(id));
      expect(stateOf(id)).toBe('TASK_STATE_COMPLETED');
    });

    it('a refusal after the effect began is OUTCOME_UNKNOWN, whatever refused it', async () => {
      const id = await approvedTier1Booking();
      const child = iw.childOf(id).id;
      iw.world.repo.claimDelegationTask(NODE, iw.world.clock, 30_000, LOCAL_RUNNER_NAME);
      expect(admitInboundClaimWith(iw.rt, { id: child }, NODE, 'deferred')).toBe('admitted');
      expect(authorizeInboundEffectWith(iw.rt, { id: child }, NODE)).toBe('authorized');
      // The round's permit gone by other means, after its effect began: no shortcut applies.
      iw.world.store.db.run(`UPDATE a2a_permits SET state = 'void' WHERE execution_child_id = ?`, [child]);
      iw.world.store.db.run(`UPDATE a2a_tasks SET snapshot_json = '{' WHERE id = ?`, [iw.opOf(id).id]);
      expect(authorizeInboundEffectWith(iw.rt, { id: child }, NODE)).toBe('refused');
      expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'outcome_unknown', reason_code: 'snapshot_unreadable' }));
    });
  });

  it('a round past its boundary can no longer ask: the call ends unknown', async () => {
    const id = await approvedTier1Booking();
    await runner([
      async (turn) => {
        turn.authorizeEffect();
        return new CapabilityInputRequired('One more thing?', STOP_SCHEMA);
      },
    ]).runTick();
    settleInbound(iw.rt, iw.opOf(id));
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'outcome_unknown' }));
  });

  it('a lease lost before the boundary requeues the round', async () => {
    const id = await approvedTier1Booking();
    const child = iw.childOf(id).id;
    const claimed = iw.world.repo.claimDelegationTask(NODE, iw.world.clock, 30_000, LOCAL_RUNNER_NAME);
    expect(claimed?.id).toBe(child);
    expect(admitInboundClaimWith(iw.rt, { id: child }, NODE, 'deferred')).toBe('admitted');
    iw.world.clock += 31_000;
    iw.world.repo.expireLeasedTasks(iw.world.clock);
    expect(iw.world.workflow.store().getById(child)?.status).toBe('queued');
    expect(permits(id)[0]?.state).toBe('minted');
  });

  it('a lease lost after the boundary is outcome_unknown, never a second run', async () => {
    const id = await approvedTier1Booking();
    const child = iw.childOf(id).id;
    iw.world.repo.claimDelegationTask(NODE, iw.world.clock, 30_000, LOCAL_RUNNER_NAME);
    expect(admitInboundClaimWith(iw.rt, { id: child }, NODE, 'deferred')).toBe('admitted');
    expect(authorizeInboundEffectWith(iw.rt, { id: child }, NODE)).toBe('authorized');
    // Idempotent: the same round authorized again consumes nothing more.
    expect(authorizeInboundEffectWith(iw.rt, { id: child }, NODE)).toBe('authorized');
    expect(permits(id).map((p) => p.state)).toEqual(['consumed']);
    iw.world.clock += 31_000;
    iw.world.repo.expireLeasedTasks(iw.world.clock);
    expect(iw.world.workflow.store().getById(child)?.status).toBe('outcome_unknown');
    settleInbound(iw.rt, iw.opOf(id));
    expect(iw.opOf(id).state).toBe('outcome_unknown');
  });

  it('a capability not declared as authorizing its effects stays at its claim on the same runner', async () => {
    const id = await approvedTier1Booking();
    // The runner defers only some other capability; this one's claim starts its effect.
    await runner([async () => new CapabilityInputRequired('Name?', STOP_SCHEMA)], new Set(['other_capability'])).runTick();
    expect(permits(id).map((p) => p.state)).toEqual(['consumed']);
    settleInbound(iw.rt, iw.opOf(id));
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'outcome_unknown' }));
  });

  it('refuses a payload changed after its permit was minted', async () => {
    const id = await approvedTier1Booking();
    const r = runner([
      async () => new CapabilityInputRequired('Name?', { type: 'object', properties: { name: { type: 'string' } } }),
      async () => ({ booked: true }),
    ]);
    await r.runTick();
    answer(id, { name: 'Ada' });
    const next = iw.childOf(id);
    const payload = JSON.parse(next.payload) as { continuation: { turns: { input: unknown }[] } };
    payload.continuation.turns[0] = { ...payload.continuation.turns[0], input: { name: 'Mallory' } } as never;
    iw.world.store.db.run('UPDATE workflow_tasks SET payload = ? WHERE id = ?', [JSON.stringify(payload), next.id]);
    await r.runTick();
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'permit_mismatch' }));
  });

  // Cold audit C5-10: round 0 too, claimed as the runner claims it, so the permit check is what decides
  describe('binds round 0’s permit to its own payload', () => {
    /** Round 0, approved and claimed by the in-process runner, its claim token in hand. */
    async function claimedRound0() {
      const id = await approvedTier1Booking();
      const child = iw.childOf(id).id;
      const claimed = iw.world.repo.claimDelegationTask(NODE, iw.world.clock, 30_000, LOCAL_RUNNER_NAME);
      expect(claimed?.id).toBe(child);
      const task = { id: child, claim_id: claimed?.claim_id ?? null };
      expect(admitInboundClaimWith(iw.rt, task, NODE, 'deferred')).toBe('admitted');
      const [permit] = permits(id);
      if (permit === undefined) throw new Error('no permit');
      return { id, task, permit };
    }

    it('a permit naming another payload is refused: the call fails permit_mismatch, the permit unspent', async () => {
      const { id, task, permit } = await claimedRound0();
      iw.world.store.db.run('UPDATE a2a_permits SET payload_hash = ? WHERE permit_id = ?', ['0'.repeat(64), permit.permit_id]);
      expect(authorizeInboundEffectWith(iw.rt, task, NODE)).toBe('refused');
      expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'permit_mismatch', effect_phase: 'pre_effect' }));
      expect(permits(id).map((p) => p.state)).not.toContain('consumed');
    });

    it('control: the permit as minted is authorized and consumed, once', async () => {
      const { id, task, permit } = await claimedRound0();
      const snapshot = readInboundSnapshot(iw.opOf(id));
      if (snapshot === null) throw new Error('snapshot');
      expect(permit.payload_hash).toBe(inboundRoundHash(snapshot, undefined));
      expect(authorizeInboundEffectWith(iw.rt, task, NODE)).toBe('authorized');
      expect(permits(id).map((p) => p.state)).toEqual(['consumed']);
      expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'open', effect_phase: 'effect_started' }));
    });
  });
});

describe('the executor route', () => {
  const router = new CoreRouter();
  registerWorkflowRoutes(router);
  const post = (id: string, did: string, body: Record<string, unknown>): Promise<CoreResponse> =>
    router.handle({
      method: 'POST',
      path: `/v1/workflow/tasks/${id}/input-required`,
      query: {},
      headers: { 'x-did': did },
      body,
      rawBody: new Uint8Array(),
      params: { id },
      trustedInProcess: true,
      callerType: 'agent',
      callerDID: did,
    } as CoreRequest);

  it('parks a round for its pinned runner holding the claim token', async () => {
    const id = eta();
    const { taskId } = iw.claimChild(id);
    const claimId = iw.world.workflow.store().getById(taskId)?.claim_id ?? '';
    const out = await post(taskId, iw.runnerDid, { claim_id: claimId, ...ASK });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ status: 'awaiting_input', task_id: taskId, expires_at: expect.any(Number) });
    expect(stateOf(id)).toBe('TASK_STATE_INPUT_REQUIRED');
  });

  it.each([
    ['no claim token', (_c: string) => ({ ...ASK }), 'runner', 400],
    ['another runner', (c: string) => ({ claim_id: c, ...ASK }), 'other', 403],
    ['a malformed question', (c: string) => ({ claim_id: c, prompt: 'x' }), 'runner', 400],
    ['a stale claim token', (_c: string) => ({ claim_id: 'stale', ...ASK }), 'runner', 409],
  ])('refuses %s', async (_name, body, who, status) => {
    const id = eta();
    const { taskId } = iw.claimChild(id);
    const claimId = iw.world.workflow.store().getById(taskId)?.claim_id ?? '';
    const did = who === 'runner' ? iw.runnerDid : 'did:key:z6MkOther';
    expect((await post(taskId, did, body(claimId))).status).toBe(status);
    expect(stateOf(id)).toBe('TASK_STATE_WORKING');
  });

  it('refuses a task that is not an A2A round', async () => {
    iw.world.repo.create({
      id: 'plain',
      kind: 'delegation',
      status: 'running',
      priority: 'normal',
      description: 'plain',
      payload: '{}',
      result_summary: '',
      policy: '{}',
      agent_did: iw.runnerDid,
      created_at: iw.world.clock,
      updated_at: iw.world.clock,
    });
    const out = await post('plain', iw.runnerDid, { claim_id: 'c', ...ASK });
    expect(out).toEqual(expect.objectContaining({ status: 409, body: expect.objectContaining({ error: 'not_an_a2a_call' }) }));
  });
});

describe('the question parser', () => {
  it('keeps the schema in canonical form', () => {
    expect(parseInputRequest({ prompt: 'p', input_schema: { required: ['a'], type: 'object' } })).toEqual({
      prompt: 'p',
      input_schema: { required: ['a'], type: 'object' },
    });
  });
});
