/**
 * Two Dina nodes (design §12 "two-node E2E harness with a real remote
 * agent"; notes "A protocol fix found while starting M3"): Dina A's Lane 1
 * calls Dina B's Lane 2 gateway. Node B is the real thing end to end: its
 * gateway (Fastify), signed HTTP into its Core router, its ingress, its
 * signed card. Node A runs its Lane 1 on its own identity file with its own
 * runtime, runner and guard. The only stand-in is A's socket: A's host
 * transport hands each HTTPS request for b.example to B's gateway in
 * process, as the network would.
 *
 * Module state (the installed A2A store, the workflow service, the rate
 * limiter, the card config) is B's; A never reads it, since every Lane 1
 * step takes A's runtime by hand.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { pino } from 'pino';

import { A2AGuardWorker, WorkflowEventConsumer } from '@dina/brain';
import { deleteThread, deliverA2AOutcome, getThread } from '@dina/brain/chat';
import {
  A2AReleaseLog,
  A2AStore,
  IDENTITY_MIGRATIONS,
  SQLiteServiceConfigRepository,
  SQLiteWorkflowRepository,
  WorkflowService,
  a2aWorkflowHooks,
  activateRemoteAgent,
  admitInboundClaim,
  applyMigrations,
  bindRemoteSkill,
  bindRunner,
  claimNextGuardJob,
  configureRateLimiter,
  createA2AClient,
  createA2ARuntime,
  createCoreRouter,
  createRemoteCredential,
  deriveDIDKey,
  deriveP256SigningKey,
  getA2ARuntime,
  getPublicKey,
  installA2A,
  installA2ACardConfig,
  installA2AReleaseLog,
  outboundOperationView,
  pinnedRemoteSkills,
  proposeDelegation,
  registerRemoteAgent,
  registerService,
  requestInboundInput,
  resetMiddlewareState,
  setA2AHostTransport,
  setNodeDID,
  setServiceConfigDurable,
  setServiceConfigRepository,
  setWorkflowService,
  submitGuardVerdict,
  type A2AHttpRequest,
  type A2ARuntime,
  type CoreRequest,
  type CoreRouter,
} from '@dina/core';
import { registerDevice, resetDeviceRegistry } from '@dina/core/devices';
import { SQLiteServiceGrantRepository, setServiceGrantRepository } from '@dina/core/storage';
import { A2ADispatchRunner } from '@dina/home-node';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { createCoreLink } from '../../a2a-gateway/src/core_link';
import { EdgeLimiter } from '../../a2a-gateway/src/edge_limit';
import { AGENT_CARD_PATH, buildGatewayServer } from '../../a2a-gateway/src/server';
import { StreamHub } from '../../a2a-gateway/src/stream_hub';

import type { FastifyInstance } from 'fastify';

const B_ORIGIN = 'https://b.example';
const B_CARD_URL = `${B_ORIGIN}${AGENT_CARD_PATH}`;
const B_NODE_DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const SESSION = 'chat:two-node';
/**
 * Dina's invocation envelope (design §7.2a): one data part naming the skill
 * as B's card writes it. It must be the bound skill exactly, and it leaves A
 * as written, unscrubbed (gap workflow B-X1).
 */
const envelopeFor = (skill: string) => ({ skill, params: { route_id: '42' } });
const THREAD = 'two-node';

// ---------------------------------------------------------------- node B

let dir: string;
let dbB: NodeSQLiteAdapter;
let repoB: SQLiteWorkflowRepository;
let workflowB: WorkflowService;
let routerB: CoreRouter;
let coreHttp: Server;
let gateway: FastifyInstance;
let bearer: string;
let runnerB: string;

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

async function startNodeB(): Promise<void> {
  dbB = new NodeSQLiteAdapter({ path: path.join(dir, 'b.sqlite'), passphraseHex: 'b0'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(dbB, IDENTITY_MIGRATIONS);
  installA2A({ store: new A2AStore(dbB) });
  repoB = new SQLiteWorkflowRepository(dbB);
  workflowB = new WorkflowService({ repository: repoB, ...a2aWorkflowHooks(getA2ARuntime), responseBridgeSender: async () => undefined });
  setWorkflowService(workflowB);
  setServiceConfigRepository(new SQLiteServiceConfigRepository(dbB));
  setServiceGrantRepository(new SQLiteServiceGrantRepository(dbB));
  resetDeviceRegistry();
  runnerB = registerDevice('Transit runner', 'z6MkTwoNodeRunnerB', 'agent', 'runner').did;
  const store = getA2ARuntime()?.store;
  if (store === undefined) throw new Error('node B runtime');
  bindRunner(store, { lane: 'transit', device_did: runnerB }, Date.now());
  await setServiceConfigDurable(
    {
      isDiscoverable: true,
      discoverability: 'public',
      status: 'active',
      name: 'Bus 42',
      description: 'Arrival times for route 42.',
      capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'auto', category: 'transit' } },
      capabilitySchemas: {
        eta_query: {
          params: { type: 'object', required: ['route_id'], properties: { route_id: { type: 'string', minLength: 1 } } },
          result: { type: 'object', required: ['eta_minutes'], properties: { eta_minutes: { type: 'integer' } } },
          schemaHash: 'h',
        },
      },
    },
    'bus',
  );
  // The bearer B's owner issues to A, delivered out of band.
  const client = createA2AClient(store, { display_name: 'Dina A' }, Date.now());
  if (!client.ok) throw new Error(client.reason);
  bearer = client.token;

  const seed = new Uint8Array(randomBytes(32));
  const gatewayKey = { seed, did: deriveDIDKey(getPublicKey(seed)) };
  registerService(gatewayKey.did, 'gateway');
  configureRateLimiter({ maxRequests: 1_000, windowSeconds: 60, perDidMax: { [gatewayKey.did]: Number.POSITIVE_INFINITY } });
  setNodeDID(B_NODE_DID);
  routerB = createCoreRouter();
  coreHttp = await serveCore(routerB);
  const addr = coreHttp.address();
  if (addr === null || typeof addr === 'string') throw new Error('core address');
  installA2ACardConfig({ key: { privateKey: deriveP256SigningKey(new Uint8Array(32).fill(9), 0).privateKey, generation: 0 }, publicOrigin: B_ORIGIN });
  gateway = buildGatewayServer({
    core: createCoreLink({ baseUrl: `http://127.0.0.1:${addr.port}`, key: gatewayKey, timeoutMs: 5_000 }),
    limiter: new EdgeLimiter(1_000),
    logger: pino({ level: 'silent' }),
    cardCacheMs: 0,
    trustProxy: 0,
    hub: new StreamHub({ maxStreams: 4, bufferMs: 60_000, bufferEvents: 16, bufferTasks: 16, bufferBytes: 1 << 20 }),
    streams: { perIp: 4, maxLifetimeMs: 60_000, keepaliveMs: 60_000, maxBufferedBytes: 1 << 20 },
  });
  await gateway.ready();
}

/** B's runner: takes the call off its lane through Core's claim check, then answers or asks. */
function nodeBRunner(mode: 'answer' | 'ask'): void {
  const claimed = repoB.claimDelegationTask(runnerB, Date.now(), 30_000, 'transit');
  if (claimed === null) return;
  expect(admitInboundClaim(claimed, runnerB)).toBe('admitted');
  if (mode === 'answer') {
    workflowB.complete(claimed.id, JSON.stringify({ eta_minutes: 4 }), 'done', runnerB);
    return;
  }
  const asked = requestInboundInput({
    taskId: claimed.id,
    claimantDid: runnerB,
    claimId: claimed.claim_id,
    request: { prompt: 'Which stop are you at?', input_schema: { type: 'object', required: ['stop'], properties: { stop: { type: 'string' } } } },
  });
  expect(asked.kind).toBe('parked');
}

// ---------------------------------------------------------------- node A

let dbA: NodeSQLiteAdapter;
let runtimeA: A2ARuntime;
let workflowA: WorkflowService;
let logA: A2AReleaseLog;
let clockA = 1_800_000_000_000;
let nodeA = 0;
let seen: { method: string; path: string; headers: Record<string, string>; body: string }[];
let bMode: 'answer' | 'ask';

function startNodeA(): void {
  nodeA += 1;
  dbA = new NodeSQLiteAdapter({ path: path.join(dir, `a-${nodeA}.sqlite`), passphraseHex: 'a0'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(dbA, IDENTITY_MIGRATIONS);
  const store = new A2AStore(dbA);
  const hooks = a2aWorkflowHooks(() => runtimeA);
  workflowA = new WorkflowService({ repository: new SQLiteWorkflowRepository(dbA), nowMsFn: () => clockA, approvalDecisionHandler: hooks.approvalDecisionHandler });
  runtimeA = createA2ARuntime({ store, workflow: workflowA, nowMs: () => clockA });
  logA = new A2AReleaseLog(dbA, () => clockA);
  installA2AReleaseLog(logA);
  // A's socket: an HTTPS request for b.example reaches B's gateway, as the network would carry it.
  setA2AHostTransport(async (request: A2AHttpRequest) => {
    const url = new URL(request.url);
    if (url.origin !== B_ORIGIN) return { ok: false, error: 'dns_failed', sent: false };
    const headers: Record<string, string> = {
      ...request.headers,
      ...(request.body !== undefined ? { 'content-type': request.contentType ?? 'application/json' } : {}),
    };
    seen.push({ method: request.method, path: url.pathname, headers, body: request.body ?? '' });
    const res = await gateway.inject({ method: request.method, url: `${url.pathname}${url.search}`, headers, ...(request.body !== undefined ? { payload: request.body } : {}) });
    return { ok: true, status: res.statusCode, body: res.body, connectedAddress: '203.0.113.42' };
  });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'a2a-two-node-'));
  await startNodeB();
});

// Node B serves every test; each test gets a fresh node A.
beforeEach(() => {
  seen = [];
  deleteThread(THREAD);
  deleteThread('main');
  startNodeA();
});

afterEach(() => {
  setA2AHostTransport(null);
  installA2AReleaseLog(null);
  dbA.close();
});

afterAll(async () => {
  resetMiddlewareState();
  await gateway.close();
  await new Promise((resolve) => coreHttp.close(resolve));
  installA2ACardConfig(null);
  installA2A(null);
  setWorkflowService(null);
  setServiceConfigRepository(null);
  setServiceGrantRepository(null);
  resetDeviceRegistry();
  dbB.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A's owner registers B's live card, gives it B's bearer, allows its skill, and activates it. */
async function aRegistersB(): Promise<{ agentId: string; skill: string }> {
  const d = { store: runtimeA.store, nowMs: () => clockA };
  const reg = await registerRemoteAgent(d, B_CARD_URL);
  if (!reg.ok) throw new Error(`register: ${reg.reason}`);
  const agentId = reg.agent.agent_id;
  const skill = pinnedRemoteSkills(reg.agent)[0]?.id ?? '';
  const credential = createRemoteCredential(d, agentId, { kind: 'bearer', scheme: 'bearer', secret: { token: bearer } });
  if (!credential.ok) throw new Error(`credential: ${credential.reason}`);
  expect(bindRemoteSkill(d, agentId, { skill, actionClass: 'read', credentialRef: credential.credential.credential_ref }).ok).toBe(true);
  expect(activateRemoteAgent(d, agentId)).toEqual({ ok: true });
  return { agentId, skill };
}

/** A's owner speaks, Brain proposes the call, A's owner approves, A's runner runs it to its end. */
async function aCallsB(agentId: string, skill: string): Promise<string> {
  clockA += 60_000;
  logA.recordUtterance(SESSION, `turn-${clockA}`, 'When is the next bus 42?');
  expect(skill).toMatch(/^eta_query@/);
  const proposed = proposeDelegation(runtimeA, { agentId, skill, data: envelopeFor(skill), replyTo: THREAD, releaseSession: SESSION });
  expect(proposed.ok && proposed.projection.parts.find((p) => 'data' in p)).toEqual({ data: envelopeFor(skill) });
  if (!proposed.ok) throw new Error(`propose: ${proposed.reason}`);
  workflowA.approve(proposed.approvalTaskId);
  const runner = new A2ADispatchRunner({
    runtime: () => runtimeA,
    runnerDid: 'did:key:z6MkTwoNodeRunnerA',
    // While A waits between polls, B's runner does its work.
    sleep: async (ms) => {
      clockA += ms;
      nodeBRunner(bMode);
    },
    pollBackoffMs: [1_000],
    pollDeadlineMs: 60_000,
  });
  await runner.tick();
  await runner.flush();
  return proposed.operationId;
}

describe('Dina A calls Dina B over A2A (design §12; A2A-I1, §6.1, §6.4)', () => {
  // Plan X-1
  it('registers B’s signed live card, calls it with B’s bearer once A’s owner approves, and A’s guard releases B’s answer into the chat that asked', async () => {
    const { agentId, skill } = await aRegistersB();
    const agent = runtimeA.store.getAgent(agentId);
    // ES256 through B's jku, verified; B's JSON-RPC interface pinned, never its REST one.
    expect(agent).toMatchObject({ signature_state: 'verified', endpoint: `${B_ORIGIN}/a2a/v1` });
    const offered = (JSON.parse(agent?.card_json ?? '{}') as { supportedInterfaces: { protocolBinding: string }[] }).supportedInterfaces;
    expect(offered.map((i) => i.protocolBinding)).toEqual(['JSONRPC', 'HTTP+JSON']);
    expect(seen.map((s) => [s.method, s.path])).toEqual([
      ['GET', AGENT_CARD_PATH],
      ['GET', '/.well-known/jwks.json'],
    ]);

    bMode = 'answer';
    const operationId = await aCallsB(agentId, skill);
    expect(seen.filter((s) => s.path.startsWith('/a2a/rest'))).toEqual([]);
    const calls = seen.filter((s) => s.method === 'POST');
    expect(calls.every((s) => s.path === '/a2a/v1' && s.headers.Authorization === `Bearer ${bearer}` && s.headers['A2A-Version'] === '1.0')).toBe(true);
    // B answers a submitted task; A polls it to its end.
    expect(calls.map((s) => (JSON.parse(s.body) as { method: string }).method)).toEqual(['SendMessage', 'GetTask']);
    expect(runtimeA.store.getTaskByExternal('outbound', 'owner', operationId)?.state).toBe('quarantined');

    // A's guard: Core's guard functions, as its routes serve them to Brain's worker.
    const guard = new A2AGuardWorker({
      core: {
        claimA2AGuardJob: async () => claimNextGuardJob(runtimeA),
        submitA2AGuardVerdict: async (v: Parameters<typeof submitGuardVerdict>[1]) => submitGuardVerdict(runtimeA, v),
      } as never,
      llm: async () => '{"verdict":"pass","reason":"plain answer"}',
    });
    expect(await guard.tick()).toBe(1);
    const view = outboundOperationView(runtimeA, operationId);
    expect(view).toMatchObject({ state: 'completed', reply_to: THREAD, result: { version: 1, parts: [{ data: { eta_minutes: 4 } }] } });

    // A's delivery, as Brain runs it: the event consumer reads A's events and
    // the operation, and the thread comes from the operation's reply_to.
    const storeA = workflowA.store();
    const consumer = new WorkflowEventConsumer({
      coreClient: {
        listWorkflowEvents: async (opts) => storeA.listUndeliveredEvents(clockA, 0, opts?.limit ?? 50),
        acknowledgeWorkflowEvent: async (id) => storeA.markEventAcknowledged(id, clockA) && storeA.markEventDelivered(id, clockA),
        failWorkflowEventDelivery: async (id, o) => storeA.markEventDeliveryFailed(id, o?.nextDeliveryAt ?? clockA + 30_000, clockA),
        getWorkflowTask: async (id) => storeA.getById(id),
        getA2AOperation: async (id) => outboundOperationView(runtimeA, id),
      },
      deliver: ({ text, event, details }) => {
        if (details.a2a === undefined) return;
        deliverA2AOutcome({ threadId: details.a2a.reply_to ?? 'main', text, eventId: event.event_id, operationId: details.a2a.operation_id });
      },
    });
    const tick = await consumer.runTick();
    expect(tick).toMatchObject({ delivered: 1, failed: 0, errors: [] });
    const thread = getThread(THREAD);
    expect(thread).toHaveLength(1);
    expect(thread[0]?.content).toContain('"eta_minutes": 4');
    expect(getThread('main')).toEqual([]);
  });

  // Plan X-1
  it('a question from B (INPUT_REQUIRED) ends A’s call remote_needs_input, and A sends nothing more', async () => {
    const { agentId, skill } = await aRegistersB();
    bMode = 'ask';
    const operationId = await aCallsB(agentId, skill);
    expect(runtimeA.store.getTaskByExternal('outbound', 'owner', operationId)).toMatchObject({ state: 'failed', reason_code: 'remote_needs_input' });
    const methods = seen.filter((s) => s.method === 'POST').map((s) => (JSON.parse(s.body) as { method: string }).method);
    expect(methods).toEqual(['SendMessage', 'GetTask']);
  });
});
