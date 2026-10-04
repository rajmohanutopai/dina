/**
 * Lane 2's internal routes: the gateway picks a route from the body, by the
 * same table Core checks the route against.
 */

import {
  A2A_DISPATCH_TABLE,
  A2A_METHODS,
  A2A_STREAMING_METHODS,
  ingressPathFor,
  parseJsonRpcRequestText,
  type JsonRpcRequest,
} from '../src';

function request(text: string): JsonRpcRequest {
  const parsed = parseJsonRpcRequestText(text);
  if (!parsed.ok) throw new Error('fixture');
  return parsed.request;
}

describe('ingressPathFor', () => {
  it('maps a served method to its route, ids filled from the body and escaped', () => {
    expect(
      ingressPathFor(request('{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{}}')),
    ).toEqual({
      ok: true,
      path: '/v1/a2a/ingress/message',
    });
    expect(
      ingressPathFor(
        request('{"jsonrpc":"2.0","id":1,"method":"GetTask","params":{"id":"a/b c"}}'),
      ),
    ).toEqual({
      ok: true,
      path: '/v1/a2a/ingress/tasks/a%2Fb%20c/get',
    });
  });

  it('serves every A2A v1.0 method, each at its own route (M3)', () => {
    expect(Object.keys(A2A_DISPATCH_TABLE).sort()).toEqual([...A2A_METHODS].sort());
    const paths = A2A_METHODS.map((m) => A2A_DISPATCH_TABLE[m].path);
    expect(paths.every((p) => typeof p === 'string')).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
    expect([...A2A_STREAMING_METHODS].sort()).toEqual(['SendStreamingMessage', 'SubscribeToTask']);
  });

  it('routes streaming, push-config and extended-card calls, ids from the body', () => {
    const route = (text: string) => ingressPathFor(request(text));
    expect(route('{"jsonrpc":"2.0","id":1,"method":"SendStreamingMessage","params":{}}')).toEqual({
      ok: true,
      path: '/v1/a2a/ingress/message/stream',
    });
    expect(
      route('{"jsonrpc":"2.0","id":1,"method":"SubscribeToTask","params":{"id":"t1"}}'),
    ).toEqual({
      ok: true,
      path: '/v1/a2a/ingress/tasks/t1/subscribe',
    });
    expect(
      route(
        '{"jsonrpc":"2.0","id":1,"method":"GetTaskPushNotificationConfig","params":{"taskId":"t","id":"c/1"}}',
      ),
    ).toEqual({ ok: true, path: '/v1/a2a/ingress/push-configs/t/c%2F1/get' });
    expect(
      route(
        '{"jsonrpc":"2.0","id":1,"method":"CreateTaskPushNotificationConfig","params":{"taskId":"t","url":"https://x.test/h"}}',
      ),
    ).toEqual({
      ok: true,
      path: '/v1/a2a/ingress/push-configs/t/create',
    });
    // No params at all, as the spec's own example sends it.
    expect(route('{"jsonrpc":"2.0","id":1,"method":"GetExtendedAgentCard"}')).toEqual({
      ok: true,
      path: '/v1/a2a/ingress/extended-card',
    });
  });

  it('says when a route id is missing', () => {
    expect(
      ingressPathFor(request('{"jsonrpc":"2.0","id":1,"method":"CancelTask","params":{"id":""}}')),
    ).toEqual({
      ok: false,
      reason: 'id_missing',
    });
    expect(
      ingressPathFor(
        request(
          '{"jsonrpc":"2.0","id":1,"method":"DeleteTaskPushNotificationConfig","params":{"taskId":"t"}}',
        ),
      ),
    ).toEqual({ ok: false, reason: 'id_missing' });
  });

  it('fills every template parameter of every served route', () => {
    for (const method of A2A_METHODS) {
      const out = ingressPathFor({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: { id: 'x', taskId: 'y' },
      } as JsonRpcRequest);
      expect(out.ok && !out.path.includes(':')).toBe(true);
    }
  });
});

describe('dot-segment ids: no task has one, and no forward could keep one', () => {
  it.each(['.', '..'])('ingressPathFor refuses the id %p as unroutable', (id) => {
    expect(ingressPathFor(request(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id } })))).toEqual({
      ok: false,
      reason: 'id_unroutable',
    });
    expect(ingressPathFor(request(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'CancelTask', params: { id } }))).ok).toBe(false);
  });

  it('an id with dots that is not a dot segment routes as any other', () => {
    expect(ingressPathFor(request('{"jsonrpc":"2.0","id":1,"method":"GetTask","params":{"id":"..."}}'))).toEqual({
      ok: true,
      path: '/v1/a2a/ingress/tasks/.../get',
    });
  });
});

