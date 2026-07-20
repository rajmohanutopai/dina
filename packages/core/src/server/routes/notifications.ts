/**
 * `/v1/notifications` routes (R4-03) — the durable notification-log backing,
 * reachable across the split boundary.
 *
 * Brain owns the runtime inbox (`packages/brain/src/notifications/inbox.ts`) but
 * never touches SQLite, so on the split server it dual-writes THROUGH these Core
 * routes into `identity.sqlite` (via the wired `NotificationLogRepository`). On
 * mobile the inbox writes the repository directly in-process; these routes are
 * still functional there but unused.
 *
 *   POST /v1/notifications          — append (upsert on id). Body is a
 *       `StoredNotificationItem`. Response `{ ok: true }`.
 *   GET  /v1/notifications?limit=…  — list, newest-first. Response
 *       `{ notifications: StoredNotificationItem[] }`.
 *   POST /v1/notifications/read     — mark read. Body `{ id, readAt }`.
 *       Response `{ changed: boolean }`.
 *   POST /v1/notifications/purge    — retention purge. Body `{ cutoff }`.
 *       Response `{ purged: number }`.
 *   POST /v1/notifications/reset    — wipe (identity reset). Response `{ ok: true }`.
 *
 * Auth: brain/admin/device allowlist (`authz.ts` `/v1/notifications`). A missing
 * repository is a 503 (never a silent success).
 */

import {
  getNotificationLogRepository,
  storedNotificationToWire,
  wireToStoredNotification,
} from '../../notifications/repository';

import {
  NOTIFICATIONS_ROOT,
  NOTIFICATIONS_READ,
  NOTIFICATIONS_PURGE,
  NOTIFICATIONS_RESET,
} from './paths';

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

/** Body cap — a notification is a few short strings; 16 KiB is generous. */
const BODY_MAX_BYTES = 16 * 1024;

function jsonError(status: number, message: string): CoreResponse {
  return { status, body: { error: message } };
}

async function handleAppend(req: CoreRequest): Promise<CoreResponse> {
  if (req.rawBody.byteLength > BODY_MAX_BYTES) {
    return jsonError(413, `body exceeds ${BODY_MAX_BYTES} bytes`);
  }
  if (req.body === null || typeof req.body !== 'object') {
    return jsonError(400, 'body must be a JSON object');
  }
  const repo = getNotificationLogRepository();
  if (repo === null) return jsonError(503, 'notification log not wired');
  // R5-08 — wire body is snake_case.
  const parsed = wireToStoredNotification(req.body);
  if (parsed === null) return jsonError(400, 'id, kind, title, body, fired_at are required');
  try {
    await repo.append(parsed);
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }
  return { status: 200, body: { ok: true } };
}

async function handleList(req: CoreRequest): Promise<CoreResponse> {
  const repo = getNotificationLogRepository();
  if (repo === null) return jsonError(503, 'notification log not wired');
  let limit: number | undefined;
  const rawLimit = req.query.limit;
  if (typeof rawLimit === 'string' && rawLimit !== '') {
    const n = Number.parseInt(rawLimit, 10);
    if (Number.isFinite(n) && n > 0) limit = n;
  }
  try {
    const rows = await repo.listAll(limit);
    return { status: 200, body: { notifications: rows.map(storedNotificationToWire) } };
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }
}

async function handleMarkRead(req: CoreRequest): Promise<CoreResponse> {
  if (req.body === null || typeof req.body !== 'object') {
    return jsonError(400, 'body must be a JSON object');
  }
  const repo = getNotificationLogRepository();
  if (repo === null) return jsonError(503, 'notification log not wired');
  const body = req.body as Record<string, unknown>;
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (id === '') return jsonError(400, 'id is required');
  const readAt =
    typeof body.read_at === 'number' && Number.isFinite(body.read_at) ? body.read_at : Date.now();
  try {
    const changed = await repo.markRead(id, readAt);
    return { status: 200, body: { changed } };
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }
}

async function handlePurge(req: CoreRequest): Promise<CoreResponse> {
  if (req.body === null || typeof req.body !== 'object') {
    return jsonError(400, 'body must be a JSON object');
  }
  const repo = getNotificationLogRepository();
  if (repo === null) return jsonError(503, 'notification log not wired');
  const body = req.body as Record<string, unknown>;
  if (typeof body.cutoff !== 'number' || !Number.isFinite(body.cutoff)) {
    return jsonError(400, 'cutoff (epoch ms) is required');
  }
  try {
    const purged = await repo.purgeBefore(body.cutoff);
    return { status: 200, body: { purged } };
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }
}

async function handleReset(_req: CoreRequest): Promise<CoreResponse> {
  const repo = getNotificationLogRepository();
  if (repo === null) return jsonError(503, 'notification log not wired');
  try {
    await repo.reset();
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }
}

/** Handlers exported for direct unit testing (no signed-auth pipeline). */
export function makeNotificationHandlers(): {
  append: (req: CoreRequest) => Promise<CoreResponse>;
  list: (req: CoreRequest) => Promise<CoreResponse>;
  markRead: (req: CoreRequest) => Promise<CoreResponse>;
  purge: (req: CoreRequest) => Promise<CoreResponse>;
  reset: (req: CoreRequest) => Promise<CoreResponse>;
} {
  return {
    append: handleAppend,
    list: handleList,
    markRead: handleMarkRead,
    purge: handlePurge,
    reset: handleReset,
  };
}

export function registerNotificationRoutes(router: CoreRouter): void {
  const h = makeNotificationHandlers();
  router.post(NOTIFICATIONS_ROOT, h.append);
  router.get(NOTIFICATIONS_ROOT, h.list);
  router.post(NOTIFICATIONS_READ, h.markRead);
  router.post(NOTIFICATIONS_PURGE, h.purge);
  router.post(NOTIFICATIONS_RESET, h.reset);
}
