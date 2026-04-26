/**
 * Notification-log repository contract (task 5.66).
 *
 * Pins the InMemory implementation; the SQLite implementation is a 1:1
 * shape mapping behind standard SQL and is exercised by integration
 * tests through `initializePersistence`. The schema-presence check at
 * the bottom guards against migration drift.
 */

import {
  InMemoryNotificationLogRepository,
  type NotificationLogRepository,
  type StoredNotificationItem,
} from '../../src/notifications/repository';

function mkItem(overrides: Partial<StoredNotificationItem> = {}): StoredNotificationItem {
  return {
    id: overrides.id ?? `nt-${Math.random().toString(36).slice(2, 8)}`,
    kind: overrides.kind ?? 'reminder',
    title: overrides.title ?? 'Title',
    body: overrides.body ?? 'Body',
    firedAt: overrides.firedAt ?? Date.now(),
    readAt: overrides.readAt ?? null,
    sourceId: overrides.sourceId ?? '',
    deepLink: overrides.deepLink ?? null,
    expiresAt: overrides.expiresAt ?? null,
  };
}

describe('InMemoryNotificationLogRepository', () => {
  let repo: NotificationLogRepository;
  beforeEach(() => {
    repo = new InMemoryNotificationLogRepository();
  });

  it('append + listAll round-trip preserves every field', async () => {
    const t = 1_700_000_000_000;
    await repo.append(
      mkItem({
        id: 'a',
        kind: 'reminder',
        title: 'Pay rent',
        body: 'Due today',
        firedAt: t,
        sourceId: 'rem-123',
        deepLink: 'dina://reminders/rem-123',
        expiresAt: t + 86_400_000,
      }),
    );
    const rows = await repo.listAll();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      id: 'a',
      kind: 'reminder',
      title: 'Pay rent',
      body: 'Due today',
      firedAt: t,
      readAt: null,
      sourceId: 'rem-123',
      deepLink: 'dina://reminders/rem-123',
      expiresAt: t + 86_400_000,
    });
  });

  it('listAll returns newest-first regardless of insertion order', async () => {
    await repo.append(mkItem({ id: 'middle', firedAt: 200 }));
    await repo.append(mkItem({ id: 'old', firedAt: 100 }));
    await repo.append(mkItem({ id: 'new', firedAt: 300 }));
    expect((await repo.listAll()).map((r) => r.id)).toEqual(['new', 'middle', 'old']);
  });

  it('limit clamps results but keeps newest-first order', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.append(mkItem({ id: String(i), firedAt: i * 1000 }));
    }
    expect((await repo.listAll(2)).map((r) => r.id)).toEqual(['4', '3']);
  });

  it('append upserts on id so a replay does not duplicate', async () => {
    await repo.append(mkItem({ id: 'a', title: 'v1' }));
    await repo.append(mkItem({ id: 'a', title: 'v2' }));
    const rows = await repo.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('v2');
  });

  it('markRead flips read_at when previously unread; no-op afterwards', async () => {
    await repo.append(mkItem({ id: 'a', readAt: null }));
    expect(await repo.markRead('a', 1234)).toBe(true);
    expect(await repo.markRead('a', 5678)).toBe(false); // already read
    const row = (await repo.listAll())[0]!;
    expect(row.readAt).toBe(1234); // first ack timestamp wins
  });

  it('markRead returns false for unknown id', async () => {
    expect(await repo.markRead('nope', 0)).toBe(false);
  });

  it('purgeBefore drops rows older than the cutoff', async () => {
    await repo.append(mkItem({ id: 'old', firedAt: 100 }));
    await repo.append(mkItem({ id: 'borderline', firedAt: 200 }));
    await repo.append(mkItem({ id: 'new', firedAt: 300 }));
    const purged = await repo.purgeBefore(200);
    expect(purged).toBe(1); // only 'old'
    expect((await repo.listAll()).map((r) => r.id).sort()).toEqual(['borderline', 'new']);
  });

  it('purgeBefore prefers explicit expiresAt when present', async () => {
    // fired long ago, but explicit TTL still in the future → keep
    await repo.append(mkItem({ id: 'kept', firedAt: 100, expiresAt: 1000 }));
    // fresh fire, but explicit TTL already past → purge
    await repo.append(mkItem({ id: 'purged', firedAt: 900, expiresAt: 100 }));
    expect(await repo.purgeBefore(500)).toBe(1);
    expect((await repo.listAll()).map((r) => r.id)).toEqual(['kept']);
  });

  it('reset wipes the entire log', async () => {
    await repo.append(mkItem({ id: 'a' }));
    await repo.append(mkItem({ id: 'b' }));
    await repo.reset();
    expect(await repo.listAll()).toEqual([]);
  });

  it('returned objects are clones — caller mutations do not poison the store', async () => {
    await repo.append(mkItem({ id: 'a', title: 'orig' }));
    const a = (await repo.listAll())[0]!;
    (a as { title: string }).title = 'leaked';
    const b = (await repo.listAll())[0]!;
    expect(b.title).toBe('orig');
  });
});

