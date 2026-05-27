/**
 * Task 4.30 — rate-limit tests (`@fastify/rate-limit`).
 *
 * Pins the per-DID-or-IP budget behaviour: 60/min default, configurable
 * via `config.runtime.rateLimitPerMinute` (sourced from `DINA_RATE_LIMIT`
 * env var at boot). /healthz + /readyz are exempt so orchestrator probes
 * never get throttled. Rate-limit rejections use the canonical error
 * envelope (`{error: ...}`) per task 4.18.
 */

import { pino } from 'pino';

import { createServer } from '../src/server';

import type { CoreServerConfig } from '../src/config';
import type { Logger } from '../src/logger';

function configWithRateLimit(rateLimitPerMinute: number): CoreServerConfig {
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

describe('rate limit (task 4.30)', () => {
  it('allows up to the configured budget', async () => {
    // Budget = 3 so we can exercise saturation within a test's timeWindow.
    const app = await createServer({ config: configWithRateLimit(3), logger: silentLogger() });
    app.get('/x', async () => ({ ok: true }));
    await app.ready();

    const r1 = await app.inject({ method: 'GET', url: '/x' });
    const r2 = await app.inject({ method: 'GET', url: '/x' });
    const r3 = await app.inject({ method: 'GET', url: '/x' });

    expect([r1.statusCode, r2.statusCode, r3.statusCode]).toEqual([200, 200, 200]);
    await app.close();
  });

  it('rejects the (budget+1)th request from the same caller with 429', async () => {
    const app = await createServer({ config: configWithRateLimit(2), logger: silentLogger() });
    app.get('/x', async () => ({ ok: true }));
    await app.ready();

    // First 2 pass, 3rd is 429 + envelope.
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'GET', url: '/x' });
      expect(res.statusCode).toBe(200);
    }
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(429);
    // Canonical error envelope.
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/rate limit exceeded/);
    await app.close();
  });

  it('rotating X-DID does NOT mint a fresh bucket — edge limiter keys by IP (P2.11)', async () => {
    // The edge limiter runs before signature verification, so X-DID is
    // unauthenticated here. Keying on it would let an attacker rotate X-DID to
    // get a fresh budget every request; the limiter keys by IP instead. (Per-
    // identity limiting is enforced post-verification by Core's auth layer.)
    const app = await createServer({ config: configWithRateLimit(1), logger: silentLogger() });
    app.get('/x', async () => ({ ok: true }));
    await app.ready();

    // First request from this IP uses the 1-req budget.
    const a1 = await app.inject({
      method: 'GET',
      url: '/x',
      headers: { 'x-did': 'did:plc:alice' },
    });
    expect(a1.statusCode).toBe(200);

    // A second request with a DIFFERENT X-DID from the SAME IP is still
    // throttled — rotating the (unauthenticated) DID cannot escape the limit.
    const b1 = await app.inject({ method: 'GET', url: '/x', headers: { 'x-did': 'did:plc:bob' } });
    expect(b1.statusCode).toBe(429);

    await app.close();
  });

  it('/healthz is exempt (orchestrator probes never throttled)', async () => {
    const app = await createServer({ config: configWithRateLimit(1), logger: silentLogger() });
    await app.ready();
    // First request uses the 1-req budget for IP-based caller.
    const r1 = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r1.statusCode).toBe(200);
    // Fire 5 more — all must pass.
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'GET', url: '/healthz' });
      expect(r.statusCode).toBe(200);
    }
    await app.close();
  });

  it('/readyz is exempt', async () => {
    const app = await createServer({ config: configWithRateLimit(1), logger: silentLogger() });
    await app.ready();
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'GET', url: '/readyz' });
      expect(r.statusCode).toBe(200);
    }
    await app.close();
  });

  it('error envelope shape matches task 4.18 ({error: string})', async () => {
    const app = await createServer({ config: configWithRateLimit(1), logger: silentLogger() });
    app.get('/x', async () => ({ ok: true }));
    await app.ready();

    await app.inject({ method: 'GET', url: '/x' }); // consume budget
    const res = await app.inject({ method: 'GET', url: '/x' }); // rejected
    expect(res.statusCode).toBe(429);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['error']);
    expect(typeof body['error']).toBe('string');
    await app.close();
  });
});
