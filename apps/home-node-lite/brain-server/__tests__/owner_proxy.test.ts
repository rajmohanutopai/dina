/**
 * Round-A A-07 — the owner run/watch byte-pipe. Brain forwards the SPA's owner
 * calls (method, path, body, and the browser-presented capability header)
 * VERBATIM to Core, and relays Core's response. Brain never mints or injects
 * the capability — a call WITHOUT the header is forwarded header-less (Core
 * 403s it), so a compromised Brain can never originate owner authority.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { registerOwnerProxyRoutes } from '../src/routes/owner_proxy';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function makeApp(captured: Captured[], status = 200, responseBody = '{"ok":true}'): FastifyInstance {
  const app = Fastify({ logger: false });
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    captured.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(responseBody, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  registerOwnerProxyRoutes(app, { coreBaseUrl: 'http://127.0.0.1:8100', fetchFn });
  return app;
}

describe('Brain server — owner run/watch proxy (A-07)', () => {
  it('forwards method, path, body, and the capability header verbatim', async () => {
    const captured: Captured[] = [];
    const app = makeApp(captured);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/run/r-1/pause',
        headers: { 'x-dina-owner-capability': 'cap-123', 'content-type': 'application/json' },
        payload: { idempotency_key: 'k-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0].url).toBe('http://127.0.0.1:8100/v1/run/r-1/pause');
      expect(captured[0].method).toBe('POST');
      expect(captured[0].headers['x-dina-owner-capability']).toBe('cap-123');
      expect(JSON.parse(captured[0].body ?? '{}')).toEqual({ idempotency_key: 'k-1' });
    } finally {
      await app.close();
    }
  });

  it('NEVER injects a capability — a header-less call forwards header-less', async () => {
    const captured: Captured[] = [];
    const app = makeApp(captured, 403, '{"error":"access_denied"}');
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/run/list' });
      expect(res.statusCode).toBe(403); // Core's denial relayed as-is
      expect(captured[0].headers['x-dina-owner-capability']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('forwards watch routes and preserves the query string', async () => {
    const captured: Captured[] = [];
    const app = makeApp(captured);
    try {
      await app.inject({
        method: 'GET',
        url: '/api/v1/watch/list?limit=5',
        headers: { 'x-dina-owner-capability': 'cap-123' },
      });
      expect(captured[0].url).toBe('http://127.0.0.1:8100/v1/watch/list?limit=5');
    } finally {
      await app.close();
    }
  });

  it('an unreachable Core relays as 502, never a hang or a crash', async () => {
    const app = Fastify({ logger: false });
    const failingFetch = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    registerOwnerProxyRoutes(app, { coreBaseUrl: 'http://127.0.0.1:8100', fetchFn: failingFetch });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/run/list',
        headers: { 'x-dina-owner-capability': 'cap-123' },
      });
      expect(res.statusCode).toBe(502);
      expect((res.json() as { error: string }).error).toBe('core_unreachable');
    } finally {
      await app.close();
    }
  });
});
