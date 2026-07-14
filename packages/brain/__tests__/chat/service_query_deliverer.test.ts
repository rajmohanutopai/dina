/**
 * Contact Services seam 4 (BRAIN UNIT) — `createServiceQueryDeliverer`'s
 * resolver PLUMBING: it calls the injected `threadResolver` with the task's
 * `origin_channel` and patches the card in the resolved thread, falling back to
 * the default thread when the resolver returns null.
 *
 * Brain can't import the app's boot resolver (that would invert the dependency),
 * so this uses a representative resolver to pin the deliverer's mechanism. The
 * REAL boot `talkThreadResolver` (and the DID-origin / terminal-status /
 * confused-deputy cases through it) is pinned in
 * `apps/mobile/__tests__/services/talk_thread_routing.test.ts`.
 */

import { createServiceQueryDeliverer } from '../../src/chat/service_query_deliverer';
import { addLifecycleMessage, getThread, readLifecycle, resetThreads } from '../../src/chat/thread';

import type { ServiceQueryEventDetails } from '../../src/service/result_formatter';
import type { WorkflowEvent, WorkflowTask } from '@dina/core';

const PEER = 'did:plc:sancho';
const TASK_ID = 'sq-q1-aabbccdd';

// A representative resolver matching the deliverer's contract — the deliverer
// mechanism is what's under test here (the real boot resolver lives in the
// mobile suite). A DID origin diverts to its own thread; else fall back.
const threadResolver = ({ originChannel }: { originChannel: string }): string | null =>
  originChannel.startsWith('did:') ? originChannel : null;

/** A `service_query` task whose payload carries the given origin_channel. */
function makeTask(originChannel: string): WorkflowTask {
  return {
    id: TASK_ID,
    kind: 'service_query',
    payload: JSON.stringify({
      query_id: 'q1',
      capability: 'availability_coordination',
      origin_channel: originChannel,
    }),
  } as unknown as WorkflowTask;
}

function makeEvent(): WorkflowEvent {
  return { task_id: TASK_ID, event_kind: 'completed' } as unknown as WorkflowEvent;
}

const SUCCESS_DETAILS: ServiceQueryEventDetails = {
  response_status: 'success',
  capability: 'availability_coordination',
  service_name: 'Sancho scheduling',
  result: { status: 'accepted', accepted_slots: [{ start: 'Tue 3pm' }] },
};

beforeEach(() => {
  resetThreads();
});

describe('createServiceQueryDeliverer — peer-thread routing (seam 4)', () => {
  it('patches the pending card in the PEER thread when origin_channel is a DID', async () => {
    // A pending card already exists in the peer thread (posted by seam 5).
    addLifecycleMessage(PEER, 'Asking Sancho scheduling…', {
      kind: 'service_query',
      status: 'pending',
      taskId: TASK_ID,
      queryId: 'q1',
      capability: 'availability_coordination',
      serviceName: 'Sancho scheduling',
      providerDid: PEER,
    });

    const deliver = createServiceQueryDeliverer({ threadId: 'main', threadResolver });
    await deliver({
      text: 'Sancho can do Tue 3pm.',
      event: makeEvent(),
      task: makeTask(PEER),
      details: SUCCESS_DETAILS,
    });

    // The peer thread's single card flipped to resolved — no second bubble,
    // and nothing leaked into 'main'.
    const peerThread = getThread(PEER);
    expect(peerThread).toHaveLength(1);
    const lc = readLifecycle(peerThread[0]);
    expect(lc?.kind).toBe('service_query');
    if (lc?.kind !== 'service_query') throw new Error('expected service_query lifecycle');
    expect(lc.status).toBe('resolved');
    expect(lc.taskId).toBe(TASK_ID);
    expect(lc.result).toEqual({ status: 'accepted', accepted_slots: [{ start: 'Tue 3pm' }] });
    expect(getThread('main')).toHaveLength(0);
  });

  it('falls back to the default thread when origin_channel is NOT a DID (main-tab path)', async () => {
    addLifecycleMessage('main', 'Asking…', {
      kind: 'service_query',
      status: 'pending',
      taskId: TASK_ID,
      queryId: 'q1',
      capability: 'availability_coordination',
      serviceName: 'Sancho scheduling',
    });

    const deliver = createServiceQueryDeliverer({ threadId: 'main', threadResolver });
    await deliver({
      text: 'done',
      event: makeEvent(),
      task: makeTask('ask'), // non-DID origin → resolver returns null
      details: SUCCESS_DETAILS,
    });

    const mainThread = getThread('main');
    expect(mainThread).toHaveLength(1);
    const lc = readLifecycle(mainThread[0]);
    if (lc?.kind !== 'service_query') throw new Error('expected service_query lifecycle');
    expect(lc.status).toBe('resolved');
    expect(getThread(PEER)).toHaveLength(0);
  });
});

describe('createServiceQueryDeliverer — round-14 #12 delegation bubble dedup', () => {
  const delegTask = (id: string): WorkflowTask =>
    ({
      id,
      kind: 'delegation',
      payload: JSON.stringify({ type: 'free_form_task' }),
    }) as unknown as WorkflowTask;
  const evt = (eventId: number, taskId: string): WorkflowEvent =>
    ({ event_id: eventId, task_id: taskId, event_kind: 'completed' }) as unknown as WorkflowEvent;
  const noDetails = {} as ServiceQueryEventDetails;

  it('dedupes a redelivered (same event_id) non-service_query event to ONE bubble', async () => {
    const deliver = createServiceQueryDeliverer({ threadId: 'main' });
    // At-least-once redelivery: the SAME event arrives twice.
    await deliver({
      text: 'agent finished: 42',
      event: evt(77, 'deleg-1'),
      task: delegTask('deleg-1'),
      details: noDetails,
    });
    await deliver({
      text: 'agent finished: 42',
      event: evt(77, 'deleg-1'),
      task: delegTask('deleg-1'),
      details: noDetails,
    });
    expect(getThread('main')).toHaveLength(1);
  });

  it('does NOT dedupe distinct events (different event_id) on the same task', async () => {
    const deliver = createServiceQueryDeliverer({ threadId: 'main' });
    await deliver({
      text: 'first',
      event: evt(1, 'deleg-2'),
      task: delegTask('deleg-2'),
      details: noDetails,
    });
    await deliver({
      text: 'second',
      event: evt(2, 'deleg-2'),
      task: delegTask('deleg-2'),
      details: noDetails,
    });
    expect(getThread('main')).toHaveLength(2);
  });
});
