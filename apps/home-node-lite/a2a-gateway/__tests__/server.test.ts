/**
 * The gateway's public surface with a recording Core link: what it forwards,
 * byte for byte, and what it answers itself (protocol errors, a call with no
 * route id, its edge limit, its stream limit, oversized bodies). It decides
 * nothing else.
 */

import { Writable } from 'node:stream';

import { pino } from 'pino';

import { EdgeLimiter } from '../src/edge_limit';
import { AGENT_CARD_PATH, buildGatewayServer } from '../src/server';
import { StreamHub } from '../src/stream_hub';

import type { CoreLink, CoreReply } from '../src/core_link';
import type { GatewayEnvelope } from '@dina/core';
import type { FastifyInstance } from 'fastify';

/** The opaque client key Core sends with a stream's opening answer. */
const STREAM_CLIENT = 'c'.repeat(32);

const TOKEN = `dina_a2a_${'Q'.repeat(43)}`;

interface Recorded {
  path: string;
  envelope: GatewayEnvelope;
}

let forwarded: Recorded[];
let cardCalls: number;
let coreReply: CoreReply;
let cardReply: Awaited<ReturnType<CoreLink['card']>>;
let logLines: string[];
let clock: number;
let app: FastifyInstance;
let hub: StreamHub;
/** When set, Core's answer waits for it: the moment a call is still at Core. */
let coreHold: Promise<void> | null;
let reachedCore: () => void;

function build(
  limit = 1000,
  streams = { perIp: 20, maxLifetimeMs: 60_000, keepaliveMs: 60_000, maxBufferedBytes: 1 << 20 },
): FastifyInstance {
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      logLines.push(chunk.toString());
      done();
    },
  });
  const core: CoreLink = {
    async forward(path, envelope) {
      forwarded.push({ path, envelope });
      reachedCore();
      if (coreHold !== null) await coreHold;
      return coreReply;
    },
    async card() {
      cardCalls += 1;
      return cardReply;
    },
    async claimEvents() {
      return { ok: true, claim: { items: [], closed: [], fenced: [] } };
    },
    async ackEvents(acks) {
      return { ok: true, applied: acks.length };
    },
  };
  hub = new StreamHub({
    maxStreams: 4,
    bufferMs: 60_000,
    bufferEvents: 16,
    bufferTasks: 16,
    bufferBytes: 1 << 20,
    now: () => clock,
  });
  return buildGatewayServer({
    core,
    limiter: new EdgeLimiter(limit, () => clock),
    logger: pino({ level: 'info' }, sink),
    cardCacheMs: 30_000,
    trustProxy: 0,
    hub,
    streams,
    now: () => clock,
  });
}

beforeEach(() => {
  coreHold = null;
  reachedCore = () => undefined;
  forwarded = [];
  cardCalls = 0;
  logLines = [];
  clock = 1_800_000_000_000;
  coreReply = {
    ok: true,
    answer: { status: 200, headers: {}, body: { jsonrpc: '2.0', id: 1, result: { id: 't-1' } } },
  };
  cardReply = { ok: true, card: { name: 'Bus 42' }, jwks: { keys: [{ kid: 'k' }] } };
  app = build();
});

afterEach(async () => {
  await app.close();
});

function rpc(body: string, headers: Record<string, string> = {}, url = '/a2a/v1') {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      'a2a-version': '1.0',
      ...headers,
    },
    payload: body,
  });
}

describe('forwarding', () => {
  it('forwards the raw body, the client’s bearer and version, to the route the body names', async () => {
    const body =
      '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"messageId":"m","role":"ROLE_USER","parts":[{"data":{"skill":"eta_query","params":{}}}]}}}';
    const res = await rpc(body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { id: 't-1' } });
    expect(forwarded).toEqual([
      {
        path: '/v1/a2a/ingress/message',
        envelope: {
          request: { method: 'POST', path: '/a2a/v1', query: '', body, version: '1.0' },
          client_auth: { authorization: `Bearer ${TOKEN}` },
        },
      },
    ]);
  });

  it('passes a DID-signed client’s four headers through as they came (M4)', async () => {
    const body = '{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{}}';
    const res = await app.inject({
      method: 'POST',
      url: '/a2a/v1',
      headers: {
        'content-type': 'application/json',
        'a2a-version': '1.0',
        'x-did': 'did:key:z6MkClient',
        'x-timestamp': '2027-01-15T08:00:00Z',
        'x-nonce': 'n1',
        'x-signature': 'ab',
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(forwarded[0]?.envelope.client_auth).toEqual({
      did_signature: {
        did: 'did:key:z6MkClient',
        timestamp: '2027-01-15T08:00:00Z',
        nonce: 'n1',
        signature: 'ab',
      },
    });
  });

  it('forwards a DID binding to Core’s binding door, the body as it came and no credential', async () => {
    coreReply = {
      ok: true,
      answer: { status: 200, headers: {}, body: { did: 'did:key:z6MkClient' } },
    };
    const body = '{"did":"did:key:z6MkClient","challenge":"c","signature":"s"}';
    const res = await app.inject({
      method: 'POST',
      url: '/a2a/v1/did-binding',
      // The owner's challenge is the authority: whatever else a caller sends stays here.
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        'x-did': 'did:key:z6MkClient',
        'x-signature': 'ab',
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(forwarded).toEqual([
      {
        path: '/v1/a2a/ingress/did/complete',
        envelope: {
          request: { method: 'POST', path: '/a2a/v1/did-binding', query: '', body },
          client_auth: {},
        },
      },
    ]);
  });

  it('keeps whitespace and member order exactly, and passes the query through', async () => {
    const body = '{ "id": 7, "method": "GetTask", "jsonrpc": "2.0", "params": { "id": "a/b" } }';
    await rpc(body, {}, '/a2a/v1?A2A-Version=1.0');
    expect(forwarded[0]?.path).toBe('/v1/a2a/ingress/tasks/a%2Fb/get');
    expect(forwarded[0]?.envelope.request).toEqual(
      expect.objectContaining({ body, query: 'A2A-Version=1.0' }),
    );
  });

  it('relays Core’s challenge and slow-down headers, and nothing else', async () => {
    coreReply = {
      ok: true,
      answer: {
        status: 401,
        headers: { 'www-authenticate': 'Bearer realm="dina-a2a"' },
        body: { error: 'unauthenticated' },
      },
    };
    const res = await rpc('{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{}}');
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer realm="dina-a2a"');
  });

  it('answers 503 when Core does not answer for the client', async () => {
    coreReply = { ok: false, status: 403 };
    const res = await rpc('{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{}}');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'unavailable' });
  });
});

describe('answered at the gateway, never forwarded', () => {
  it.each([
    ['not JSON', '{oops', -32700],
    [
      'a duplicate member',
      '{"jsonrpc":"2.0","id":1,"method":"GetTask","method":"CancelTask","params":{"id":"t"}}',
      -32600,
    ],
    ['an unknown method', '{"jsonrpc":"2.0","id":1,"method":"Explode","params":{}}', -32601],
    [
      'a task call with no task id',
      '{"jsonrpc":"2.0","id":1,"method":"GetTask","params":{}}',
      -32602,
    ],
  ])('%s', async (_name, body, code) => {
    const res = await rpc(body);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { error: { code: number } }).error.code).toBe(code);
    expect(forwarded).toHaveLength(0);
  });

  it('runs nothing for a notification', async () => {
    const res = await rpc('{"jsonrpc":"2.0","method":"SendMessage","params":{}}');
    expect(res.statusCode).toBe(204);
    expect(forwarded).toHaveLength(0);
  });

  it('refuses a body past 256 KB, and a body that is not JSON', async () => {
    const big = `{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"x":"${'a'.repeat(256 * 1024)}"}}`;
    expect((await rpc(big)).statusCode).toBe(413);
    const plain = await app.inject({
      method: 'POST',
      url: '/a2a/v1',
      headers: { 'content-type': 'text/plain' },
      payload: 'hi',
    });
    expect(plain.statusCode).toBe(415);
    expect(forwarded).toHaveLength(0);
  });

  it('accepts JSON with a charset parameter', async () => {
    const res = await rpc('{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{}}', {
      'content-type': 'application/json; charset=utf-8',
    });
    expect(res.statusCode).toBe(200);
    expect(forwarded).toHaveLength(1);
  });

  it('limits calls per address per minute', async () => {
    await app.close();
    app = build(2);
    const body = '{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{}}';
    expect((await rpc(body)).statusCode).toBe(200);
    expect((await rpc(body)).statusCode).toBe(200);
    const third = await rpc(body);
    expect([third.statusCode, third.headers['retry-after']]).toEqual([429, '60']);
    clock += 60_000;
    expect((await rpc(body)).statusCode).toBe(200);
    expect(forwarded).toHaveLength(3);
  });
});

describe('the card', () => {
  it('serves Core’s card and key set, cached for 30 seconds, readable cross-origin', async () => {
    const a = await app.inject({ method: 'GET', url: AGENT_CARD_PATH });
    const b = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect([a.statusCode, a.json()]).toEqual([200, { name: 'Bus 42' }]);
    expect(b.json()).toEqual({ keys: [{ kid: 'k' }] });
    expect(a.headers['access-control-allow-origin']).toBe('*');
    expect(cardCalls).toBe(1);
    clock += 30_000;
    await app.inject({ method: 'GET', url: AGENT_CARD_PATH });
    expect(cardCalls).toBe(2);
  });

  it('serves the card’s canonical bytes, whatever order Core’s object has', async () => {
    cardReply = { ok: true, card: { name: 'Bus 42', capabilities: { streaming: true, b: 1, a: 2 } }, jwks: { keys: [] } };
    const res = await app.inject({ method: 'GET', url: AGENT_CARD_PATH });
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toBe('{"capabilities":{"a":2,"b":1,"streaming":true},"name":"Bus 42"}');
  });

  it('answers 503 while Core has no card to give', async () => {
    cardReply = { ok: false, status: 503 };
    expect((await app.inject({ method: 'GET', url: AGENT_CARD_PATH })).statusCode).toBe(503);
  });
});

describe('logs', () => {
  it('never carry a body, a bearer or a task id', async () => {
    await rpc('{"jsonrpc":"2.0","id":1,"method":"GetTask","params":{"id":"secret-task-id"}}');
    coreReply = { ok: false, status: 500 };
    await rpc(
      '{"jsonrpc":"2.0","id":2,"method":"SendMessage","params":{"message":{"note":"my private words"}}}',
    );
    const all = logLines.join('');
    expect(all).toContain('"method":"GetTask"');
    for (const secret of [TOKEN, 'secret-task-id', 'my private words'])
      expect(all).not.toContain(secret);
  });
});

describe('REST (HTTP+JSON, A2A §11)', () => {
  const restCall = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: string, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url: `/a2a/rest${url}`,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'a2a-version': '1.0',
        ...(payload === undefined ? {} : { 'content-type': 'application/a2a+json' }),
        ...headers,
      },
      ...(payload === undefined ? {} : { payload }),
    });

  it.each([
    ['POST', '/message:send', '{"message":{}}', '/v1/a2a/ingress/message'],
    ['GET', '/tasks/a%2Fb', undefined, '/v1/a2a/ingress/tasks/a%2Fb/get'],
    ['POST', '/tasks/t-1:cancel', undefined, '/v1/a2a/ingress/tasks/t-1/cancel'],
    ['GET', '/tasks', undefined, '/v1/a2a/ingress/tasks/list'],
    ['DELETE', '/tasks/t-1/pushNotificationConfigs/c-2', undefined, '/v1/a2a/ingress/push-configs/t-1/c-2/delete'],
    ['GET', '/extendedAgentCard', undefined, '/v1/a2a/ingress/extended-card'],
  ] as const)('%s %s goes to its operation’s Core route, the request as sent', async (method, url, payload, route) => {
    coreReply = { ok: true, answer: { status: 200, headers: {}, body: { id: 't-1' } } };
    const res = await restCall(method, `${url}?A2A-Version=1.0`, payload);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/a2a+json');
    expect(forwarded).toEqual([
      {
        path: route,
        envelope: {
          request: {
            method,
            path: `/a2a/rest${url}`,
            query: 'A2A-Version=1.0',
            body: payload ?? '',
            version: '1.0',
          },
          client_auth: { authorization: `Bearer ${TOKEN}` },
        },
      },
    ]);
  });

  it('relays Core’s REST answer as it came: status, headers, body', async () => {
    coreReply = {
      ok: true,
      answer: {
        status: 404,
        headers: { 'x-extra': '1' },
        body: { error: { code: 404, status: 'NOT_FOUND', message: 'Task not found' } },
      },
    };
    const res = await restCall('GET', '/tasks/none');
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-extra']).toBe('1');
    expect(res.json()).toEqual({ error: { code: 404, status: 'NOT_FOUND', message: 'Task not found' } });
  });

  it('answers what needs no authority itself, as google.rpc.Status: no route, a wrong method', async () => {
    const none = await restCall('GET', '/nothing');
    expect(none.statusCode).toBe(404);
    expect(none.json()).toEqual({ error: { code: 404, status: 'NOT_FOUND', message: 'not_found' } });
    const wrong = await restCall('DELETE', '/message:send');
    expect(wrong.statusCode).toBe(405);
    expect(wrong.headers.allow).toBe('POST');
    expect(forwarded).toEqual([]);
  });

  it.each([
    [
      'a body over 256 KB',
      { method: 'POST' as const, url: '/a2a/rest/message:send', headers: { 'content-type': 'application/a2a+json' }, payload: `{"x":"${'a'.repeat(300_000)}"}` },
      413,
      'INVALID_ARGUMENT',
      'payload_too_large',
    ],
    [
      'a content type it does not read',
      { method: 'POST' as const, url: '/a2a/rest/message:send', headers: { 'content-type': 'text/plain' }, payload: 'hello' },
      415,
      'INVALID_ARGUMENT',
      'unsupported_media_type',
    ],
    ['the bare REST base', { method: 'GET' as const, url: '/a2a/rest' }, 404, 'NOT_FOUND', 'not_found'],
  ])('answers %s as google.rpc.Status, as the SDK expects', async (_name, req, code, status, message) => {
    const res = await app.inject(req);
    expect(res.statusCode).toBe(code);
    expect(res.headers['content-type']).toContain('application/a2a+json');
    expect(res.json()).toEqual({ error: { code, status, message } });
    expect(forwarded).toEqual([]);
  });

  it.each(['PATCH', 'PUT', 'OPTIONS'] as const)('answers %s on a REST path with 405 and the methods served', async (method) => {
    const res = await app.inject({ method, url: '/a2a/rest/tasks/t-1' });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('GET');
    expect((res.json() as { error: { status: string } }).error.status).toBe('UNIMPLEMENTED');
  });

  it('keeps the plain answers off REST paths', async () => {
    const res = await app.inject({ method: 'POST', url: '/a2a/v1', headers: { 'content-type': 'text/plain' }, payload: 'x' });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: 'unsupported_media_type' });
    expect((await app.inject({ method: 'GET', url: '/nothing' })).json()).toEqual({ error: 'not_found' });
  });

  it('a Core it cannot reach is 503 UNAVAILABLE', async () => {
    coreReply = { ok: false, status: 0 };
    const res = await restCall('GET', '/tasks');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: { code: 503, status: 'UNAVAILABLE', message: 'unavailable' } });
  });

  it('the edge limit holds for REST too', async () => {
    await app.close();
    app = build(1);
    expect((await restCall('GET', '/tasks')).statusCode).toBe(200);
    const res = await restCall('GET', '/tasks');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'rate_limited' } });
    expect(res.headers['retry-after']).toBe('60');
  });
});

describe('streaming calls (JSON-RPC binding §9.4.2)', () => {
  const TASK = {
    id: 't-9',
    contextId: 'c-9',
    status: { state: 'TASK_STATE_WORKING', timestamp: '2027-01-15T08:00:00.000Z' },
  };
  const status = (state: string) => ({
    statusUpdate: { taskId: 't-9', contextId: 'c-9', status: { state } },
  });
  const streamBody = (id = 7) =>
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'SendStreamingMessage',
      params: { message: { messageId: 'm', role: 'ROLE_USER', parts: [] } },
    });

  /** A real socket: an open stream never ends an `inject`. */
  async function listen(): Promise<string> {
    await app.listen({ port: 0, host: '127.0.0.1' });
    return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  }

  /** POST a streaming call; read its events as they come. */
  async function open(base: string, body = streamBody()) {
    const res = await fetch(`${base}/a2a/v1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        'a2a-version': '1.0',
      },
      body,
    });
    const reader = res.body?.getReader();
    let buffered = '';
    const next = async (): Promise<unknown> => {
      for (;;) {
        const at = buffered.indexOf('\n\n');
        if (at !== -1) {
          const frame = buffered.slice(0, at);
          buffered = buffered.slice(at + 2);
          if (frame.startsWith('data: ')) return JSON.parse(frame.slice(6));
          continue;
        }
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) return 'end';
        buffered += new TextDecoder().decode(chunk.value);
      }
    };
    return { res, next, cancel: () => reader?.cancel() };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('opens with Core’s answer, carries the task’s later events under the call’s id, and ends with the task', async () => {
    coreReply = {
      ok: true,
      answer: {
        status: 200,
        headers: {},
        body: { jsonrpc: '2.0', id: 7, result: { task: TASK } },
        eventSeq: 2, credentialGen: 0, streamClient: STREAM_CLIENT,
      },
    };
    const base = await listen();
    const s = await open(base);
    expect(s.res.headers.get('content-type')).toBe('text/event-stream');
    expect(await s.next()).toEqual({ jsonrpc: '2.0', id: 7, result: { task: TASK } });
    await settle();
    // Already reflected in the opening Task (seq ≤ 2): never sent.
    hub.publish('t-9', { seq: 2, credentialGen: 0 }, status('TASK_STATE_WORKING'));
    hub.publish('t-9', { seq: 3, credentialGen: 0 }, status('TASK_STATE_COMPLETED'));
    expect(await s.next()).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: status('TASK_STATE_COMPLETED'),
    });
    expect(await s.next()).toBe('end');
    expect(forwarded[0]?.path).toBe('/v1/a2a/ingress/message/stream');
  });

  it('ends the stream when the task stops to ask its client (INPUT_REQUIRED), as the reference SDK does', async () => {
    coreReply = {
      ok: true,
      answer: {
        status: 200,
        headers: {},
        body: { jsonrpc: '2.0', id: 7, result: { task: TASK } },
        eventSeq: 2, credentialGen: 0, streamClient: STREAM_CLIENT,
      },
    };
    const base = await listen();
    const s = await open(base);
    await s.next();
    await settle();
    hub.publish('t-9', { seq: 3, credentialGen: 0 }, status('TASK_STATE_INPUT_REQUIRED'));
    expect(await s.next()).toEqual({ jsonrpc: '2.0', id: 7, result: status('TASK_STATE_INPUT_REQUIRED') });
    expect(await s.next()).toBe('end');
  });

  it('a stream that opens on a task already asking sends it, then ends', async () => {
    const asking = { ...TASK, status: { ...TASK.status, state: 'TASK_STATE_INPUT_REQUIRED' } };
    coreReply = {
      ok: true,
      answer: {
        status: 200,
        headers: {},
        body: { jsonrpc: '2.0', id: 7, result: { task: asking } },
        eventSeq: 4, credentialGen: 0, streamClient: STREAM_CLIENT,
      },
    };
    const base = await listen();
    const s = await open(base);
    expect(await s.next()).toEqual({ jsonrpc: '2.0', id: 7, result: { task: asking } });
    expect(await s.next()).toBe('end');
  });

  it('over REST: the bare StreamResponse, opening with Core’s answer, ending with the task', async () => {
    coreReply = { ok: true, answer: { status: 200, headers: {}, body: { task: TASK }, eventSeq: 2, credentialGen: 0, streamClient: STREAM_CLIENT } };
    const base = await listen();
    const res = await fetch(`${base}/a2a/rest/message:stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/a2a+json', authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0' },
      body: '{"message":{}}',
    });
    const reader = res.body?.getReader();
    let buffered = '';
    const next = async (): Promise<unknown> => {
      for (;;) {
        const at = buffered.indexOf('\n\n');
        if (at !== -1) {
          const frame = buffered.slice(0, at);
          buffered = buffered.slice(at + 2);
          if (frame.startsWith('data: ')) return JSON.parse(frame.slice(6));
          continue;
        }
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) return 'end';
        buffered += new TextDecoder().decode(chunk.value);
      }
    };
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await next()).toEqual({ task: TASK });
    await settle();
    hub.publish('t-9', { seq: 3, credentialGen: 0 }, status('TASK_STATE_COMPLETED'));
    expect(await next()).toEqual(status('TASK_STATE_COMPLETED'));
    expect(await next()).toBe('end');
    expect(forwarded[0]?.path).toBe('/v1/a2a/ingress/message/stream');
  });

  /** Hold Core's next answer; resolves once the call reached Core, with the way to let it go. */
  function holdCore(): { atCore: Promise<void>; release: () => void } {
    let release: () => void = () => undefined;
    coreHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const atCore = new Promise<void>((resolve) => {
      reachedCore = resolve;
    });
    return { atCore, release };
  }

  it('an event delivered while the call is at Core is replayed to its stream', async () => {
    coreReply = {
      ok: true,
      answer: {
        status: 200,
        headers: {},
        body: { jsonrpc: '2.0', id: 7, result: { task: TASK } },
        eventSeq: 0, credentialGen: 0, streamClient: STREAM_CLIENT,
      },
    };
    const held = holdCore();
    const base = await listen();
    const opening = open(base);
    await held.atCore;
    hub.publish('t-9', { seq: 1, credentialGen: 0 }, status('TASK_STATE_WORKING'));
    held.release();
    const s = await opening;
    await s.next();
    expect(await s.next()).toEqual({ jsonrpc: '2.0', id: 7, result: status('TASK_STATE_WORKING') });
    s.cancel();
  });

  it('with no streaming call on its way, nothing is kept', () => {
    hub.publish('t-9', { seq: 1, credentialGen: 0 }, status('TASK_STATE_WORKING'));
    expect(hub.bufferedBytes).toBe(0);
  });

  it('a client that leaves while Core answers opens no stream, and its slot is free again', async () => {
    await app.close();
    app = build(1000, {
      perIp: 1,
      maxLifetimeMs: 60_000,
      keepaliveMs: 60_000,
      maxBufferedBytes: 1 << 20,
    });
    coreReply = {
      ok: true,
      answer: {
        status: 200,
        headers: {},
        body: { jsonrpc: '2.0', id: 7, result: { task: TASK } },
        eventSeq: 0, credentialGen: 0, streamClient: STREAM_CLIENT,
      },
    };
    const base = await listen();
    const held = holdCore();
    const gone = new AbortController();
    const leaving = fetch(`${base}/a2a/v1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        'a2a-version': '1.0',
      },
      body: streamBody(),
      signal: gone.signal,
    }).catch(() => null);
    await held.atCore;
    gone.abort();
    await leaving;
    await settle();
    held.release();
    await settle();
    expect(hub.size).toBe(0);
    expect(hub.awaiting).toBe(0);
    // The one slot is free: the next streaming call opens.
    coreHold = null;
    const next = await open(base);
    expect(next.res.status).toBe(200);
    next.cancel();
  });

  it('a stream ended by its lifetime frees its slot and its place in the hub', async () => {
    await app.close();
    app = build(1000, {
      perIp: 1,
      maxLifetimeMs: 50,
      keepaliveMs: 60_000,
      maxBufferedBytes: 1 << 20,
    });
    coreReply = {
      ok: true,
      answer: {
        status: 200,
        headers: {},
        body: { jsonrpc: '2.0', id: 7, result: { task: TASK } },
        eventSeq: 0, credentialGen: 0, streamClient: STREAM_CLIENT,
      },
    };
    const base = await listen();
    const first = await open(base);
    await first.next();
    expect(await first.next()).toBe('end');
    expect(hub.size).toBe(0);
    const second = await open(base);
    expect(second.res.status).toBe(200);
    second.cancel();
  });

  describe('a client whose credential ended before Core’s answer got here (design §10; dual review CX-2)', () => {
    const fenced = () => hub.setFences([{ client: STREAM_CLIENT, before_gen: 1 }]);
    const answeredUnder = (task: object, credentialGen: number): CoreReply => ({
      ok: true,
      answer: {
        status: 200,
        headers: {},
        body: { jsonrpc: '2.0', id: 7, result: { task } },
        eventSeq: 2,
        credentialGen,
        streamClient: STREAM_CLIENT,
      },
    });
    const finished = {
      ...TASK,
      status: { ...TASK.status, state: 'TASK_STATE_COMPLETED' },
      artifacts: [{ artifactId: 'result', parts: [{ data: { secret: 'RESULT-SECRET' } }] }],
    };
    const asking = {
      ...TASK,
      status: {
        ...TASK.status,
        state: 'TASK_STATE_INPUT_REQUIRED',
        message: { messageId: 'q', role: 'ROLE_AGENT', parts: [{ text: 'QUESTION-SECRET' }] },
      },
    };

    it.each([
      ['a finished task, with its result', finished],
      ['a task asking its client, with its question', asking],
      ['a working task', TASK],
    ])('%s: 401 and nothing of it, the opening frame included; the slot is free again', async (_name, task) => {
      fenced();
      coreReply = answeredUnder(task, 0);
      const base = await listen();
      const res = await fetch(`${base}/a2a/v1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0' },
        body: streamBody(),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="dina-a2a"');
      expect(res.headers.get('content-type')).not.toBe('text/event-stream');
      const text = await res.text();
      expect(text).not.toContain('SECRET');
      expect(JSON.parse(text)).toEqual({ error: 'unauthenticated' });
      expect([hub.size, hub.awaiting]).toEqual([0, 0]);
    });

    it('over REST the same: 401 in REST’s error shape, and nothing of the task', async () => {
      fenced();
      coreReply = {
        ok: true,
        answer: { status: 200, headers: {}, body: { task: finished }, eventSeq: 2, credentialGen: 0, streamClient: STREAM_CLIENT },
      };
      const base = await listen();
      const res = await fetch(`${base}/a2a/rest/message:stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/a2a+json', authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0' },
        body: '{"message":{}}',
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="dina-a2a"');
      const text = await res.text();
      expect(text).not.toContain('SECRET');
      expect(JSON.parse(text)).toEqual({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'unauthenticated' } });
    });

    it('the client under its new credential is let through, and its stream opens', async () => {
      fenced();
      coreReply = answeredUnder(TASK, 1);
      const s = await open(await listen());
      expect(s.res.status).toBe(200);
      expect(await s.next()).toEqual({ jsonrpc: '2.0', id: 7, result: { task: TASK } });
      await settle();
      expect(hub.size).toBe(1);
      s.cancel();
    });

    it('a Task answer that does not say whose credential it was answered under is not relayed: 503, nothing of it', async () => {
      coreReply = { ok: true, answer: { status: 200, headers: {}, body: { jsonrpc: '2.0', id: 7, result: { task: finished } }, eventSeq: 2 } };
      const base = await listen();
      const res = await fetch(`${base}/a2a/v1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0' },
        body: streamBody(),
      });
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain('SECRET');
      expect([hub.size, hub.awaiting]).toEqual([0, 0]);
    });
  });

  it('Core’s JSON-RPC error is the one event, and the stream ends', async () => {
    const error = {
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32004, message: 'Operation not supported' },
    };
    coreReply = { ok: true, answer: { status: 200, headers: {}, body: error } };
    const s = await open(await listen());
    expect(await s.next()).toEqual(error);
    expect(await s.next()).toBe('end');
  });

  it('a task already ended opens and ends its stream at once', async () => {
    const done = { ...TASK, status: { state: 'TASK_STATE_REJECTED' } };
    coreReply = {
      ok: true,
      answer: {
        status: 200,
        headers: {},
        body: { jsonrpc: '2.0', id: 7, result: { task: done } },
        eventSeq: 0, credentialGen: 0, streamClient: STREAM_CLIENT,
      },
    };
    const s = await open(await listen());
    expect((await s.next()) as object).toEqual({ jsonrpc: '2.0', id: 7, result: { task: done } });
    expect(await s.next()).toBe('end');
    expect(hub.size).toBe(0);
  });

  it('an HTTP refusal (no credential) stays plain HTTP, and frees the slot', async () => {
    await app.close();
    app = build(1000, {
      perIp: 1,
      maxLifetimeMs: 60_000,
      keepaliveMs: 60_000,
      maxBufferedBytes: 1 << 20,
    });
    coreReply = {
      ok: true,
      answer: {
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
        body: { error: 'unauthenticated' },
      },
    };
    const base = await listen();
    const refused = await open(base);
    expect(refused.res.status).toBe(401);
    expect(refused.res.headers.get('content-type')).toContain('application/json');
    // The one slot is free again: the next streaming call opens.
    coreReply = {
      ok: true,
      answer: {
        status: 200,
        headers: {},
        body: { jsonrpc: '2.0', id: 7, result: { task: TASK } },
        eventSeq: 0, credentialGen: 0, streamClient: STREAM_CLIENT,
      },
    };
    const next = await open(base);
    expect(next.res.status).toBe(200);
    next.cancel();
  });

  it('Core’s order to close ends the stream with nothing more sent', async () => {
    coreReply = {
      ok: true,
      answer: {
        status: 200,
        headers: {},
        body: { jsonrpc: '2.0', id: 7, result: { task: TASK } },
        eventSeq: 0, credentialGen: 0, streamClient: STREAM_CLIENT,
      },
    };
    const s = await open(await listen());
    await s.next();
    await settle();
    hub.close('t-9');
    expect(await s.next()).toBe('end');
  });

  it('a client over its stream limit is refused before Core sees the call; a closed stream frees its slot', async () => {
    await app.close();
    app = build(1000, {
      perIp: 1,
      maxLifetimeMs: 60_000,
      keepaliveMs: 60_000,
      maxBufferedBytes: 1 << 20,
    });
    coreReply = {
      ok: true,
      answer: {
        status: 200,
        headers: {},
        body: { jsonrpc: '2.0', id: 7, result: { task: TASK } },
        eventSeq: 0, credentialGen: 0, streamClient: STREAM_CLIENT,
      },
    };
    const base = await listen();
    const first = await open(base);
    await first.next();
    const second = await open(base);
    expect(second.res.status).toBe(429);
    expect(forwarded).toHaveLength(1);
    first.cancel();
    await settle();
    expect(hub.size).toBe(0);
    const third = await open(base);
    expect(third.res.status).toBe(200);
    third.cancel();
  });
});

describe('the client address behind a proxy', () => {
  it('trusts only the hops it is told: an entry the client wrote cannot change its address', async () => {
    await app.close();
    app = buildGatewayServer({
      core: {
        forward: async () => coreReply,
        card: async () => cardReply,
        claimEvents: async () => ({ ok: true, claim: { items: [], closed: [], fenced: [] } }),
        ackEvents: async (acks) => ({ ok: true, applied: acks.length }),
      },
      limiter: new EdgeLimiter(1, () => clock),
      logger: pino({ level: 'silent' }),
      cardCacheMs: 30_000,
      trustProxy: 1,
      hub: new StreamHub({
        maxStreams: 4,
        bufferMs: 1_000,
        bufferEvents: 4,
        bufferTasks: 4,
        bufferBytes: 1 << 20,
      }),
      streams: { perIp: 20, maxLifetimeMs: 60_000, keepaliveMs: 60_000, maxBufferedBytes: 1 << 20 },
      now: () => clock,
    });
    const body = '{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{}}';
    // The terminator appends what it saw (203.0.113.9); the client wrote the rest.
    const first = await rpc(body, { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
    const forged = await rpc(body, { 'x-forwarded-for': '7.7.7.7, 203.0.113.9' });
    expect(first.statusCode).toBe(200);
    expect(forged.statusCode).toBe(429);
  });
});
