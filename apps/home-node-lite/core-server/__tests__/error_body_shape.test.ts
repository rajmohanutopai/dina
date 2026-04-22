/**
 * Task 4.18 — error body shape parity audit.
 *
 * The error-envelope shape is `{"error": "<message>"}` — the `error`
 * key name matches Go Core's handler output (`http.Error` writes a
 * plain-text body that Go's JSON middleware wraps as
 * `{"error": ...}`). Exact error MESSAGE strings are deferred to the
 * M5 per-test fixups where tests actually string-match; this file
 * pins the **key name** + **body shape** so any drift surfaces
 * immediately.
 *
 * Task 4.8 (@fastify/sensible envelope) landed the setErrorHandler +
 * setNotFoundHandler that emit this shape. This test file formalises
 * the 4.18 close-out: one authoritative assertion surface for the
 * envelope invariant across every 4xx + 5xx rendering path.
 */

import { pino } from 'pino';
import { createServer } from '../src/server';
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

/**
 * Structural predicate — a valid error envelope has EXACTLY one key
 * (`error`) whose value is a non-empty string. No extra fields, no
 * nested objects, no array-of-errors.
 */
function isErrorEnvelope(body: unknown): body is { error: string } {
  if (body === null || typeof body !== 'object') return false;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'error') return false;
  const val = (body as Record<string, unknown>)['error'];
  return typeof val === 'string' && val.length > 0;
}

describe('error body shape parity (task 4.18)', () => {
  it('404 envelope: {error: "not found"}', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    const body = res.json() as unknown;
    expect(res.statusCode).toBe(404);
    expect(isErrorEnvelope(body)).toBe(true);
    expect(body).toEqual({ error: 'not found' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
    await app.close();
  });

  it('500 envelope: {error: "internal server error"} — message is MASKED', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.get('/crash', async () => {
      throw new Error('DB_HOST=vault.internal password=mega-secret-token');
    });
    const res = await app.inject({ method: 'GET', url: '/crash' });
    const body = res.json() as unknown;
    expect(res.statusCode).toBe(500);
    expect(isErrorEnvelope(body)).toBe(true);
    // Masking invariant: the raw thrown-error detail must NOT reach the client.
    const msg = (body as { error: string }).error;
    expect(msg).toBe('internal server error');
    expect(msg).not.toMatch(/DB_HOST|vault\.internal|mega-secret-token/);
    await app.close();
  });

  it('400 envelope via @fastify/sensible reply.badRequest()', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.get('/bad', async (_req, reply) => {
      return reply.badRequest('bad query param');
    });
    const res = await app.inject({ method: 'GET', url: '/bad' });
    const body = res.json() as unknown;
    expect(res.statusCode).toBe(400);
    expect(isErrorEnvelope(body)).toBe(true);
    expect(body).toEqual({ error: 'bad query param' });
    await app.close();
  });

  it('401 envelope via @fastify/sensible reply.unauthorized()', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.get('/locked', async (_req, reply) => {
      return reply.unauthorized('unauthorised caller');
    });
    const res = await app.inject({ method: 'GET', url: '/locked' });
    const body = res.json() as unknown;
    expect(res.statusCode).toBe(401);
    expect(isErrorEnvelope(body)).toBe(true);
    expect((body as { error: string }).error).toBe('unauthorised caller');
    await app.close();
  });

  it('403 envelope via @fastify/sensible reply.forbidden()', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.get('/locked', async (_req, reply) => {
      return reply.forbidden('not your vault');
    });
    const res = await app.inject({ method: 'GET', url: '/locked' });
    const body = res.json() as unknown;
    expect(res.statusCode).toBe(403);
    expect(isErrorEnvelope(body)).toBe(true);
    expect((body as { error: string }).error).toBe('not your vault');
    await app.close();
  });

  it('404 envelope via @fastify/sensible reply.notFound()', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.get('/thing/:id', async (_req, reply) => {
      return reply.notFound('thing gone');
    });
    const res = await app.inject({ method: 'GET', url: '/thing/x' });
    const body = res.json() as unknown;
    expect(res.statusCode).toBe(404);
    expect(isErrorEnvelope(body)).toBe(true);
    expect((body as { error: string }).error).toBe('thing gone');
    await app.close();
  });

  it('409 envelope via @fastify/sensible reply.conflict()', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.get('/conflict', async (_req, reply) => {
      return reply.conflict('version conflict');
    });
    const res = await app.inject({ method: 'GET', url: '/conflict' });
    const body = res.json() as unknown;
    expect(res.statusCode).toBe(409);
    expect(isErrorEnvelope(body)).toBe(true);
    await app.close();
  });

  it('validation errors (400) follow the same envelope', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.post('/validate', {
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
      url: '/validate',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    const body = res.json() as unknown;
    expect(res.statusCode).toBe(400);
    expect(isErrorEnvelope(body)).toBe(true);
    // Fastify emits a readable validation message — we pin the shape,
    // not the exact string (M5 fixtures pin strings per-test).
    await app.close();
  });

  it('envelope never carries both {error, data} — error is exclusive', async () => {
    // Go's http.Error writes error-only bodies. We pin: when status
    // >= 400, response body has exactly one key, `error`, and nothing
    // else (no `message`, `status`, `code`, etc).
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.get('/boom', async () => {
      throw new Error('boom');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['error']);
    await app.close();
  });
});
