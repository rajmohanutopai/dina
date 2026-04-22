/**
 * Task 4.29 — error response **keys** match Go (messages tracked in M5).
 *
 * The 4.18 audit pinned the envelope shape `{error: <message>}`. This
 * file closes 4.29 specifically for the Phase 4c auth-middleware error
 * surfaces — once auth lands, the rejections (401 for bad sig, 401 for
 * missing headers, 403 for wrong caller-type, 429 for rate limit, 415
 * for wrong content-type, 413 for body too large) ALL use the same
 * `error` key. No alternate keys (`message`, `statusCode`, `error_code`,
 * `detail`) appear anywhere.
 *
 * Note: task 4.29's parenthetical — "messages tracked in M5" — means
 * this file asserts KEY SHAPE, not exact message strings. M5 fixtures
 * will pin messages per-test where tests actually string-match.
 */

import { pino } from 'pino';
import { createServer } from '../src/server';
import type { Logger } from '../src/logger';
import type { CoreServerConfig } from '../src/config';

function configFor(rateLimitPerMinute = 60): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'silent', rateLimitPerMinute, prettyLogs: false },
    msgbox: {},
    cors: {},
  };
}
function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

/**
 * A body-shape predicate: when status is in the 4xx/5xx range, the
 * response body MUST be exactly `{error: <string>}`. No alternate
 * keys permitted.
 */
function isCanonicalErrorKey(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  const keys = Object.keys(body);
  return keys.length === 1 && keys[0] === 'error';
}

describe('error response keys match Go (task 4.29)', () => {
  it.each([
    ['unknown route 404', 'GET', '/never-exists', {}, 404],
    ['validation 400', 'POST', '/v1/validate', {}, 400],
  ])('%s → single key "error"', async (_label, method, url, payload, expectedStatus) => {
    const app = await createServer({ config: configFor(), logger: silentLogger() });
    // Register validation route for the 400 case.
    if (url === '/v1/validate') {
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
    }
    const res = await app.inject({
      method: method as 'GET' | 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: method === 'POST' ? JSON.stringify(payload) : undefined,
    });
    expect(res.statusCode).toBe(expectedStatus);
    expect(isCanonicalErrorKey(res.json())).toBe(true);
    await app.close();
  });

  it('sensible helpers (400, 401, 403, 404, 409) — all use "error" key', async () => {
    const app = await createServer({ config: configFor(), logger: silentLogger() });
    app.get('/bad', async (_r, reply) => reply.badRequest());
    app.get('/unauth', async (_r, reply) => reply.unauthorized());
    app.get('/forbid', async (_r, reply) => reply.forbidden());
    app.get('/nf', async (_r, reply) => reply.notFound());
    app.get('/conf', async (_r, reply) => reply.conflict());

    for (const url of ['/bad', '/unauth', '/forbid', '/nf', '/conf']) {
      const res = await app.inject({ method: 'GET', url });
      expect(isCanonicalErrorKey(res.json())).toBe(true);
    }
    await app.close();
  });

  it('415 content-type enforcement → "error" key', async () => {
    const app = await createServer({ config: configFor(), logger: silentLogger() });
    app.post('/x', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/x',
      headers: { 'content-type': 'text/plain' },
      payload: 'nope',
    });
    expect(res.statusCode).toBe(415);
    expect(isCanonicalErrorKey(res.json())).toBe(true);
  });

  it('429 rate limit → "error" key', async () => {
    const app = await createServer({ config: configFor(1), logger: silentLogger() });
    app.get('/x', async () => ({ ok: true }));
    await app.ready();
    await app.inject({ method: 'GET', url: '/x' }); // burn budget
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(429);
    expect(isCanonicalErrorKey(res.json())).toBe(true);
    await app.close();
  });

  it('500 masked error → "error" key', async () => {
    const app = await createServer({ config: configFor(), logger: silentLogger() });
    app.get('/boom', async () => {
      throw new Error('internal detail');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(isCanonicalErrorKey(res.json())).toBe(true);
  });

  it('503 readiness failure → "error" key is NOT required (structured body with status + checks)', async () => {
    // Exception to the envelope rule: /readyz is deliberately structured
    // (`{status, checks}`) because ops needs to see which probe failed,
    // not just a single string. Go Core makes the same exception. Pin
    // that exception explicitly so 4.29 readers don't think it's a bug.
    const app = await createServer({
      config: configFor(),
      logger: silentLogger(),
      readinessChecks: [{ name: 'db', probe: () => false }],
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['checks', 'status']);
    expect(body['status']).toBe('not_ready');
    // Explicitly NOT an `error` envelope — structured probe report.
    expect('error' in body).toBe(false);
    await app.close();
  });

  it('NO alternate keys leak — no `message`, `statusCode`, `code`, `detail`, etc.', async () => {
    // Defense-in-depth sweep: if Fastify's serializer ever starts
    // leaking `.statusCode` or `.code` properties into the body, this
    // test catches it.
    const app = await createServer({ config: configFor(), logger: silentLogger() });
    app.get('/boom', async () => {
      const e = new Error('boom') as Error & { statusCode?: number; code?: string };
      e.statusCode = 500;
      e.code = 'INTERNAL_KITCHEN_FIRE';
      throw e;
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['error']);
    const leaks = ['message', 'statusCode', 'code', 'detail', 'errorCode'];
    for (const key of leaks) {
      expect(key in body).toBe(false);
    }
  });
});
