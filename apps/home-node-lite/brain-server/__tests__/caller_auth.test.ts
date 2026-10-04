/**
 * Brain serves signed callers only (A2A design §4.1, plan §3.18): Core under
 * its service key and the owner's devices, both learnt from Core.
 */

import { request } from 'node:http';

import Fastify, { type FastifyInstance } from 'fastify';

import { NonceCache, deriveDIDKey, getPublicKey, signRequest } from '@dina/core';

import {
  CALLER_SET_FAILURE_WAIT_MS,
  CALLER_SET_MISS_INTERVAL_MS,
  CALLER_SET_REFRESH_MS,
  CALLER_SET_TTL_MS,
  CallerDirectory,
  callerOf,
  registerCallerAuth,
  type CallerSet,
} from '../src/caller_auth';
import { openEventStream } from '../src/routes/sse';

const key = (n: number) => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, did: deriveDIDKey(getPublicKey(privateKey)) };
};
const CORE = key(1);
const OWNER = key(2);
const STRANGER = key(3);

let now = 1_800_000_000_000;
let set: CallerSet;
let fetches: number;
let app: FastifyInstance;

beforeEach(async () => {
  set = { core: CORE.did, ownerDevices: [OWNER.did] };
  fetches = 0;
  app = Fastify();
  registerCallerAuth(app, {
    directory: new CallerDirectory(
      async () => {
        fetches += 1;
        return set;
      },
      { now: () => now },
    ),
  });
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/v1/who', async (req) => callerOf(req));
  app.post('/api/v1/echo', async (req) => ({ caller: callerOf(req), body: req.body }));
  await app.ready();
});

afterEach(() => app.close());

/** A fake one-shot timer: the pending callback, when it is due, and how many were set. */
function fakeTimer() {
  const timer = { tick: null as (() => void) | null, dueAt: 0, armed: 0 };
  return {
    timer,
    options: {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => {
        timer.tick = fn;
        timer.dueAt = now + ms;
        timer.armed += 1;
        return timer.armed;
      },
      clearTimeout: () => {
        timer.tick = null;
      },
    },
    /** Move the clock to the timer's due time and run it. */
    fire: async () => {
      const tick = timer.tick;
      if (tick === null) throw new Error('no timer armed');
      now = timer.dueAt;
      timer.tick = null;
      tick();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function signed(
  signer: { privateKey: Uint8Array; did: string },
  method: 'GET' | 'POST',
  url: string,
  body?: string,
) {
  const [path, query = ''] = url.split('?');
  const headers = signRequest(
    method,
    path ?? url,
    query,
    new TextEncoder().encode(body ?? ''),
    signer.privateKey,
    signer.did,
  );
  return app.inject({
    method,
    url,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { payload: body }),
  });
}

it('serves Core and the owner’s devices, and says which', async () => {
  expect((await signed(CORE, 'GET', '/api/v1/who')).json()).toEqual({
    kind: 'core',
    did: CORE.did,
  });
  const echo = await signed(OWNER, 'POST', '/api/v1/echo?x=1', '{"a":1}');
  expect(echo.json()).toEqual({ caller: { kind: 'owner_device', did: OWNER.did }, body: { a: 1 } });
});

it('refuses the unsigned, the unknown, the tampered and the replayed; the probes stay open', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/v1/who' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  expect((await signed(STRANGER, 'GET', '/api/v1/who')).statusCode).toBe(401);
  const headers = signRequest(
    'POST',
    '/api/v1/echo',
    '',
    new TextEncoder().encode('{"a":1}'),
    OWNER.privateKey,
    OWNER.did,
  );
  const tampered = await app.inject({
    method: 'POST',
    url: '/api/v1/echo',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: '{"a":2}',
  });
  expect(tampered.statusCode).toBe(401);
  const once = {
    ...signRequest('GET', '/api/v1/who', '', new Uint8Array(), CORE.privateKey, CORE.did),
  };
  expect((await app.inject({ method: 'GET', url: '/api/v1/who', headers: once })).statusCode).toBe(
    200,
  );
  expect((await app.inject({ method: 'GET', url: '/api/v1/who', headers: once })).statusCode).toBe(
    401,
  );
});

it('a device paired after Brain last asked is learnt at once; misses ask Core at most every five seconds', async () => {
  await signed(CORE, 'GET', '/api/v1/who');
  const asked = fetches;
  const later = key(9);
  set = { core: CORE.did, ownerDevices: [OWNER.did, later.did] };
  expect((await signed(later, 'GET', '/api/v1/who')).statusCode).toBe(200);
  expect(fetches).toBe(asked + 1);
  for (let i = 0; i < 3; i += 1)
    expect((await signed(STRANGER, 'GET', '/api/v1/who')).statusCode).toBe(401);
  // That lookup used this five-second slot: the stranger costs Core nothing.
  expect(fetches).toBe(asked + 1);
  now += CALLER_SET_MISS_INTERVAL_MS;
  await signed(STRANGER, 'GET', '/api/v1/who');
  expect(fetches).toBe(asked + 2);
});

it('a revoked owner device stops working once Brain’s copy is thirty seconds old', async () => {
  expect((await signed(OWNER, 'GET', '/api/v1/who')).statusCode).toBe(200);
  set = { core: CORE.did, ownerDevices: [] };
  now += CALLER_SET_TTL_MS;
  expect((await signed(OWNER, 'GET', '/api/v1/who')).statusCode).toBe(401);
});

it('knows no one when Core cannot say', async () => {
  await app.close();
  app = Fastify();
  registerCallerAuth(app, {
    directory: new CallerDirectory(async () => null, { now: () => now }),
  });
  app.get('/api/v1/who', async (req) => callerOf(req));
  await app.ready();
  expect((await signed(CORE, 'GET', '/api/v1/who')).statusCode).toBe(401);
});

describe('review cases', () => {
  it('two calls at once from a just-paired device both get through', async () => {
    await signed(CORE, 'GET', '/api/v1/who');
    const fresh = key(11);
    set = { core: CORE.did, ownerDevices: [OWNER.did, fresh.did] };
    const [a, b] = await Promise.all([
      signed(fresh, 'GET', '/api/v1/who'),
      signed(fresh, 'GET', '/api/v1/who'),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
  });

  it('a copy past thirty seconds is never used, even while Core is silent', async () => {
    expect((await signed(OWNER, 'GET', '/api/v1/who')).statusCode).toBe(200);
    await app.close();
    let answer: CallerSet | null = { core: CORE.did, ownerDevices: [OWNER.did] };
    app = Fastify();
    registerCallerAuth(app, {
      directory: new CallerDirectory(async () => answer, { now: () => now }),
    });
    app.get('/api/v1/who', async (req) => callerOf(req));
    await app.ready();
    expect((await signed(OWNER, 'GET', '/api/v1/who')).statusCode).toBe(200);
    answer = null;
    now += CALLER_SET_TTL_MS;
    expect((await signed(OWNER, 'GET', '/api/v1/who')).statusCode).toBe(401);
  });

  it('a stranger never reaches the replay cache', async () => {
    await app.close();
    const nonces = new NonceCache();
    const spent = jest.spyOn(nonces, 'check');
    app = Fastify();
    registerCallerAuth(app, {
      directory: new CallerDirectory(async () => set, { now: () => now }),
      nonces,
    });
    app.get('/api/v1/who', async (req) => callerOf(req));
    await app.ready();
    expect((await signed(STRANGER, 'GET', '/api/v1/who')).statusCode).toBe(401);
    expect(spent).not.toHaveBeenCalled();
    expect((await signed(CORE, 'GET', '/api/v1/who')).statusCode).toBe(200);
    expect(spent).toHaveBeenCalledTimes(1);
  });

  it('keeps Fastify’s JSON rules: a poisoned or empty body is refused', async () => {
    expect((await signed(OWNER, 'POST', '/api/v1/echo', '{"__proto__":{"x":1}}')).statusCode).toBe(
      400,
    );
    expect(
      (await signed(OWNER, 'POST', '/api/v1/echo', '{"constructor":{"prototype":{}}}')).statusCode,
    ).toBe(400);
    expect((await signed(OWNER, 'POST', '/api/v1/echo', '')).statusCode).toBe(400);
  });

  it('other methods are checked too, and an unknown route answers 401: a stranger learns no route names', async () => {
    expect((await app.inject({ method: 'HEAD', url: '/api/v1/who' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/nothing-here' })).statusCode).toBe(401);
  });
});

describe('round 2: refresh ahead, back off, end streams of callers who left', () => {
  it('one failed ask past half-life refuses no one', async () => {
    let answer: CallerSet | null = { core: CORE.did, ownerDevices: [OWNER.did] };
    const directory = new CallerDirectory(async () => answer, { now: () => now });
    expect(await directory.classify(OWNER.did)).toBe('owner_device');
    answer = null;
    now += CALLER_SET_REFRESH_MS;
    expect(await directory.classify(OWNER.did)).toBe('owner_device');
    await Promise.resolve();
    expect(await directory.classify(CORE.did)).toBe('core');
  });

  it('while Core fails, Brain asks it a bounded number of times, not once per request', async () => {
    let asked = 0;
    const directory = new CallerDirectory(
      async () => {
        asked += 1;
        return null;
      },
      { now: () => now },
    );
    for (let i = 0; i < 50; i += 1) expect(await directory.classify(CORE.did)).toBeNull();
    expect(asked).toBe(1);
    now += CALLER_SET_FAILURE_WAIT_MS;
    for (let i = 0; i < 50; i += 1) await directory.classify(CORE.did);
    expect(asked).toBe(2);
  });

  it('a watched caller that leaves the set is told, without any request arriving', async () => {
    let answer: CallerSet = { core: CORE.did, ownerDevices: [OWNER.did] };
    const fake = fakeTimer();
    const directory = new CallerDirectory(async () => answer, fake.options);
    await directory.classify(OWNER.did);
    const fetchedAt = now;
    const left = jest.fn();
    directory.watch(OWNER.did, left);
    // Aimed at the refresh: half the copy's life.
    expect(fake.timer.dueAt).toBe(fetchedAt + CALLER_SET_REFRESH_MS);
    answer = { core: CORE.did, ownerDevices: [] };
    await fake.fire();
    expect(left).toHaveBeenCalledTimes(1);
    expect(fake.timer.tick).toBeNull(); // no watchers, no timer
  });

  it('while Core fails, a watched stream ends when its copy reaches thirty seconds, not later', async () => {
    let answer: CallerSet | null = { core: CORE.did, ownerDevices: [OWNER.did] };
    const fake = fakeTimer();
    const directory = new CallerDirectory(async () => answer, fake.options);
    await directory.classify(OWNER.did);
    const fetchedAt = now;
    // The stream opens 14 s into the copy's life: a fixed 15 s interval
    // from here would check at +29 s and +44 s, and miss the +30 s ceiling.
    now += 14_000;
    const left = jest.fn();
    directory.watch(OWNER.did, left);
    answer = null;
    while (left.mock.calls.length === 0 && fake.timer.tick !== null) {
      expect(fake.timer.dueAt).toBeLessThanOrEqual(fetchedAt + CALLER_SET_TTL_MS);
      await fake.fire();
    }
    expect(left).toHaveBeenCalledTimes(1);
    expect(now).toBe(fetchedAt + CALLER_SET_TTL_MS);
  });

  it('a watch that ends cancels the timer', async () => {
    const fake = fakeTimer();
    const directory = new CallerDirectory(async () => set, fake.options);
    await directory.classify(OWNER.did);
    const unwatch = directory.watch(OWNER.did, () => undefined);
    expect(fake.timer.tick).not.toBeNull();
    unwatch();
    expect(fake.timer.tick).toBeNull();
  });

  it('a known DID with malformed signature material gets 401, not 500', async () => {
    const good = signRequest(
      'GET',
      '/api/v1/who',
      '',
      new Uint8Array(),
      OWNER.privateKey,
      OWNER.did,
    );
    for (const bad of [{ 'X-Timestamp': 'yesterday' }, { 'X-Signature': 'zz' }]) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/who',
        headers: { ...good, ...bad },
      });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('an open stream ends when its caller leaves', () => {
  it('ends the owner device’s stream once the device is revoked', async () => {
    let answer: CallerSet = { core: CORE.did, ownerDevices: [OWNER.did] };
    const fake = fakeTimer();
    const server = Fastify();
    registerCallerAuth(server, {
      directory: new CallerDirectory(async () => answer, fake.options),
    });
    server.get('/api/v1/stream', async (req, reply) => {
      openEventStream(req, reply);
    });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const port = (server.server.address() as { port: number }).port;
    const headers = signRequest(
      'GET',
      '/api/v1/stream',
      '',
      new Uint8Array(),
      OWNER.privateKey,
      OWNER.did,
    );
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/stream`, { headers });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    await reader?.read(); // the retry line
    answer = { core: CORE.did, ownerDevices: [] };
    await fake.fire();
    const end = await reader?.read();
    expect(end?.done).toBe(true);
    await server.close();
  });

  it('a client that leaves while its caller is checked gets no stream, no watch and no timer', async () => {
    let release: (value: CallerSet) => void = () => undefined;
    const fake = fakeTimer();
    const server = Fastify();
    registerCallerAuth(server, {
      directory: new CallerDirectory(
        () =>
          new Promise<CallerSet>((resolve) => {
            release = resolve;
          }),
        fake.options,
      ),
    });
    const handled = new Promise<boolean>((resolve) => {
      server.get('/api/v1/stream', async (req, reply) => {
        resolve(openEventStream(req, reply));
      });
    });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const port = (server.server.address() as { port: number }).port;
    const headers = signRequest(
      'GET',
      '/api/v1/stream',
      '',
      new Uint8Array(),
      OWNER.privateKey,
      OWNER.did,
    );
    // A plain request (fetch's pool would open a spare idle socket after the abort).
    const client = request({ host: '127.0.0.1', port, path: '/api/v1/stream', headers });
    client.on('error', () => undefined);
    client.end();
    // The caller check is waiting on Core; the client gives up.
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    release({ core: CORE.did, ownerDevices: [OWNER.did] });
    expect(await handled).toBe(false);
    expect(fake.timer.armed).toBe(0);
    await server.close();
  });
});
