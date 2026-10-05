/**
 * M4 at the gateway's public surface (design §5.1, §7.5, §7.7; notes M4
 * steps 1–3): the rules the plan's area D listed with no test of their
 * own. The gateway passes a half-signed request through as it came and
 * leaves the verdict to Core; a REST stream ends when its task asks, and a
 * REST subscribe on a task already asking sends it and ends; a wrong method
 * on :subscribe names both methods served; Core's retry-after reaches a
 * REST client through the real Core link.
 */

import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { pino } from 'pino';

import { deriveDIDKey, getPublicKey } from '@dina/core';

import { createCoreLink, type CoreLink, type CoreReply } from '../src/core_link';
import { EdgeLimiter } from '../src/edge_limit';
import { buildGatewayServer } from '../src/server';
import { StreamHub } from '../src/stream_hub';

import type { GatewayEnvelope } from '@dina/core';
import type { FastifyInstance } from 'fastify';

/** The opaque client key Core sends with a stream's opening answer. */
const STREAM_CLIENT = 'c'.repeat(32);

const TOKEN = `dina_a2a_${'M'.repeat(43)}`;
const STREAMS = { perIp: 20, maxLifetimeMs: 60_000, keepaliveMs: 60_000, maxBufferedBytes: 1 << 20 };

const newHub = () => new StreamHub({ maxStreams: 4, bufferMs: 60_000, bufferEvents: 16, bufferTasks: 16, bufferBytes: 1 << 20 });

let forwarded: { path: string; envelope: GatewayEnvelope }[];
let coreReply: CoreReply;
let hub: StreamHub;
let app: FastifyInstance;

/** Core as a recording link: what the gateway forwards, and the answer the test sets. */
function recordingLink(): CoreLink {
  return {
    async forward(path, envelope) {
      forwarded.push({ path, envelope });
      return coreReply;
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

function gatewayWith(core: CoreLink): FastifyInstance {
  hub = newHub();
  return buildGatewayServer({
    core,
    limiter: new EdgeLimiter(1_000),
    logger: pino({ level: 'silent' }),
    cardCacheMs: 0,
    trustProxy: 0,
    hub,
    streams: STREAMS,
  });
}

beforeEach(() => {
  forwarded = [];
  coreReply = { ok: true, answer: { status: 200, headers: {}, body: { tasks: [] } } };
  app = gatewayWith(recordingLink());
});
afterEach(async () => {
  await app.close();
});

/** Read a stream's SSE frames, one `data:` payload at a time, or `end`. */
function frames(res: Response): () => Promise<unknown> {
  const reader = res.body?.getReader();
  let buffered = '';
  return async () => {
    for (;;) {
      const at = buffered.indexOf('\n\n');
      if (at !== -1) {
        const frame = buffered.slice(0, at);
        buffered = buffered.slice(at + 2);
        if (frame.startsWith('data: ')) return JSON.parse(frame.slice(6)) as unknown;
        continue;
      }
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done) return 'end';
      buffered += new TextDecoder().decode(chunk.value);
    }
  };
}

/** Wait until the hub holds the stream just opened (no clock: a few turns of the event loop). */
async function streamOpen(): Promise<void> {
  for (let turn = 0; hub.size === 0 && turn < 1_000; turn++) await new Promise((resolve) => setImmediate(resolve));
  expect(hub.size).toBe(1);
}

async function listen(): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
}

describe('a half-signed request (§5.1: the gateway decides nothing)', () => {
  // Plan D41
  it.each([
    ['JSON-RPC', 'POST', '/a2a/v1', '{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{}}'],
    ['REST', 'GET', '/a2a/rest/tasks', undefined],
  ] as const)('over %s, forwards X-DID alone beside the bearer as it came, for Core to refuse', async (_binding, method, url, payload) => {
    const res = await app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'a2a-version': '1.0',
        'x-did': 'did:key:z6MkHalfSigned',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload }),
    });
    expect(res.statusCode).toBe(200);
    expect(forwarded).toHaveLength(1);
    // Both credentials go to Core, the signature as empty as it came: Core refuses the pair.
    expect(forwarded[0]?.envelope.client_auth).toEqual({
      authorization: `Bearer ${TOKEN}`,
      did_signature: { did: 'did:key:z6MkHalfSigned', timestamp: '', nonce: '', signature: '' },
    });
  });
});

describe('REST streams end where the task asks (§7.7, notes M4 step 2)', () => {
  const TASK = {
    id: 't-9',
    contextId: 'c-9',
    status: { state: 'TASK_STATE_WORKING', timestamp: '2027-01-15T08:00:00.000Z' },
  };
  const status = (state: string) => ({ statusUpdate: { taskId: 't-9', contextId: 'c-9', status: { state } } });
  const restHeaders = { authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0' };

  // Plan D90
  it('a REST :stream sends the INPUT_REQUIRED event bare, then ends', async () => {
    coreReply = { ok: true, answer: { status: 200, headers: {}, body: { task: TASK }, eventSeq: 2, credentialGen: 0, streamClient: STREAM_CLIENT } };
    const base = await listen();
    const res = await fetch(`${base}/a2a/rest/message:stream`, {
      method: 'POST',
      headers: { ...restHeaders, 'content-type': 'application/a2a+json' },
      body: '{"message":{}}',
    });
    const next = frames(res);
    expect(await next()).toEqual({ task: TASK });
    await streamOpen();
    hub.publish('t-9', { seq: 3, credentialGen: 0 }, status('TASK_STATE_INPUT_REQUIRED'));
    expect(await next()).toEqual(status('TASK_STATE_INPUT_REQUIRED'));
    expect(await next()).toBe('end');
    expect(forwarded[0]?.path).toBe('/v1/a2a/ingress/message/stream');
  });

  // Plan D90
  it.each(['GET', 'POST'])('a REST %s :subscribe on a task already asking sends it, then ends', async (method) => {
    const asking = { ...TASK, status: { ...TASK.status, state: 'TASK_STATE_INPUT_REQUIRED' } };
    coreReply = { ok: true, answer: { status: 200, headers: {}, body: { task: asking }, eventSeq: 4, credentialGen: 0, streamClient: STREAM_CLIENT } };
    const base = await listen();
    const res = await fetch(`${base}/a2a/rest/tasks/t-9:subscribe`, { method, headers: restHeaders });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const next = frames(res);
    expect(await next()).toEqual({ task: asking });
    expect(await next()).toBe('end');
    expect(forwarded[0]?.path).toBe('/v1/a2a/ingress/tasks/t-9/subscribe');
    expect(hub.size).toBe(0);
  });
});

describe('the methods :subscribe is served by (A2A §11, notes M4 step 3)', () => {
  // Plan D144
  it.each(['PUT', 'DELETE', 'PATCH'] as const)('answers %s with 405, naming GET and POST', async (method) => {
    const res = await app.inject({ method, url: '/a2a/rest/tasks/t-1:subscribe', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(405);
    expect(
      String(res.headers.allow)
        .split(',')
        .map((m) => m.trim())
        .sort(),
    ).toEqual(['GET', 'POST']);
    expect(forwarded).toEqual([]);
  });
});

describe('Core’s slow-down reaches a REST client (notes M4 step 3: the headers stay)', () => {
  /** What Core sends the client: a google.rpc.Status with the Dina ErrorInfo detail. */
  const CORE_BODY = {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'rate_limited',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'rate_limited', domain: 'dinakernel.com' }],
    },
  };
  let core: Server;
  let coreUrl: string;

  beforeEach(async () => {
    // Core at the network edge: it answers the client 429 with its own wait.
    core = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(429, { 'content-type': 'application/json', 'x-dina-a2a-answer': '1', 'retry-after': '17' });
        res.end(JSON.stringify(CORE_BODY));
      });
    });
    await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', () => resolve()));
    coreUrl = `http://127.0.0.1:${(core.address() as { port: number }).port}`;
    await app.close();
    const seed = new Uint8Array(randomBytes(32));
    app = gatewayWith(createCoreLink({ baseUrl: coreUrl, key: { seed, did: deriveDIDKey(getPublicKey(seed)) }, timeoutMs: 2_000 }));
  });
  afterEach(async () => {
    await new Promise((resolve) => core.close(resolve));
  });

  // Plan D169
  it('relays Core’s 429, its retry-after and its google.rpc.Status, as Core sent them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/a2a/rest/message:send',
      headers: { authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0', 'content-type': 'application/a2a+json' },
      payload: '{"message":{}}',
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('17');
    expect(res.headers['content-type']).toContain('application/a2a+json');
    expect(res.json()).toEqual(CORE_BODY);
  });
});
