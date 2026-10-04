/**
 * The REST binding (A2A v1.0 §11, M4) through Core's ingress routes, as the
 * gateway forwards it: every operation reached from its own method and
 * path, the same operation a JSON-RPC call reaches; answers bare, errors as
 * `google.rpc.Status`; the binding of path, query and body to the route
 * the gateway called; and one receipt book for both bindings.
 */

import { A2A_EVENT_SEQ_HEADER, matchRestRequest, restIngressPath } from '@dina/a2a';

import { ingressSendMessage, requestInboundInputWith } from '../../src/a2a';
import { CoreRouter, type CoreRequest, type CoreResponse } from '../../src/server/router';
import { registerA2AIngressRoutes, resetA2AIngressState } from '../../src/server/routes/a2a_ingress';

import { InboundWorld, sentTask } from './inbound_fixture';

const REST = '/a2a/rest';

let iw: InboundWorld;
const router = new CoreRouter();
registerA2AIngressRoutes(router);

beforeEach(async () => {
  resetA2AIngressState();
  iw = await InboundWorld.create();
});
afterEach(() => iw.close());

interface RestCall {
  query?: string;
  body?: unknown;
  auth?: string | null;
  version?: string | null;
  /** The Core route the gateway calls, when a test sends the request somewhere else. */
  route?: string;
}

/** A REST request as the gateway forwards it: to the route its path maps to, the request as sent. */
function rest(method: string, path: string, over: RestCall = {}): Promise<CoreResponse> {
  const body = over.body === undefined ? '' : typeof over.body === 'string' ? over.body : JSON.stringify(over.body);
  const match = matchRestRequest(method, `${REST}${path}`);
  const route = over.route ?? (match === null ? '/v1/a2a/ingress/message' : restIngressPath(match));
  const auth = over.auth === undefined ? `Bearer ${iw.token}` : over.auth;
  const version = over.version === undefined ? '1.0' : over.version;
  const envelope = {
    request: { method, path: `${REST}${path}`, query: over.query ?? '', body, ...(version === null ? {} : { version }) },
    client_auth: auth === null ? {} : { authorization: auth },
  };
  return router.handle({
    method: 'POST',
    path: route,
    query: {},
    headers: {},
    body: envelope,
    rawBody: new TextEncoder().encode(JSON.stringify(envelope)),
    params: routeParams(route),
    trustedInProcess: true,
    callerType: 'gateway',
    callerDID: 'did:key:z6MkGateway',
  } as unknown as CoreRequest);
}

/** The router fills route params; a direct `handle` call names them. */
function routeParams(route: string): Record<string, string> {
  const parts = route.split('/');
  const at = (name: string) => parts.indexOf(name);
  if (parts.includes('tasks') && parts.length >= 7) return { extId: decodeURIComponent(parts[at('tasks') + 1] ?? '') };
  if (parts.includes('push-configs')) {
    const i = at('push-configs');
    const extId = decodeURIComponent(parts[i + 1] ?? '');
    const next = parts[i + 2] ?? '';
    return next === 'create' || next === 'list' ? { extId } : { extId, configId: decodeURIComponent(next) };
  }
  return {};
}

/** A call that asks to be answered at once: these tests read the mapping, not the wait (send_wait.test.ts). */
const message = (messageId: string, data: Record<string, unknown> = { skill: 'eta_query', params: { route_id: '42' } }) => ({
  message: { messageId, role: 'ROLE_USER', parts: [{ data }] },
  configuration: { returnImmediately: true },
});

const errorOf = (res: CoreResponse) =>
  (res.body as { error: { code: number; status: string; details: { reason: string; domain: string }[] } }).error;

describe('every operation, its own method and path', () => {
  it('sends a message: the bare SendMessageResponse, marked as the client’s answer', async () => {
    const res = await rest('POST', '/message:send', { body: message('r-1') });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.jsonrpc).toBeUndefined();
    expect((body.task as { status: { state: string } }).status.state).toBe('TASK_STATE_SUBMITTED');
    expect(res.headers?.['x-dina-a2a-answer']).toBe('1');
  });

  it('reads, lists and cancels a task', async () => {
    const id = ((await rest('POST', '/message:send', { body: message('r-2') })).body as { task: { id: string } }).task.id;
    const got = await rest('GET', `/tasks/${id}`);
    expect((got.body as { id: string }).id).toBe(id);
    const listed = await rest('GET', '/tasks', { query: 'pageSize=10&includeArtifacts=true' });
    expect((listed.body as { tasks: { id: string }[] }).tasks.map((t) => t.id)).toEqual([id]);
    const canceled = await rest('POST', `/tasks/${id}:cancel`);
    expect((canceled.body as { status: { state: string } }).status.state).toBe('TASK_STATE_CANCELED');
  });

  it('a streaming call opens with the task and the event cursor, as over JSON-RPC', async () => {
    const res = await rest('POST', '/message:stream', { body: message('r-3') });
    expect(res.status).toBe(200);
    expect((res.body as { task: { id: string } }).task.id).toEqual(expect.any(String));
    expect(res.headers?.[A2A_EVENT_SEQ_HEADER]).toEqual(expect.any(String));
    const id = (res.body as { task: { id: string } }).task.id;
    const sub = await rest('GET', `/tasks/${id}:subscribe`);
    expect((sub.body as { task: { id: string } }).task.id).toBe(id);
    expect((await rest('POST', `/tasks/${id}:subscribe`)).status).toBe(200);
  });

  it('push configs: create, list, get, delete', async () => {
    const id = ((await rest('POST', '/message:send', { body: message('r-4') })).body as { task: { id: string } }).task.id;
    const made = await rest('POST', `/tasks/${id}/pushNotificationConfigs`, { body: { url: 'https://hooks.example/a2a' } });
    expect(made.status).toBe(200);
    const configId = (made.body as { id: string }).id;
    expect((made.body as { taskId: string }).taskId).toBe(id);
    const listed = await rest('GET', `/tasks/${id}/pushNotificationConfigs`);
    expect((listed.body as { configs: { id: string }[] }).configs.map((c) => c.id)).toEqual([configId]);
    expect(((await rest('GET', `/tasks/${id}/pushNotificationConfigs/${configId}`)).body as { id: string }).id).toBe(configId);
    expect(await rest('DELETE', `/tasks/${id}/pushNotificationConfigs/${configId}`)).toEqual(
      expect.objectContaining({ status: 200, body: {} }),
    );
  });

  it('answers a question over REST, as a message that names its task', async () => {
    const id = ((await rest('POST', '/message:send', { body: message('r-5') })).body as { task: { id: string } }).task.id;
    const { taskId } = iw.claimChild(id);
    const claimId = iw.world.workflow.store().getById(taskId)?.claim_id;
    requestInboundInputWith(iw.rt, {
      taskId,
      claimantDid: iw.runnerDid,
      claimId,
      request: { prompt: 'Which stop?', input_schema: { type: 'object', required: ['stop'], properties: { stop: { type: 'string' } } } },
    });
    expect(((await rest('GET', `/tasks/${id}`)).body as { status: { state: string } }).status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    const answered = await rest('POST', '/message:send', {
      body: {
        message: { messageId: 'r-5-answer', role: 'ROLE_USER', taskId: id, parts: [{ data: { stop: 'Elm' } }] },
        configuration: { returnImmediately: true },
      },
    });
    expect(((answered.body as { task: { status: { state: string } } }).task.status.state)).toBe('TASK_STATE_WORKING');
  });

  it('one receipt book for both bindings: the same message by JSON-RPC is a replay', async () => {
    const id = ((await rest('POST', '/message:send', { body: message('r-6') })).body as { task: { id: string } }).task.id;
    // The same params, configuration included: the receipt is a hash of them all.
    const viaRpc = sentTask(ingressSendMessage(iw.rt, iw.request('SendMessage', message('r-6'))));
    expect(viaRpc.id).toBe(id);
  });
});

describe('errors: google.rpc.Status, A2A’s HTTP mapping, Dina’s reason kept', () => {
  it('a task not found is 404 NOT_FOUND / TASK_NOT_FOUND', async () => {
    const res = await rest('GET', '/tasks/no-such-task');
    expect(res.status).toBe(404);
    expect(errorOf(res)).toEqual(
      expect.objectContaining({
        code: 404,
        status: 'NOT_FOUND',
        details: [expect.objectContaining({ reason: 'TASK_NOT_FOUND', domain: 'a2a-protocol.org' })],
      }),
    );
  });

  it('a refusal keeps Dina’s reason after A2A’s', async () => {
    const res = await rest('POST', '/message:send', {
      body: { message: { messageId: 'r-7', role: 'ROLE_AGENT', parts: [{ data: { skill: 'eta_query', params: {} } }] } },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).details.map((d) => [d.reason, d.domain])).toEqual([
      ['INVALID_PARAMS', 'a2a-protocol.org'],
      ['role_not_user', 'dinakernel.com'],
    ]);
  });

  it('no credential is 401 UNAUTHENTICATED, with the challenge kept', async () => {
    const res = await rest('GET', '/tasks', { auth: null });
    expect(res.status).toBe(401);
    expect(errorOf(res)).toEqual(expect.objectContaining({ status: 'UNAUTHENTICATED' }));
    expect(res.headers?.['www-authenticate']).toContain('Bearer');
  });

  it('no version is 400 VERSION_NOT_SUPPORTED; the query parameter is enough', async () => {
    const res = await rest('GET', '/tasks', { version: null });
    expect(res.status).toBe(400);
    expect(errorOf(res).details[0]?.reason).toBe('VERSION_NOT_SUPPORTED');
    expect((await rest('GET', '/tasks', { version: null, query: 'A2A-Version=1.0' })).status).toBe(200);
  });

  it.each(['1.00', '01.0', '0001.0000', '1.0.01'])('a version in non-canonical digits (%s) is refused, as on every door', async (version) => {
    const res = await rest('GET', '/tasks', { version });
    expect(res.status).toBe(400);
    expect(errorOf(res).details[0]?.reason).toBe('VERSION_NOT_SUPPORTED');
  });
});

describe('Core binds the REST request to the route the gateway called', () => {
  it.each([
    ['a request sent to another operation’s route', 'GET', '/tasks/t-1', { route: '/v1/a2a/ingress/tasks/t-1/cancel' }, 'operation_mismatch'],
    ['a path for one task sent to another task’s route', 'GET', '/tasks/t-1', { route: '/v1/a2a/ingress/tasks/t-2/get' }, 'id_mismatch'],
    ['a path no route serves', 'POST', '/tasks/t-1:pause', {}, 'external_mismatch'],
    ['a body on a read', 'GET', '/tasks/t-1', { body: {} }, 'body_not_allowed'],
    ['a query parameter the operation does not read', 'GET', '/tasks/t-1', { query: 'secret=1' }, 'query_not_allowed'],
    ['a message call with no body', 'POST', '/message:send', {}, 'malformed_body'],
  ] as const)('refuses %s (400 INVALID_REQUEST)', async (_name, method, path, over, reason) => {
    const res = await rest(method, path, over);
    expect(res.status).toBe(400);
    expect(errorOf(res).details.map((d) => d.reason)).toEqual(['INVALID_REQUEST', reason]);
  });
});
