/**
 * Notification-log repository contract (task 5.66).
 *
 * Pins the InMemory implementation; the SQLite implementation is a 1:1
 * shape mapping behind standard SQL and is exercised by integration
 * tests through `initializePersistence`. The schema-presence check at
 * the bottom guards against migration drift.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import {
  InMemoryNotificationLogRepository,
  SqliteNotificationLogRepository,
  storedNotificationToWire,
  wireToStoredNotification,
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
    dataScope: overrides.dataScope ?? 'user',
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

  it('purgeByScopePrefix drops guided-demo rows and keeps user rows (R4-03)', async () => {
    await repo.append(mkItem({ id: 'u1', dataScope: 'user' }));
    await repo.append(mkItem({ id: 'd1', dataScope: 'guided_demo:run-1' }));
    await repo.append(mkItem({ id: 'd2', dataScope: 'guided_demo:run-2' }));
    expect(await repo.purgeByScopePrefix('guided_demo:')).toBe(2);
    expect((await repo.listAll()).map((r) => r.id)).toEqual(['u1']);
  });
});

// R5-08 — the snake_case wire mapping used at every HTTP/SSE boundary.
describe('notification wire mapping (R5-08)', () => {
  const stored: StoredNotificationItem = {
    id: 'a',
    kind: 'push',
    title: 'Flight delayed',
    body: 'BA117 +40m',
    firedAt: 1_700_000_000_000,
    readAt: null,
    sourceId: 'task-1',
    deepLink: 'dina://subscriptions',
    expiresAt: null,
    dataScope: 'guided_demo:run-1',
  };

  it('storedNotificationToWire → wireToStoredNotification round-trips (snake_case on the wire)', () => {
    const wire = storedNotificationToWire(stored);
    expect(wire).toEqual({
      id: 'a',
      kind: 'push',
      title: 'Flight delayed',
      body: 'BA117 +40m',
      fired_at: 1_700_000_000_000,
      read_at: null,
      source_id: 'task-1',
      deep_link: 'dina://subscriptions',
      expires_at: null,
      data_scope: 'guided_demo:run-1',
    });
    expect(wireToStoredNotification(wire)).toEqual(stored);
  });

  it('wireToStoredNotification rejects a malformed body', () => {
    expect(wireToStoredNotification(null)).toBeNull();
    expect(wireToStoredNotification({ kind: 'push' })).toBeNull(); // no id
    expect(wireToStoredNotification({ id: 'x', kind: 'push', title: 't', body: 'b' })).toBeNull(); // no fired_at
  });
});

// R4-03 — the DURABLE store: the SAME contract against the real SQLite engine +
// the v27 notification_log migration, so restart survival + data_scope are real.
describe('SqliteNotificationLogRepository (durable, migration v27)', () => {
  let dir: string;
  let dbPath: string;
  let passHex: string;
  let adapter: NodeSQLiteAdapter;
  let repo: SqliteNotificationLogRepository;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'notiflog-'));
    dbPath = path.join(dir, 'identity.sqlite');
    passHex = randomBytes(32).toString('hex');
    adapter = new NodeSQLiteAdapter({
      path: dbPath,
      passphraseHex: passHex,
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    repo = new SqliteNotificationLogRepository(adapter);
  });

  afterEach(() => {
    adapter?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function row(over: Partial<StoredNotificationItem> = {}): StoredNotificationItem {
    return {
      id: over.id ?? 'n1',
      kind: over.kind ?? 'push',
      title: over.title ?? 'Flight delayed',
      body: over.body ?? 'BA117 +40m',
      firedAt: over.firedAt ?? 1_700_000_000_000,
      readAt: over.readAt ?? null,
      sourceId: over.sourceId ?? 'task-1',
      deepLink: over.deepLink ?? 'dina://subscriptions',
      expiresAt: over.expiresAt ?? null,
      dataScope: over.dataScope ?? 'user',
    };
  }

  it('append + listAll round-trips every field including data_scope', async () => {
    await repo.append(row({ id: 'a', dataScope: 'guided_demo:run-9' }));
    const [got] = await repo.listAll();
    expect(got).toEqual(row({ id: 'a', dataScope: 'guided_demo:run-9' }));
  });

  it('append upserts on id (a re-fire overwrites, no duplicate)', async () => {
    await repo.append(row({ id: 'a', title: 'first' }));
    await repo.append(row({ id: 'a', title: 'second' }));
    const all = await repo.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe('second');
  });

  it('listAll is newest-first and honours the limit', async () => {
    await repo.append(row({ id: 'old', firedAt: 100 }));
    await repo.append(row({ id: 'new', firedAt: 300 }));
    await repo.append(row({ id: 'mid', firedAt: 200 }));
    expect((await repo.listAll()).map((r) => r.id)).toEqual(['new', 'mid', 'old']);
    expect((await repo.listAll(2)).map((r) => r.id)).toEqual(['new', 'mid']);
  });

  it('markRead is one-shot', async () => {
    await repo.append(row({ id: 'a' }));
    expect(await repo.markRead('a', 123)).toBe(true);
    expect(await repo.markRead('a', 456)).toBe(false); // already read
    expect(await repo.markRead('nope', 1)).toBe(false);
    expect((await repo.listAll())[0]!.readAt).toBe(123);
  });

  it('purgeBefore prefers explicit expiresAt', async () => {
    await repo.append(row({ id: 'kept', firedAt: 100, expiresAt: 1000 }));
    await repo.append(row({ id: 'purged', firedAt: 900, expiresAt: 100 }));
    expect(await repo.purgeBefore(500)).toBe(1);
    expect((await repo.listAll()).map((r) => r.id)).toEqual(['kept']);
  });

  it('purgeByScopePrefix drops only guided-demo rows (escaped LIKE)', async () => {
    await repo.append(row({ id: 'u1', dataScope: 'user' }));
    await repo.append(row({ id: 'd1', dataScope: 'guided_demo:run-1' }));
    await repo.append(row({ id: 'd2', dataScope: 'guided_demo:run-2' }));
    expect(await repo.purgeByScopePrefix('guided_demo:')).toBe(2);
    expect((await repo.listAll()).map((r) => r.id)).toEqual(['u1']);
  });

  it('survives a fresh adapter over the same file (restart durability)', async () => {
    await repo.append(row({ id: 'persisted', title: 'kept across restart' }));
    adapter.close();
    // Reopen the SAME encrypted file with the SAME passphrase — a process
    // restart. The row must still be there (the whole point of R4-03:
    // notifications no longer vanish on restart).
    const reopened = new NodeSQLiteAdapter({
      path: dbPath,
      passphraseHex: passHex,
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    const all = await new SqliteNotificationLogRepository(reopened).listAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe('kept across restart');
    // Hand the reopened adapter to afterEach so it (not the closed original) is
    // the one closed.
    adapter = reopened;
  });
});

