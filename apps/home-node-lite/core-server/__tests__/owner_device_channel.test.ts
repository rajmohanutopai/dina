/**
 * WEB_OWNER_SURFACE_PLAN §3.3 — the owner-device path through the HTTP
 * adapter, with real signatures and a real pairing.
 *
 * A browser paired as the owner's device signs its requests like any
 * device. On the owner surface the adapter verifies it and marks the
 * request exactly as a matching capability header does, so the routes' own
 * owner checks pass unedited. Off the owner surface it reaches nothing (the
 * matrix grants its class nothing). A bad signature is refused at the entry
 * point, never passed on. A device of any other role falls through to the
 * ordinary pipeline untouched.
 */

import { randomBytes } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';

import {
  HttpOwnerDispatcher,
  InMemoryCommandReceiptRepository,
  InMemoryWorkflowRepository,
  WorkflowService,
  OwnerCommerceClient,
  OwnerCommerceHttpError,
  OwnerRunControlClient,
  InMemoryRunRepository,
  RunService,
  authenticateOwnerDeviceCore,
  clearOwnerPresence,
  clearPairingState,
  completePairing,
  configureRateLimiter,
  createCoreRouter,
  deriveDIDKey,
  generatePairingCode,
  getPublicKey,
  installOwnerPresenceVerifier,
  namesOwnerDevice,
  publicKeyToMultibase,
  resetCallerTypeState,
  resetMiddlewareState,
  setCommandReceiptRepository,
  setRunRepository,
  setNodeDID,
  setRunService,
  setWorkflowService,
  sign,
  signRequest,
} from '@dina/core';
import { getDeviceByDID, resetDeviceRegistry, revokeDevice } from '@dina/core/devices';

import { bindCoreRouter } from '../src/server/bind_core_router';

import type { DeviceRole } from '@dina/core/devices';

const CAP = 'test-owner-capability-0123456789abcdef';

interface Device {
  did: string;
  seed: Uint8Array;
}

function pair(role: DeviceRole, name: string): Device {
  const seed = new Uint8Array(randomBytes(32));
  const pub = getPublicKey(seed);
  const { code } = generatePairingCode({ deviceName: name, role });
  completePairing(code, name, publicKeyToMultibase(pub), role);
  return { did: deriveDIDKey(pub), seed };
}

function signedHeaders(
  d: Device,
  method: string,
  path: string,
  body = '',
  query = '',
): Record<string, string> {
  const h = signRequest(method, path, query, new TextEncoder().encode(body), d.seed, d.did);
  return {
    'x-did': h['X-DID'],
    'x-timestamp': h['X-Timestamp'],
    'x-nonce': h['X-Nonce'],
    'x-signature': h['X-Signature'],
    ...(body === '' ? {} : { 'content-type': 'application/json' }),
  };
}

const ownerDeviceAuth = { namesOwnerDevice, authenticate: authenticateOwnerDeviceCore };

async function server(withOwnerDevices: boolean): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  bindCoreRouter({
    coreRouter: createCoreRouter({ ownerCapability: CAP }),
    app: app as never,
    ownerCapability: CAP,
    ...(withOwnerDevices ? { ownerDeviceAuth } : {}),
  });
  await app.ready();
  return app;
}

describe('owner device over HTTP (bindCoreRouter)', () => {
  let app: FastifyInstance;
  let laptop: Device;
  let clerk: Device;

  beforeEach(async () => {
    resetMiddlewareState();
    resetCallerTypeState();
    resetDeviceRegistry();
    clearPairingState();
    setNodeDID('did:plc:owner-device-test');
    const runs = new InMemoryRunRepository();
    setRunRepository(runs);
    setRunService(new RunService({ repository: runs }));
    setCommandReceiptRepository(new InMemoryCommandReceiptRepository());
    app = await server(true);
    laptop = pair('owner', 'Office laptop');
    clerk = pair('staff', 'Clerk phone');
  });

  afterEach(async () => {
    await app.close();
    setRunRepository(null);
    setRunService(null);
    setCommandReceiptRepository(null);
    resetDeviceRegistry();
    resetCallerTypeState();
    resetMiddlewareState();
  });

  it('a signed owner device reaches the owner surface as the owner', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/run/list',
      headers: signedHeaders(laptop, 'GET', '/v1/run/list'),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { runs: unknown[] }).runs).toEqual([]);
  });

  it('a throttled owner device is told 429, not refused as a device', async () => {
    configureRateLimiter({ maxRequests: 1, windowSeconds: 60 });
    const first = await app.inject({
      method: 'GET',
      url: '/v1/run/list',
      headers: signedHeaders(laptop, 'GET', '/v1/run/list'),
    });
    expect(first.statusCode).toBe(200);
    const throttled = await app.inject({
      method: 'GET',
      url: '/v1/run/list',
      headers: signedHeaders(laptop, 'GET', '/v1/run/list'),
    });
    expect(throttled.statusCode).toBe(429);
    expect((throttled.json() as { rejected_at: string }).rejected_at).toBe('rate_limit');
  });

  it('presence proven by one browser lets only that browser act (§3.8)', async () => {
    installOwnerPresenceVerifier(async (p) => p === 'correct horse');
    try {
      const other = pair('owner', 'Home desktop');
      const proofBody = JSON.stringify({ passphrase: 'correct horse' });
      const proof = await app.inject({
        method: 'POST',
        url: '/v1/commerce/catalog/drafts/presence',
        headers: signedHeaders(laptop, 'POST', '/v1/commerce/catalog/drafts/presence', proofBody),
        payload: proofBody,
      });
      expect(proof.statusCode).toBe(200);

      const gated = '/v1/plugins/install/confirm';
      const body = JSON.stringify({ install_id: 'inst-1' });
      const errorOf = async (headers: Record<string, string>): Promise<string> =>
        (
          (await app.inject({ method: 'POST', url: gated, headers, payload: body })).json() as {
            error?: string;
          }
        ).error ?? '';
      // The laptop proved: its request gets past the gate (to whatever the
      // route answers here).
      expect(await errorOf(signedHeaders(laptop, 'POST', gated, body))).not.toBe(
        'no_user_presence',
      );
      // Another browser, and the capability (console, scripts), did not.
      expect(await errorOf(signedHeaders(other, 'POST', gated, body))).toBe('no_user_presence');
      expect(
        await errorOf({ 'x-dina-owner-capability': CAP, 'content-type': 'application/json' }),
      ).toBe('no_user_presence');
    } finally {
      clearOwnerPresence();
      installOwnerPresenceVerifier(null);
    }
  });

  it('a signed body reaches the handler intact (the owner starts a run)', async () => {
    const body = JSON.stringify({
      service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
      provider_did: 'did:plc:prov',
      persona: 'general',
      idempotency_key: 'k-1',
      ttl_seconds: 600,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/run/start',
      headers: signedHeaders(laptop, 'POST', '/v1/run/start', body),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
  });

  it('off the owner surface an owner device reaches nothing', async () => {
    for (const [method, url] of [
      ['POST', '/v1/vault/store'],
      ['POST', '/v1/vault/query'],
      ['GET', '/v1/personas'],
    ] as const) {
      const res = await app.inject({ method, url, headers: signedHeaders(laptop, method, url) });
      expect([method, url, res.statusCode]).toEqual([method, url, 403]);
    }
  });

  it('a body changed after signing is refused at the entry point', async () => {
    const signedFor = JSON.stringify({ idempotency_key: 'a' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/run/start',
      headers: signedHeaders(laptop, 'POST', '/v1/run/start', signedFor),
      payload: JSON.stringify({ idempotency_key: 'b' }),
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { rejected_at: string }).rejected_at).toBe('signature');
  });

  it('a replayed request is refused', async () => {
    const headers = signedHeaders(laptop, 'GET', '/v1/run/list');
    expect((await app.inject({ method: 'GET', url: '/v1/run/list', headers })).statusCode).toBe(
      200,
    );
    const again = await app.inject({ method: 'GET', url: '/v1/run/list', headers });
    expect(again.statusCode).toBe(401);
    expect((again.json() as { rejected_at: string }).rejected_at).toBe('nonce');
  });

  it('a device of another role signing an owner-surface path is NOT made the owner', async () => {
    // The staff device falls through to the ordinary pipeline, whose matrix
    // refuses a staff caller the run surface.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/run/list',
      headers: signedHeaders(clerk, 'GET', '/v1/run/list'),
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { rejected_at: string }).rejected_at).toBe('authorization');
  });

  it('a staff device still reaches its own trade routes unchanged', async () => {
    // The trade surface is also an owner-surface prefix; the staff request
    // must pass through to its own gate, not be refused as a failed owner.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/trade/inbox',
      headers: signedHeaders(clerk, 'GET', '/v1/commerce/trade/inbox'),
    });
    expect(res.statusCode).not.toBe(401);
    expect((res.json() as { rejected_at?: string }).rejected_at).not.toBe('signature');
  });

  it('a revoked owner device is no longer the owner', async () => {
    const device = getDeviceByDID(laptop.did);
    if (device === null) throw new Error('paired device missing');
    revokeDevice(device.deviceId);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/run/list',
      headers: signedHeaders(laptop, 'GET', '/v1/run/list'),
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('a host that does not enable owner devices never treats one as the owner', async () => {
    const plain = await server(false);
    try {
      const res = await plain.inject({
        method: 'GET',
        url: '/v1/run/list',
        headers: signedHeaders(laptop, 'GET', '/v1/run/list'),
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await plain.close();
    }
  });

  it('the capability header keeps working beside owner devices', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/run/list',
      headers: { 'x-dina-owner-capability': CAP },
    });
    expect(res.statusCode).toBe(200);
  });

  describe('HttpOwnerDispatcher end to end (a real socket)', () => {
    let base: string;

    beforeEach(async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      base = `http://127.0.0.1:${String(address.port)}`;
    });

    function dispatcherFor(d: Device): HttpOwnerDispatcher {
      return new HttpOwnerDispatcher({
        baseUrl: base,
        signer: { did: d.did, sign: async (m) => sign(d.seed, m) },
      });
    }

    it('the owner device lists and starts runs through the owner client, exactly as the phone does', async () => {
      const runs = new OwnerRunControlClient(dispatcherFor(laptop));
      expect((await runs.runList()).runs).toEqual([]);
      const started = await runs.runStart({
        service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
        provider_did: 'did:plc:prov',
        persona: 'general',
        idempotency_key: 'owner-http-1',
        ttl_seconds: 600,
      });
      expect(typeof started.run_id).toBe('string');
      expect((await runs.runList()).runs).toHaveLength(1);
    });

    it('a query string with spaces and non-ASCII verifies (the page and Core serialise it alike)', async () => {
      const commerce = new OwnerCommerceClient(dispatcherFor(laptop));
      // No commerce runtime in this harness: the route answering 503 for itself
      // proves the signature and the owner verdict both passed.
      await expect(commerce.listDrafts('Café & bakery / 2026')).rejects.toMatchObject({
        status: 503,
        errorKey: 'commerce_unavailable',
      });
    });

    it('a staff device over the same dispatcher is refused the owner surface', async () => {
      const runs = new OwnerRunControlClient(dispatcherFor(clerk));
      await expect(runs.runList()).rejects.toMatchObject({ status: 403 });
    });

    it('an unpaired key is refused', async () => {
      const seed = new Uint8Array(randomBytes(32));
      const stranger = { did: deriveDIDKey(getPublicKey(seed)), seed };
      const commerce = new OwnerCommerceClient(dispatcherFor(stranger));
      const failure = commerce.listDrafts('c1');
      // It names no owner device, so it falls through to the ordinary
      // pipeline: a valid signature from an unknown caller, refused there.
      await expect(failure).rejects.toBeInstanceOf(OwnerCommerceHttpError);
      await expect(failure).rejects.toMatchObject({ status: 403 });
    });
  });
});

describe('the web approval inbox, as the owner device (§3.5)', () => {
  let app: FastifyInstance;
  let laptop: Device;
  let clerk: Device;
  let workflow: WorkflowService;

  beforeEach(async () => {
    resetMiddlewareState();
    resetCallerTypeState();
    resetDeviceRegistry();
    clearPairingState();
    setNodeDID('did:plc:owner-device-test');
    workflow = new WorkflowService({ repository: new InMemoryWorkflowRepository() });
    setWorkflowService(workflow);
    workflow.create({
      id: 'card-1',
      kind: 'approval',
      description: 'An agent asks to send an email',
      payload: JSON.stringify({ type: 'intent_validation' }),
      initialState: 'pending_approval' as never,
    });
    app = await server(true);
    laptop = pair('owner', 'Office laptop');
    clerk = pair('staff', 'Clerk phone');
  });

  afterEach(async () => {
    await app.close();
    setWorkflowService(null);
    resetDeviceRegistry();
    resetCallerTypeState();
    resetMiddlewareState();
  });

  it('lists the cards, reads one, and decides it', async () => {
    const query = 'kind=approval&state=pending_approval';
    const list = await app.inject({
      method: 'GET',
      url: `/v1/workflow/tasks?${query}`,
      headers: signedHeaders(laptop, 'GET', '/v1/workflow/tasks', '', query),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { tasks: { id: string }[] }).tasks.map((t) => t.id)).toEqual(['card-1']);

    const one = await app.inject({
      method: 'GET',
      url: '/v1/workflow/tasks/card-1',
      headers: signedHeaders(laptop, 'GET', '/v1/workflow/tasks/card-1'),
    });
    expect(one.statusCode).toBe(200);
    expect((one.json() as { task: { id: string } }).task.id).toBe('card-1');

    const body = JSON.stringify({ reason: 'not now' });
    const declined = await app.inject({
      method: 'POST',
      url: '/v1/workflow/tasks/card-1/cancel',
      headers: signedHeaders(laptop, 'POST', '/v1/workflow/tasks/card-1/cancel', body),
      payload: body,
    });
    expect(declined.statusCode).toBe(200);
    expect(workflow.store().getById('card-1')?.status).toBe('cancelled');
  });

  it('reaches the service-query answer route (the route itself answers)', async () => {
    const body = JSON.stringify({ task_id: 'card-1', response_body: { status: 'unavailable' } });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/service/respond',
      headers: signedHeaders(laptop, 'POST', '/v1/service/respond', body),
      payload: body,
    });
    // Admitted as the owner; this harness wires no D2D sender, so the route
    // says so. An unadmitted caller never gets this far (401/403).
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toBe('service-respond sender not wired');
  });

  it('nothing else on the workflow tree: no create, no claim, no write to a card', async () => {
    const create = JSON.stringify({ id: 'x', kind: 'approval', description: 'x' });
    for (const [method, path, body] of [
      ['POST', '/v1/workflow/tasks', create],
      ['POST', '/v1/workflow/tasks/claim', '{}'],
      ['POST', '/v1/workflow/tasks/card-1/complete', '{}'],
      ['POST', '/v1/workflow/tasks/card-1/running', '{}'],
    ] as const) {
      const res = await app.inject({
        method,
        url: path,
        headers: signedHeaders(laptop, method, path, body),
        payload: body,
      });
      expect([path, res.statusCode]).toEqual([path, 403]);
    }
    expect(workflow.store().getById('card-1')?.status).toBe('pending_approval');
  });

  it('a staff device reads no card through these paths', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/workflow/tasks/card-1',
      headers: signedHeaders(clerk, 'GET', '/v1/workflow/tasks/card-1'),
    });
    expect([401, 403]).toContain(res.statusCode);
  });
});
