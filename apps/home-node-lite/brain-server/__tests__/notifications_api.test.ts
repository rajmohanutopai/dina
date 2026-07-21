/**
 * `/api/v1/notifications` Fastify routes — the SPA's notification data layer
 * (R4-03). Round-A NEW-1 regression pin: the LIST route must return the SAME
 * snake_case wire rows as the SSE branch, because the web client parses every
 * row with `wireToStoredNotification` (which rejects a camelCase row) — an
 * unmapped list silently hydrates ZERO notifications after reload/reconnect.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { wireToStoredNotification } from '@dina/core';
import { appendNotification, resetNotifications } from '@dina/brain/notifications';

import { registerNotificationApiRoutes } from '../src/routes/notifications';

function makeApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerNotificationApiRoutes(app);
  return app;
}

describe('Brain server — /api/v1/notifications HTTP wiring', () => {
  beforeEach(() => {
    resetNotifications();
  });
  afterEach(() => {
    resetNotifications();
  });

  it('GET list returns snake_case wire rows the web client can parse (NEW-1)', async () => {
    appendNotification({
      id: 'n-1',
      kind: 'run',
      title: 'Service update',
      body: 'bus42 sent a new update.',
      sourceId: 'msg-1',
      deepLink: 'dina://runs',
    });
    const app = makeApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/notifications' });
      expect(res.statusCode).toBe(200);
      const { notifications } = res.json() as { notifications: Record<string, unknown>[] };
      expect(notifications).toHaveLength(1);
      const row = notifications[0];
      // snake_case wire contract — the exact fields wireToStoredNotification needs.
      expect(typeof row.fired_at).toBe('number');
      expect(row.source_id).toBe('msg-1');
      expect(row.deep_link).toBe('dina://runs');
      expect(row).not.toHaveProperty('firedAt');
      // The web client's parser must ACCEPT every listed row (a null here is
      // exactly the silent zero-row hydrate this test pins against).
      expect(wireToStoredNotification(row)).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('POST read marks a row read and the list reflects it', async () => {
    appendNotification({
      id: 'n-2',
      kind: 'push',
      title: 'Watch result',
      body: 'x',
      sourceId: 'w-1',
    });
    const app = makeApp();
    try {
      const read = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications/read',
        payload: { id: 'n-2' },
      });
      expect(read.statusCode).toBe(200);
      expect((read.json() as { changed: boolean }).changed).toBe(true);

      const res = await app.inject({ method: 'GET', url: '/api/v1/notifications' });
      const { notifications } = res.json() as { notifications: { read_at: unknown }[] };
      expect(typeof notifications[0].read_at).toBe('number');
    } finally {
      await app.close();
    }
  });
});
