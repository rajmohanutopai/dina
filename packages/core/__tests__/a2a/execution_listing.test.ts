/**
 * Every round of an inbound call names the listing the call resolved to
 * (design §7.3). The runner reads the listing from the execution payload's
 * `service_uri` and takes the default one when it is absent, as a D2D query
 * that names none means; so a call made to any other listing must carry it,
 * on the first round, after the owner's review, and on every round that
 * continues the call. A node that has no DID to name the listing under runs
 * no round at all: a new call is refused, and a reviewed call approved or a
 * question answered then ends FAILED, once, instead of hanging or throwing.
 */

import { SERVICE_PROFILE_COLLECTION, parseServiceListingUri, parseServiceQueryExecutionPayload } from '@dina/protocol';

import { ingressGetTask, ingressSendMessage, requestInboundInputWith, sweepA2AInbound } from '../../src/a2a';
import { clearPairingState } from '../../src/pairing/ceremony';

import { INBOUND_NODE_DID, InboundWorld, bookingListing, listing, resultOf, save, sentTask } from './inbound_fixture';

import type { WorkflowTask } from '../../src/workflow/domain';

let iw: InboundWorld;
beforeEach(async () => {
  iw = await InboundWorld.create();
});
afterEach(() => iw.close());

/** The listing a child's payload names, as the runner reads it. */
function listingOf(child: WorkflowTask): { uri: string | undefined; rkey: string | undefined } {
  const uri = parseServiceQueryExecutionPayload(child.payload)?.service_uri;
  return { uri, rkey: uri === undefined ? undefined : parseServiceListingUri(uri)?.rkey };
}

const busUri = `at://${INBOUND_NODE_DID}/${SERVICE_PROFILE_COLLECTION}/bus`;

describe('an execution child names its listing (§7.3)', () => {
  it('the first round of a call to a listing other than the default one', () => {
    const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    expect(listingOf(iw.childOf(id))).toEqual({ uri: busUri, rkey: 'bus' });
  });

  it('an in-process round: the runner that falls back to the default listing is told which one', async () => {
    // The default listing holds the same capability with another instruction: the one a fallback would run.
    const inProcess = (instruction: string) =>
      listing({ capabilities: { eta_query: { responsePolicy: 'auto', instruction, category: 'transit' } } });
    await save(inProcess('Answer from the default timetable.'), 'self');
    await save(inProcess('Answer from the night timetable.'), 'night');
    const id = sentTask(iw.call({ skill: 'eta_query@night', params: { route_id: '42' } })).id as string;
    const child = iw.childOf(id);
    expect(child.requested_runner).toBe('dina.local');
    expect(listingOf(child)).toEqual({ uri: `at://${INBOUND_NODE_DID}/${SERVICE_PROFILE_COLLECTION}/night`, rkey: 'night' });
  });

  it('a call the owner reviewed: the child minted on approval', async () => {
    await save(bookingListing(), 'bus');
    const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    const card = iw.childOf(id);
    iw.world.workflow.approve(card.id);
    const child = iw.childOf(id);
    expect(child.id).not.toBe(card.id);
    expect(listingOf(child)).toEqual({ uri: busUri, rkey: 'bus' });
  });

  it('every round that continues a call', () => {
    const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    const ask = { prompt: 'Which stop?', input_schema: { type: 'object', required: ['stop'], properties: { stop: { type: 'string' } } } };
    for (let round = 1; round <= 2; round += 1) {
      const { verdict, taskId } = iw.claimChild(id);
      expect(verdict).toBe('admitted');
      const claimId = iw.world.workflow.store().getById(taskId)?.claim_id;
      expect(requestInboundInputWith(iw.rt, { taskId, claimantDid: iw.runnerDid, claimId, request: ask })).toEqual(
        expect.objectContaining({ kind: 'parked' }),
      );
      sentTask(iw.call({ stop: `S${round}` }, { taskId: id }));
      const next = iw.childOf(id);
      expect(next.id).not.toBe(taskId);
      expect(parseServiceQueryExecutionPayload(next.payload)?.continuation?.turns).toHaveLength(round);
      expect(listingOf(next)).toEqual({ uri: busUri, rkey: 'bus' });
    }
  });

  // Cold audit C5-5: the owner's decision is acted on, so its card ends
  it('an approved review card ends at once: completed when its round is minted, untouched by its deadline', async () => {
    await save(bookingListing(), 'bus');
    const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    const card = iw.childOf(id);
    iw.world.workflow.approve(card.id);
    const after = iw.world.workflow.store().getById(card.id);
    expect(after?.status).toBe('completed');
    expect(JSON.parse(after?.result ?? '{}')).toEqual({ execution_task_id: iw.childOf(id).id });
    // A day and more later, the lapse sweep has nothing to say about it.
    iw.world.clock += 25 * 60 * 60_000;
    iw.world.workflow.expireTasks(Math.floor(iw.world.clock / 1000), iw.world.clock);
    expect(iw.world.workflow.store().getById(card.id)?.status).toBe('completed');
  });

  it('an approved review card whose call closes instead ends failed, with the reason', async () => {
    await save(bookingListing(), 'bus');
    const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    const card = iw.childOf(id);
    clearPairingState();
    iw.world.workflow.approve(card.id);
    expect(iw.world.workflow.store().getById(card.id)).toEqual(expect.objectContaining({ status: 'failed', error: 'no_executor' }));
  });

  it('a reviewed call approved with no node DID ends FAILED, once; the sweep finds nothing to repair', async () => {
    await save(bookingListing(), 'bus');
    const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    const card = iw.childOf(id);
    clearPairingState();
    iw.world.workflow.approve(card.id);
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'no_executor' }));
    expect(iw.world.store.childrenOf(iw.opOf(id).id, 'execution')).toEqual([]);
    expect(sweepA2AInbound(iw.rt)).toEqual(expect.objectContaining({ minted: 0, failed: 0 }));
    expect((resultOf(ingressGetTask(iw.rt, iw.request('GetTask', { id }), id)).status as { state: string }).state).toBe('TASK_STATE_FAILED');
  });

  it('an answer to a question with no node DID ends the call FAILED, answered as such, and a retry reads the same end', () => {
    const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
    const { taskId } = iw.claimChild(id);
    const claimId = iw.world.workflow.store().getById(taskId)?.claim_id;
    const ask = { prompt: 'Which stop?', input_schema: { type: 'object', required: ['stop'], properties: { stop: { type: 'string' } } } };
    expect(requestInboundInputWith(iw.rt, { taskId, claimantDid: iw.runnerDid, claimId, request: ask })).toEqual(
      expect.objectContaining({ kind: 'parked' }),
    );
    clearPairingState();
    const answerParams = iw.message({ stop: 'Elm' }, { messageId: 'answer-no-did', taskId: id });
    const answered = sentTask(ingressSendMessage(iw.rt, iw.request('SendMessage', answerParams)));
    expect([answered.id, (answered.status as { state: string }).state]).toEqual([id, 'TASK_STATE_FAILED']);
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'no_executor', input_required_json: null }));
    // The round that asked is retired, and no new one was made.
    expect(iw.world.workflow.store().getById(taskId)?.status).toBe('cancelled');
    expect(iw.world.store.childrenOf(iw.opOf(id).id, 'execution').map((c) => c.child_task_id)).toEqual([taskId]);
    // The same answer again is a replay of that end.
    const again = sentTask(ingressSendMessage(iw.rt, iw.request('SendMessage', answerParams)));
    expect([again.id, (again.status as { state: string }).state]).toEqual([id, 'TASK_STATE_FAILED']);
  });

  it('with no node DID to name the listing under, the call is refused and no round is made', () => {
    clearPairingState();
    const task = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42' } }));
    expect((task.status as { state: string }).state).toBe('TASK_STATE_REJECTED');
    const op = iw.opOf(task.id as string);
    expect(op).toEqual(expect.objectContaining({ state: 'rejected', reason_code: 'no_executor', internal_id: null }));
    expect(iw.world.store.childrenOf(op.id)).toEqual([]);
  });
});
