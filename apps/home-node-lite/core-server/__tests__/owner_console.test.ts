/**
 * Round-B B-02 (full fix) — the CORE-SERVED owner console. Core serves a
 * self-contained page whose owner calls target Core's OWN routes same-origin,
 * so the owner capability never transits Brain.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { registerOwnerConsoleRoute } from '../src/server/owner_console';

async function makeApp(enabled: boolean): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerOwnerConsoleRoute(app as never, { enabled });
  await app.ready();
  return app;
}

describe('Core owner console (B-02)', () => {
  it('serves a self-contained HTML page at /owner when enabled', async () => {
    const app = await makeApp(true);
    try {
      const res = await app.inject({ method: 'GET', url: '/owner' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      const body = res.body;
      // Same-origin owner calls — the page hits Core's OWN routes.
      expect(body).toContain('/v1/run/list');
      expect(body).toContain('/v1/run/start');
      expect(body).toContain('/v1/watch/list');
      // Presents the capability header the HTTP adapter validates.
      expect(body).toContain('x-dina-owner-capability');
      // Never targets a Brain-origin proxy path from this page.
      expect(body).not.toContain('/api/v1/run');
      // Self-contained: no external script/style/fetch host.
      expect(body).not.toMatch(/src="https?:\/\//);
      expect(body).not.toMatch(/href="https?:\/\//);
      // XSS-safe: builds DOM with textContent, never innerHTML.
      expect(body).not.toContain('innerHTML');
      // Framing + CSP hardening headers.
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");
    } finally {
      await app.close();
    }
  });

  it('does NOT serve the console when disabled (default off)', async () => {
    const app = await makeApp(false);
    try {
      const res = await app.inject({ method: 'GET', url: '/owner' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('registerOwnerConsoleRoute returns the bound path (enabled) or null (disabled)', async () => {
    const on = Fastify({ logger: false });
    const off = Fastify({ logger: false });
    try {
      expect(registerOwnerConsoleRoute(on as never, { enabled: true })).toBe('/owner');
      expect(registerOwnerConsoleRoute(off as never, { enabled: false })).toBeNull();
    } finally {
      await on.close();
      await off.close();
    }
  });
});
