/**
 * The streaming doors (A2A §3.1.2, §3.1.6; design §7.5): Core answers the
 * Task a stream opens with, and the last event that Task already reflects,
 * so the gateway sends only what follows.
 */

import { A2A_CREDENTIAL_GEN_HEADER, A2A_EVENT_SEQ_HEADER, A2A_STREAM_CLIENT_HEADER } from '@dina/a2a';

import {
  ingressSendMessage,
  ingressSubscribeToTask,
  createA2AClient,
  streamClientKeyOf,
} from '../../src/a2a';

import { InboundWorld, errorOf, resultOf, sentTask } from './inbound_fixture';

let iw: InboundWorld;
beforeEach(async () => {
  iw = await InboundWorld.create();
});
afterEach(() => iw.close());

const streamCall = (data: Record<string, unknown>, messageId?: string) =>
  ingressSendMessage(
    iw.rt,
    iw.request(
      'SendStreamingMessage',
      iw.message(data, messageId === undefined ? {} : { messageId }),
    ),
    'SendStreamingMessage',
  );
const subscribe = (id: string, auth?: string) =>
  ingressSubscribeToTask(iw.rt, iw.request('SubscribeToTask', { id }, {}, auth), id);

describe('SendStreamingMessage', () => {
  it('answers the Task the stream opens with, the event cursor it reflects, and the client and credential generation of the call', () => {
    const answer = streamCall({ skill: 'eta_query', params: { route_id: '42' } });
    expect(sentTask(answer).status).toEqual(
      expect.objectContaining({ state: 'TASK_STATE_SUBMITTED' }),
    );
    expect(answer.headers).toEqual({
      [A2A_EVENT_SEQ_HEADER]: '0',
      [A2A_CREDENTIAL_GEN_HEADER]: '0',
      [A2A_STREAM_CLIENT_HEADER]: streamClientKeyOf(`a2a:${iw.clientId}`),
    });
  });

  it('shares one idempotency key with SendMessage: the same call through either door is one task', () => {
    const data = { skill: 'eta_query', params: { route_id: '42' } };
    const streamed = sentTask(streamCall(data, 'same-message')).id;
    const plain = ingressSendMessage(
      iw.rt,
      iw.request('SendMessage', iw.message(data, { messageId: 'same-message' })),
    );
    expect(sentTask(plain).id).toBe(streamed);
    expect(plain.headers).toBeUndefined();
  });

  it('a refused call still opens (and at once ends) its stream with REJECTED', () => {
    const answer = streamCall({ skill: 'eta_query', params: {} });
    expect((sentTask(answer).status as { state: string }).state).toBe('TASK_STATE_REJECTED');
  });
});

describe('SubscribeToTask', () => {
  it('opens on a running task, with the cursor past every event the Task already shows', () => {
    const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    iw.claimChild(id);
    const answer = subscribe(id);
    expect((resultOf(answer).task as { status: { state: string } }).status.state).toBe(
      'TASK_STATE_WORKING',
    );
    expect(answer.headers).toEqual({
      [A2A_EVENT_SEQ_HEADER]: '1',
      [A2A_CREDENTIAL_GEN_HEADER]: '0',
      [A2A_STREAM_CLIENT_HEADER]: streamClientKeyOf(`a2a:${iw.clientId}`),
    });
  });

  it('settles a task whose child ended before answering, so its end is never sent twice', async () => {
    const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    const { taskId } = iw.claimChild(id);
    // The child ended, but nothing has settled the operation yet.
    iw.world.repo.completeWithDetails(
      taskId,
      iw.runnerDid,
      'done',
      JSON.stringify({ eta_minutes: 2 }),
      '{}',
      iw.world.clock,
    );
    expect(iw.opOf(id).state).toBe('open');
    expect(errorOf(subscribe(id))).toEqual({ code: -32004, reason: 'task_terminal' });
  });

  it('refuses an ended task (UnsupportedOperationError, A2A §3.1.6)', () => {
    const id = sentTask(iw.call({ skill: 'eta_query', params: {} })).id as string;
    expect(errorOf(subscribe(id))).toEqual({ code: -32004, reason: 'task_terminal' });
  });

  it('another client’s task is TaskNotFound', () => {
    const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    const other = createA2AClient(iw.world.store, { display_name: 'Other' }, iw.world.clock);
    if (!other.ok) throw new Error(other.reason);
    expect(errorOf(subscribe(id, `Bearer ${other.token}`)).code).toBe(-32001);
  });
});
