/**
 * Lane 2 in the booted Core server (design §4.1, §12 "no PII in logs";
 * notes M2 "Limits per client, not per gateway", "Server wiring"): the
 * gateway's DID is exempt from Core's per-DID bucket and only it; Core's
 * logs carry no client params, bearer, signature, webhook URL or token
 * while a call runs its whole course; with neither Lane 2 setting, boot
 * registers no gateway and serves no card.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { pino } from 'pino';

import {
  bindRunner,
  createA2AClient,
  deriveDIDKey,
  getA2ACardConfig,
  getA2ARuntime,
  getPublicKey,
  getRateLimiter,
  registerService,
  setServiceConfigDurable,
  signRequest,
} from '@dina/core';
import { registerDevice as pairDevice } from '@dina/core/devices';
import { listServices, registerDevice as registerCallerDevice, resetCallerTypeState, resetMiddlewareState } from '@dina/core/runtime';

import { bootServer } from '../src/boot';

const GATEWAY_SEED = new Uint8Array(32).fill(41);
const GATEWAY_DID = deriveDIDKey(getPublicKey(GATEWAY_SEED));
const OTHER_SEED = new Uint8Array(32).fill(42);
const OTHER_DID = deriveDIDKey(getPublicKey(OTHER_SEED));
const RUNNER_SEED = new Uint8Array(32).fill(43);
const RUNNER_DID = deriveDIDKey(getPublicKey(RUNNER_SEED));
const OWNER_CAPABILITY = `owner-cap-${'O'.repeat(40)}`;

const ETA_PARAMS = { type: 'object', required: ['route_id'], properties: { route_id: { type: 'string', minLength: 1 } } };
const ETA_RESULT = { type: 'object', required: ['eta_minutes'], properties: { eta_minutes: { type: 'integer' } } };

describe('Lane 2 in the booted server', () => {
  const originalEnv = { ...process.env };
  let dir: string;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), 'lane2-boot-'));
    process.env['DINA_VAULT_DIR'] = dir;
    process.env['DINA_CORE_HOST'] = '127.0.0.1';
    process.env['DINA_CORE_PORT'] = '0';
    process.env['DINA_LOG_LEVEL'] = 'silent';
    process.env['DINA_MSGBOX_ENABLED'] = 'false';
    // The tests below pin the default per-DID bucket; a shell's DINA_RATE_LIMIT must not change it.
    Reflect.deleteProperty(process.env, 'DINA_RATE_LIMIT');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
    for (const [k, v] of Object.entries(originalEnv)) {
      if (typeof v === 'string') process.env[k] = v;
    }
    resetMiddlewareState();
    resetCallerTypeState();
    jest.restoreAllMocks();
  });

  function lane2On(): void {
    process.env['DINA_A2A_PUBLIC_URL'] = 'https://dina.example.org';
    process.env['DINA_A2A_GATEWAY_DID'] = GATEWAY_DID;
  }

  /** A call as the gateway forwards it: the client's raw request inside an envelope, signed with `seed`. */
  function forwarded(path: string, body: string, bearer: string, seed = GATEWAY_SEED, did = GATEWAY_DID) {
    const envelope = JSON.stringify({
      request: { method: 'POST', path: '/a2a/v1', query: '', body, version: '1.0' },
      client_auth: { authorization: `Bearer ${bearer}` },
    });
    const headers = signRequest('POST', path, '', new TextEncoder().encode(envelope), seed, did);
    return { method: 'POST' as const, url: path, headers: { ...headers, 'content-type': 'application/json' }, payload: envelope };
  }

  /** A plain signed JSON POST, as a paired device or the gateway sends one. */
  function signedPost(path: string, body: unknown, seed: Uint8Array, did: string) {
    const raw = JSON.stringify(body);
    const headers = signRequest('POST', path, '', new TextEncoder().encode(raw), seed, did);
    return { method: 'POST' as const, url: path, headers: { ...headers, 'content-type': 'application/json' }, payload: raw };
  }

  function newClient(): { token: string; clientId: string } {
    const store = getA2ARuntime()?.store;
    if (store === undefined) throw new Error('no A2A runtime after boot');
    const made = createA2AClient(store, { display_name: 'Outside agent' }, Date.now());
    if (!made.ok) throw new Error(made.reason);
    return { token: made.token, clientId: made.client.client_id };
  }

  // Plan C52
  it('the configured gateway DID passes more than 60 calls a minute at the default limit; another gateway-type DID is held to 60', async () => {
    lane2On();
    const booted = await bootServer();
    try {
      expect(getRateLimiter().remaining(GATEWAY_DID)).toBe(Number.POSITIVE_INFINITY);
      const { token } = newClient();
      const list = '{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{}}';
      const statuses: number[] = [];
      for (let i = 0; i < 75; i += 1) {
        statuses.push((await booted.app.inject(forwarded('/v1/a2a/ingress/tasks/list', list, token))).statusCode);
      }
      expect(statuses).toEqual(Array(75).fill(200));
      // A DID that is a gateway but not the configured one has no exemption:
      // neither from the per-address budget (only a call naming the configured
      // gateway's DID skips it, cold audit C3-9) nor from the per-DID one.
      registerService(OTHER_DID, 'gateway');
      const other: { status: number; rejectedAt?: string }[] = [];
      for (let i = 0; i < 75; i += 1) {
        const res = await booted.app.inject(forwarded('/v1/a2a/ingress/tasks/list', list, token, OTHER_SEED, OTHER_DID));
        other.push({ status: res.statusCode, ...(res.statusCode === 200 ? {} : { rejectedAt: (res.json() as { rejected_at?: string }).rejected_at }) });
      }
      // The per-address budget holds 60 a minute and answers first, before
      // Core's signed router reads the request (so no rejected_at): the
      // configured gateway's 75 calls above were not counted against it.
      expect(other.slice(0, 60)).toEqual(Array(60).fill({ status: 200 }));
      expect(other.slice(60)).toEqual(Array(15).fill({ status: 429 }));
      const throttled = await booted.app.inject(forwarded('/v1/a2a/ingress/tasks/list', list, token, OTHER_SEED, OTHER_DID));
      expect(throttled.statusCode).toBe(429);
      expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);
      // The per-DID budget held the same DID to the same 60: its bucket is spent.
      expect(getRateLimiter().remaining(OTHER_DID)).toBe(0);
    } finally {
      await booted.app.close();
    }
  }, 60_000);

  // Extra X-23
  it('Core’s logs carry no params, bearer, signature, webhook URL, token or owner key while calls are taken, reviewed, run, settled and delivered', async () => {
    lane2On();
    process.env['DINA_OWNER_CAPABILITY'] = OWNER_CAPABILITY;
    const lines: string[] = [];
    const logger = pino(
      { level: 'trace' },
      new Writable({
        write(chunk: Buffer, _enc, done) {
          lines.push(chunk.toString());
          done();
        },
      }),
    );
    const booted = await bootServer({ logger });
    const app = booted.app;
    const signatures: string[] = [];
    const inject = async (req: { method: 'POST'; url: string; headers: Record<string, string>; payload: string }) => {
      const sig = req.headers['X-Signature'];
      if (sig !== undefined) signatures.push(sig);
      return app.inject(req);
    };
    try {
      const store = getA2ARuntime()?.store;
      if (store === undefined) throw new Error('no A2A runtime after boot');
      // A paired runner on the transit lane, and a listing with one auto and one review capability.
      pairDevice('Transit runner', RUNNER_DID.slice('did:key:'.length), 'agent', 'runner');
      registerCallerDevice(RUNNER_DID, 'Transit runner');
      expect(bindRunner(store, { lane: 'transit', device_did: RUNNER_DID }, Date.now()).ok).toBe(true);
      await setServiceConfigDurable(
        {
          isDiscoverable: true,
          discoverability: 'public',
          status: 'active',
          name: 'Bus 42',
          capabilities: {
            eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'auto', category: 'transit' },
            price_check: { mcpServer: 'transit', mcpTool: 'get_price', responsePolicy: 'review', category: 'transit' },
          },
          capabilitySchemas: {
            eta_query: { params: ETA_PARAMS, result: ETA_RESULT, schemaHash: 'h-eta' },
            price_check: { params: ETA_PARAMS, result: ETA_RESULT, schemaHash: 'h-price' },
          },
        },
        'bus',
      );
      const { token, clientId } = newClient();
      // Answered at once: the calls are followed by review, claim and delivery below, not by the wait.
      const send = (id: number, skill: string, route: string, configuration: Record<string, unknown> = {}) =>
        forwarded(
          '/v1/a2a/ingress/message',
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'SendMessage',
            params: {
              message: { messageId: `m-log-${id}`, role: 'ROLE_USER', parts: [{ data: { skill, params: { route_id: route } } }] },
              configuration: { returnImmediately: true, ...configuration },
            },
          }),
          token,
        );
      const taskOf = (res: { json: () => unknown }) => (res.json() as { result: { task: { id: string; status: { state: string } } } }).result.task;

      // The auto call, with a webhook given inline.
      const auto = await inject(
        send(1, 'eta_query', 'PARAM-SECRET-42', {
          taskPushNotificationConfig: { url: 'https://hooks.example.test/HOOK-SECRET', token: 'TOKEN-SECRET' },
        }),
      );
      expect(auto.statusCode).toBe(200);
      const autoTask = taskOf(auto);
      expect(autoTask.status.state).toBe('TASK_STATE_SUBMITTED');
      // A second webhook, with credentials, by the push-config route.
      const create = forwarded(
        `/v1/a2a/ingress/push-configs/${autoTask.id}/create`,
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'CreateTaskPushNotificationConfig',
          params: { taskId: autoTask.id, url: 'https://hooks.example.test/HOOK-SECRET-2', authentication: { scheme: 'Bearer', credentials: 'CRED-SECRET' } },
        }),
        token,
      );
      expect((await inject(create)).statusCode).toBe(200);

      // The review call: Core raises the owner's card, and the owner approves it over HTTP.
      const review = await inject(send(3, 'price_check', 'REVIEW-PARAM-SECRET'));
      const reviewTask = taskOf(review);
      // Approval is invisible to the caller: a card waiting on the owner reads WORKING (design §7.4).
      expect(reviewTask.status.state).toBe('TASK_STATE_WORKING');
      const card = store.getTaskByExternal('inbound', `a2a:${clientId}`, reviewTask.id)?.internal_id ?? '';
      expect(card).toMatch(/^a2a-in-review-/);
      const approved = await app.inject({
        method: 'POST',
        url: `/v1/workflow/tasks/${card}/approve`,
        headers: { 'content-type': 'application/json', 'x-dina-owner-capability': OWNER_CAPABILITY },
        payload: '{}',
      });
      expect(approved.statusCode).toBe(200);

      // The runner takes both calls over HTTP and completes them.
      const ran: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const claimed = await inject(signedPost('/v1/workflow/tasks/claim', { runner_filter: 'transit', lease_ms: 30_000 }, RUNNER_SEED, RUNNER_DID));
        if (claimed.statusCode === 204) break;
        expect(claimed.statusCode).toBe(200);
        const child = claimed.json() as { id: string; claim_id: string };
        const done = await inject(
          signedPost(`/v1/workflow/tasks/${child.id}/complete`, { result: '{"eta_minutes":3}', claim_id: child.claim_id }, RUNNER_SEED, RUNNER_DID),
        );
        expect(done.statusCode).toBe(200);
        ran.push(child.id);
      }
      expect(ran).toHaveLength(2);
      // With no workflow plane (no PDS identity here), the client's read settles each call.
      let rpcId = 10;
      for (const id of [autoTask.id, reviewTask.id]) {
        rpcId += 1;
        const read = await inject(
          forwarded(`/v1/a2a/ingress/tasks/${id}/get`, JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'GetTask', params: { id } }), token),
        );
        expect((read.json() as { result: { status: { state: string } } }).result.status.state).toBe('TASK_STATE_COMPLETED');
        expect(store.getTaskByExternal('inbound', `a2a:${clientId}`, id)?.state).toBe('completed');
      }

      // The gateway claims the events: the webhook items carry the URL and token in the claim answer.
      const claim = await inject(signedPost('/v1/a2a/ingress/events/claim', { limit: 50, webhook_limit: 10 }, GATEWAY_SEED, GATEWAY_DID));
      expect(claim.statusCode).toBe(200);
      const items = (claim.json() as { items: { id: number; claim_id: string; target: string }[] }).items;
      const hooks = items.filter((i) => i.target === 'webhook');
      expect(hooks.length).toBeGreaterThan(0);
      expect(items.some((i) => i.target === 'sse')).toBe(true);
      expect(claim.body).toContain('HOOK-SECRET');
      expect(claim.body).toContain('TOKEN-SECRET');
      // ...and reports them.
      const ack = await inject(
        signedPost('/v1/a2a/ingress/events/ack', { acks: items.map((i) => ({ id: i.id, claim_id: i.claim_id, outcome: 'delivered' })) }, GATEWAY_SEED, GATEWAY_DID),
      );
      expect(ack.statusCode).toBe(200);
      expect((ack.json() as { applied: number }).applied).toBe(items.length);

      // A wrong bearer, refused: its value must not reach a log either.
      await inject(forwarded('/v1/a2a/ingress/tasks/list', '{"jsonrpc":"2.0","id":4,"method":"ListTasks","params":{}}', `dina_a2a_${'W'.repeat(43)}`));

      // Core logged a request line on every one of these paths, so a leak on any of them would show.
      const urls = lines.flatMap((line) => {
        try {
          const url = (JSON.parse(line) as { req?: { url?: string } }).req?.url;
          return url === undefined ? [] : [url];
        } catch {
          return [];
        }
      });
      for (const step of [
        /^\/v1\/a2a\/ingress\/message$/,
        /^\/v1\/a2a\/ingress\/push-configs\/[^/]+\/create$/,
        /^\/v1\/workflow\/tasks\/a2a-in-review-[^/]+\/approve$/,
        /^\/v1\/workflow\/tasks\/claim$/,
        /^\/v1\/workflow\/tasks\/a2a-in-exec-[^/]+\/complete$/,
        /^\/v1\/a2a\/ingress\/tasks\/[^/]+\/get$/,
        /^\/v1\/a2a\/ingress\/events\/claim$/,
        /^\/v1\/a2a\/ingress\/events\/ack$/,
        /^\/v1\/a2a\/ingress\/tasks\/list$/,
      ]) {
        expect([step.source, urls.some((u) => step.test(u))]).toEqual([step.source, true]);
      }
      const all = lines.join('\n');
      expect(signatures.length).toBeGreaterThanOrEqual(10);
      for (const secret of [
        'PARAM-SECRET-42',
        'REVIEW-PARAM-SECRET',
        token,
        'W'.repeat(43),
        'HOOK-SECRET',
        'TOKEN-SECRET',
        'CRED-SECRET',
        OWNER_CAPABILITY,
        ...signatures,
      ]) {
        expect(all).not.toContain(secret);
      }
    } finally {
      await app.close();
    }
  }, 60_000);

  // Extra X-18 (with neither setting)
  it('with neither Lane 2 setting, boot exempts no DID, registers no gateway and has no card to serve', async () => {
    const booted = await bootServer();
    try {
      expect(getA2ACardConfig()).toBeNull();
      // Boot gave no DID a ceiling of its own, and registered no gateway service.
      expect(getRateLimiter().ceilings()).toEqual({});
      expect(listServices().filter((s) => s.name === 'gateway')).toEqual([]);
      expect(getRateLimiter().remaining(GATEWAY_DID)).toBe(60);
      const res = await booted.app.inject(forwarded('/v1/a2a/ingress/tasks/list', '{"jsonrpc":"2.0","id":1,"method":"ListTasks","params":{}}', `dina_a2a_${'Q'.repeat(43)}`));
      // The signature checks out (a did:key carries its own key), but the DID is no caller Core knows.
      expect([res.statusCode, (res.json() as { rejected_at?: string }).rejected_at]).toEqual([403, 'authorization']);
      expect(res.headers['x-dina-a2a-answer']).toBeUndefined();
      // Even a DID made a gateway by hand finds no card: Lane 2 stays off.
      registerService(GATEWAY_DID, 'gateway');
      const cardHeaders = signRequest('GET', '/v1/a2a/card', '', new Uint8Array(), GATEWAY_SEED, GATEWAY_DID);
      const card = await booted.app.inject({ method: 'GET', url: '/v1/a2a/card', headers: cardHeaders });
      expect([card.statusCode, card.json()]).toEqual([503, { error: 'a2a_card_unconfigured' }]);
    } finally {
      await booted.app.close();
    }
  }, 60_000);
});
