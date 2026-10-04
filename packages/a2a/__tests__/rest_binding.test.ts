/**
 * The REST binding (A2A v1.0 §11): every operation at its own method and
 * path, as the reference SDK serves them; params from path, query and body,
 * strictly; errors as `google.rpc.Status` with A2A's HTTP mapping.
 */

import {
  A2A_REST_PATH,
  a2aError,
  matchRestRequest,
  restError,
  restIngressPath,
  restMethodsFor,
  restParams,
  type RestMatch,
} from '../src';

const at = (p: string) => `${A2A_REST_PATH}${p}`;

function matched(method: string, path: string): RestMatch {
  const m = matchRestRequest(method, at(path));
  if (m === null) throw new Error(`no route for ${method} ${path}`);
  return m;
}

describe('routes: the v1.0 paths, no /v1 prefix', () => {
  it.each([
    ['POST', '/message:send', 'SendMessage', {}],
    ['POST', '/message:stream', 'SendStreamingMessage', {}],
    ['GET', '/tasks', 'ListTasks', {}],
    ['GET', '/tasks/t-1', 'GetTask', { id: 't-1' }],
    ['POST', '/tasks/t-1:cancel', 'CancelTask', { id: 't-1' }],
    ['GET', '/tasks/t-1:subscribe', 'SubscribeToTask', { id: 't-1' }],
    ['POST', '/tasks/t-1:subscribe', 'SubscribeToTask', { id: 't-1' }],
    ['POST', '/tasks/t-1/pushNotificationConfigs', 'CreateTaskPushNotificationConfig', { taskId: 't-1' }],
    ['GET', '/tasks/t-1/pushNotificationConfigs', 'ListTaskPushNotificationConfigs', { taskId: 't-1' }],
    ['GET', '/tasks/t-1/pushNotificationConfigs/c-2', 'GetTaskPushNotificationConfig', { taskId: 't-1', id: 'c-2' }],
    ['DELETE', '/tasks/t-1/pushNotificationConfigs/c-2', 'DeleteTaskPushNotificationConfig', { taskId: 't-1', id: 'c-2' }],
    ['GET', '/extendedAgentCard', 'GetExtendedAgentCard', {}],
  ])('%s %s → %s', (method, path, operation, ids) => {
    const m = matched(method, path);
    expect(m.operation).toBe(operation);
    expect(m.ids).toEqual(ids);
  });

  it('decodes a percent-encoded id, and refuses one that does not decode', () => {
    expect(matched('GET', '/tasks/a%2Fb%3Ac').ids).toEqual({ id: 'a/b:c' });
    expect(matchRestRequest('GET', at('/tasks/%E0%A4%A'))).toBeNull();
  });

  it.each([
    ['the JSON-RPC path', 'POST', '/a2a/v1'],
    ['a /v1 prefix', 'POST', `${A2A_REST_PATH}/v1/message:send`],
    ['another method', 'GET', `${A2A_REST_PATH}/message:send`],
    ['a trailing segment', 'GET', `${A2A_REST_PATH}/tasks/t-1/extra`],
    ['an unknown action', 'POST', `${A2A_REST_PATH}/tasks/t-1:pause`],
  ])('matches nothing for %s', (_name, method, path) => {
    expect(matchRestRequest(method, path)).toBeNull();
  });

  it('maps each request to its operation’s Core route, the ids from the path', () => {
    expect(restIngressPath(matched('POST', '/message:send'))).toBe('/v1/a2a/ingress/message');
    expect(restIngressPath(matched('GET', '/tasks/t%2F1'))).toBe('/v1/a2a/ingress/tasks/t%2F1/get');
    expect(restIngressPath(matched('POST', '/tasks/t-1:subscribe'))).toBe('/v1/a2a/ingress/tasks/t-1/subscribe');
    expect(restIngressPath(matched('DELETE', '/tasks/t-1/pushNotificationConfigs/c-2'))).toBe(
      '/v1/a2a/ingress/push-configs/t-1/c-2/delete',
    );
    expect(restIngressPath(matched('GET', '/extendedAgentCard'))).toBe('/v1/a2a/ingress/extended-card');
  });

  it('names the methods a path is served by', () => {
    expect(restMethodsFor(at('/message:send'))).toEqual(['POST']);
    expect(restMethodsFor(at('/tasks/t-1/pushNotificationConfigs/c'))).toEqual(['GET', 'DELETE']);
    expect(restMethodsFor(at('/nothing'))).toEqual([]);
    // A dot-segment id (also spelled %2e) matches no route, so it is a 404, never a 405.
    for (const id of ['.', '..', '%2e', '%2E%2e']) {
      expect(matchRestRequest('GET', at(`/tasks/${id}`))).toBeNull();
      expect(restMethodsFor(at(`/tasks/${id}`))).toEqual([]);
    }
    expect(matchRestRequest('GET', at('/tasks/t.1'))?.ids).toEqual({ id: 't.1' });
  });
});

describe('params', () => {
  it('a message call: the body is the request', () => {
    const body = JSON.stringify({ message: { messageId: 'm', role: 'ROLE_USER', parts: [] } });
    expect(restParams(matched('POST', '/message:send'), '', body)).toEqual({ ok: true, params: JSON.parse(body) });
  });

  it('a list: typed query parameters, and the version', () => {
    expect(
      restParams(matched('GET', '/tasks'), 'contextId=c%201&pageSize=20&includeArtifacts=true&A2A-Version=1.0', ''),
    ).toEqual({ ok: true, params: { contextId: 'c 1', pageSize: 20, includeArtifacts: true }, versionParameter: '1.0' });
  });

  it('the path names the task: a body may repeat it, never change it', () => {
    const cancel = matched('POST', '/tasks/t-1:cancel');
    expect(restParams(cancel, '', '')).toEqual({ ok: true, params: { id: 't-1' } });
    expect(restParams(cancel, '', '{"id":"t-1","metadata":{}}')).toEqual({ ok: true, params: { id: 't-1', metadata: {} } });
    expect(restParams(cancel, '', '{"id":"t-2"}')).toEqual({ ok: false, reason: 'id_mismatch' });
    const create = matched('POST', '/tasks/t-1/pushNotificationConfigs');
    expect(restParams(create, '', '{"url":"https://h.example/a"}')).toEqual({
      ok: true,
      params: { url: 'https://h.example/a', taskId: 't-1' },
    });
    expect(restParams(create, '', '{"url":"https://h.example/a","taskId":"t-9"}')).toEqual({ ok: false, reason: 'id_mismatch' });
  });

  it.each([
    ['an unknown query parameter', 'GET', '/tasks/t-1', 'x=1', '', 'query_not_allowed'],
    ['a key named after an Object.prototype member', 'GET', '/tasks/t-1', 'constructor=1', '', 'query_not_allowed'],
    ['toString on a list', 'GET', '/tasks', 'toString=1', '', 'query_not_allowed'],
    ['__proto__', 'GET', '/tasks', '__proto__=1', '', 'query_not_allowed'],
    ['hasOwnProperty on a body route', 'POST', '/message:send', 'hasOwnProperty=1', '{"message":{}}', 'query_not_allowed'],
    ['a parameter twice', 'GET', '/tasks', 'pageSize=1&pageSize=2', '', 'query_not_allowed'],
    ['a number that is not one', 'GET', '/tasks', 'pageSize=ten', '', 'query_not_allowed'],
    ['a negative number', 'GET', '/tasks', 'pageSize=-1', '', 'query_not_allowed'],
    ['a boolean that is not one', 'GET', '/tasks', 'includeArtifacts=yes', '', 'query_not_allowed'],
    ['a version that is not one', 'GET', '/tasks', 'A2A-Version=latest', '', 'query_not_allowed'],
    ['a query that does not decode', 'GET', '/tasks', 'contextId=%E0%A4%A', '', 'query_not_allowed'],
    ['a body on a read', 'GET', '/tasks/t-1', '', '{}', 'body_not_allowed'],
    ['a message call with no body', 'POST', '/message:send', '', '', 'malformed_body'],
    ['a body that is not an object', 'POST', '/message:send', '', '[1]', 'malformed_body'],
    ['a body with a member twice', 'POST', '/message:send', '', '{"message":{},"message":{}}', 'malformed_body'],
  ])('refuses %s', (_name, method, path, query, body, reason) => {
    expect(restParams(matched(method, path), query, body)).toEqual({ ok: false, reason });
  });

  it('no route takes both query parameters and a body', () => {
    for (const [method, path] of [
      ['POST', '/message:send'],
      ['POST', '/message:stream'],
      ['POST', '/tasks/t:cancel'],
      ['POST', '/tasks/t:subscribe'],
      ['POST', '/tasks/t/pushNotificationConfigs'],
    ] as const) {
      expect(Object.keys(matched(method, path).route.query)).toEqual([]);
    }
  });
});

describe('errors: google.rpc.Status, A2A’s mapping, Dina’s reason kept', () => {
  it.each([
    ['taskNotFound', 404, 'NOT_FOUND', 'TASK_NOT_FOUND'],
    ['taskNotCancelable', 400, 'FAILED_PRECONDITION', 'TASK_NOT_CANCELABLE'],
    ['unsupportedOperation', 400, 'FAILED_PRECONDITION', 'UNSUPPORTED_OPERATION'],
    ['versionNotSupported', 400, 'FAILED_PRECONDITION', 'VERSION_NOT_SUPPORTED'],
    ['extendedAgentCardNotConfigured', 400, 'FAILED_PRECONDITION', 'EXTENDED_AGENT_CARD_NOT_CONFIGURED'],
    ['invalidParams', 400, 'INVALID_ARGUMENT', 'INVALID_PARAMS'],
    ['invalidRequest', 400, 'INVALID_ARGUMENT', 'INVALID_REQUEST'],
    ['methodNotFound', 404, 'NOT_FOUND', 'METHOD_NOT_FOUND'],
    ['internalError', 500, 'INTERNAL', 'INTERNAL_ERROR'],
  ] as const)('%s → %i %s', (kind, http, status, reason) => {
    const out = restError(a2aError(kind, 'dina_reason'));
    expect(out.status).toBe(http);
    expect(out.body).toEqual({
      error: {
        code: http,
        status,
        message: a2aError(kind).message,
        details: [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org', metadata: {} },
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'dina_reason', domain: 'dinakernel.com' },
        ],
      },
    });
  });

  it('an error with no Dina reason carries A2A’s alone', () => {
    expect((restError(a2aError('taskNotFound')).body.error as { details: unknown[] }).details).toHaveLength(1);
  });
});
