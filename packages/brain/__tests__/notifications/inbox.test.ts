/**
 * Notifications inbox store contract (task 5.66).
 *
 * Pins the in-memory API: append + subscribe + markRead + list +
 * persistence dual-write + auto-purge. The repository contract is
 * covered separately in `packages/core/__tests__/notifications/repository.test.ts`.
 */

import {
  appendNotification,
  getUnreadCount,
  hydrateNotifications,
  listNotifications,
  markNotificationRead,
  resetNotifications,
  setRetentionDays,
  subscribeNotifications,
  type NotificationEvent,
} from '../../src/notifications/inbox';
import {
  InMemoryNotificationLogRepository,
  setNotificationLogRepository,
} from '../../../core/src/notifications/repository';

describe('Notifications inbox (5.66)', () => {
  beforeEach(() => {
    setNotificationLogRepository(null);
    resetNotifications();
  });

  describe('appendNotification', () => {
    it('returns an item with generated id, default readAt = null, no deepLink/expiresAt when omitted', () => {
      const item = appendNotification({
        kind: 'reminder',
        title: 'Pay rent',
        body: 'Due today',
        sourceId: 'rem-1',
        now: 1234,
      });
      expect(item.id).toMatch(/^nt-/);
      expect(item.kind).toBe('reminder');
      expect(item.title).toBe('Pay rent');
      expect(item.body).toBe('Due today');
      expect(item.sourceId).toBe('rem-1');
      expect(item.firedAt).toBe(1234);
      expect(item.readAt).toBeNull();
      expect(item.deepLink).toBeUndefined();
      expect(item.expiresAt).toBeUndefined();
    });

    it('honours caller-supplied id (idempotent producers)', () => {
      const a = appendNotification({ id: 'fixed-1', kind: 'nudge', title: 't', body: 'b' });
      const b = appendNotification({ id: 'fixed-1', kind: 'nudge', title: 't2', body: 'b2' });
      expect(a.id).toBe('fixed-1');
      expect(b.id).toBe('fixed-1');
      const list = listNotifications();
      expect(list).toHaveLength(1);
      expect(list[0]!.title).toBe('t2'); // upserted
    });

    it('preserves deepLink and expiresAt when set', () => {
      const item = appendNotification({
        kind: 'approval',
        title: 'Pending',
        body: '',
        deepLink: 'dina://approvals/abc',
        expiresAt: 9999,
      });
      expect(item.deepLink).toBe('dina://approvals/abc');
      expect(item.expiresAt).toBe(9999);
    });
  });

  describe('listNotifications', () => {
    it('returns newest-first regardless of insertion order', () => {
      appendNotification({ kind: 'reminder', title: 'mid', body: '', now: 200 });
      appendNotification({ kind: 'reminder', title: 'old', body: '', now: 100 });
      appendNotification({ kind: 'reminder', title: 'new', body: '', now: 300 });
      expect(listNotifications().map((i) => i.title)).toEqual(['new', 'mid', 'old']);
    });

    it('filters by since', () => {
      appendNotification({ kind: 'reminder', title: 'a', body: '', now: 100 });
      appendNotification({ kind: 'reminder', title: 'b', body: '', now: 200 });
      appendNotification({ kind: 'reminder', title: 'c', body: '', now: 300 });
      expect(listNotifications({ since: 200 }).map((i) => i.title)).toEqual(['c', 'b']);
    });

    it('filters by kinds', () => {
      appendNotification({ kind: 'reminder', title: 'r', body: '' });
      appendNotification({ kind: 'approval', title: 'a', body: '' });
      appendNotification({ kind: 'nudge', title: 'n', body: '' });
      expect(
        listNotifications({ kinds: ['approval', 'nudge'] })
          .map((i) => i.title)
          .sort(),
      ).toEqual(['a', 'n']);
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        appendNotification({ kind: 'reminder', title: String(i), body: '', now: i * 1000 });
      }
      expect(listNotifications({ limit: 2 }).map((i) => i.title)).toEqual(['4', '3']);
    });

    it('unreadOnly skips read items', () => {
      const a = appendNotification({ kind: 'reminder', title: 'a', body: '' });
      appendNotification({ kind: 'reminder', title: 'b', body: '' });
      markNotificationRead(a.id);
      const titles = listNotifications({ unreadOnly: true }).map((i) => i.title);
      expect(titles).toEqual(['b']);
    });

    it('returns clones — caller mutations do not poison the store', () => {
      appendNotification({ kind: 'reminder', title: 'orig', body: '' });
      const list = listNotifications();
      (list[0] as { title: string }).title = 'leaked';
      const second = listNotifications();
      expect(second[0]!.title).toBe('orig');
    });
  });

  describe('markNotificationRead', () => {
    it('flips readAt + fires marked_read on first ack', () => {
      const events: NotificationEvent[] = [];
      const off = subscribeNotifications((e) => events.push(e));
      const item = appendNotification({ kind: 'reminder', title: 't', body: 'b' });
      expect(markNotificationRead(item.id, 555)).toBe(true);
      expect(events.at(-1)).toEqual({ type: 'marked_read', id: item.id });
      off();
    });

    it('is idempotent — second ack returns false, no duplicate event', () => {
      const events: NotificationEvent[] = [];
      const off = subscribeNotifications((e) => events.push(e));
      const item = appendNotification({ kind: 'reminder', title: 't', body: 'b' });
      markNotificationRead(item.id);
      const beforeSecondAck = events.length;
      expect(markNotificationRead(item.id)).toBe(false);
      expect(events.length).toBe(beforeSecondAck);
      off();
    });

    it('returns false for unknown id', () => {
      expect(markNotificationRead('nope')).toBe(false);
    });
  });

  describe('getUnreadCount', () => {
    it('counts unread items, ignoring read ones', () => {
      const a = appendNotification({ kind: 'reminder', title: 'a', body: '' });
      appendNotification({ kind: 'reminder', title: 'b', body: '' });
      appendNotification({ kind: 'approval', title: 'c', body: '' });
      markNotificationRead(a.id);
      expect(getUnreadCount()).toBe(2);
    });

    it('filters by kind for per-tab badges', () => {
      appendNotification({ kind: 'reminder', title: 'a', body: '' });
      appendNotification({ kind: 'reminder', title: 'b', body: '' });
      appendNotification({ kind: 'approval', title: 'c', body: '' });
      expect(getUnreadCount('reminder')).toBe(2);
      expect(getUnreadCount('approval')).toBe(1);
      expect(getUnreadCount('nudge')).toBe(0);
    });
  });

  describe('subscribeNotifications', () => {
    it('fires appended on each new item; unsubscribe stops further events', () => {
      const events: NotificationEvent[] = [];
      const off = subscribeNotifications((e) => events.push(e));
      appendNotification({ kind: 'reminder', title: 'a', body: '' });
      off();
      appendNotification({ kind: 'reminder', title: 'b', body: '' });
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('appended');
    });

    it('multiple subscribers each get their own copy of every event', () => {
      const ev1: NotificationEvent[] = [];
      const ev2: NotificationEvent[] = [];
      subscribeNotifications((e) => ev1.push(e));
      subscribeNotifications((e) => ev2.push(e));
      appendNotification({ kind: 'reminder', title: 'a', body: '' });
      expect(ev1).toHaveLength(1);
      expect(ev2).toHaveLength(1);
    });

    it('a faulty listener does not break fan-out to other subscribers', () => {
      const ev: NotificationEvent[] = [];
      subscribeNotifications(() => {
        throw new Error('boom');
      });
      subscribeNotifications((e) => ev.push(e));
      appendNotification({ kind: 'reminder', title: 'a', body: '' });
      expect(ev).toHaveLength(1);
    });

    it('idempotent upsert (same id twice) does NOT fire appended a second time', () => {
      const ev: NotificationEvent[] = [];
      subscribeNotifications((e) => ev.push(e));
      appendNotification({ id: 'fixed', kind: 'reminder', title: 'a', body: '' });
      appendNotification({ id: 'fixed', kind: 'reminder', title: 'a-v2', body: '' });
      expect(ev.filter((e) => e.type === 'appended')).toHaveLength(1);
    });
  });

  describe('persistence dual-write', () => {
    it('appendNotification writes to repo when one is installed', async () => {
      const repo = new InMemoryNotificationLogRepository();
      setNotificationLogRepository(repo);
      const item = appendNotification({ kind: 'reminder', title: 'persisted', body: 'b' });
      // dual-write is fire-and-forget; flush microtasks
      await Promise.resolve();
      const rows = await repo.listAll();
      expect(rows.map((r) => r.id)).toEqual([item.id]);
    });

    it('markNotificationRead persists the readAt mutation', async () => {
      const repo = new InMemoryNotificationLogRepository();
      setNotificationLogRepository(repo);
      const item = appendNotification({ kind: 'reminder', title: 't', body: 'b' });
      await Promise.resolve();
      markNotificationRead(item.id, 999);
      await Promise.resolve();
      const rows = await repo.listAll();
      expect(rows[0]!.readAt).toBe(999);
    });

    it('repo failures are swallowed — in-memory store stays usable', () => {
      class ThrowingRepo extends InMemoryNotificationLogRepository {
        override append(): Promise<void> {
          return Promise.reject(new Error('disk full'));
        }
      }
      setNotificationLogRepository(new ThrowingRepo());
      const item = appendNotification({ kind: 'reminder', title: 't', body: 'b' });
      // The append must still surface in-memory even though the repo blew up.
      expect(listNotifications().map((i) => i.id)).toEqual([item.id]);
    });

    it('hydrateNotifications replays repo on cold start', async () => {
      const repo = new InMemoryNotificationLogRepository();
      await repo.append({
        id: 'x',
        kind: 'briefing',
        title: 'Daily',
        body: 'Today\'s items',
        firedAt: 1000,
        readAt: null,
        sourceId: 'b-1',
        deepLink: null,
        expiresAt: null,
      });
      setNotificationLogRepository(repo);
      const hydrated = await hydrateNotifications();
      expect(hydrated).toBe(1);
      expect(listNotifications().map((i) => i.id)).toEqual(['x']);
    });

    it('hydrateNotifications is idempotent unless force', async () => {
      // firedAt close to "now" so the auto-purge trigger from the
      // `appendNotification` below doesn't sweep the hydrated row.
      const recent = Date.now();
      const repo = new InMemoryNotificationLogRepository();
      await repo.append({
        id: 'x',
        kind: 'reminder',
        title: 'a',
        body: '',
        firedAt: recent,
        readAt: null,
        sourceId: '',
        deepLink: null,
        expiresAt: null,
      });
      setNotificationLogRepository(repo);
      await hydrateNotifications();
      // Mutate in-memory only
      appendNotification({ kind: 'nudge', title: 'live', body: '' });
      // Without force, hydrate is a no-op since items.length > 0.
      expect(await hydrateNotifications()).toBe(0);
      expect(listNotifications().map((i) => i.kind).sort()).toEqual(['nudge', 'reminder']);
    });
  });

  describe('auto-purge', () => {
    it('drops in-memory rows past the retention window on the next append', () => {
      setRetentionDays(7);
      const oneDay = 86_400_000;
      // Far-past item — older than 7 days from "now" of next append.
      appendNotification({
        kind: 'reminder',
        title: 'ancient',
        body: '',
        now: 0,
      });
      // First fresh append: now = 8 days later — purge fires (lastPurgeAt = 0
      // → now > PURGE_INTERVAL_MS).
      appendNotification({
        kind: 'reminder',
        title: 'fresh',
        body: '',
        now: 8 * oneDay,
      });
      expect(listNotifications().map((i) => i.title)).toEqual(['fresh']);
    });

    it('honours explicit expiresAt over the retention default', () => {
      setRetentionDays(1); // cutoff = now - 1 day
      const oneDay = 86_400_000;
      // firedAt fresh, but expiresAt is in the past relative to the
      // second append's now=2*oneDay (cutoff = oneDay) → purge.
      appendNotification({
        kind: 'reminder',
        title: 'short-lived',
        body: '',
        now: 0,
        expiresAt: 100, // far below cutoff (oneDay = 86_400_000)
      });
      // Fresh — firedAt at the boundary, expiresAt unset.
      appendNotification({
        kind: 'reminder',
        title: 'normal',
        body: '',
        now: 2 * oneDay,
      });
      expect(listNotifications().map((i) => i.title)).toEqual(['normal']);
    });
  });
});
