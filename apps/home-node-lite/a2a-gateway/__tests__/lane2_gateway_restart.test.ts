/**
 * The gateway keeps no durable state (design §4.1, §7.5 "state survives
 * gateway restarts; SSE recovers via GetTask"): an outside client → the
 * gateway → signed HTTP → Core's real router over a real SQLCipher
 * database. A gateway that stops loses only its open streams; a new one
 * over the same Core serves the same tasks, and a client that subscribes
 * again gets the story GetTask tells, nothing lost and nothing twice.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { pino } from 'pino';

import {
  A2AStore,
  IDENTITY_MIGRATIONS,
  SQLiteServiceConfigRepository,
  SQLiteWorkflowRepository,
  WorkflowService,
  a2aWorkflowHooks,
  admitInboundClaim,
  applyMigrations,
  bindRunner,
  configureRateLimiter,
  createA2AClient,
  createCoreRouter,
  deriveDIDKey,
  getA2ARuntime,
  getPublicKey,
  installA2A,
  registerService,
  resetMiddlewareState,
  setNodeDID,
  setServiceConfigDurable,
  setServiceConfigRepository,
  setWorkflowService,
  type CoreRequest,
  type CoreRouter,
} from '@dina/core';
import { registerDevice, resetDeviceRegistry } from '@dina/core/devices';
import { SQLiteServiceGrantRepository, setServiceGrantRepository } from '@dina/core/storage';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { createCoreLink } from '../src/core_link';
import { DeliveryPump } from '../src/delivery_pump';
import { EdgeLimiter } from '../src/edge_limit';
import { buildGatewayServer } from '../src/server';
import { StreamHub } from '../src/stream_hub';

import type { FastifyInstance } from 'fastify';

const ETA_PARAMS = { type: 'object', required: ['route_id'], properties: { route_id: { type: 'string', minLength: 1 } } };
const ETA_RESULT = { type: 'object', required: ['eta_minutes'], properties: { eta_minutes: { type: 'integer' } } };

let dir: string;
let db: NodeSQLiteAdapter;
let repo: SQLiteWorkflowRepository;
let workflow: WorkflowService;
let router: CoreRouter;
let coreHttp: Server;
let coreUrl: string;
let key: { seed: Uint8Array; did: string };
let token: string;
let runnerDid: string;

function serveCore(r: CoreRouter): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', 'http://core');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      const coreReq: CoreRequest = {
        method: (req.method ?? 'GET') as CoreRequest['method'],
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers,
        body: raw.length === 0 ? undefined : (JSON.parse(raw.toString('utf8')) as unknown),
        rawBody: new Uint8Array(raw),
        params: {},
      };
      void r.handle(coreReq).then((out) => {
        res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) });
        res.end(out.body === undefined ? '' : JSON.stringify(out.body));
      });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** One gateway process: its server on a real socket, its hub and its delivery loop. */
async function startGateway(): Promise<{ app: FastifyInstance; base: string; pump: DeliveryPump; stop: () => Promise<void> }> {
  const hub = new StreamHub({ maxStreams: 10, bufferMs: 60_000, bufferEvents: 16, bufferTasks: 64, bufferBytes: 1 << 20 });
  const link = createCoreLink({ baseUrl: coreUrl, key, timeoutMs: 5_000 });
  const app = buildGatewayServer({
    core: link,
    limiter: new EdgeLimiter(1_000),
    logger: pino({ level: 'silent' }),
    cardCacheMs: 0,
    trustProxy: 0,
    hub,
    streams: { perIp: 10, maxLifetimeMs: 60_000, keepaliveMs: 60_000, maxBufferedBytes: 1 << 20 },
  });
  const pump = new DeliveryPump({
    core: link,
    hub,
    transport: async () => ({ ok: true, status: 202, body: '', connectedAddress: '203.0.113.5' }),
    logger: pino({ level: 'silent' }),
    intervalMs: 10,
    webhookConcurrency: 4,
    claimLimit: 100,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return {
    app,
    base,
    pump,
    // The process going down: the loop stops, every open stream ends with it, the server closes.
    stop: async () => {
      await pump.stop();
      hub.closeAll();
      await app.close();
    },
  };
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'a2a-gw-restart-'));
  db = new NodeSQLiteAdapter({ path: path.join(dir, 'identity.sqlite'), passphraseHex: 'ac'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  installA2A({ store: new A2AStore(db) });
  repo = new SQLiteWorkflowRepository(db);
  workflow = new WorkflowService({ repository: repo, ...a2aWorkflowHooks(getA2ARuntime), responseBridgeSender: async () => undefined });
  setWorkflowService(workflow);
  setServiceConfigRepository(new SQLiteServiceConfigRepository(db));
  setServiceGrantRepository(new SQLiteServiceGrantRepository(db));
  resetDeviceRegistry();
  runnerDid = registerDevice('Transit runner', 'z6MkGatewayRestartRunner', 'agent', 'runner').did;
  const store = getA2ARuntime()?.store;
  if (store === undefined) throw new Error('a2a runtime');
  bindRunner(store, { lane: 'transit', device_did: runnerDid }, Date.now());
  await setServiceConfigDurable(
    {
      isDiscoverable: true,
      discoverability: 'public',
      status: 'active',
      name: 'Bus 42',
      capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'auto', category: 'transit' } },
      capabilitySchemas: { eta_query: { params: ETA_PARAMS, result: ETA_RESULT, schemaHash: 'h' } },
    },
    'bus',
  );
  const client = createA2AClient(store, { display_name: 'Outside agent' }, Date.now());
  if (!client.ok) throw new Error(client.reason);
  token = client.token;
  const seed = new Uint8Array(randomBytes(32));
  key = { seed, did: deriveDIDKey(getPublicKey(seed)) };
  registerService(key.did, 'gateway');
  configureRateLimiter({ maxRequests: 50, windowSeconds: 60, perDidMax: { [key.did]: Number.POSITIVE_INFINITY } });
  setNodeDID('did:plc:ewvi7nxzyoun6zhxrhs64oiz');
  router = createCoreRouter();
  coreHttp = await serveCore(router);
  coreUrl = `http://127.0.0.1:${(coreHttp.address() as { port: number }).port}`;
});

afterAll(async () => {
  resetMiddlewareState();
  await new Promise((resolve) => coreHttp.close(resolve));
  installA2A(null);
  setWorkflowService(null);
  setServiceConfigRepository(null);
  setServiceGrantRepository(null);
  resetDeviceRegistry();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let rpcId = 0;
async function call(base: string, method: string, params: Record<string, unknown>, extra: Record<string, string> = {}) {
  rpcId += 1;
  const res = await fetch(`${base}/a2a/v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0', authorization: `Bearer ${token}`, ...extra },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
  });
  return { status: res.status, body: (await res.json()) as { result?: Record<string, unknown>; error?: { code: number } } };
}

/** Open a streaming call; read its JSON-RPC events as they come. */
async function stream(base: string, method: string, params: Record<string, unknown>) {
  rpcId += 1;
  const res = await fetch(`${base}/a2a/v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
  });
  const reader = res.body?.getReader();
  let buffered = '';
  return async (): Promise<Record<string, unknown> | 'end'> => {
    for (;;) {
      const at = buffered.indexOf('\n\n');
      if (at !== -1) {
        const frame = buffered.slice(0, at);
        buffered = buffered.slice(at + 2);
        if (frame.startsWith('data: ')) return (JSON.parse(frame.slice(6)) as { result: Record<string, unknown> }).result;
        continue;
      }
      let chunk;
      try {
        chunk = await reader?.read();
      } catch {
        return 'end';
      }
      if (chunk === undefined || chunk.done) return 'end';
      buffered += new TextDecoder().decode(chunk.value);
    }
  };
}

/** What one stream message says: the opening Task's state, a status update's state, or an artifact. */
const said = (m: Record<string, unknown> | 'end'): string => {
  if (m === 'end') return 'end';
  if (m.task !== undefined) return `task:${(m.task as { status: { state: string } }).status.state}`;
  if (m.statusUpdate !== undefined) return (m.statusUpdate as { status: { state: string } }).status.state;
  return 'artifact';
};

function runnerClaims(taskId: string, leaseMs = 30_000): string {
  const store = getA2ARuntime()?.store;
  const op = store?.getTaskByExternal('inbound', `a2a:${clientIdOf()}`, taskId) ?? null;
  const claimed = repo.claimDelegationTask(runnerDid, Date.now(), leaseMs, 'transit');
  if (claimed === null || op === null || claimed.id !== op.internal_id) throw new Error('the runner took another call');
  expect(admitInboundClaim(claimed, runnerDid)).toBe('admitted');
  return claimed.id;
}

function clientIdOf(): string {
  const row = getA2ARuntime()?.store.db.query('SELECT client_id FROM a2a_clients LIMIT 1') as { client_id: string }[];
  return row[0]?.client_id ?? '';
}

describe('a gateway restart loses only open streams (§4.1, §7.5)', () => {
  // Plan C9 and Extra X-13
  it('a client that subscribes again after a restart gets the current Task, then the rest: nothing lost, nothing twice', async () => {
    const first = await startGateway();
    const a = await stream(first.base, 'SendStreamingMessage', {
      message: { messageId: 'restart-1', role: 'ROLE_USER', parts: [{ data: { skill: 'eta_query', params: { route_id: '42' } } }] },
    });
    const opening = await a();
    expect(said(opening)).toBe('task:TASK_STATE_SUBMITTED');
    const id = ((opening as { task: { id: string } }).task).id;
    // The runner takes it with a short lease; the first gateway streams WORKING.
    runnerClaims(id, 1);
    await first.pump.turn();
    expect(said(await a())).toBe('TASK_STATE_WORKING');

    // The gateway goes down: its open stream ends with it.
    const ended = a();
    await first.stop();
    expect(await ended).toBe('end');
    // While it is down the lease lapses: the call is SUBMITTED again, an event no gateway has claimed.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(repo.expireLeasedTasks(Date.now())).toHaveLength(1);

    // A new gateway over the same Core serves the same task.
    const second = await startGateway();
    try {
      const polled = await call(second.base, 'GetTask', { id });
      expect((polled.body.result?.status as { state: string }).state).toBe('TASK_STATE_SUBMITTED');
      const b = await stream(second.base, 'SubscribeToTask', { id });
      const reopened = await b();
      // It opens on the task as it stands now: the change made while no gateway ran is not lost.
      expect((reopened as { task: { status: unknown } }).task.status).toEqual(polled.body.result?.status);
      // The waiting SUBMITTED event is already in the Task it opened with: it is not sent again.
      await second.pump.turn();
      const child = runnerClaims(id);
      await second.pump.turn();
      const working = await b();
      expect(said(working)).toBe('TASK_STATE_WORKING');
      workflow.complete(child, JSON.stringify({ eta_minutes: 3 }), 'done', runnerDid);
      await second.pump.turn();
      const story = [said(working), said(await b()), said(await b()), said(await b())];
      expect(story).toEqual(['TASK_STATE_WORKING', 'artifact', 'TASK_STATE_COMPLETED', 'end']);
      const done = await call(second.base, 'GetTask', { id });
      expect((done.body.result?.status as { state: string }).state).toBe('TASK_STATE_COMPLETED');
    } finally {
      await second.stop();
    }
  });
});

describe('extensions (design §7.2 step 2, §7.6 required:false)', () => {
  // Extra X-15
  it.each([
    ['an unknown extension', { 'a2a-extensions': 'https://unknown.example/ext/v9' }],
    ['Dina’s extension left out', {}],
  ])('a call naming %s is served through to Core; -32008 is never raised', async (_name, extra) => {
    const gw = await startGateway();
    try {
      const sent = await call(
        gw.base,
        'SendMessage',
        {
          message: { messageId: `ext-${rpcId}`, role: 'ROLE_USER', parts: [{ data: { skill: 'eta_query', params: { route_id: '7' } } }] },
          // Answered at once: the test cancels the call while it is queued.
          configuration: { returnImmediately: true },
        },
        extra,
      );
      expect(sent.status).toBe(200);
      expect(sent.body.error).toBeUndefined();
      const task = sent.body.result?.task as { id: string; status: { state: string } };
      expect(task.status.state).toBe('TASK_STATE_SUBMITTED');
      // The cancel of a queued auto call has one answer: the task, CANCELED.
      const canceled = await call(gw.base, 'CancelTask', { id: task.id }, extra);
      expect(canceled.status).toBe(200);
      expect(canceled.body.error).toBeUndefined();
      expect(canceled.body.result?.id).toBe(task.id);
      expect((canceled.body.result?.status as { state: string }).state).toBe('TASK_STATE_CANCELED');
    } finally {
      await gw.stop();
    }
  });
});
