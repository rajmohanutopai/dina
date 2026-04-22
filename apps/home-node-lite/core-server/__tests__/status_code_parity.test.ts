/**
 * Task 4.17 — HTTP status codes parity audit.
 *
 * Pins the status-code contract of every Fastify endpoint this server
 * owns today (app-level routes only — the CoreRouter bind test suite
 * exercises status codes per route for handler-registered routes).
 * If a future change flips a status code, the test diff surfaces it.
 *
 * Go Core parity target:
 *   - /healthz → 200 always (liveness)
 *   - /readyz  → 200 when ready, 503 when any probe fails
 *   - unknown route → 404 with `{error}` envelope
 *   - thrown Error (5xx) → 500 with masked `"internal server error"`
 *   - @fastify/sensible helpers → each status per the HTTP standard
 *   - validation failure → 400
 *   - HEAD on GET route → 200 (auto-wired)
 *   - verb mismatch on registered path → 404 (Fastify default, NOT 405)
 *
 * This file is the single source of truth for "what status code does
 * Core emit for <situation>" at the Fastify layer. Tests elsewhere
 * cover the individual helpers; this audit lists them side-by-side.
 */

import { pino } from 'pino';
import { createServer, type ReadinessCheck } from '../src/server';
import type { Logger } from '../src/logger';
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
function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

describe('HTTP status code parity audit (task 4.17)', () => {
  describe('2xx success codes', () => {
    it('GET /healthz → 200', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('HEAD /healthz → 200 (Fastify auto-wires HEAD)', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      const res = await app.inject({ method: 'HEAD', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('GET /readyz → 200 when no checks or all pass', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('GET /readyz → 200 with mixed-but-all-passing checks', async () => {
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
      await app.close();
    });
  });

  describe('4xx client-error codes', () => {
    it('POST /v1/validate with missing required field → 400', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.post('/v1/validate', {
        schema: {
          body: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
          },
        },
        handler: async () => ({ ok: true }),
      });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/validate',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('reply.unauthorized() → 401', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.get('/u', async (_req, reply) => reply.unauthorized());
      const res = await app.inject({ method: 'GET', url: '/u' });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('reply.forbidden() → 403', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.get('/f', async (_req, reply) => reply.forbidden());
      const res = await app.inject({ method: 'GET', url: '/f' });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it('unknown path → 404', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      const res = await app.inject({ method: 'GET', url: '/no-such-route' });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('reply.notFound() → 404 (explicit)', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.get('/n', async (_req, reply) => reply.notFound());
      const res = await app.inject({ method: 'GET', url: '/n' });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('verb mismatch on registered path → 404 (NOT 405)', async () => {
      // Fastify's default is 404 for "path matches but method doesn't".
      // We don't configure 405 semantics — this test pins that choice.
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.post('/v1/thing', async () => ({ ok: true }));
      const res = await app.inject({ method: 'GET', url: '/v1/thing' });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('reply.conflict() → 409', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.get('/c', async (_req, reply) => reply.conflict());
      const res = await app.inject({ method: 'GET', url: '/c' });
      expect(res.statusCode).toBe(409);
      await app.close();
    });

    it('body over 2 MiB limit → 413 Payload Too Large', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.post('/big', async () => ({ ok: true }));
      // 3 MiB body > our 2 MiB bodyLimit (task 4.32).
      const payload = JSON.stringify({ blob: 'x'.repeat(3 * 1024 * 1024) });
      const res = await app.inject({
        method: 'POST',
        url: '/big',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode).toBe(413);
      await app.close();
    });
  });

  describe('5xx server-error codes', () => {
    it('thrown Error in handler → 500 (masked message)', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.get('/crash', async () => {
        throw new Error('raw internal detail');
      });
      const res = await app.inject({ method: 'GET', url: '/crash' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal server error' });
      await app.close();
    });

    it('GET /readyz → 503 when any probe fails', async () => {
      const checks: ReadinessCheck[] = [{ name: 'db', probe: () => false }];
      const app = await createServer({
        config: baseConfig(),
        logger: silentLogger(),
        readinessChecks: checks,
      });
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      await app.close();
    });

    it('GET /readyz → 503 when probe throws', async () => {
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
      await app.close();
    });
  });

  describe('status code parity summary (canonical mapping)', () => {
    // This test documents the full status-code decision matrix as a
    // data-driven summary. It doesn't add new behavior — just pins the
    // canonical mapping in one readable place.
    const matrix = [
      { situation: 'healthy liveness', status: 200 },
      { situation: 'healthy readiness', status: 200 },
      { situation: 'validation failure', status: 400 },
      { situation: 'auth failure', status: 401 },
      { situation: 'authz failure', status: 403 },
      { situation: 'unknown route', status: 404 },
      { situation: 'verb mismatch', status: 404 }, // Fastify default
      { situation: 'resource not found', status: 404 },
      { situation: 'resource conflict', status: 409 },
      { situation: 'payload too large', status: 413 },
      { situation: 'handler throw', status: 500 },
      { situation: 'dependency unhealthy', status: 503 }, // /readyz
    ] as const;

    it('canonical matrix has expected entries', () => {
      // Structural sanity: all status codes are 2xx / 4xx / 5xx.
      for (const entry of matrix) {
        expect(entry.status).toBeGreaterThanOrEqual(200);
        expect(entry.status).toBeLessThan(600);
        expect([200, 400, 401, 403, 404, 409, 413, 500, 503]).toContain(entry.status);
      }
      // No duplicate (situation) entries.
      const seen = new Set<string>();
      for (const entry of matrix) {
        expect(seen.has(entry.situation)).toBe(false);
        seen.add(entry.situation);
      }
    });
  });
});
