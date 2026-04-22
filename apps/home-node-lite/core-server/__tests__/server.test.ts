/**
 * Task 4.6 (server half) + 4.10 — Fastify server + /healthz + /readyz tests.
 *
 * Uses Fastify's `inject()` — no real port binding, no cleanup overhead.
 */

import { pino } from 'pino';
import { createServer, type ReadinessCheck } from '../src/server';
import type { CoreServerConfig } from '../src/config';

function baseConfig(): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'silent', rateLimitPerMinute: 60, prettyLogs: false },
    msgbox: {},
    cors: {},
  };
}

function silentLogger() {
  return pino({ level: 'silent' });
}

describe('core-server Fastify app (tasks 4.6 + 4.10)', () => {
  describe('/healthz (liveness)', () => {
    it('returns 200 + status ok', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; version: string };
      expect(body.status).toBe('ok');
      expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
      await app.close();
    });

    it('does NOT probe readiness checks (liveness is decoupled)', async () => {
      const failing: ReadinessCheck = {
        name: 'db',
        probe: () => false,
      };
      const app = await createServer({
        config: baseConfig(),
        logger: silentLogger(),
        readinessChecks: [failing],
      });
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      // /healthz stays 200 even when /readyz would fail.
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  describe('/readyz (readiness)', () => {
    it('returns 200 with no checks configured', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; checks: Record<string, string> };
      expect(body.status).toBe('ok');
      expect(body.checks).toEqual({});
      await app.close();
    });

    it('returns 200 when all checks pass', async () => {
      const checks: ReadinessCheck[] = [
        { name: 'db', probe: () => true },
        { name: 'msgbox', probe: async () => true },
      ];
      const app = await createServer({
        config: baseConfig(),
        logger: silentLogger(),
        readinessChecks: checks,
      });
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; checks: Record<string, string> };
      expect(body.status).toBe('ok');
      expect(body.checks).toEqual({ db: 'ok', msgbox: 'ok' });
      await app.close();
    });

    it('returns 503 with per-check fail labels when any check fails', async () => {
      const checks: ReadinessCheck[] = [
        { name: 'db', probe: () => true },
        { name: 'msgbox', probe: () => false },
      ];
      const app = await createServer({
        config: baseConfig(),
        logger: silentLogger(),
        readinessChecks: checks,
      });
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { status: string; checks: Record<string, string> };
      expect(body.status).toBe('not_ready');
      expect(body.checks).toEqual({ db: 'ok', msgbox: 'fail' });
      await app.close();
    });

    it('treats probe exceptions as fail (does not crash the handler)', async () => {
      const checks: ReadinessCheck[] = [
        {
          name: 'db',
          probe: () => {
            throw new Error('connection refused');
          },
        },
      ];
      const app = await createServer({
        config: baseConfig(),
        logger: silentLogger(),
        readinessChecks: checks,
      });
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { status: string; checks: Record<string, string> };
      expect(body.checks['db']).toBe('fail');
      await app.close();
    });

    it('async probes are awaited before aggregating', async () => {
      let probeDone = false;
      const checks: ReadinessCheck[] = [
        {
          name: 'slow-check',
          probe: async () => {
            await new Promise((r) => setTimeout(r, 5));
            probeDone = true;
            return true;
          },
        },
      ];
      const app = await createServer({
        config: baseConfig(),
        logger: silentLogger(),
        readinessChecks: checks,
      });
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(probeDone).toBe(true);
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  describe('Fastify config', () => {
    it('bodyLimit is set to 2 MiB (task 4.32 spec)', async () => {
      // Assert the runtime cap via request sizes — 1.5 MiB passes
      // (above Fastify default 1 MiB, below our 2 MiB limit) while
      // 3 MiB is rejected as 413. The dedicated bodyLimit-rejection
      // test is in `__tests__/status_code_parity.test.ts`.
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.post('/echo-size', async (req) => ({ size: JSON.stringify(req.body).length }));

      // 1.5 MiB fits under the 2 MiB cap — expect 200.
      const fits = 'x'.repeat(Math.floor(1.5 * 1024 * 1024));
      const underCap = await app.inject({
        method: 'POST',
        url: '/echo-size',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ blob: fits }),
      });
      expect(underCap.statusCode).toBe(200);

      // 3 MiB exceeds the cap — expect 413.
      const exceeds = 'x'.repeat(3 * 1024 * 1024);
      const overCap = await app.inject({
        method: 'POST',
        url: '/echo-size',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ blob: exceeds }),
      });
      expect(overCap.statusCode).toBe(413);

      await app.close();
    });
  });
});
