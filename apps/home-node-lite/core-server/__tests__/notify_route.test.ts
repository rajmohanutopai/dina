/**
 * Task 4.36 — /v1/ws/notify route integration tests.
 */

import { pino } from 'pino';
import { createServer } from '../src/server';
import type { CoreServerConfig } from '../src/config';
import { NotifyHub, type WebSocketLike } from '../src/ws/notify_hub';
import {
  DEFAULT_NOTIFY_WS_PATH,
  registerNotifyRoute,
  type NotifyAuthResult,
} from '../src/ws/notify_route';

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

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

describe('registerNotifyRoute (task 4.36)', () => {
  describe('constants', () => {
    it('DEFAULT_NOTIFY_WS_PATH is /v1/ws/notify', () => {
      expect(DEFAULT_NOTIFY_WS_PATH).toBe('/v1/ws/notify');
    });
  });

  describe('auth-gated upgrade', () => {
    it('rejects unauthenticated upgrade with 401', async () => {
      const hub = new NotifyHub();
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      let wsFactoryCalled = false;
      registerNotifyRoute(app, {
        hub,
        authenticate: (): NotifyAuthResult => ({ ok: false, reason: 'missing' }),
        wsFactory: () => {
          wsFactoryCalled = true;
          return new FakeSocket();
        },
      });
      const res = await app.inject({ method: 'GET', url: '/v1/ws/notify' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        error: 'authorization header is required',
      });
      expect(hub.size()).toBe(0);
      expect(wsFactoryCalled).toBe(false);
      await app.close();
    });

    it('401 error message varies by reason', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      registerNotifyRoute(app, {
        hub: new NotifyHub(),
        authenticate: (): NotifyAuthResult => ({ ok: false, reason: 'unknown_token' }),
        wsFactory: () => new FakeSocket(),
      });
      const res = await app.inject({ method: 'GET', url: '/v1/ws/notify' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unknown or revoked token' });
      await app.close();
    });

    it('malformed reason gets its own 401 message', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      registerNotifyRoute(app, {
        hub: new NotifyHub(),
        authenticate: (): NotifyAuthResult => ({ ok: false, reason: 'malformed' }),
        wsFactory: () => new FakeSocket(),
      });
      const res = await app.inject({ method: 'GET', url: '/v1/ws/notify' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        error: 'authorization header is malformed',
      });
      await app.close();
    });

    it('authenticated upgrade calls wsFactory + registers with hub', async () => {
      const hub = new NotifyHub();
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      const socket = new FakeSocket();
      let factoryRequest: unknown = null;
      registerNotifyRoute(app, {
        hub,
        authenticate: (): NotifyAuthResult => ({ ok: true, deviceId: 'dev-1' }),
        wsFactory: (req, _reply, _onDisconnect) => {
          factoryRequest = req;
          return socket;
        },
      });
      await app.inject({
        method: 'GET',
        url: '/v1/ws/notify',
        headers: { authorization: 'Bearer abc' },
      });
      expect(factoryRequest).not.toBeNull();
      expect(hub.hasClient('dev-1')).toBe(true);
      await app.close();
    });
  });

  describe('onDisconnect wiring', () => {
    it('the onDisconnect callback invokes hub.unregister', async () => {
      const hub = new NotifyHub();
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      let capturedOnDisconnect: (() => void) | null = null;
      registerNotifyRoute(app, {
        hub,
        authenticate: (): NotifyAuthResult => ({ ok: true, deviceId: 'dev-1' }),
        wsFactory: (_req, _reply, onDisconnect) => {
          capturedOnDisconnect = onDisconnect;
          return new FakeSocket();
        },
      });
      await app.inject({
        method: 'GET',
        url: '/v1/ws/notify',
        headers: { authorization: 'Bearer abc' },
      });
      expect(hub.hasClient('dev-1')).toBe(true);
      capturedOnDisconnect!();
      expect(hub.hasClient('dev-1')).toBe(false);
      await app.close();
    });
  });

  describe('wsFactory returning null (refused upgrade)', () => {
    it('emits 500 when factory returns null without setting reply', async () => {
      const hub = new NotifyHub();
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      registerNotifyRoute(app, {
        hub,
        authenticate: (): NotifyAuthResult => ({ ok: true, deviceId: 'dev-1' }),
        wsFactory: () => null,
      });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/ws/notify',
        headers: { authorization: 'Bearer abc' },
      });
      expect(res.statusCode).toBe(500);
      expect(hub.size()).toBe(0);
      await app.close();
    });

    it('does NOT emit 500 when factory already responded', async () => {
      const hub = new NotifyHub();
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      registerNotifyRoute(app, {
        hub,
        authenticate: (): NotifyAuthResult => ({ ok: true, deviceId: 'dev-1' }),
        wsFactory: async (_req, reply) => {
          await reply.code(503).send({ error: 'service unavailable' });
          return null;
        },
      });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/ws/notify',
        headers: { authorization: 'Bearer abc' },
      });
      expect(res.statusCode).toBe(503);
      expect(hub.size()).toBe(0);
      await app.close();
    });
  });

  describe('async authenticate', () => {
    it('awaits promise-returning authenticate', async () => {
      const hub = new NotifyHub();
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      registerNotifyRoute(app, {
        hub,
        authenticate: async (): Promise<NotifyAuthResult> => {
          await new Promise<void>((r) => queueMicrotask(r));
          return { ok: true, deviceId: 'dev-1' };
        },
        wsFactory: () => new FakeSocket(),
      });
      await app.inject({
        method: 'GET',
        url: '/v1/ws/notify',
        headers: { authorization: 'Bearer abc' },
      });
      expect(hub.hasClient('dev-1')).toBe(true);
      await app.close();
    });
  });

  describe('custom path', () => {
    it('binds to the caller-supplied path', async () => {
      const hub = new NotifyHub();
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      registerNotifyRoute(app, {
        hub,
        path: '/custom/ws',
        authenticate: (): NotifyAuthResult => ({ ok: true, deviceId: 'dev-x' }),
        wsFactory: () => new FakeSocket(),
      });
      await app.inject({
        method: 'GET',
        url: '/custom/ws',
        headers: { authorization: 'Bearer abc' },
      });
      expect(hub.hasClient('dev-x')).toBe(true);
      // Default path is 404 when overridden.
      const miss = await app.inject({ method: 'GET', url: '/v1/ws/notify' });
      expect(miss.statusCode).toBe(404);
      await app.close();
    });
  });

  describe('construction validation', () => {
    it('rejects missing hub', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      expect(() =>
        registerNotifyRoute(app, {
          hub: undefined as unknown as NotifyHub,
          authenticate: () => ({ ok: true, deviceId: 'x' }),
          wsFactory: () => new FakeSocket(),
        }),
      ).toThrow(/hub is required/);
      await app.close();
    });

    it('rejects missing authenticate', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      expect(() =>
        registerNotifyRoute(app, {
          hub: new NotifyHub(),
          authenticate: undefined as unknown as () => NotifyAuthResult,
          wsFactory: () => new FakeSocket(),
        }),
      ).toThrow(/authenticate is required/);
      await app.close();
    });

    it('rejects missing wsFactory', async () => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      expect(() =>
        registerNotifyRoute(app, {
          hub: new NotifyHub(),
          authenticate: () => ({ ok: true, deviceId: 'x' }),
          wsFactory: undefined as unknown as () => WebSocketLike | null,
        }),
      ).toThrow(/wsFactory is required/);
      await app.close();
    });
  });
});
