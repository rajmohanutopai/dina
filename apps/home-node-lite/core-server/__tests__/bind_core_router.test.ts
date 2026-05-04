/**
 * Task 4.13 — walk CoreRouter → Fastify route binding tests.
 *
 * Uses a real Fastify instance (via `createServer`) + a real
 * `CoreRouter` with a handful of representative handlers. Exercises
 * the binding end-to-end via Fastify's `inject()`.
 */

import { pino } from 'pino';

import { CoreRouter, deriveDIDKey, getPublicKey, signRequest } from '@dina/core';
import {
  registerPublicKeyResolver,
  registerService,
  resetCallerTypeState,
  resetMiddlewareState,
} from '@dina/core/runtime';

import { createServer } from '../src/server';
import { bindCoreRouter } from '../src/server/bind_core_router';

import type { CoreServerConfig } from '../src/config';
import type { Logger } from '../src/logger';

const TEST_SEED = new Uint8Array([
  0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0xc4,
  0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae, 0x7f, 0x60,
]);
const TEST_PUB = getPublicKey(TEST_SEED);
const TEST_DID = deriveDIDKey(TEST_PUB);

function baseConfig(): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'silent', rateLimitPerMinute: 60, prettyLogs: false },
    msgbox: {},
    cors: {},
  };
}

function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

function resetAuth(): void {
  resetMiddlewareState();
  resetCallerTypeState();
}

function registerBrainCaller(): void {
  resetAuth();
  registerPublicKeyResolver((did) => (did === TEST_DID ? TEST_PUB : null));
  registerService(TEST_DID, 'brain');
}

describe('bindCoreRouter (task 4.13)', () => {
  afterEach(() => {
    resetAuth();
  });

  it('binds a GET handler that returns a CoreResponse', async () => {
    const coreRouter = new CoreRouter();
    coreRouter.get(
      '/v1/thing',
      () => ({ status: 200, body: { ok: true, via: 'core' } }),
      { auth: 'public' },
    );

    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    const count = bindCoreRouter({ coreRouter, app });
    expect(count).toBe(1);

    const res = await app.inject({ method: 'GET', url: '/v1/thing' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, via: 'core' });
    await app.close();
  });

  it('binds all four verbs', async () => {
    const coreRouter = new CoreRouter();
    coreRouter
      .get('/g', () => ({ status: 200, body: { v: 'get' } }), { auth: 'public' })
      .post('/p', () => ({ status: 201, body: { v: 'post' } }), { auth: 'public' })
      .put('/u', () => ({ status: 200, body: { v: 'put' } }), { auth: 'public' })
      .delete('/d', () => ({ status: 204 }), { auth: 'public' });

    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    expect(bindCoreRouter({ coreRouter, app })).toBe(4);

    expect((await app.inject({ method: 'GET', url: '/g' })).json()).toEqual({ v: 'get' });
    expect((await app.inject({ method: 'POST', url: '/p' })).statusCode).toBe(201);
    expect((await app.inject({ method: 'PUT', url: '/u' })).json()).toEqual({ v: 'put' });
    const delRes = await app.inject({ method: 'DELETE', url: '/d' });
    expect(delRes.statusCode).toBe(204);

    await app.close();
  });

  it('passes path params through', async () => {
    const coreRouter = new CoreRouter();
    coreRouter.get(
      '/v1/items/:id',
      (req) => ({ status: 200, body: { id: req.params['id'] } }),
      { auth: 'public' },
    );

    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    bindCoreRouter({ coreRouter, app });

    const res = await app.inject({ method: 'GET', url: '/v1/items/abc-123' });
    expect(res.json()).toEqual({ id: 'abc-123' });
    await app.close();
  });

  it('passes query string through as Record<string,string>', async () => {
    const coreRouter = new CoreRouter();
    coreRouter.get(
      '/v1/search',
      (req) => ({ status: 200, body: { q: req.query } }),
      { auth: 'public' },
    );

    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    bindCoreRouter({ coreRouter, app });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/search?q=hello&limit=10',
    });
    expect(res.json()).toEqual({ q: { q: 'hello', limit: '10' } });
    await app.close();
  });

  it('JSON body is parsed AND rawBody is populated', async () => {
    const coreRouter = new CoreRouter();
    coreRouter.post(
      '/v1/echo',
      (req) => ({
        status: 200,
        body: {
          parsed: req.body,
          rawLen: req.rawBody.length,
          rawStart: Array.from(req.rawBody.slice(0, 5)),
        },
      }),
      { auth: 'public' },
    );

    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    bindCoreRouter({ coreRouter, app });

    const payload = JSON.stringify({ hello: 'world' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/echo',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      parsed: unknown;
      rawLen: number;
      rawStart: number[];
    };
    expect(body.parsed).toEqual({ hello: 'world' });
    expect(body.rawLen).toBe(Buffer.byteLength(payload));
    // First 5 chars of `{"hello"...` as bytes.
    expect(body.rawStart).toEqual([0x7b, 0x22, 0x68, 0x65, 0x6c]);
    await app.close();
  });

  it('headers propagate (lowercased)', async () => {
    const coreRouter = new CoreRouter();
    coreRouter.get(
      '/v1/hdrs',
      (req) => ({
        status: 200,
        body: { trace: req.headers['x-trace-id'], ua: req.headers['user-agent'] },
      }),
      { auth: 'public' },
    );

    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    bindCoreRouter({ coreRouter, app });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/hdrs',
      headers: { 'X-Trace-Id': 'abc', 'User-Agent': 'jest/1' },
    });
    expect(res.json()).toEqual({ trace: 'abc', ua: 'jest/1' });
    await app.close();
  });

  it('custom response headers flow through to Fastify', async () => {
    const coreRouter = new CoreRouter();
    coreRouter.get(
      '/v1/hdr-out',
      () => ({
        status: 200,
        headers: { 'x-echo': 'hello' },
        body: { ok: true },
      }),
      { auth: 'public' },
    );

    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    bindCoreRouter({ coreRouter, app });

    const res = await app.inject({ method: 'GET', url: '/v1/hdr-out' });
    expect(res.headers['x-echo']).toBe('hello');
    await app.close();
  });

  it('empty body on 204 response does not crash', async () => {
    const coreRouter = new CoreRouter();
    coreRouter.delete('/v1/gone', () => ({ status: 204 }), { auth: 'public' });

    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    bindCoreRouter({ coreRouter, app });

    const res = await app.inject({ method: 'DELETE', url: '/v1/gone' });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    await app.close();
  });

  it('async handler is awaited', async () => {
    const coreRouter = new CoreRouter();
    coreRouter.get(
      '/v1/slow',
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { status: 200, body: { done: true } };
      },
      { auth: 'public' },
    );

    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    bindCoreRouter({ coreRouter, app });

    const res = await app.inject({ method: 'GET', url: '/v1/slow' });
    expect(res.json()).toEqual({ done: true });
    await app.close();
  });

  it('binding 10 routes returns count 10', async () => {
    const coreRouter = new CoreRouter();
    for (let i = 0; i < 10; i++) {
      coreRouter.get(
        `/v1/r${i}`,
        () => ({ status: 200, body: { i } }),
        { auth: 'public' },
      );
    }

    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    const count = bindCoreRouter({ coreRouter, app });
    expect(count).toBe(10);
    expect(count).toBe(coreRouter.size());
    await app.close();
  });

  it('runs CoreRouter auth and rejects unsigned signed routes', async () => {
    registerBrainCaller();
    let called = false;
    const coreRouter = new CoreRouter();
    coreRouter.get('/v1/workflow/tasks', () => {
      called = true;
      return { status: 200, body: { ok: true } };
    });

    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    bindCoreRouter({ coreRouter, app });

    const res = await app.inject({ method: 'GET', url: '/v1/workflow/tasks' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: 'Missing required auth headers (X-DID, X-Timestamp, X-Nonce, X-Signature)',
      rejected_at: 'headers',
    });
    expect(called).toBe(false);
    await app.close();
  });

  it('runs CoreRouter auth and rejects invalid signatures', async () => {
    registerBrainCaller();
    const coreRouter = new CoreRouter();
    coreRouter.get('/v1/workflow/tasks', () => ({ status: 200, body: { ok: true } }));

    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    bindCoreRouter({ coreRouter, app });

    const headers = signRequest(
      'GET',
      '/v1/workflow/other',
      '',
      new Uint8Array(0),
      TEST_SEED,
      TEST_DID,
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/workflow/tasks',
      headers,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: 'Ed25519 signature verification failed',
      rejected_at: 'signature',
    });
    await app.close();
  });

  it('runs CoreRouter auth and accepts valid signed routes', async () => {
    registerBrainCaller();
    const coreRouter = new CoreRouter();
    coreRouter.get('/v1/workflow/tasks', () => ({ status: 200, body: { ok: true } }));

    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    bindCoreRouter({ coreRouter, app });

    const headers = signRequest(
      'GET',
      '/v1/workflow/tasks',
      '',
      new Uint8Array(0),
      TEST_SEED,
      TEST_DID,
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/workflow/tasks',
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it('does not allow HTTP callers to forge trusted in-process dispatch', async () => {
    registerBrainCaller();
    const coreRouter = new CoreRouter();
    coreRouter.get('/v1/workflow/tasks', () => ({ status: 200, body: { ok: true } }));

    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    bindCoreRouter({ coreRouter, app });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/workflow/tasks',
      headers: { trustedInProcess: 'true' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: 'Missing required auth headers (X-DID, X-Timestamp, X-Nonce, X-Signature)',
      rejected_at: 'headers',
    });
    await app.close();
  });
});
