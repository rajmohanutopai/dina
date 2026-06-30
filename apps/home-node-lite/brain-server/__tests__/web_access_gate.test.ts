/**
 * Web access gate (D4) — the brain's /api/v1 surface must require the
 * per-process session cookie that it issues on /web/* loads. Driven
 * against a real Fastify instance via `inject` so the onRequest-hook
 * integration (cookie issuance, 401 enforcement, dev-open bypass,
 * ungated health) is exercised exactly as in boot.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import {
  createWebAccessGate,
  parseCookie,
  WEB_SESSION_COOKIE,
} from '../src/web_access_gate';

const SECRET = 'a'.repeat(64);

function makeApp(opts: { devOpen?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const gate = createWebAccessGate({ secret: SECRET, devOpen: opts.devOpen });
  app.addHook('onRequest', gate.onRequest);
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/web/index.html', async () => 'spa');
  app.get('/api/v1/ping', async () => ({ pong: true }));
  app.post('/api/v1/write', async () => ({ written: true }));
  return app;
}

function cookieHeader(value: string): { cookie: string } {
  return { cookie: `${WEB_SESSION_COOKIE}=${value}` };
}

describe('parseCookie', () => {
  it('extracts the named value, trimming whitespace', () => {
    expect(parseCookie('a=1; dina_web_session=xyz ; b=2', WEB_SESSION_COOKIE)).toBe('xyz');
    expect(parseCookie('a=1', WEB_SESSION_COOKIE)).toBeNull();
    expect(parseCookie(undefined, WEB_SESSION_COOKIE)).toBeNull();
  });
});

describe('Web access gate — gated (default)', () => {
  it('REFUSES an unauthenticated /web load (no cookie, no token) → 401 + NO cookie', async () => {
    // The core of the fix: a /web visitor without the out-of-band token must
    // NOT be handed the session secret — else any local process can curl /web,
    // read the secret off Set-Cookie, and replay it on /api/v1.
    const app = makeApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/web/index.html' });
      expect(res.statusCode).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.body).not.toContain(SECRET); // the secret never leaks in the body
    } finally {
      await app.close();
    }
  });

  it('mints the cookie + 302-redirects (token stripped) on /web/?token=<secret>', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({ method: 'GET', url: `/web/index.html?token=${SECRET}` });
      expect(res.statusCode).toBe(302);
      // Redirect to the clean path so the token doesn't linger in the URL bar.
      expect(res.headers['location']).toBe('/web/index.html');
      const setCookie = res.headers['set-cookie'];
      const raw = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie ?? '');
      expect(raw).toContain(`${WEB_SESSION_COOKIE}=${SECRET}`);
      expect(raw).toContain('HttpOnly');
      expect(raw).toContain('SameSite=Strict');
    } finally {
      await app.close();
    }
  });

  it('REFUSES /web/?token=<wrong> → 401 + NO cookie', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/web/index.html?token=${'b'.repeat(64)}`,
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('serves /web/* (no re-issue) once the request carries the valid cookie', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/web/index.html',
        headers: cookieHeader(SECRET),
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('spa');
      expect(res.headers['set-cookie']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('401s /api/v1/* without the cookie (other local process / cross-origin)', async () => {
    const app = makeApp();
    try {
      expect((await app.inject({ method: 'GET', url: '/api/v1/ping' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/v1/write' })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('401s /api/v1/* with a WRONG cookie value', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/ping',
        headers: cookieHeader('b'.repeat(64)),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('allows /api/v1/* with the correct cookie', async () => {
    const app = makeApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/ping',
        headers: cookieHeader(SECRET),
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { pong: boolean }).pong).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('leaves /healthz ungated', async () => {
    const app = makeApp();
    try {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('Web access gate — dev-open (DINA_BRAIN_DEV_OPEN=1)', () => {
  it('lets /api/v1/* through with no cookie, and issues no cookie', async () => {
    const app = makeApp({ devOpen: true });
    try {
      const api = await app.inject({ method: 'GET', url: '/api/v1/ping' });
      expect(api.statusCode).toBe(200);
      const web = await app.inject({ method: 'GET', url: '/web/index.html' });
      expect(web.headers['set-cookie']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
