/**
 * Tasks 4.88 + 4.89 — Fastify metrics hook integration tests.
 */

import { pino } from 'pino';
import { createServer } from '../src/server';
import type { CoreServerConfig } from '../src/config';
import { MetricsRegistry } from '../src/metrics/registry';
import { installMetricsHook } from '../src/metrics/hook';

function baseConfig(): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'silent', rateLimitPerMinute: 10_000, prettyLogs: false },
    msgbox: {},
    cors: {},
  };
}

function silentLogger() {
  return pino({ level: 'silent' });
}

async function buildApp(registry: MetricsRegistry) {
  const app = await createServer({ config: baseConfig(), logger: silentLogger() });
  installMetricsHook(app, { registry });
  return app;
}

describe('installMetricsHook (tasks 4.88 + 4.89)', () => {
  it('records one observation per request with matched route pattern', async () => {
    const registry = new MetricsRegistry();
    const app = await buildApp(registry);
    app.get('/v1/things/:id', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/v1/things/abc' });
    expect(res.statusCode).toBe(200);

    const snap = registry.snapshot();
    expect(snap.totalRequests).toBe(1);
    expect(snap.counters).toHaveLength(1);
    expect(snap.counters[0]).toMatchObject({
      route: '/v1/things/:id', // pattern, not filled URL
      method: 'GET',
      status: 200,
      count: 1,
    });
    await app.close();
  });

  it('unknown route (404) keyed as route="unknown"', async () => {
    const registry = new MetricsRegistry();
    const app = await buildApp(registry);
    const res = await app.inject({ method: 'GET', url: '/no-such-route' });
    expect(res.statusCode).toBe(404);
    const snap = registry.snapshot();
    expect(snap.counters).toHaveLength(1);
    expect(snap.counters[0]).toMatchObject({ route: 'unknown', status: 404 });
    expect(snap.totalErrors).toBe(1);
    await app.close();
  });

  it('records 5xx from throwing handler as status=500 error', async () => {
    const registry = new MetricsRegistry();
    const app = await buildApp(registry);
    app.get('/crash', async () => {
      throw new Error('boom');
    });
    const res = await app.inject({ method: 'GET', url: '/crash' });
    expect(res.statusCode).toBe(500);
    const snap = registry.snapshot();
    expect(snap.counters).toHaveLength(1);
    expect(snap.counters[0]).toMatchObject({ route: '/crash', status: 500 });
    expect(snap.totalErrors).toBe(1);
    await app.close();
  });

  it('multiple concurrent requests produce one observation each', async () => {
    const registry = new MetricsRegistry();
    const app = await buildApp(registry);
    app.get('/thing', async () => ({ ok: true }));

    await Promise.all([
      app.inject({ method: 'GET', url: '/thing' }),
      app.inject({ method: 'GET', url: '/thing' }),
      app.inject({ method: 'GET', url: '/thing' }),
    ]);
    const snap = registry.snapshot();
    expect(snap.totalRequests).toBe(3);
    expect(snap.counters[0]!.count).toBe(3);
    await app.close();
  });

  it('observes a real (non-zero, finite) duration from reply.elapsedTime', async () => {
    const registry = new MetricsRegistry();
    const app = await buildApp(registry);
    app.get('/timed', async () => ({ ok: true }));
    await app.inject({ method: 'GET', url: '/timed' });

    const h = registry.snapshot().histograms[0]!;
    expect(h.count).toBe(1);
    expect(h.sum).toBeGreaterThanOrEqual(0);
    expect(h.sum).toBeLessThan(10); // well within the largest default bucket
    // Exactly one bucket OR overflow received the observation.
    const placed =
      h.buckets.reduce((n, b) => n + b.count, 0) + h.overflow;
    expect(placed).toBe(1);
    await app.close();
  });

  it('short-circuiting 415 (content-type check) IS recorded', async () => {
    // Regression guard: server.ts enforces Content-Type in an
    // onRequest hook that sends 415 directly. Fastify skips
    // subsequent onRequest hooks when a prior one ends the request,
    // so a symbol-stashed start-time approach would miss these
    // observations entirely. reply.elapsedTime is always set, so
    // this test pins the correctness of the onResponse-only path.
    const registry = new MetricsRegistry();
    const app = await buildApp(registry);
    app.post('/strict', async (req) => req.body as object);
    const res = await app.inject({
      method: 'POST',
      url: '/strict',
      headers: { 'content-type': 'text/plain' },
      payload: 'not json',
    });
    expect(res.statusCode).toBe(415);
    const snap = registry.snapshot();
    expect(snap.totalRequests).toBe(1);
    expect(snap.totalErrors).toBe(1);
    expect(snap.counters[0]).toMatchObject({
      route: '/strict',
      method: 'POST',
      status: 415,
      count: 1,
    });
    await app.close();
  });

  it('different routes produce separate histograms', async () => {
    const registry = new MetricsRegistry();
    const app = await buildApp(registry);
    app.get('/a', async () => ({ ok: true }));
    app.get('/b', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/a' });
    await app.inject({ method: 'GET', url: '/b' });
    await app.inject({ method: 'GET', url: '/a' });

    const snap = registry.snapshot();
    expect(snap.histograms).toHaveLength(2);
    const byRoute = Object.fromEntries(snap.histograms.map((h) => [h.route, h.count]));
    expect(byRoute['/a']).toBe(2);
    expect(byRoute['/b']).toBe(1);
    await app.close();
  });

  it('method is captured uppercased (POST)', async () => {
    const registry = new MetricsRegistry();
    const app = await buildApp(registry);
    app.post('/thing', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/thing',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(registry.snapshot().counters[0]!.method).toBe('POST');
    await app.close();
  });

  it('construction rejects missing registry', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    expect(() =>
      installMetricsHook(app, { registry: undefined as unknown as MetricsRegistry }),
    ).toThrow(/registry is required/);
    await app.close();
  });
});
