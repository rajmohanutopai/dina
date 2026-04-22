/**
 * Task 4.85 — GET /metrics endpoint integration tests.
 */

import { pino } from 'pino';
import { createServer } from '../src/server';
import type { CoreServerConfig } from '../src/config';
import { MetricsRegistry } from '../src/metrics/registry';
import { installMetricsHook } from '../src/metrics/hook';
import {
  DEFAULT_METRICS_PATH,
  registerMetricsRoutes,
} from '../src/metrics/routes';
import { PROMETHEUS_CONTENT_TYPE } from '../src/metrics/exporter';

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

async function buildApp() {
  const registry = new MetricsRegistry();
  const app = await createServer({ config: baseConfig(), logger: silentLogger() });
  installMetricsHook(app, { registry });
  registerMetricsRoutes(app, { registry });
  return { app, registry };
}

describe('GET /metrics (task 4.85)', () => {
  describe('content type + status', () => {
    it('returns 200 with Prometheus text content-type on cold boot', async () => {
      const { app } = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe(PROMETHEUS_CONTENT_TYPE);
      expect(res.body).toContain('dina_core_requests_total_all 0');
      await app.close();
    });

    it('body ends with newline (Prometheus parser convention)', async () => {
      const { app } = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.body.endsWith('\n')).toBe(true);
      await app.close();
    });
  });

  describe('live traffic round-trip', () => {
    it('records traffic + renders it in the next scrape', async () => {
      const { app } = await buildApp();
      app.get('/thing', async () => ({ ok: true }));
      app.get('/crash', async () => {
        throw new Error('boom');
      });

      await app.inject({ method: 'GET', url: '/thing' });
      await app.inject({ method: 'GET', url: '/thing' });
      await app.inject({ method: 'GET', url: '/crash' });

      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);

      // /metrics scrape itself counts too — 4 requests before this line,
      // but `/metrics` may have been recorded or not depending on hook
      // order. We assert the core invariants:
      expect(res.body).toContain(
        'dina_core_requests_total{route="/thing",method="GET",status="200"} 2',
      );
      expect(res.body).toContain(
        'dina_core_requests_total{route="/crash",method="GET",status="500"} 1',
      );
      // Error total >= 1 (we hit /crash once).
      const m = /dina_core_requests_error_total (\d+)/.exec(res.body);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeGreaterThanOrEqual(1);
      await app.close();
    });
  });

  describe('custom path', () => {
    it('binds to the caller-supplied path', async () => {
      const registry = new MetricsRegistry();
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      installMetricsHook(app, { registry });
      registerMetricsRoutes(app, { registry, path: '/dina/metrics' });

      const res = await app.inject({ method: 'GET', url: '/dina/metrics' });
      expect(res.statusCode).toBe(200);

      const missing = await app.inject({ method: 'GET', url: '/metrics' });
      expect(missing.statusCode).toBe(404);
      await app.close();
    });
  });

  describe('namePrefix override', () => {
    it('reaches the rendered output', async () => {
      const registry = new MetricsRegistry();
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      installMetricsHook(app, { registry });
      registerMetricsRoutes(app, { registry, namePrefix: 'myapp' });

      registry.record('/x', 'GET', 200, 0.01);
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.body).toContain('myapp_requests_total{');
      expect(res.body).not.toContain('dina_core_requests_total{');
      await app.close();
    });
  });

  describe('construction validation', () => {
    it('rejects missing registry', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      expect(() =>
        registerMetricsRoutes(app, {
          registry: undefined as unknown as MetricsRegistry,
        }),
      ).toThrow(/registry is required/);
      await app.close();
    });

    it('rejects non-slash-prefixed path', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      const registry = new MetricsRegistry();
      expect(() =>
        registerMetricsRoutes(app, { registry, path: 'metrics' }),
      ).toThrow(/must start with/);
      await app.close();
    });
  });

  describe('constants', () => {
    it('DEFAULT_METRICS_PATH is /metrics', () => {
      expect(DEFAULT_METRICS_PATH).toBe('/metrics');
    });
  });
});
