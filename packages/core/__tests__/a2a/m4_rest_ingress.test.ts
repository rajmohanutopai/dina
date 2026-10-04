/**
 * M4 REST binding through Core's ingress routes (A2A v1.0 §11; notes M4
 * step 3): the rules the plan's area D listed with no test of their own. A
 * ListTasks status filter is refused over REST as over JSON-RPC; a
 * dot-segment task id names no route, and Core refuses a forward for one
 * built by hand; REST subscribe on a task that asks answers the asking
 * task.
 */

import { A2A_EVENT_SEQ_HEADER, matchRestRequest, restIngressPath, restMethodsFor } from '@dina/a2a';

import { requestInboundInputWith } from '../../src/a2a';
import { CoreRouter, type CoreRequest, type CoreResponse } from '../../src/server/router';
import { registerA2AIngressRoutes, resetA2AIngressState } from '../../src/server/routes/a2a_ingress';

import { InboundWorld } from './inbound_fixture';

const REST = '/a2a/rest';

let iw: InboundWorld;
const router = new CoreRouter();
registerA2AIngressRoutes(router);

beforeEach(async () => {
  resetA2AIngressState();
  iw = await InboundWorld.create();
});
afterEach(() => iw.close());

/** A REST request as the gateway forwards it: to the Core route its path maps to, the request as sent. */
function rest(method: string, path: string, over: { query?: string; body?: unknown } = {}): Promise<CoreResponse> {
  const body = over.body === undefined ? '' : JSON.stringify(over.body);
  const match = matchRestRequest(method, `${REST}${path}`);
  if (match === null) throw new Error(`no REST route for ${method} ${path}`);
  const envelope = {
    request: { method, path: `${REST}${path}`, query: over.query ?? '', body, version: '1.0' },
    client_auth: { authorization: `Bearer ${iw.token}` },
  };
  return router.handle({
    method: 'POST',
    path: restIngressPath(match),
    query: {},
    headers: {},
    body: envelope,
    rawBody: new TextEncoder().encode(JSON.stringify(envelope)),
    params: match.ids.id === undefined ? {} : { extId: match.ids.id },
    trustedInProcess: true,
    callerType: 'gateway',
    callerDID: 'did:key:z6MkGateway',
  } as unknown as CoreRequest);
}

const reasons = (res: CoreResponse) =>
  (res.body as { error: { details: { reason: string }[] } }).error.details.map((d) => d.reason);

async function sendCall(messageId: string): Promise<string> {
  const res = await rest('POST', '/message:send', {
    body: {
      message: { messageId, role: 'ROLE_USER', parts: [{ data: { skill: 'eta_query', params: { route_id: '42' } } }] },
      // Answered at once: these tests read what follows, not the wait (send_wait.test.ts).
      configuration: { returnImmediately: true },
    },
  });
  return (res.body as { task: { id: string } }).task.id;
}

describe('ListTasks over REST', () => {
  // Plan D159
  it('refuses a status filter, as the operation does over JSON-RPC: no stored column can answer it exactly', async () => {
    await sendCall('m4-rest-1');
    const res = await rest('GET', '/tasks', { query: 'status=TASK_STATE_WORKING' });
    expect(res.status).toBe(400);
    expect(reasons(res)).toEqual(['INVALID_PARAMS', 'status_filter_unsupported']);
    // Without the filter the same list answers.
    expect((await rest('GET', '/tasks')).status).toBe(200);
  });
});

describe('a task id that is a dot segment', () => {
  // Plan D160: no route takes it, so nothing is forwarded to Core (the gateway answers 404; dot_segment_ids.test.ts there).
  it.each(['..', '.', '%2e%2e', '%2E'])('GET /tasks/%s matches no REST route and offers no other method', (id) => {
    expect(matchRestRequest('GET', `${REST}/tasks/${id}`)).toBeNull();
    expect(restMethodsFor(`${REST}/tasks/${id}`)).toEqual([]);
  });

  /** A GetTask forward built by hand, as no gateway would build it for a dot-segment id: Core's own check. */
  const forwardGet = (id: string): Promise<CoreResponse> => {
    const envelope = {
      request: { method: 'GET', path: `${REST}/tasks/${id}`, query: '', body: '', version: '1.0' },
      client_auth: { authorization: `Bearer ${iw.token}` },
    };
    return router.handle({
      method: 'POST',
      path: `/v1/a2a/ingress/tasks/${id}/get`,
      query: {},
      headers: {},
      body: envelope,
      rawBody: new TextEncoder().encode(JSON.stringify(envelope)),
      params: { extId: id },
      trustedInProcess: true,
      callerType: 'gateway',
      callerDID: 'did:key:z6MkGateway',
    } as unknown as CoreRequest);
  };

  // Plan D160 (Core's half): forwarded anyway, it reads no task and no list.
  it.each(['..', '.', '%2e%2e', '%2E'])('Core refuses a GetTask forward for /tasks/%s: no task, no list, the real id unseen', async (id) => {
    const real = await sendCall(`m4-rest-dot-${id}`);
    // The same forward, built for the real id, reads the task: the refusal below is the id's.
    const control = await forwardGet(real);
    expect(control.status).toBe(200);
    expect((control.body as { id: string }).id).toBe(real);
    const res = await forwardGet(id);
    expect([400, 404]).toContain(res.status);
    expect([['INVALID_REQUEST', 'external_mismatch'], ['TASK_NOT_FOUND']]).toContainEqual(reasons(res));
    expect(JSON.stringify(res.body)).not.toContain(real);
    expect((res.body as Record<string, unknown>).tasks).toBeUndefined();
  });
});

describe('REST subscribe on a task that asks (notes M4 step 2: asking is not an end)', () => {
  // Plan D90 (Core's side), D91
  it.each(['GET', 'POST'])('%s :subscribe answers the asking task, the question as its message, and the cursor', async (method) => {
    const id = await sendCall('m4-rest-3');
    const { taskId } = iw.claimChild(id);
    requestInboundInputWith(iw.rt, {
      taskId,
      claimantDid: iw.runnerDid,
      claimId: iw.world.workflow.store().getById(taskId)?.claim_id,
      request: { prompt: 'Which stop?', input_schema: { type: 'object', required: ['stop'], properties: { stop: { type: 'string' } } } },
    });
    const res = await rest(method, `/tasks/${id}:subscribe`);
    expect(res.status).toBe(200);
    const task = (res.body as { task: { id: string; status: { state: string; message?: { messageId: string } } } }).task;
    expect([task.id, task.status.state, task.status.message?.messageId]).toEqual([id, 'TASK_STATE_INPUT_REQUIRED', `${id}-input-0`]);
    expect(res.headers?.[A2A_EVENT_SEQ_HEADER]).toBe(String(iw.opOf(id).event_seq));
  });
});
