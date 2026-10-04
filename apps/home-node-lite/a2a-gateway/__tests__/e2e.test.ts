/**
 * End to end (design §12 M2): an outside client → the gateway → signed HTTP
 * → Core's real router (signature check, gateway role, ingress routes) over
 * a real SQLCipher identity database. The runner's side is driven through
 * Core's workflow store, as the Core tests do; this file is about the
 * gateway↔Core contract.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { pino } from 'pino';

import {
  A2A_DID_BINDING_PATH,
  base64urlEncodeUtf8,
  cardFormPayload,
  cardSigningForms,
  didBindingSigningInput,
  didRequestSigningInput,
  dinaErrorInfo,
  verifyAgentCardSignatures,
  type JsonObject,
} from '@dina/a2a';
import { Crypto, createCanonicalRequestSigner } from '@dina/adapters-node';
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
  deriveP256SigningKey,
  getA2ARuntime,
  getPublicKey,
  sign as ed25519Sign,
  installA2A,
  installA2ACardConfig,
  issueDidChallenge,
  parsePublicJwk,
  registerService,
  requestInboundInput,
  resetMiddlewareState,
  revokeA2AClient,
  setNodeDID,
  setServiceConfigDurable,
  setServiceConfigRepository,
  setWorkflowService,
  verifyWithJwk,
  type A2AHttpRequest,
  type CoreRequest,
  type CoreRouter,
} from '@dina/core';
import { registerDevice, resetDeviceRegistry } from '@dina/core/devices';
import { SQLiteServiceGrantRepository, setServiceGrantRepository } from '@dina/core/storage';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { createCoreLink } from '../src/core_link';
import { DeliveryPump } from '../src/delivery_pump';
import { EdgeLimiter } from '../src/edge_limit';
import { AGENT_CARD_PATH, buildGatewayServer } from '../src/server';
import { StreamHub } from '../src/stream_hub';

import type { FastifyInstance } from 'fastify';

const NODE_DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const ETA_PARAMS = {
  type: 'object',
  required: ['route_id'],
  properties: { route_id: { type: 'string', minLength: 1 } },
};
const ETA_RESULT = {
  type: 'object',
  required: ['eta_minutes'],
  properties: { eta_minutes: { type: 'integer' } },
};

let dir: string;
let db: NodeSQLiteAdapter;
let repo: SQLiteWorkflowRepository;
let workflow: WorkflowService;
let router: CoreRouter;
let coreHttp: Server;
let coreUrl: string;
let gateway: FastifyInstance;
let gatewayKey: { seed: Uint8Array; did: string };
let token: string;
let clientId: string;
let grants: SQLiteServiceGrantRepository;
let runnerDid: string;

/** A thin HTTP front for Core's router: the shape core-server's binding builds. */
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

function gatewayFor(key: { seed: Uint8Array; did: string }, hub = newHub()): FastifyInstance {
  return buildGatewayServer({
    core: createCoreLink({ baseUrl: coreUrl, key, timeoutMs: 5_000 }),
    limiter: new EdgeLimiter(1_000),
    logger: pino({ level: 'silent' }),
    cardCacheMs: 0,
    trustProxy: 0,
    hub,
    streams: { perIp: 10, maxLifetimeMs: 60_000, keepaliveMs: 60_000, maxBufferedBytes: 1 << 20 },
  });
}

function a2aStore(): A2AStore {
  const store = getA2ARuntime()?.store;
  if (store === undefined) throw new Error('a2a runtime');
  return store;
}

function newHub(): StreamHub {
  return new StreamHub({
    maxStreams: 10,
    bufferMs: 60_000,
    bufferEvents: 16,
    bufferTasks: 64,
    bufferBytes: 1 << 20,
  });
}

function newKey(): { seed: Uint8Array; did: string } {
  const seed = new Uint8Array(randomBytes(32));
  return { seed, did: deriveDIDKey(getPublicKey(seed)) };
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'a2a-gw-e2e-'));
  db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: 'ab'.repeat(32),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  installA2A({ store: new A2AStore(db) });
  repo = new SQLiteWorkflowRepository(db);
  // As the full workflow plane does: a bridge sender, so a completed
  // child's result goes through A2A's gate (which settles inbound calls).
  workflow = new WorkflowService({
    repository: repo,
    ...a2aWorkflowHooks(getA2ARuntime),
    responseBridgeSender: async () => undefined,
  });
  setWorkflowService(workflow);
  setServiceConfigRepository(new SQLiteServiceConfigRepository(db));
  grants = new SQLiteServiceGrantRepository(db);
  setServiceGrantRepository(grants);
  resetDeviceRegistry();
  runnerDid = registerDevice('Transit runner', 'z6MkGatewayE2ERunner', 'agent', 'runner').did;
  const store = getA2ARuntime()?.store;
  if (store === undefined) throw new Error('a2a runtime');
  bindRunner(store, { lane: 'transit', device_did: runnerDid }, Date.now());
  await setServiceConfigDurable(
    {
      isDiscoverable: true,
      discoverability: 'public',
      status: 'active',
      name: 'Bus 42',
      description: 'Arrival times for route 42.',
      capabilities: {
        eta_query: {
          mcpServer: 'transit',
          mcpTool: 'get_eta',
          responsePolicy: 'auto',
          category: 'transit',
        },
      },
      capabilitySchemas: { eta_query: { params: ETA_PARAMS, result: ETA_RESULT, schemaHash: 'h' } },
    },
    'bus',
  );
  const client = createA2AClient(store, { display_name: 'Outside agent' }, Date.now());
  if (!client.ok) throw new Error(client.reason);
  token = client.token;
  clientId = client.client.client_id;

  gatewayKey = newKey();
  registerService(gatewayKey.did, 'gateway');
  // As core-server's boot does: the gateway carries every client's calls
  // under its one DID, so Core's per-DID limit does not apply to it.
  configureRateLimiter({
    maxRequests: 50,
    windowSeconds: 60,
    perDidMax: { [gatewayKey.did]: Number.POSITIVE_INFINITY },
  });
  setNodeDID(NODE_DID);
  router = createCoreRouter();
  coreHttp = await serveCore(router);
  const addr = coreHttp.address();
  if (addr === null || typeof addr === 'string') throw new Error('core address');
  coreUrl = `http://127.0.0.1:${addr.port}`;
  installA2ACardConfig({
    key: {
      privateKey: deriveP256SigningKey(new Uint8Array(32).fill(7), 0).privateKey,
      generation: 0,
    },
    publicOrigin: 'http://127.0.0.1:8400',
  });
  gateway = gatewayFor(gatewayKey);
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
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let rpcId = 0;
function call(
  method: string,
  params: Record<string, unknown>,
  bearer: string | null = token,
  gw = gateway,
) {
  rpcId += 1;
  return gw.inject({
    method: 'POST',
    url: '/a2a/v1',
    headers: {
      'content-type': 'application/json',
      'a2a-version': '1.0',
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
    },
    payload: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
  });
}

const result = (res: { json: () => unknown }) =>
  (res.json() as { result: Record<string, unknown> }).result;

/** The runner's part, while a SendMessage waits: claim the call once Core has queued it, and complete it. */
async function runQueuedCall(output: Record<string, unknown>): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    const claimed = repo.claimDelegationTask(runnerDid, Date.now(), 30_000, 'transit');
    if (claimed !== null) {
      workflow.complete(claimed.id, JSON.stringify(output), 'done', runnerDid);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('nothing to claim');
}

describe('an outside client through the gateway', () => {
  it('reads a signed card that verifies under the key set the gateway serves', async () => {
    const card = (await gateway.inject({ method: 'GET', url: AGENT_CARD_PATH })).json() as Record<
      string,
      unknown
    >;
    const jwks = (
      await gateway.inject({ method: 'GET', url: '/.well-known/jwks.json' })
    ).json() as { keys: unknown[] };
    expect((card.skills as { id: string }[]).map((s) => s.id)).toEqual(['eta_query@bus']);
    const key = parsePublicJwk(jwks.keys[0]);
    if (key === null) throw new Error('jwk');
    const report = await verifyAgentCardSignatures(card, ({ header, signingInputs, signature }) =>
      signingInputs.some((input) => verifyWithJwk(key, header.alg, input, signature)),
    );
    expect(report.state).toBe('verified');
  });

  it('calls a skill from the card’s own example, and is answered with the result once the runner finishes', async () => {
    const card = (await gateway.inject({ method: 'GET', url: AGENT_CARD_PATH })).json() as {
      skills: { examples: string[] }[];
    };
    const example = JSON.parse(card.skills[0]?.examples[0] ?? 'null') as Record<string, unknown>;
    // A2A returnImmediately, false by default: the answer waits for the task to end.
    const sending = call('SendMessage', {
      message: { messageId: 'e2e-1', role: 'ROLE_USER', parts: [{ data: example }] },
    });
    await runQueuedCall({ eta_minutes: 4 });
    // A2A v1.0: SendMessage answers `{task}`.
    const task = result(await sending).task as { id: string; status: { state: string } };
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');

    const got = result(await call('GetTask', { id: task.id })) as {
      status: { state: string };
      artifacts: unknown;
    };
    expect(got.status.state).toBe('TASK_STATE_COMPLETED');
    expect(got.artifacts).toEqual([
      {
        artifactId: 'result',
        parts: [{ data: { eta_minutes: 4 }, mediaType: 'application/json' }],
      },
    ]);
    const listed = result(await call('ListTasks', {})) as { tasks: { id: string }[] };
    expect(listed.tasks.map((t) => t.id)).toContain(task.id);
  });

  it('cancels a call before any runner takes it', async () => {
    const sent = result(
      await call('SendMessage', {
        message: {
          messageId: 'e2e-2',
          role: 'ROLE_USER',
          parts: [{ data: { skill: 'eta_query', params: { route_id: '9' } } }],
        },
        configuration: { returnImmediately: true },
      }),
    ).task as { id: string };
    const canceled = result(await call('CancelTask', { id: sent.id })) as {
      status: { state: string };
    };
    expect(canceled.status.state).toBe('TASK_STATE_CANCELED');
  });

  it('relays Core’s challenge for a wrong bearer', async () => {
    const res = await call('ListTasks', {}, `dina_a2a_${'Z'.repeat(43)}`);
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer realm="dina-a2a"');
    expect((await call('ListTasks', {}, null)).statusCode).toBe(401);
  });
});

describe('REST through the gateway (A2A §11, M4)', () => {
  const rest = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    gateway.inject({
      method,
      url: `/a2a/rest${url}`,
      headers: {
        authorization: `Bearer ${token}`,
        'a2a-version': '1.0',
        ...(payload === undefined ? {} : { 'content-type': 'application/a2a+json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });

  it('the card offers REST after JSON-RPC', async () => {
    const card = (await gateway.inject({ method: 'GET', url: AGENT_CARD_PATH })).json() as {
      supportedInterfaces: { protocolBinding: string; url: string }[];
    };
    expect(card.supportedInterfaces.map((i) => [i.protocolBinding, i.url])).toEqual([
      ['JSONRPC', 'http://127.0.0.1:8400/a2a/v1'],
      ['HTTP+JSON', 'http://127.0.0.1:8400/a2a/rest'],
    ]);
  });

  it('a call over REST, from sending to the runner’s result, the bare v1.0 shapes throughout', async () => {
    const sending = rest('POST', '/message:send', {
      message: { messageId: 'rest-1', role: 'ROLE_USER', parts: [{ data: { skill: 'eta_query', params: { route_id: '7' } } }] },
    });
    await runQueuedCall({ eta_minutes: 3 });
    const sent = await sending;
    expect(sent.statusCode).toBe(200);
    expect(sent.headers['content-type']).toContain('application/a2a+json');
    // The send waited for the runner: its answer is the result.
    const task = (sent.json() as { task: { id: string; status: { state: string } } }).task;
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');

    const got = (await rest('GET', `/tasks/${task.id}`)).json() as { status: { state: string }; artifacts: unknown };
    expect(got.status.state).toBe('TASK_STATE_COMPLETED');
    expect(got.artifacts).toEqual([{ artifactId: 'result', parts: [{ data: { eta_minutes: 3 }, mediaType: 'application/json' }] }]);
    // The same task, read by JSON-RPC.
    expect(result(await call('GetTask', { id: task.id })).status).toEqual(got.status);
  });

  it('errors are google.rpc.Status with A2A’s HTTP mapping', async () => {
    const missing = await rest('GET', '/tasks/no-such-task');
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: { status: string } }).error.status).toBe('NOT_FOUND');
    const cancel = await rest('POST', '/tasks/no-such-task:cancel');
    expect(cancel.statusCode).toBe(404);
    const unauth = await gateway.inject({ method: 'GET', url: '/a2a/rest/tasks', headers: { 'a2a-version': '1.0' } });
    expect(unauth.statusCode).toBe(401);
    expect((unauth.json() as { error: { status: string } }).error.status).toBe('UNAUTHENTICATED');
  });
});

describe('Core trusts the gateway with nothing', () => {
  it('a gateway Core never registered gets nothing through, and the client sees only 503', async () => {
    const rogue = gatewayFor(newKey());
    const res = await call('ListTasks', {}, token, rogue);
    expect(res.statusCode).toBe(503);
    await rogue.close();
  });

  it('a gateway that sends a body to another operation’s route is refused by Core', async () => {
    const link = createCoreLink({ baseUrl: coreUrl, key: gatewayKey, timeoutMs: 5_000 });
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'GetTask',
      params: { id: 'some-task' },
    });
    const out = await link.forward('/v1/a2a/ingress/tasks/some-task/cancel', {
      request: { method: 'POST', path: '/a2a/v1', query: '', body, version: '1.0' },
      client_auth: { authorization: `Bearer ${token}` },
    });
    if (!out.ok) throw new Error(`core status ${String(out.status)}`);
    expect(
      (out.answer.body as { error: { code: number; data: { reason: string }[] } }).error,
    ).toEqual(
      expect.objectContaining({
        code: -32600,
        // A2A's own ErrorInfo first (spec §9.5), Dina's reason after it.
        data: [expect.objectContaining({ reason: 'INVALID_REQUEST' }), expect.objectContaining({ reason: 'operation_mismatch' })],
      }),
    );
  });

  it('the gateway’s key opens no other Core route', async () => {
    const link = createCoreLink({ baseUrl: coreUrl, key: gatewayKey, timeoutMs: 5_000 });
    const out = await link.forward('/v1/workflow/tasks/claim', {
      request: { method: 'POST', path: '/a2a/v1', query: '', body: '{}' },
      client_auth: {},
    });
    expect(out).toEqual({ ok: false, status: 403 });
  });

  it('a body for one task sent to another task’s route is refused by Core', async () => {
    const link = createCoreLink({ baseUrl: coreUrl, key: gatewayKey, timeoutMs: 5_000 });
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'GetTask',
      params: { id: 'task-a' },
    });
    const out = await link.forward('/v1/a2a/ingress/tasks/task-b/get', {
      request: { method: 'POST', path: '/a2a/v1', query: '', body, version: '1.0' },
      client_auth: { authorization: `Bearer ${token}` },
    });
    if (!out.ok) throw new Error(`core status ${String(out.status)}`);
    expect(
      dinaErrorInfo((out.answer.body as { error: { data: JsonObject[] } }).error)?.reason,
    ).toBe('id_mismatch');
  });

  it('an envelope changed after the gateway signed it is refused', async () => {
    const signer = createCanonicalRequestSigner({
      did: gatewayKey.did,
      privateKey: gatewayKey.seed,
      sign: (privateKey, message) => new Crypto().ed25519Sign(privateKey, message),
    });
    const envelope = (bodyText: string) => ({
      request: { method: 'POST', path: '/a2a/v1', query: '', body: bodyText, version: '1.0' },
      client_auth: { authorization: `Bearer ${token}` },
    });
    const signedBytes = new TextEncoder().encode(
      JSON.stringify(envelope('{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{}}')),
    );
    const headers = await signer({
      method: 'POST',
      path: '/v1/a2a/ingress/tasks/list',
      query: '',
      body: signedBytes,
    });
    const tampered = JSON.stringify(
      envelope('{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{"pageSize":1}}'),
    );
    const res = await fetch(`${coreUrl}/v1/a2a/ingress/tasks/list`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-did': headers.did,
        'x-timestamp': headers.timestamp,
        'x-nonce': headers.nonce,
        'x-signature': headers.signature,
      },
      body: tampered,
    });
    expect(res.status).toBe(401);
  });
});

describe('M3 through the gateway: streams, webhooks, push configs, the extended card (design §7.5)', () => {
  let hub: StreamHub;
  let gw: FastifyInstance;
  let base: string;
  let pump: DeliveryPump;
  let posts: A2AHttpRequest[];

  beforeAll(async () => {
    hub = newHub();
    gw = gatewayFor(gatewayKey, hub);
    await gw.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(gw.server.address() as { port: number }).port}`;
    posts = [];
    pump = new DeliveryPump({
      core: createCoreLink({ baseUrl: coreUrl, key: gatewayKey, timeoutMs: 5_000 }),
      hub,
      // The transport's own policy is net-node's to test; here it records.
      transport: async (req) => {
        posts.push(req);
        return { ok: true, status: 202, body: '', connectedAddress: '203.0.113.5' };
      },
      logger: pino({ level: 'silent' }),
      intervalMs: 10,
      webhookConcurrency: 4,
      claimLimit: 100,
    });
  });

  afterAll(async () => {
    await pump.stop();
    await gw.close();
  });

  /** A call answered at once (these tests follow it by stream and webhook), with `extra` beside it. */
  const message = (messageId: string, extra: { configuration?: Record<string, unknown> } & Record<string, unknown> = {}) => ({
    message: {
      messageId,
      role: 'ROLE_USER',
      parts: [{ data: { skill: 'eta_query', params: { route_id: '42' } } }],
    },
    ...extra,
    configuration: { returnImmediately: true, ...extra.configuration },
  });

  /** Open a streaming call and read its JSON-RPC events as they come. */
  async function stream(method: string, params: Record<string, unknown>) {
    rpcId += 1;
    const res = await fetch(`${base}/a2a/v1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'a2a-version': '1.0',
        authorization: `Bearer ${token}`,
      },
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
          if (frame.startsWith('data: '))
            return JSON.parse(frame.slice(6)) as Record<string, unknown>;
          continue;
        }
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) return 'end';
        buffered += new TextDecoder().decode(chunk.value);
      }
    };
  }

  /** The runner takes this call's child through Core's claim check, as the claim route does. */
  function runnerClaims(taskId: string, owner = clientId): string {
    const claimed = repo.claimDelegationTask(runnerDid, Date.now(), 30_000, 'transit');
    const op = a2aStore().getTaskByExternal('inbound', `a2a:${owner}`, taskId);
    if (claimed === null || op === null || claimed.id !== op.internal_id)
      throw new Error('the runner took another call');
    expect(admitInboundClaim(claimed, runnerDid)).toBe('admitted');
    return claimed.id;
  }

  const stateOf = (event: Record<string, unknown> | 'end') =>
    event === 'end'
      ? 'end'
      : ((event.result as { statusUpdate?: { status: { state: string } } }).statusUpdate?.status
          .state ?? 'artifact');

  it('a streamed call tells the story GetTask tells, event by event, and ends with the task', async () => {
    const next = await stream('SendStreamingMessage', message('m3-stream'));
    const opening = (await next()) as { result: { task: { id: string; status: unknown } } };
    const id = opening.result.task.id;
    const polledStatus = async () => result(await call('GetTask', { id })).status;
    expect(opening.result.task.status).toEqual(await polledStatus());

    const child = runnerClaims(id);
    await pump.turn();
    const working = (await next()) as { result: { statusUpdate: { status: unknown } } };
    expect(stateOf(working)).toBe('TASK_STATE_WORKING');
    expect(working.result.statusUpdate.status).toEqual(await polledStatus());

    workflow.complete(child, JSON.stringify({ eta_minutes: 6 }), 'done', runnerDid);
    await pump.turn();
    const artifact = (await next()) as { result: { artifactUpdate: { artifact: unknown } } };
    const done = (await next()) as { result: { statusUpdate: { status: unknown } } };
    const polled = result(await call('GetTask', { id }));
    expect(artifact.result.artifactUpdate.artifact).toEqual((polled.artifacts as unknown[])[0]);
    expect(done.result.statusUpdate.status).toEqual(polled.status);
    expect(await next()).toBe('end');
  });

  it('multi-turn over the wire: the stream ends on the question, the answer opens the next, and the call finishes (design §7.7)', async () => {
    const next = await stream('SendStreamingMessage', message('m4-turn'));
    const id = ((await next()) as { result: { task: { id: string } } }).result.task.id;
    const child = runnerClaims(id);
    await pump.turn();
    expect(stateOf(await next())).toBe('TASK_STATE_WORKING');

    // The runner asks, holding its claim, as Core's input-required route does.
    const asked = requestInboundInput({
      taskId: child,
      claimantDid: runnerDid,
      claimId: repo.getById(child)?.claim_id,
      request: {
        prompt: 'Which stop are you at?',
        input_schema: { type: 'object', required: ['stop'], properties: { stop: { type: 'string' } } },
      },
    });
    expect(asked.kind).toBe('parked');
    await pump.turn();
    const question = (await next()) as { result: { statusUpdate: { status: Record<string, unknown> } } };
    expect(stateOf(question)).toBe('TASK_STATE_INPUT_REQUIRED');
    // Streamed = polled, the question included.
    expect(question.result.statusUpdate.status).toEqual(result(await call('GetTask', { id })).status);
    expect((question.result.statusUpdate.status.message as { parts: unknown[] }).parts[0]).toEqual({
      text: 'Which stop are you at?',
    });
    // An interrupted task ends its stream.
    expect(await next()).toBe('end');

    // The answer, streamed: it opens on the task at work again and follows it to the end.
    const again = await stream('SendStreamingMessage', {
      message: { messageId: 'm4-answer', role: 'ROLE_USER', taskId: id, parts: [{ data: { stop: 'Elm' } }] },
    });
    const opening = (await again()) as { result: { task: { status: { state: string } } } };
    expect(opening.result.task.status.state).toBe('TASK_STATE_WORKING');
    const round = runnerClaims(id);
    expect(round).not.toBe(child);
    const payload = JSON.parse(repo.getById(round)?.payload ?? '{}') as { continuation?: unknown };
    expect(payload.continuation).toEqual({
      turns: [
        {
          prompt: 'Which stop are you at?',
          input_schema: { type: 'object', required: ['stop'], properties: { stop: { type: 'string' } } },
          input: { stop: 'Elm' },
        },
      ],
    });
    workflow.complete(round, JSON.stringify({ eta_minutes: 2 }), 'done', runnerDid);
    await pump.turn();
    expect(stateOf(await again())).toBe('artifact');
    const done = (await again()) as { result: { statusUpdate: { status: unknown } } };
    expect(stateOf(done)).toBe('TASK_STATE_COMPLETED');
    // Streamed = polled, at the end as at the question.
    expect(done.result.statusUpdate.status).toEqual(result(await call('GetTask', { id })).status);
    expect(await again()).toBe('end');
  });

  it('a webhook set inline gets each event as A2A JSON with its credentials, and Core records it delivered', async () => {
    const config = {
      url: 'https://hooks.example.test/m3',
      token: 'tok-m3',
      authentication: { scheme: 'Bearer', credentials: 'sekrit' },
    };
    const sent = result(
      await call(
        'SendMessage',
        message('m3-hook', { configuration: { taskPushNotificationConfig: config } }),
      ),
    );
    const id = (sent.task as { id: string }).id;
    runnerClaims(id);
    await pump.turn();
    await new Promise((resolve) => setImmediate(resolve));
    await pump.turn();
    const mine = posts.filter((p) => p.url === config.url);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toEqual(
      expect.objectContaining({
        method: 'POST',
        contentType: 'application/a2a+json',
        headers: { authorization: 'Bearer sekrit', 'x-a2a-notification-token': 'tok-m3' },
      }),
    );
    expect(JSON.parse(mine[0]?.body ?? '{}')).toEqual({
      statusUpdate: expect.objectContaining({
        taskId: id,
        status: expect.objectContaining({ state: 'TASK_STATE_WORKING' }),
      }),
    });
    const op = a2aStore().getTaskByExternal('inbound', `a2a:${clientId}`, id);
    if (op === null) throw new Error('no operation');
    expect(
      a2aStore()
        .outboxOf(op.id)
        .filter((r) => r.target_kind === 'webhook')
        .map((r) => r.status),
    ).toEqual(['delivered']);
  });

  it('push configs over the wire: create, list, delete', async () => {
    const id = (result(await call('SendMessage', message('m3-config'))).task as { id: string }).id;
    const made = result(
      await call('CreateTaskPushNotificationConfig', {
        taskId: id,
        url: 'https://hooks.example.test/c',
      }),
    );
    expect(made).toEqual(
      expect.objectContaining({ taskId: id, url: 'https://hooks.example.test/c' }),
    );
    expect(
      (result(await call('ListTaskPushNotificationConfigs', { taskId: id })).configs as unknown[])
        .length,
    ).toBe(1);
    expect(
      result(await call('DeleteTaskPushNotificationConfig', { taskId: id, id: made.id })),
    ).toEqual({});
    // Leave no queued call behind for the next case's runner.
    await call('CancelTask', { id });
  });

  it('the extended card over the wire, signed like the public one', async () => {
    rpcId += 1;
    const res = await gw.inject({
      method: 'POST',
      url: '/a2a/v1',
      headers: {
        'content-type': 'application/json',
        'a2a-version': '1.0',
        authorization: `Bearer ${token}`,
      },
      payload: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'GetExtendedAgentCard' }),
    });
    const card = result(res) as Record<string, unknown> & {
      skills: { id: string }[];
      signatures: { protected: string; signature: string }[];
    };
    expect(card.skills.map((s) => s.id)).toEqual(['eta_query@bus']);
    // One signature per form that differs (§6.6: the reference SDK signs another form), each over its own.
    const forms = cardSigningForms(card);
    expect(forms).toEqual(['spec', 'a2a_sdk']);
    expect(card.signatures).toHaveLength(forms.length);
    const jwks = (await gw.inject({ method: 'GET', url: '/.well-known/jwks.json' })).json() as { keys: unknown[] };
    const key = parsePublicJwk(jwks.keys[0]);
    if (key === null) throw new Error('jwk');
    forms.forEach((form, i) => {
      const sig = card.signatures[i];
      if (sig === undefined) throw new Error('signature');
      const input = new TextEncoder().encode(`${sig.protected}.${base64urlEncodeUtf8(cardFormPayload(card, form))}`);
      expect(verifyWithJwk(key, 'ES256', input, Buffer.from(sig.signature, 'base64url'))).toBe(true);
    });
  });

  it('revoking the client ends its open stream with nothing more sent', async () => {
    const other = createA2AClient(a2aStore(), { display_name: 'Short-lived' }, Date.now());
    if (!other.ok) throw new Error(other.reason);
    const saved = token;
    token = other.token;
    try {
      const next = await stream('SendStreamingMessage', message('m3-revoke'));
      const opening = (await next()) as { result: { task: { id: string } } };
      runnerClaims(opening.result.task.id, other.client.client_id);
      revokeA2AClient(a2aStore(), grants, other.client.client_id, Date.now());
      await pump.turn();
      expect(await next()).toBe('end');
    } finally {
      token = saved;
    }
  });
});

describe('M4 through the gateway: a client binds its DID, then signs its calls (design §5.1)', () => {
  const clientKey = new Uint8Array(32).fill(21);
  const clientDid = deriveDIDKey(getPublicKey(clientKey));

  /** The client's signature over its own request to the gateway, addressed to this node (`didRequestSigningInput`). */
  function signedHeaders(path: string, body: string, method = 'POST', query = ''): Record<string, string> {
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const nonce = randomBytes(16).toString('hex');
    const input = didRequestSigningInput({
      nodeDid: NODE_DID,
      method,
      path,
      query,
      timestamp,
      nonce,
      bodySha256Hex: createHash('sha256').update(body, 'utf8').digest('hex'),
    });
    return {
      'x-did': clientDid,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': Buffer.from(ed25519Sign(clientKey, new TextEncoder().encode(input))).toString('hex'),
    };
  }

  it('binds through the public door, runs a DID-signed call, and the old bearer stops working', async () => {
    const store = a2aStore();
    const made = createA2AClient(store, { display_name: 'DID agent' }, Date.now());
    if (!made.ok) throw new Error(made.reason);
    const issued = issueDidChallenge(store, made.client.client_id, clientDid, Date.now());
    if (!issued.ok) throw new Error(issued.reason);
    const input = didBindingSigningInput({
      nodeDid: NODE_DID,
      clientId: made.client.client_id,
      did: clientDid,
      challenge: issued.challenge,
    });
    const binding = JSON.stringify({
      did: clientDid,
      challenge: issued.challenge,
      signature: Buffer.from(ed25519Sign(clientKey, new TextEncoder().encode(input))).toString('hex'),
    });
    const bound = await gateway.inject({
      method: 'POST',
      url: A2A_DID_BINDING_PATH,
      headers: { 'content-type': 'application/json' },
      payload: binding,
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json()).toEqual(
      expect.objectContaining({ did: clientDid, principal: `a2a:${made.client.client_id}` }),
    );

    rpcId += 1;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId,
      method: 'SendMessage',
      params: {
        message: {
          messageId: 'm4-did',
          role: 'ROLE_USER',
          parts: [{ data: { skill: 'eta_query', params: { route_id: '4' } } }],
        },
        configuration: { returnImmediately: true },
      },
    });
    const headers = {
      'content-type': 'application/json',
      'a2a-version': '1.0',
      ...signedHeaders('/a2a/v1', body),
    };
    const signed = await gateway.inject({ method: 'POST', url: '/a2a/v1', headers, payload: body });
    expect(signed.statusCode).toBe(200);
    // The same signed request again is a replay.
    const replayed = await gateway.inject({ method: 'POST', url: '/a2a/v1', headers, payload: body });
    expect(replayed.statusCode).toBe(401);
    expect((result(signed).task as { status: { state: string } }).status.state).toBe(
      'TASK_STATE_SUBMITTED',
    );

    // A body changed in flight no longer matches its signature.
    const tampered = await gateway.inject({
      method: 'POST',
      url: '/a2a/v1',
      headers: {
        'content-type': 'application/json',
        'a2a-version': '1.0',
        ...signedHeaders('/a2a/v1', body),
      },
      payload: body.replace('"4"', '"5"'),
    });
    expect(tampered.statusCode).toBe(401);
    expect((await call('ListTasks', {}, made.token)).statusCode).toBe(401);

    // The same DID signs a REST read: method, path and query are what it signs.
    const listed = await gateway.inject({
      method: 'GET',
      url: '/a2a/rest/tasks?pageSize=5',
      headers: { 'a2a-version': '1.0', ...signedHeaders('/a2a/rest/tasks', '', 'GET', 'pageSize=5') },
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { tasks: unknown[] }).tasks).toHaveLength(1);
    // A query changed after signing is refused.
    const changed = await gateway.inject({
      method: 'GET',
      url: '/a2a/rest/tasks?pageSize=50',
      headers: { 'a2a-version': '1.0', ...signedHeaders('/a2a/rest/tasks', '', 'GET', 'pageSize=5') },
    });
    expect(changed.statusCode).toBe(401);
  });
});
