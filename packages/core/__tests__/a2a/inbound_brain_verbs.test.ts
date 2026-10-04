/**
 * Design §7.3, §10 ("compromised Brain corrupts inbound execution"): an
 * inbound child is moved by the runner it was claimed for, never by Brain.
 * An in-process (`dina.local`) child has no pinned runner: Core's own runner
 * claims it and reports on it, asking Brain only for the answer, so Brain
 * has no executor verb on it at all.
 */

import { admitInboundClaimWith } from '../../src/a2a';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerWorkflowRoutes } from '../../src/server/routes/workflow';

import { BOOK_PARAMS, BOOK_RESULT, InboundWorld, listing, save, sentTask } from './inbound_fixture';

let iw: InboundWorld;
beforeEach(async () => {
  iw = await InboundWorld.create();
});
afterEach(() => iw.close());

const LOCAL = 'did:key:z6MkLocalCore';

/** An approved in-process booking, claimed by Core's runner and past the effect boundary. */
async function runningLocalChild(): Promise<{ id: string; taskId: string }> {
  await save(
    listing({
      capabilities: { appointment_book: { responsePolicy: 'review', instruction: 'Book it.', category: 'appointments' } },
      capabilitySchemas: { appointment_book: { params: BOOK_PARAMS, result: BOOK_RESULT, schemaHash: 'h-book' } },
    }),
    'bus',
  );
  const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
  iw.world.workflow.approve(iw.childOf(id).id);
  const claimed = iw.world.repo.claimDelegationTask(LOCAL, iw.world.clock, 30_000, 'dina.local');
  if (claimed === null) throw new Error('no claim');
  expect(admitInboundClaimWith(iw.rt, claimed, LOCAL)).toBe('admitted');
  return { id, taskId: claimed.id };
}

const brainPost = (router: CoreRouter, path: string, body: Record<string, unknown>) =>
  router.handle({
    method: 'POST',
    path,
    query: {},
    headers: { 'x-did': 'did:key:brain' },
    body,
    rawBody: new Uint8Array(),
    params: { id: path.split('/')[4] ?? '' },
    trustedInProcess: true,
    callerType: 'brain',
    callerDID: 'did:key:brain',
  } as unknown as CoreRequest);

it.each([
  ['complete', { result: '{"booked":false}' }],
  ['fail', { error: 'nope' }],
  ['heartbeat', {}],
  ['progress', { message: 'half way' }],
  ['input-required', { question: 'Which slot?' }],
])('Brain cannot %s a running in-process inbound child; the call stays Core’s runner’s to settle', async (verb, body) => {
  const { id, taskId } = await runningLocalChild();
  const router = new CoreRouter();
  registerWorkflowRoutes(router);
  const resp = await brainPost(router, `/v1/workflow/tasks/${taskId}/${verb}`, body);
  expect([verb, resp.status]).toEqual([verb, 403]);
  expect(iw.childOf(id).status).toBe('running');
  expect(iw.opOf(id).state).toBe('open');
  // Core's runner still reports as before.
  iw.world.workflow.complete(taskId, JSON.stringify({ booked: true }), 'done', LOCAL);
  expect(iw.opOf(id).state).toBe('completed');
});
