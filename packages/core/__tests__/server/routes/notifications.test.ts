/**
 * `/v1/notifications` core routes (R4-03) — the durable notification-log backing
 * reached across the split boundary. Drives the handlers directly against a
 * wired InMemory repository; a missing repository is a 503.
 */

import {
  InMemoryNotificationLogRepository,
  setNotificationLogRepository,
  type StoredNotificationItem,
  type NotificationWireDTO,
} from '../../../src/notifications/repository';
import { makeNotificationHandlers } from '../../../src/server/routes/notifications';

import type { CoreRequest } from '../../../src/server/router';

function req(
  method: CoreRequest['method'],
  path: string,
  opts: { body?: Record<string, unknown>; query?: Record<string, string> } = {},
): CoreRequest {
  const rawBody = opts.body ? new TextEncoder().encode(JSON.stringify(opts.body)) : new Uint8Array();
  return {
    method,
    path,
    query: opts.query ?? {},
    headers: {},
    body: opts.body ?? {},
    rawBody,
    params: {},
    trustedInProcess: true,
  };
}

function item(over: Partial<StoredNotificationItem> = {}): Record<string, unknown> {
  return {
    // R5-08 — the wire body is snake_case.
    id: over.id ?? 'n1',
    kind: over.kind ?? 'push',
    title: over.title ?? 'Flight delayed',
    body: over.body ?? 'BA117 +40m',
    fired_at: over.firedAt ?? 1_700_000_000_000,
    read_at: over.readAt ?? null,
    source_id: over.sourceId ?? 'task-1',
    deep_link: over.deepLink ?? 'dina://subscriptions',
    expires_at: over.expiresAt ?? null,
    data_scope: over.dataScope ?? 'user',
  };
}

describe('/v1/notifications core routes', () => {
  const h = makeNotificationHandlers();

  afterEach(() => setNotificationLogRepository(null));

  it('503 on every route when no repository is wired', async () => {
    setNotificationLogRepository(null);
    expect((await h.append(req('POST', '/v1/notifications', { body: item() }))).status).toBe(503);
    expect((await h.list(req('GET', '/v1/notifications'))).status).toBe(503);
    expect((await h.markRead(req('POST', '/v1/notifications/read', { body: { id: 'n1' } }))).status).toBe(503);
    expect((await h.purge(req('POST', '/v1/notifications/purge', { body: { cutoff: 1 } }))).status).toBe(503);
    expect((await h.reset(req('POST', '/v1/notifications/reset'))).status).toBe(503);
  });

  it('append + list round-trips through the wired repository', async () => {
    setNotificationLogRepository(new InMemoryNotificationLogRepository());
    expect((await h.append(req('POST', '/v1/notifications', { body: item({ id: 'a' }) }))).status).toBe(200);
    const res = await h.list(req('GET', '/v1/notifications'));
    expect(res.status).toBe(200);
    const { notifications } = res.body as { notifications: NotificationWireDTO[] };
    expect(notifications.map((n) => n.id)).toEqual(['a']);
    // R5-08 — the response is the snake_case wire shape.
    expect(notifications[0]!.data_scope).toBe('user');
    expect(notifications[0]!.fired_at).toBe(1_700_000_000_000);
  });

  it('append rejects a body missing required fields (400)', async () => {
    setNotificationLogRepository(new InMemoryNotificationLogRepository());
    const res = await h.append(req('POST', '/v1/notifications', { body: { kind: 'push' } }));
    expect(res.status).toBe(400);
  });

  it('list honours ?limit', async () => {
    setNotificationLogRepository(new InMemoryNotificationLogRepository());
    await h.append(req('POST', '/v1/notifications', { body: item({ id: 'old', firedAt: 100 }) }));
    await h.append(req('POST', '/v1/notifications', { body: item({ id: 'new', firedAt: 300 }) }));
    const res = await h.list(req('GET', '/v1/notifications', { query: { limit: '1' } }));
    const { notifications } = res.body as { notifications: NotificationWireDTO[] };
    expect(notifications.map((n) => n.id)).toEqual(['new']);
  });

  it('markRead is one-shot; unknown id → changed:false', async () => {
    setNotificationLogRepository(new InMemoryNotificationLogRepository());
    await h.append(req('POST', '/v1/notifications', { body: item({ id: 'a' }) }));
    const first = await h.markRead(req('POST', '/v1/notifications/read', { body: { id: 'a', read_at: 123 } }));
    expect((first.body as { changed: boolean }).changed).toBe(true);
    const second = await h.markRead(req('POST', '/v1/notifications/read', { body: { id: 'a', read_at: 456 } }));
    expect((second.body as { changed: boolean }).changed).toBe(false);
    const missing = await h.markRead(req('POST', '/v1/notifications/read', { body: { id: 'nope' } }));
    expect((missing.body as { changed: boolean }).changed).toBe(false);
  });

  it('purge drops old rows; reset wipes', async () => {
    setNotificationLogRepository(new InMemoryNotificationLogRepository());
    await h.append(req('POST', '/v1/notifications', { body: item({ id: 'old', firedAt: 100 }) }));
    await h.append(req('POST', '/v1/notifications', { body: item({ id: 'new', firedAt: 300 }) }));
    const purged = await h.purge(req('POST', '/v1/notifications/purge', { body: { cutoff: 200 } }));
    expect((purged.body as { purged: number }).purged).toBe(1);
    expect((await h.reset(req('POST', '/v1/notifications/reset'))).status).toBe(200);
    const res = await h.list(req('GET', '/v1/notifications'));
    expect((res.body as { notifications: unknown[] }).notifications).toEqual([]);
  });
});
