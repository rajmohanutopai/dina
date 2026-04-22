/**
 * Task 4.8 — @fastify/sensible error envelope tests.
 *
 * Validates the canonical error body shape `{error: "<message>"}` across:
 *   - Unknown route → 404
 *   - Thrown Error in handler → 500, masked message
 *   - `reply.notFound()` / `reply.badRequest()` via @fastify/sensible
 *   - Validation failure → 400 with Fastify's generated message
 *   - 5xx paths don't leak the raw thrown message to clients
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

describe('error envelope (task 4.8)', () => {
  it('404 on unknown route returns {error: "not found"}', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
    await app.close();
  });

  it('thrown Error in handler → 500 with masked generic message', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.get('/boom', async () => {
      throw new Error('internal secret detail about db connection');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    // Client sees the generic message — raw detail MUST NOT leak.
    expect(res.json()).toEqual({ error: 'internal server error' });
    await app.close();
  });

  it('reply.notFound() via @fastify/sensible uses the envelope', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.get('/thing/:id', async (req, reply) => {
      return reply.notFound('thing not found');
    });
    const res = await app.inject({ method: 'GET', url: '/thing/abc' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'thing not found' });
    await app.close();
  });

  it('reply.badRequest() → 400 envelope', async () => {
    const app = await createServer({ config: baseConfig(), logger: silentLogger() });
    app.get('/bad', async (_req, reply) => {
      return reply.badRequest('bad query param');
    });
    const res = await app.inject({ method: 'GET', url: '/bad' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad query param' });
    await app.close();
  });

  it('validation failure → 400 envelope (Fastify-generated message)', async () => {
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
      payload: JSON.stringify({}), // missing `name`
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/name|required/i);
    await app.close();
  });

  it('5xx server error is logged (not silently swallowed)', async () => {
    const logged: unknown[] = [];
    const logger: Logger = pino(
      {
        level: 'error',
        formatters: { level: (label) => ({ level: label }) },
        messageKey: 'msg',
        base: null,
      },
      {
        write: (chunk: string | Buffer): boolean => {
          logged.push(JSON.parse(String(chunk)));
          return true;
        },
      },
    );
    const app = await createServer({ config: baseConfig(), logger });
    app.get('/crash', async () => {
      throw new Error('db connection lost');
    });
    await app.inject({ method: 'GET', url: '/crash' });
    await app.close();

    const errorLogs = logged.filter(
      (l): l is { msg: string; err?: { message: string } } =>
        typeof l === 'object' && l !== null && 'msg' in l && (l as { msg: string }).msg === 'request failed (5xx)',
    );
    expect(errorLogs.length).toBe(1);
    expect(errorLogs[0]?.err?.message).toBe('db connection lost');
  });
});
