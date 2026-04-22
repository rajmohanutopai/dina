/**
 * Task 4.91 — GET /v1/admin/sync-status tests.
 */

import { pino } from 'pino';
import { createServer } from '../src/server';
import type { CoreServerConfig } from '../src/config';
import {
  SYNC_STATUS_PATH,
  registerSyncStatusRoute,
} from '../src/admin/sync_status';

function baseConfig(): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'silent', rateLimitPerMinute: 10_000, prettyLogs: false },
    msgbox: {},
    cors: {},
  };
}

function silentLogger() {
  return pino({ level: 'silent' });
}

async function buildApp(probe?: () => Promise<boolean>) {
  const app = await createServer({ config: baseConfig(), logger: silentLogger() });
  registerSyncStatusRoute(app, probe ? { brainProbeFn: probe } : {});
  return app;
}

describe('GET /v1/admin/sync-status (task 4.91)', () => {
  describe('path constant', () => {
    it('SYNC_STATUS_PATH is /v1/admin/sync-status (Go wire-parity)', () => {
      expect(SYNC_STATUS_PATH).toBe('/v1/admin/sync-status');
    });
  });

  describe('no probe configured', () => {
    it('returns brain_connected=false, status=degraded', async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/v1/admin/sync-status' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        brain_connected: false,
        status: 'degraded',
      });
      await app.close();
    });
  });

  describe('probe returns true', () => {
    it('brain_connected=true, status=ok', async () => {
      const app = await buildApp(async () => true);
      const res = await app.inject({ method: 'GET', url: '/v1/admin/sync-status' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        brain_connected: true,
        status: 'ok',
      });
      await app.close();
    });
  });

  describe('probe returns false', () => {
    it('brain_connected=false, status=degraded', async () => {
      const app = await buildApp(async () => false);
      const res = await app.inject({ method: 'GET', url: '/v1/admin/sync-status' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        brain_connected: false,
        status: 'degraded',
      });
      await app.close();
    });
  });

  describe('probe throws', () => {
    it('returns 500 with generic error', async () => {
      const app = await buildApp(async () => {
        throw new Error('connection refused');
      });
      const res = await app.inject({ method: 'GET', url: '/v1/admin/sync-status' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'brain probe failed' });
      await app.close();
    });

    it('does NOT leak probe error message to the response body', async () => {
      const app = await buildApp(async () => {
        throw new Error('internal-hostname:18200 ECONNREFUSED');
      });
      const res = await app.inject({ method: 'GET', url: '/v1/admin/sync-status' });
      expect(res.body).not.toContain('internal-hostname');
      expect(res.body).not.toContain('ECONNREFUSED');
      await app.close();
    });
  });

  describe('wire shape invariants (Go parity)', () => {
    it('response body has exactly brain_connected + status keys (no ProxyTarget leak)', async () => {
      const app = await buildApp(async () => true);
      const res = await app.inject({ method: 'GET', url: '/v1/admin/sync-status' });
      const body = res.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['brain_connected', 'status']);
      await app.close();
    });

    it('status is exactly "ok" or "degraded" (no other values)', async () => {
      for (const [connected, expected] of [
        [true, 'ok'],
        [false, 'degraded'],
      ] as const) {
        const app = await buildApp(async () => connected);
        const res = await app.inject({ method: 'GET', url: '/v1/admin/sync-status' });
        expect((res.json() as { status: string }).status).toBe(expected);
        await app.close();
      }
    });
  });

  describe('probe is called once per request', () => {
    it('consecutive requests each invoke the probe', async () => {
      let count = 0;
      const app = await buildApp(async () => {
        count++;
        return true;
      });
      await app.inject({ method: 'GET', url: '/v1/admin/sync-status' });
      await app.inject({ method: 'GET', url: '/v1/admin/sync-status' });
      await app.inject({ method: 'GET', url: '/v1/admin/sync-status' });
      expect(count).toBe(3);
      await app.close();
    });
  });
});
