/**
 * `/api/v1/reminders` Fastify routes — thin proxy over the CoreClient
 * the SPA uses (mobile hits the in-process service instead). Drives the
 * routes with a MockCoreClient so a handler/path/shape regression fails
 * here without standing up core-server.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { MockCoreClient } from '@dina/test-harness';

import { registerReminderApiRoutes, startReminderFireLoop } from '../src/routes/reminders';

function makeApp(core: MockCoreClient): FastifyInstance {
  const app = Fastify({ logger: false });
  registerReminderApiRoutes(app, { core });
  return app;
}

describe('Brain server — /api/v1/reminders HTTP wiring', () => {
  it('create → list → complete → delete round-trips through the CoreClient', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const due = Date.now() + 60_000;
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/reminders',
        payload: { message: 'Call mom', due_at: due, persona: 'general' },
      });
      expect(created.statusCode).toBe(200);
      const reminder = created.json() as { id: string; persona: string };
      expect(reminder.persona).toBe('general');

      const list = await app.inject({ method: 'GET', url: '/api/v1/reminders?persona=general' });
      expect(list.statusCode).toBe(200);
      expect((list.json() as { reminders: unknown[] }).reminders).toHaveLength(1);

      const done = await app.inject({
        method: 'POST',
        url: `/api/v1/reminders/${reminder.id}/complete`,
      });
      expect(done.statusCode).toBe(200);
      expect((done.json() as { next: unknown }).next).toBeNull();

      const del = await app.inject({ method: 'DELETE', url: `/api/v1/reminders/${reminder.id}` });
      expect(del.statusCode).toBe(200);
      expect((del.json() as { deleted: boolean }).deleted).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('snooze forwards snooze_ms to the CoreClient', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const due = Date.now() + 10_000;
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/reminders',
          payload: { message: 'snooze me', due_at: due, persona: 'general' },
        })
      ).json() as { id: string };

      const snoozed = await app.inject({
        method: 'POST',
        url: `/api/v1/reminders/${created.id}/snooze`,
        payload: { snooze_ms: 60_000 },
      });
      expect(snoozed.statusCode).toBe(200);
      const body = snoozed.json() as { reminder: { due_at: number; status: string } };
      expect(body.reminder.due_at).toBe(due + 60_000);
      expect(body.reminder.status).toBe('snoozed');
    } finally {
      await app.close();
    }
  });

  it('validates inputs: missing persona on list, non-positive snooze_ms', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      expect((await app.inject({ method: 'GET', url: '/api/v1/reminders' })).statusCode).toBe(400);
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/reminders',
          payload: { message: 'x', due_at: Date.now(), persona: 'general' },
        })
      ).json() as { id: string };
      const bad = await app.inject({
        method: 'POST',
        url: `/api/v1/reminders/${created.id}/snooze`,
        payload: { snooze_ms: 0 },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('GET /pending lists across personas', async () => {
    const core = new MockCoreClient();
    const app = makeApp(core);
    try {
      const now = Date.now();
      await app.inject({
        method: 'POST',
        url: '/api/v1/reminders',
        payload: { message: 'due', due_at: now - 1000, persona: 'general' },
      });
      const pending = await app.inject({ method: 'GET', url: `/api/v1/reminders/pending?now=${now}` });
      expect(pending.statusCode).toBe(200);
      expect((pending.json() as { reminders: unknown[] }).reminders).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('startReminderFireLoop fires due reminders through Core + broadcasts to the hub', async () => {
    const core = new MockCoreClient();
    const app = Fastify({ logger: false });
    // Seed a due reminder directly in the mock store.
    await core.reminderCreate({ message: 'ring', due_at: Date.now() - 1000, persona: 'general' });

    const hub = registerReminderApiRoutes(app, { core }); // register once
    const broadcasts: string[] = [];
    const realBroadcast = hub.broadcast.bind(hub);
    hub.broadcast = (r) => {
      broadcasts.push(r.message);
      realBroadcast(r);
    };

    // tickMs tiny so the loop fires promptly; stop right after.
    const stop = startReminderFireLoop({ core, hub, tickMs: 5 });
    await new Promise((res) => setTimeout(res, 40));
    stop();
    await app.close();

    expect(broadcasts).toContain('ring');
    // Idempotent: the reminder fired once (flipped to 'fired'), so even
    // many ticks broadcast it a single time.
    expect(broadcasts.filter((m) => m === 'ring')).toHaveLength(1);
  });
});
