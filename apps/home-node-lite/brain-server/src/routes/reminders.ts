/**
 * `/api/v1/reminders` routes — the SPA's reminder data layer.
 *
 * In lite the reminder store lives in core-server's process (the
 * SQLiteReminderRepository). The browser SPA can't reach it directly,
 * so it talks to the brain-server (same origin as the served bundle),
 * which proxies each call to core-server through its `CoreClient`
 * (`HttpCoreTransport`). Exactly the shape of the chat routes — a thin
 * HTTP shim over a layer the orchestrator/Core already owns. Mobile
 * bypasses all of this (it runs Core in-process and calls
 * `@dina/core/reminders` directly via the native transport seam).
 *
 *   GET    /api/v1/reminders?persona=…   → CoreClient.reminderListByPersona
 *   POST   /api/v1/reminders             → CoreClient.reminderCreate
 *   POST   /api/v1/reminders/:id/complete→ CoreClient.reminderComplete
 *   POST   /api/v1/reminders/:id/snooze  → CoreClient.reminderSnooze
 *   DELETE /api/v1/reminders/:id         → CoreClient.reminderDelete
 */

import type { CoreClient, Reminder, ReminderCreateInput } from '@dina/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterReminderApiRoutesOptions {
  /** Brain→Core client (signed HTTP to core-server). */
  core: CoreClient;
  /** Route prefix override (defaults to `/api/v1`). */
  prefix?: string;
}

/**
 * Fan-out hub for fired reminders. The fire loop (in boot) calls
 * `broadcast` for each newly-fired reminder; every open
 * `/api/v1/reminders/stream` SSE connection receives it. Mirrors the
 * chat thread's subscribe/notify, but reminders have no per-thread store
 * so the hub is a flat subscriber set.
 */
export interface ReminderStreamHub {
  broadcast(reminder: Reminder): void;
  subscriberCount(): number;
}

interface CreateBody {
  message?: unknown;
  due_at?: unknown;
  persona?: unknown;
  kind?: unknown;
  source_item_id?: unknown;
  source?: unknown;
  recurring?: unknown;
  timezone?: unknown;
}

interface SnoozeBody {
  snooze_ms?: unknown;
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerReminderApiRoutes(
  app: FastifyInstance,
  opts: RegisterReminderApiRoutesOptions,
): ReminderStreamHub {
  const prefix = opts.prefix ?? '/api/v1';
  const { core } = opts;

  // Live subscribers to the fired-reminder stream. Each is a writer that
  // pushes one SSE frame; disconnects prune themselves on socket close.
  const subscribers = new Set<(reminder: Reminder) => void>();
  const hub: ReminderStreamHub = {
    broadcast(reminder) {
      for (const write of subscribers) {
        try {
          write(reminder);
        } catch {
          /* a dead socket prunes itself via its close handler */
        }
      }
    },
    subscriberCount: () => subscribers.size,
  };

  // GET /api/v1/reminders/stream — SSE of fired reminders (server fires;
  // the browser fire-watcher subscribes here instead of firing locally).
  app.get(`${prefix}/reminders/stream`, async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 2000\n\n');

    const write = (reminder: Reminder): void => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      try {
        reply.raw.write(`event: fired\ndata: ${JSON.stringify(reminder)}\n\n`);
      } catch {
        /* connection went away between the guard and the write */
      }
    };
    subscribers.add(write);

    const keepalive = setInterval(() => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      try {
        reply.raw.write(': keepalive\n\n');
      } catch {
        /* see above */
      }
    }, 15_000);
    if (typeof keepalive.unref === 'function') keepalive.unref();

    const cleanup = (): void => {
      subscribers.delete(write);
      clearInterval(keepalive);
    };
    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);
  });

  // GET /api/v1/reminders?persona=…
  app.get(
    `${prefix}/reminders`,
    async (req: FastifyRequest<{ Querystring: { persona?: string } }>, reply: FastifyReply) => {
      const persona = typeof req.query.persona === 'string' ? req.query.persona.trim() : '';
      if (persona === '') {
        return reply.status(400).send({ error: 'persona query parameter is required' });
      }
      try {
        const reminders = await core.reminderListByPersona(persona);
        return reply.status(200).send({ reminders });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // GET /api/v1/reminders/pending?now=…  (cross-persona, drives the
  // Reminders tab's upcoming/overdue lists)
  app.get(
    `${prefix}/reminders/pending`,
    async (req: FastifyRequest<{ Querystring: { now?: string } }>, reply: FastifyReply) => {
      let now: number | undefined;
      if (typeof req.query.now === 'string' && req.query.now.trim() !== '') {
        const parsed = Number(req.query.now);
        if (!Number.isFinite(parsed)) {
          return reply.status(400).send({ error: 'now must be a numeric epoch-ms timestamp' });
        }
        now = parsed;
      }
      try {
        const reminders = await core.reminderListPending(now);
        return reply.status(200).send({ reminders });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // POST /api/v1/reminders
  app.post(
    `${prefix}/reminders`,
    async (req: FastifyRequest<{ Body: CreateBody }>, reply: FastifyReply) => {
      const body = req.body ?? {};
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (message === '') return reply.status(400).send({ error: 'message is required' });
      if (typeof body.due_at !== 'number' || !Number.isFinite(body.due_at)) {
        return reply.status(400).send({ error: 'due_at (epoch ms) is required' });
      }
      const persona = typeof body.persona === 'string' ? body.persona.trim() : '';
      if (persona === '') return reply.status(400).send({ error: 'persona is required' });

      const input: ReminderCreateInput = {
        message,
        due_at: body.due_at,
        persona,
        ...(typeof body.kind === 'string' ? { kind: body.kind } : {}),
        ...(typeof body.source_item_id === 'string' ? { source_item_id: body.source_item_id } : {}),
        ...(typeof body.source === 'string' ? { source: body.source } : {}),
        ...(typeof body.recurring === 'string'
          ? { recurring: body.recurring as ReminderCreateInput['recurring'] }
          : {}),
        ...(typeof body.timezone === 'string' ? { timezone: body.timezone } : {}),
      };
      try {
        const reminder = await core.reminderCreate(input);
        return reply.status(200).send(reminder);
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // POST /api/v1/reminders/:id/complete
  app.post(
    `${prefix}/reminders/:id/complete`,
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const next = await core.reminderComplete(req.params.id);
        return reply.status(200).send({ next });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // POST /api/v1/reminders/:id/snooze
  app.post(
    `${prefix}/reminders/:id/snooze`,
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: SnoozeBody }>,
      reply: FastifyReply,
    ) => {
      const snoozeMs = (req.body ?? {}).snooze_ms;
      if (typeof snoozeMs !== 'number' || !Number.isFinite(snoozeMs) || snoozeMs <= 0) {
        return reply.status(400).send({ error: 'snooze_ms (positive ms duration) is required' });
      }
      try {
        const reminder = await core.reminderSnooze(req.params.id, snoozeMs);
        return reply.status(200).send({ reminder });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // DELETE /api/v1/reminders/:id
  app.delete(
    `${prefix}/reminders/:id`,
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const deleted = await core.reminderDelete(req.params.id);
        return reply.status(200).send({ deleted });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  return hub;
}

/**
 * Start the server-side reminder fire loop. On each tick it asks Core to
 * fire missed reminders and broadcasts the newly-fired rows to the SSE
 * hub (and thus to every connected SPA). This is the web counterpart of
 * mobile's in-foreground `useReminderFireWatcher` — the browser can't run
 * a reliable background timer, so the server owns firing. Returns a
 * disposer that stops the loop.
 */
export function startReminderFireLoop(opts: {
  core: CoreClient;
  hub: ReminderStreamHub;
  tickMs?: number;
  onError?: (err: unknown) => void;
}): () => void {
  const tickMs = opts.tickMs ?? 30_000;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // never overlap a slow Core round-trip
    running = true;
    try {
      const fired = await opts.core.reminderFireMissed();
      for (const r of fired) opts.hub.broadcast(r);
    } catch (err) {
      opts.onError?.(err);
    } finally {
      running = false;
    }
  };
  // Kick off the first sweep on the next macrotask (≈immediate at runtime)
  // so reminders already due at boot don't wait a full interval — but NOT
  // synchronously inside this call, so it doesn't perturb the rest of the
  // boot sequence's ordering. Then settle into the interval.
  const kickoff = setTimeout(() => void tick(), 0);
  if (typeof kickoff.unref === 'function') kickoff.unref();
  const handle = setInterval(() => void tick(), tickMs);
  if (typeof handle.unref === 'function') handle.unref();
  return () => {
    clearTimeout(kickoff);
    clearInterval(handle);
  };
}
