/**
 * WEB_OWNER_SURFACE_PLAN §3.4 — Brain lets the Core-served page read its
 * /api/* cross-origin, and nobody else.
 *
 * Pinned: only listed origins get CORS headers; only on /api/*; no
 * credentials; the preflight admits JSON bodies; a bad origin fails boot; an
 * event stream (which writes its head to the socket) still carries the CORS
 * header, checked on the real notifications route over a real socket; and a
 * page from any other origin cannot WRITE either (a no-preflight post is
 * refused before its handler runs).
 */

import * as http from 'node:http';

import Fastify, { type FastifyInstance } from 'fastify';

import { registerHostAllowlistGuard } from '../src/host_guard';
import { registerNotificationApiRoutes } from '../src/routes/notifications';
import { parseWebOrigins, registerOriginGuard, registerWebOriginCors } from '../src/web_origin';

const CORE = 'http://127.0.0.1:8100';
const CORE_LOCALHOST = 'http://localhost:8100';

describe('parseWebOrigins', () => {
  it('reads a comma-separated list of exact origins', () => {
    expect(parseWebOrigins(undefined)).toEqual([]);
    expect(parseWebOrigins('')).toEqual([]);
    expect(parseWebOrigins(` ${CORE} , ${CORE_LOCALHOST},${CORE}`)).toEqual([CORE, CORE_LOCALHOST]);
    expect(parseWebOrigins('https://node.example:8443/')).toEqual(['https://node.example:8443']);
  });

  it.each([
    ['a wildcard', '*'],
    ['not http(s)', 'file:///etc'],
    ['a page URL, not an origin', 'http://127.0.0.1:8100/app/'],
    ['a query', 'http://127.0.0.1:8100?x=1'],
    ['credentials', 'http://user:pw@127.0.0.1:8100'],
  ])('refuses %s', (_label, raw) => {
    expect(() => parseWebOrigins(raw)).toThrow(/DINA_BRAIN_WEB_ORIGIN/);
  });
});

let chatResets = 0;

/** Brain's front door as boot builds it: host guard, origin guard, CORS. */
async function appWith(origins: string[]): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerHostAllowlistGuard(app);
  registerOriginGuard(app, origins);
  await registerWebOriginCors(app, origins);
  app.get('/api/v1/contacts', async () => ({ contacts: [] }));
  app.post('/api/v1/chat', async () => ({ ok: true }));
  app.post('/api/v1/chat/reset', async () => {
    chatResets++;
    return { ok: true };
  });
  app.get('/dev', async () => 'dev page');
  app.get('/readyz', async () => ({ status: 'ok' }));
  registerNotificationApiRoutes(app);
  await app.ready();
  return app;
}

describe('CORS for the Core-served page', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  it('a listed origin may read /api/*, without credentials', async () => {
    app = await appWith([CORE, CORE_LOCALHOST]);
    for (const origin of [CORE, CORE_LOCALHOST]) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/contacts', headers: { origin } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(String(res.headers.vary)).toMatch(/origin/i);
    }
  });

  it('the preflight admits a JSON POST from a listed origin', async () => {
    app = await appWith([CORE]);
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/chat',
      headers: {
        origin: CORE,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(CORE);
    expect(String(res.headers['access-control-allow-methods'])).toContain('POST');
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toBe('content-type');
  });

  it('any other origin gets no CORS header, so the browser keeps the answer from it', async () => {
    app = await appWith([CORE]);
    for (const origin of [
      'http://evil.example',
      'http://127.0.0.1:8200',
      'http://127.0.0.1:81000',
      'null',
    ]) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/contacts', headers: { origin } });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      const pre = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/chat',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
      expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('only /api/* is shared, even with a listed origin', async () => {
    app = await appWith([CORE]);
    const res = await app.inject({ method: 'GET', url: '/readyz', headers: { origin: CORE } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('with nothing listed, Brain sends no CORS header at all (as before)', async () => {
    app = await appWith([]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/contacts',
      headers: { origin: CORE },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a page from another origin cannot write: a no-preflight post is refused before its handler', async () => {
    app = await appWith([CORE]);
    chatResets = 0;
    for (const origin of ['http://evil.example', 'null', 'http://127.0.0.1:8101']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/reset',
        headers: { origin, 'content-type': 'text/plain' },
        payload: '',
      });
      expect([origin, res.statusCode]).toEqual([origin, 403]);
      expect(res.json()).toEqual({ error: 'origin_not_allowed' });
    }
    expect(chatResets).toBe(0);
  });

  it('the listed page, Brain’s own /dev page and callers with no Origin still write', async () => {
    app = await appWith([CORE]);
    chatResets = 0;
    const listed = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/reset',
      headers: { origin: CORE },
    });
    expect(listed.statusCode).toBe(200);
    const own = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/reset',
      headers: { host: '127.0.0.1:8200', origin: 'http://127.0.0.1:8200' },
    });
    expect(own.statusCode).toBe(200);
    const noOrigin = await app.inject({ method: 'POST', url: '/api/v1/chat/reset' });
    expect(noOrigin.statusCode).toBe(200);
    expect(chatResets).toBe(3);
  });

  it('with nothing listed, only Brain’s own pages may drive it', async () => {
    app = await appWith([]);
    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/reset',
      headers: { origin: CORE },
    });
    expect(other.statusCode).toBe(403);
    const dev = await app.inject({
      method: 'GET',
      url: '/dev',
      headers: { host: 'localhost:8200', origin: 'http://localhost:8200' },
    });
    expect(dev.statusCode).toBe(200);
  });

  it('an event stream carries the CORS header too (real route, real socket)', async () => {
    app = await appWith([CORE]);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as { port: number };
    const read = (origin: string): Promise<http.IncomingMessage> =>
      new Promise((resolve, reject) => {
        const req = http.get(
          { host: '127.0.0.1', port, path: '/api/v1/notifications/stream', headers: { origin } },
          (res) => {
            resolve(res);
            req.destroy();
          },
        );
        req.on('error', (err) => {
          // Destroying the request after the head arrives is expected.
          if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
        });
      });
    const listed = await read(CORE);
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['content-type']).toBe('text/event-stream');
    expect(listed.headers['access-control-allow-origin']).toBe(CORE);
    const other = await read('http://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});
