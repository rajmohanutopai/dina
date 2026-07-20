/**
 * `/api/v1/notifications` routes (R4-03) — the SPA's notification data layer.
 *
 * On the split server Brain's inbox lives in THIS process (hydrated from Core's
 * durable log at boot, kept live as `deliverWatchResult` appends). The browser
 * SPA can't reach the in-process inbox directly, so it reads it here:
 *
 *   GET  /api/v1/notifications         → the inbox, newest-first
 *   POST /api/v1/notifications/read    → mark one read (dual-writes to Core)
 *   GET  /api/v1/notifications/stream  → SSE of newly-appended notifications
 *
 * This is the browser-visible surface watch/push results land on (the proper
 * silence-tiered Activity inbox — NOT chat). Mobile shares the process and reads
 * the inbox directly, bypassing all of this.
 */

import { storedNotificationToWire } from '@dina/core';
import {
  listNotifications,
  markNotificationRead,
  subscribeNotifications,
  type NotificationItem,
} from '@dina/brain/notifications';

import type { NotificationWireDTO } from '@dina/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** R5-08 — map a Brain in-memory inbox item onto the snake_case wire DTO. */
function toWire(item: NotificationItem): NotificationWireDTO {
  return storedNotificationToWire({
    id: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    firedAt: item.firedAt,
    readAt: item.readAt,
    sourceId: item.sourceId,
    deepLink: item.deepLink ?? null,
    expiresAt: item.expiresAt ?? null,
    dataScope: item.dataScope,
  });
}

export interface RegisterNotificationApiRoutesOptions {
  /** Route prefix override (defaults to `/api/v1`). */
  prefix?: string;
}

interface ReadBody {
  id?: unknown;
}

export function registerNotificationApiRoutes(
  app: FastifyInstance,
  opts: RegisterNotificationApiRoutesOptions = {},
): void {
  const prefix = opts.prefix ?? '/api/v1';

  // GET /api/v1/notifications/stream — SSE of appended notifications. The SPA
  // subscribes here + folds each item into its own in-browser inbox for a live
  // Activity badge without polling.
  app.get(`${prefix}/notifications/stream`, async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 2000\n\n');

    const unsubscribe = subscribeNotifications((entry) => {
      if (entry.type !== 'appended') return;
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      try {
        reply.raw.write(`event: appended\ndata: ${JSON.stringify(toWire(entry.item))}\n\n`);
      } catch {
        /* connection went away between the guard and the write */
      }
    });

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
      unsubscribe();
      clearInterval(keepalive);
    };
    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);
  });

  // GET /api/v1/notifications — the inbox, newest-first.
  app.get(`${prefix}/notifications`, async (_req: FastifyRequest, reply: FastifyReply) => {
    const notifications: NotificationItem[] = listNotifications();
    return reply.status(200).send({ notifications });
  });

  // POST /api/v1/notifications/read — mark one read.
  app.post(
    `${prefix}/notifications/read`,
    async (req: FastifyRequest<{ Body: ReadBody }>, reply: FastifyReply) => {
      const id = typeof (req.body ?? {}).id === 'string' ? (req.body.id as string).trim() : '';
      if (id === '') return reply.status(400).send({ error: 'id is required' });
      const changed = markNotificationRead(id);
      return reply.status(200).send({ changed });
    },
  );
}
