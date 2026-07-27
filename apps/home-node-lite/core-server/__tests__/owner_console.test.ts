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
      expect(body).toContain('/v1/owner/setup/coding-agent');
      expect(body).toContain('/v1/owner/setup/coding-agent/');
      expect(body).toContain('/v1/owner/setup/phone');
      expect(body).toContain('/v1/owner/agent-policies');
      expect(body).toContain('/v1/reasoning/backends/register');
      expect(body).toContain('/v1/owner/reasoning/jobs?limit=50');
      expect(body).toContain('/v1/owner/reasoning/');
      expect(body).toContain('Connected Brain work');
      expect(body).toContain('pending');
      expect(body).toContain('Network protection');
      expect(body).toContain('Use this agent as Brain');
      expect(body).toContain('Pair coding agent');
      expect(body).toContain('stale_policies');
      expect(body).toContain("This Home Node's identity changed");
      // The owner can create a poll-mode subscription from this page (Piece 2).
      expect(body).toContain('/v1/watch/create');
      expect(body).toContain('New subscription');
      // Presents the capability header the HTTP adapter validates.
      expect(body).toContain('x-dina-owner-capability');
      // Never targets a Brain-origin proxy path from this page.
      expect(body).not.toContain('/api/v1/run');
      // Self-contained: no external script/style/fetch host.
      expect(body).not.toMatch(/src="https?:\/\//);
      expect(body).not.toMatch(/href="https?:\/\//);
      // XSS-safe: builds DOM with textContent, never innerHTML.
      expect(body).not.toContain('innerHTML');
      const script = body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      expect(script).toBeDefined();
      expect(() => new Function(script as string)).not.toThrow();
      // Framing + CSP hardening headers.
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
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
