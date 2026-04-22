/**
 * Task 4.31 — CORS tests.
 *
 * Matches Go Core's `middleware/cors.go` semantics:
 *   - empty `allowOrigin` → no CORS headers emitted (same-origin only)
 *   - "*" → wildcard, no credentials
 *   - comma-separated list → exact-match, credentials enabled
 *
 * Methods, headers, and preflight status pinned identical to Go.
 */

import { pino } from 'pino';
import { createServer } from '../src/server';
import type { Logger } from '../src/logger';
import type { CoreServerConfig } from '../src/config';

function configWithCors(allowOrigin?: string): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'silent', rateLimitPerMinute: 60, prettyLogs: false },
    msgbox: {},
    cors: allowOrigin !== undefined ? { allowOrigin } : {},
  };
}
function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

describe('CORS (task 4.31)', () => {
  describe('disabled (empty / unset allowOrigin)', () => {
    it('no CORS headers emitted when allowOrigin is unset', async () => {
      const app = await createServer({ config: configWithCors(), logger: silentLogger() });
      app.get('/x', async () => ({ ok: true }));
      const res = await app.inject({
        method: 'GET',
        url: '/x',
        headers: { origin: 'https://evil.example' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      await app.close();
    });

    it('no CORS headers emitted when allowOrigin is empty string', async () => {
      const app = await createServer({ config: configWithCors(''), logger: silentLogger() });
      app.get('/x', async () => ({ ok: true }));
      const res = await app.inject({
        method: 'GET',
        url: '/x',
        headers: { origin: 'https://evil.example' },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      await app.close();
    });
  });

  describe('wildcard "*"', () => {
    it('emits Allow-Origin: * on GET', async () => {
      const app = await createServer({ config: configWithCors('*'), logger: silentLogger() });
      app.get('/x', async () => ({ ok: true }));
      const res = await app.inject({
        method: 'GET',
        url: '/x',
        headers: { origin: 'https://anywhere.example' },
      });
      expect(res.headers['access-control-allow-origin']).toBe('*');
      // CORS spec forbids `Allow-Credentials: true` with wildcard origin.
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      await app.close();
    });

    it('preflight OPTIONS returns 204 with Allow-Methods + Allow-Headers', async () => {
      const app = await createServer({ config: configWithCors('*'), logger: silentLogger() });
      app.get('/x', async () => ({ ok: true }));
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/x',
        headers: {
          origin: 'https://any.example',
          'access-control-request-method': 'GET',
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      // Methods + headers match Go's hardcoded set.
      const methods = String(res.headers['access-control-allow-methods'] ?? '');
      for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
        expect(methods).toContain(m);
      }
      const allowedHeaders = String(res.headers['access-control-allow-headers'] ?? '').toLowerCase();
      expect(allowedHeaders).toContain('authorization');
      expect(allowedHeaders).toContain('content-type');
      await app.close();
    });
  });

  describe('exact-match allowlist (credentials enabled)', () => {
    const allowed = 'https://admin.example.com';

    it('emits Allow-Origin: <origin> + credentials when origin matches', async () => {
      const app = await createServer({ config: configWithCors(allowed), logger: silentLogger() });
      app.get('/x', async () => ({ ok: true }));
      const res = await app.inject({
        method: 'GET',
        url: '/x',
        headers: { origin: allowed },
      });
      expect(res.headers['access-control-allow-origin']).toBe(allowed);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      await app.close();
    });

    it('preflight from allowed origin returns 204', async () => {
      const app = await createServer({ config: configWithCors(allowed), logger: silentLogger() });
      app.get('/x', async () => ({ ok: true }));
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/x',
        headers: {
          origin: allowed,
          'access-control-request-method': 'GET',
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(allowed);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      await app.close();
    });

    it('no Allow-Origin when origin is NOT in allowlist', async () => {
      const app = await createServer({ config: configWithCors(allowed), logger: silentLogger() });
      app.get('/x', async () => ({ ok: true }));
      const res = await app.inject({
        method: 'GET',
        url: '/x',
        headers: { origin: 'https://evil.example' },
      });
      // Fastify/CORS omits the Allow-Origin header when the origin isn't
      // in the list — a browser then enforces same-origin for the response.
      expect(res.statusCode).toBe(200);
      // Either no header at all, or explicitly false/undefined. The
      // critical bit is NOT echoing the evil origin.
      const ao = res.headers['access-control-allow-origin'];
      expect(ao === undefined || ao === 'false' || ao === '').toBe(true);
      await app.close();
    });
  });

  describe('comma-separated allowlist', () => {
    const list = 'https://a.example, https://b.example ,https://c.example';

    it('all three origins are accepted with whitespace tolerance', async () => {
      const app = await createServer({ config: configWithCors(list), logger: silentLogger() });
      app.get('/x', async () => ({ ok: true }));

      for (const origin of [
        'https://a.example',
        'https://b.example',
        'https://c.example',
      ]) {
        const res = await app.inject({
          method: 'GET',
          url: '/x',
          headers: { origin },
        });
        expect(res.headers['access-control-allow-origin']).toBe(origin);
      }
      await app.close();
    });

    it('non-listed origin is rejected', async () => {
      const app = await createServer({ config: configWithCors(list), logger: silentLogger() });
      app.get('/x', async () => ({ ok: true }));
      const res = await app.inject({
        method: 'GET',
        url: '/x',
        headers: { origin: 'https://d.example' },
      });
      const ao = res.headers['access-control-allow-origin'];
      expect(ao === undefined || ao === 'false' || ao === '').toBe(true);
      await app.close();
    });
  });
});
