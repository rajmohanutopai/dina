/**
 * The gateway at its edges (design §4.1, §6.6, §7.5; notes M2, M3): what it
 * answers itself and never forwards, what of Core's answer reaches the
 * client through the real Core link, how a stream keeps alive and ends a
 * client too far behind, and how webhook POSTs meet the outbound policy
 * through the delivery pump. Core is faked only at the network edge.
 */

import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { Writable } from 'node:stream';

import { pino } from 'pino';

import {
  A2A_CORE_ANSWER_HEADER,
  A2A_CREDENTIAL_GEN_HEADER,
  A2A_EVENT_SEQ_HEADER,
  A2A_STREAM_CLIENT_HEADER,
  type DeliveryAck,
  type DeliveryItem,
} from '@dina/a2a';
import { deriveDIDKey, getPublicKey, parsePushConfigInput } from '@dina/core';
import { createA2AHostTransport } from '@dina/net-node';

import { ConfigError, loadConfig } from '../src/config';
import { createCoreLink, type CoreLink, type CoreReply } from '../src/core_link';
import { DeliveryPump } from '../src/delivery_pump';
import { EdgeLimiter } from '../src/edge_limit';
import { buildGatewayServer, type StreamLimits } from '../src/server';
import { StreamHub } from '../src/stream_hub';

import type { A2AHostTransport, GatewayEnvelope } from '@dina/core';
import type { FastifyInstance } from 'fastify';

/** The opaque client key Core sends with a stream's opening answer. */
const STREAM_CLIENT = 'c'.repeat(32);

const TOKEN = `dina_a2a_${'Q'.repeat(43)}`;

function sinkLogger(lines: string[]) {
  return pino(
    { level: 'debug' },
    new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    }),
  );
}

function newHub(): StreamHub {
  return new StreamHub({ maxStreams: 8, bufferMs: 60_000, bufferEvents: 16, bufferTasks: 16, bufferBytes: 1 << 20 });
}

const STREAMS: StreamLimits = { perIp: 4, maxLifetimeMs: 60_000, keepaliveMs: 60_000, maxBufferedBytes: 1 << 20 };

/** A gateway over a recording Core link. */
function gatewayWith(core: CoreLink, hub = newHub(), streams: StreamLimits = STREAMS): FastifyInstance {
  return buildGatewayServer({
    core,
    limiter: new EdgeLimiter(10_000),
    logger: pino({ level: 'silent' }),
    cardCacheMs: 0,
    trustProxy: 0,
    hub,
    streams,
  });
}

function recordingCore(reply: () => CoreReply, forwarded: { path: string; envelope: GatewayEnvelope }[]): CoreLink {
  return {
    async forward(path, envelope) {
      forwarded.push({ path, envelope });
      return reply();
    },
    async card() {
      return { ok: false, status: 503 };
    },
    async ucpWebhook() {
      return { ok: false, status: 503 };
    },
    async ucpOauthCallback() {
      return { ok: false, status: 503 };
    },
    async claimEvents() {
      return { ok: true, claim: { items: [], closed: [], fenced: [] } };
    },
    async ackEvents(acks) {
      return { ok: true, applied: acks.length };
    },
  };
}

const rpc = (app: FastifyInstance, payload: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/a2a/v1',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0', ...headers },
    payload,
  });

describe('configuration (notes M3: the client’s address behind a proxy)', () => {
  // Plan C5
  it.each(['true', '1.5', '-1', '9', 'all'])('refuses DINA_A2A_GATEWAY_TRUST_PROXY=%s at boot', (value) => {
    expect(() => loadConfig({ DINA_A2A_GATEWAY_KEY_DIR: '/keys', DINA_A2A_GATEWAY_TRUST_PROXY: value })).toThrow(ConfigError);
  });

  // Plan C5
  it('takes a whole hop count, and trusts none by default', () => {
    expect(loadConfig({ DINA_A2A_GATEWAY_KEY_DIR: '/keys' }).network.trustProxy).toBe(0);
    expect(loadConfig({ DINA_A2A_GATEWAY_KEY_DIR: '/keys', DINA_A2A_GATEWAY_TRUST_PROXY: '1' }).network.trustProxy).toBe(1);
  });
});

describe('answered at the gateway, never forwarded (notes M2; §4.1 allowlist)', () => {
  let forwarded: { path: string; envelope: GatewayEnvelope }[];
  let app: FastifyInstance;
  beforeEach(() => {
    forwarded = [];
    app = gatewayWith(
      recordingCore(() => ({ ok: true, answer: { status: 200, headers: {}, body: { jsonrpc: '2.0', id: 1, result: {} } } }), forwarded),
    );
  });
  afterEach(async () => {
    await app.close();
  });

  // Plan C15
  it('a JSON-RPC batch (an array) is answered -32600 and nothing reaches Core', async () => {
    const res = await rpc(app, '[{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{}}]');
    expect(res.statusCode).toBe(200);
    expect((res.json() as { error: { code: number } }).error.code).toBe(-32600);
    expect(forwarded).toEqual([]);
  });

  // Plan C16
  it('a __proto__ member is refused as forbidden_member, and nothing reaches Core', async () => {
    const res = await rpc(app, '{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{"__proto__":{"admin":true}}}');
    const error = (res.json() as { error: { code: number; data?: { reason: string }[] } }).error;
    expect(error.code).toBe(-32600);
    expect(JSON.stringify(error)).toContain('forbidden_member');
    expect(forwarded).toEqual([]);
  });

  // Plan C17
  it.each([
    ['GET', '/a2a/v1'],
    ['POST', '/v1/a2a/ingress/message'],
    ['POST', '/v1/a2a/ingress/tasks/list'],
    ['POST', '/v1/workflow/tasks/claim'],
    ['GET', '/v1/a2a/card'],
  ] as const)('%s %s is a gateway 404, and nothing reaches Core', async (method, url) => {
    const res = await app.inject({
      method,
      url,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      ...(method === 'POST' ? { payload: '{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{}}' } : {}),
    });
    expect(res.statusCode).toBe(404);
    expect(forwarded).toEqual([]);
  });

  // Extra X-15
  it.each([
    ['an unknown extension', { 'a2a-extensions': 'https://unknown.example/ext/v9' }],
    ['no extension at all', {}],
  ])('a call naming %s is served as any other; the gateway raises no -32008', async (_name, headers) => {
    const res = await rpc(app, '{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{}}', headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(forwarded).toHaveLength(1);
  });
});

describe('through the real Core link: what of Core’s answer reaches the client (notes M2, M3)', () => {
  let core: Server;
  let base: string;
  let app: FastifyInstance;
  let answerHeaders: Record<string, string>;
  let answerBody: unknown;

  beforeAll(async () => {
    core = createHttpServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', ...answerHeaders });
        res.end(JSON.stringify(answerBody));
      });
    });
    await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', () => resolve()));
    const port = (core.address() as { port: number }).port;
    const seed = new Uint8Array(randomBytes(32));
    const link = createCoreLink({ baseUrl: `http://127.0.0.1:${port}`, key: { seed, did: deriveDIDKey(getPublicKey(seed)) }, timeoutMs: 5_000 });
    app = gatewayWith(link);
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await app.close();
    await new Promise((resolve) => core.close(resolve));
  });

  const INTERNAL = {
    [A2A_CORE_ANSWER_HEADER]: '1',
    [A2A_EVENT_SEQ_HEADER]: '7',
    [A2A_CREDENTIAL_GEN_HEADER]: '3',
    [A2A_STREAM_CLIENT_HEADER]: STREAM_CLIENT,
    'set-cookie': 'session=core-secret; HttpOnly',
    'x-dina-internal': 'core-only',
    'www-authenticate': 'Bearer realm="dina-a2a"',
    'retry-after': '60',
  };

  // Plan C22
  it('a plain answer carries Core’s challenge and slow-down headers, and never its cursor, credential generation, client key, cookies, internal headers or answer marker', async () => {
    answerHeaders = INTERNAL;
    answerBody = { jsonrpc: '2.0', id: 1, result: { tasks: [] } };
    const res = await fetch(`${base}/a2a/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0' },
      body: '{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{}}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answerBody);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="dina-a2a"');
    expect(res.headers.get('retry-after')).toBe('60');
    for (const name of [A2A_CORE_ANSWER_HEADER, A2A_EVENT_SEQ_HEADER, A2A_CREDENTIAL_GEN_HEADER, A2A_STREAM_CLIENT_HEADER, 'set-cookie', 'x-dina-internal']) {
      expect(res.headers.get(name)).toBeNull();
    }
  });

  // Plan C22
  it('a stream’s opening answer carries no cursor, credential generation, client key, cookies, internal headers or answer marker either', async () => {
    answerHeaders = INTERNAL;
    answerBody = { jsonrpc: '2.0', id: 2, result: { task: { id: 't-1', status: { state: 'TASK_STATE_COMPLETED' } } } };
    const res = await fetch(`${base}/a2a/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0' },
      body: '{"jsonrpc":"2.0","id":2,"method":"SubscribeToTask","params":{"id":"t-1"}}',
    });
    const text = await res.text();
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(text).toContain('TASK_STATE_COMPLETED');
    for (const name of [A2A_CORE_ANSWER_HEADER, A2A_EVENT_SEQ_HEADER, A2A_CREDENTIAL_GEN_HEADER, A2A_STREAM_CLIENT_HEADER, 'set-cookie', 'x-dina-internal']) {
      expect(res.headers.get(name)).toBeNull();
    }
    expect(text).not.toContain('core-secret');
  });

  // Plan C22
  it('an answer Core did not write for the client is 503, with none of its headers', async () => {
    answerHeaders = { 'set-cookie': 'session=core-secret', 'retry-after': '60' };
    answerBody = { error: 'rate_limited' };
    const res = await fetch(`${base}/a2a/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0' },
      body: '{"jsonrpc":"2.0","id":3,"method":"ListTasks","params":{}}',
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('retry-after')).toBeNull();
  });
});

describe('streams over a real socket (gateway stream limits)', () => {
  const TASK = { id: 't-9', contextId: 'c-9', status: { state: 'TASK_STATE_WORKING', timestamp: '2027-01-15T08:00:00.000Z' } };
  const opening: CoreReply = {
    ok: true,
    answer: { status: 200, headers: {}, body: { jsonrpc: '2.0', id: 7, result: { task: TASK } }, eventSeq: 0, credentialGen: 0, streamClient: STREAM_CLIENT },
  };
  const streamBody = '{"jsonrpc":"2.0","id":7,"method":"SendStreamingMessage","params":{"message":{"messageId":"m","role":"ROLE_USER","parts":[]}}}';
  let app: FastifyInstance;
  let hub: StreamHub;

  afterEach(async () => {
    await app.close();
  });

  async function listen(streams: StreamLimits): Promise<number> {
    hub = newHub();
    app = gatewayWith(recordingCore(() => opening, []), hub, streams);
    await app.listen({ port: 0, host: '127.0.0.1' });
    return (app.server.address() as { port: number }).port;
  }

  const until = async (cond: () => boolean, ms = 5_000): Promise<void> => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('condition never held');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  // Plan C184
  it('an idle stream sends keepalive comments, and stays open', async () => {
    const port = await listen({ perIp: 1, maxLifetimeMs: 60_000, keepaliveMs: 25, maxBufferedBytes: 1 << 20 });
    let received = '';
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/a2a/v1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0' },
    });
    req.on('response', (res) => res.on('data', (chunk: Buffer) => (received += chunk.toString())));
    req.end(streamBody);
    await until(() => (received.match(/: keepalive\n\n/g) ?? []).length >= 2);
    expect(received.startsWith('data: ')).toBe(true);
    expect(hub.size).toBe(1);
    req.destroy();
    await until(() => hub.size === 0);
  });

  // Plan C184
  it('a client too far behind has its stream ended, and its slot is free again; a client that reads keeps its stream', async () => {
    const port = await listen({ perIp: 1, maxLifetimeMs: 60_000, keepaliveMs: 60_000, maxBufferedBytes: 64 * 1024 });
    const event = (seq: number) => ({
      statusUpdate: { taskId: 't-9', contextId: 'c-9', status: { state: 'TASK_STATE_WORKING' }, metadata: { seq, pad: 'x'.repeat(4 * 1024) } },
    });
    const open = (paused: boolean) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/a2a/v1',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0' },
      });
      let bytes = 0;
      req.on('response', (res) => (paused ? res.pause() : res.on('data', (chunk: Buffer) => (bytes += chunk.length))));
      req.end(streamBody);
      return { req, read: () => bytes };
    };
    // A client that reads: 128 small events, and its stream stays.
    const reader = open(false);
    await until(() => hub.size === 1);
    for (let seq = 1; seq <= 128; seq += 1) {
      hub.publish('t-9', { seq, credentialGen: 0 }, event(seq));
      await new Promise((resolve) => setImmediate(resolve));
    }
    await until(() => reader.read() > 128 * 4 * 1024);
    expect(hub.size).toBe(1);
    reader.req.destroy();
    await until(() => hub.size === 0);
    // A client that never reads: its bytes pile up at the gateway until it is cut.
    const stalled = open(true);
    await until(() => hub.size === 1);
    for (let seq = 129; seq <= 8_192 && hub.size > 0; seq += 1) {
      hub.publish('t-9', { seq, credentialGen: 0 }, event(seq));
      await new Promise((resolve) => setImmediate(resolve));
    }
    await until(() => hub.size === 0);
    // The slot is free: a new stream from the same address opens.
    const next = await fetch(`http://127.0.0.1:${port}/a2a/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0' },
      body: streamBody,
    });
    expect(next.status).toBe(200);
    await next.body?.cancel();
    stalled.req.destroy();
  });
});

describe('webhook POSTs through the pump meet the outbound policy (§6.6, §12 M3 "SSRF vectors refuse")', () => {
  let tcp: TcpServer;
  let port: number;
  let connections: number;

  beforeAll(async () => {
    connections = 0;
    tcp = createTcpServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', () => resolve()));
    port = (tcp.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => tcp.close(resolve));
  });

  function pumpOver(items: DeliveryItem[], transport: A2AHostTransport, lines: string[] = []) {
    const acks: DeliveryAck[] = [];
    let given = false;
    const core: CoreLink = {
      async forward() {
        return { ok: false, status: 503 };
      },
      async card() {
        return { ok: false, status: 503 };
      },
      async ucpWebhook() {
        return { ok: false, status: 503 };
      },
      async ucpOauthCallback() {
        return { ok: false, status: 503 };
      },
      async claimEvents() {
        if (given) return { ok: true, claim: { items: [], closed: [], fenced: [] } };
        given = true;
        return { ok: true, claim: { items, closed: [], fenced: [] } };
      },
      async ackEvents(sent) {
        acks.push(...sent);
        return { ok: true, applied: sent.length };
      },
    };
    const pump = new DeliveryPump({ core, hub: newHub(), transport, logger: sinkLogger(lines), intervalMs: 10, webhookConcurrency: 4, claimLimit: 100 });
    return { pump, acks };
  }

  const hook = (id: number, url: string): DeliveryItem => ({
    id,
    claim_id: `claim-${id}`,
    target: 'webhook',
    task_id: `task-${id}`,
    seq: 1,
    event: { statusUpdate: { taskId: `task-${id}`, contextId: 'c', status: { state: 'TASK_STATE_WORKING' } } },
    webhook: { url, headers: { authorization: 'Bearer hook-secret', 'x-a2a-notification-token': 'tok-secret' } },
  });

  // Plan C211
  it.each([
    ['loopback', ['127.0.0.1']],
    ['IPv6 loopback', ['::1']],
    ['IPv4-mapped loopback', ['::ffff:127.0.0.1']],
    ['hex-mapped loopback', ['::ffff:7f00:1']],
    ['IPv4-compatible loopback', ['::127.0.0.1']],
    ['cloud metadata', ['169.254.169.254']],
    ['RFC 1918 10/8', ['10.0.0.1']],
    ['RFC 1918 172.16/12', ['172.16.5.4']],
    ['RFC 1918 192.168/16', ['192.168.1.1']],
    ['CGNAT', ['100.64.0.1']],
    ['the unspecified address', ['0.0.0.0']],
    ['IPv6 unique local', ['fd00::1']],
    ['IPv6 link-local', ['fe80::1']],
    ['NAT64 of loopback', ['64:ff9b::7f00:1']],
    ['a mixed answer', ['203.0.113.5', '127.0.0.1']],
  ])('a name that resolves to %s gets a final failure and no connection', async (_name, addresses) => {
    const before = connections;
    const transport = createA2AHostTransport({ resolve: async () => addresses });
    const { pump, acks } = pumpOver([hook(1, `https://hooks.example.test:${port}/a2a`)], transport);
    await pump.turn();
    await pump.stop();
    expect(acks).toEqual([{ id: 1, claim_id: 'claim-1', outcome: 'failed' }]);
    expect(connections).toBe(before);
  });

  // Plan C212
  it('a push URL naming localhost is accepted when set, and refused when the POST would go', async () => {
    const url = `https://localhost:${port}/a2a`;
    expect(parsePushConfigInput({ url })).toEqual({ ok: true, config: { url } });
    const before = connections;
    const { pump, acks } = pumpOver([hook(2, url)], createA2AHostTransport());
    await pump.turn();
    await pump.stop();
    expect(acks).toEqual([{ id: 2, claim_id: 'claim-2', outcome: 'failed' }]);
    expect(connections).toBe(before);
  });

  // Plan C239
  it('the pump’s logs carry counts and statuses only: never a URL, a token, an event or a task id', async () => {
    const lines: string[] = [];
    const sse: DeliveryItem = {
      id: 9,
      claim_id: 'claim-9',
      target: 'sse',
      task_id: 'task-sse-9',
      seq: 1,
      event: { statusUpdate: { taskId: 'task-sse-9', contextId: 'c', status: { state: 'TASK_STATE_WORKING' } } },
      credential_gen: 0,
    };
    const { pump } = pumpOver([hook(3, 'https://hooks.example.test/a2a-secret-path'), sse], async () => ({ ok: true, status: 500, body: '', connectedAddress: '203.0.113.5' }), lines);
    await pump.turn();
    await pump.stop();
    // A Core that refuses the claim and the report: the warnings say so, by status.
    const refusing = new DeliveryPump({
      core: {
        async forward() {
          return { ok: false, status: 503 };
        },
        async card() {
          return { ok: false, status: 503 };
        },
        async ucpWebhook() {
          return { ok: false, status: 503 };
        },
        async ucpOauthCallback() {
          return { ok: false, status: 503 };
        },
        async claimEvents() {
          return { ok: false, status: 503 };
        },
        async ackEvents() {
          return { ok: false, status: 'unreachable' };
        },
      },
      hub: newHub(),
      transport: async () => ({ ok: false, error: 'dns_failed', sent: false }),
      logger: sinkLogger(lines),
      intervalMs: 10,
      webhookConcurrency: 1,
      claimLimit: 1,
    });
    await refusing.turn();
    // A Core that takes the claim but refuses the report of a finished webhook POST.
    const unreported = new DeliveryPump({
      core: {
        async forward() {
          return { ok: false, status: 503 };
        },
        async card() {
          return { ok: false, status: 503 };
        },
        async ucpWebhook() {
          return { ok: false, status: 503 };
        },
        async ucpOauthCallback() {
          return { ok: false, status: 503 };
        },
        async claimEvents() {
          return { ok: true, claim: { items: [hook(4, 'https://hooks.example.test/a2a-secret-path')], closed: [], fenced: [] } };
        },
        async ackEvents() {
          return { ok: false, status: 503 };
        },
      },
      hub: newHub(),
      transport: async () => ({ ok: true, status: 202, body: '', connectedAddress: '203.0.113.5' }),
      logger: sinkLogger(lines),
      intervalMs: 10,
      webhookConcurrency: 1,
      claimLimit: 1,
    });
    await unreported.turn();
    await unreported.stop();
    // Each pump logged its line, by counts and statuses.
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const fields = (msg: string) => logged.filter((l) => l.msg === msg).map(({ level: _l, time: _t, pid: _p, hostname: _h, msg: _m, ...rest }) => rest);
    expect(fields('a2a delivery turn')).toEqual([
      { streamed: 1, webhooks: 1, closed: 0, fenced: 0 },
      { streamed: 0, webhooks: 1, closed: 0, fenced: 0 },
    ]);
    expect(fields('a2a delivery claim refused')).toEqual([{ core_status: 503 }]);
    expect(fields('a2a delivery report refused')).toEqual([{ core_status: 503, count: 1 }]);
    const all = lines.join('\n');
    for (const secret of ['hooks.example.test', 'a2a-secret-path', 'hook-secret', 'tok-secret', 'task-3', 'task-4', 'task-sse-9', 'statusUpdate', 'TASK_STATE_WORKING']) {
      expect(all).not.toContain(secret);
    }
  });
});
