/**
 * REQ-02, REQ-08, REQ-11, REQ-14, REQ-15: the reminder machine, on the SQLite
 * repository, restart included.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { MS_DAY } from '../../src/constants';
import { SQLiteReminderRepository, setReminderRepository } from '../../src/reminders/repository';
import {
  completeReminder,
  createReminderDurable,
  deleteReminder,
  deleteReminderDurable,
  fireMissedReminders,
  getReminder,
  hydrateRemindersFromRepo,
  listByPersona,
  listPending,
  resetReminderCaches,
  resetReminderState,
  snoozeReminder,
} from '../../src/reminders/service';
import { makeReminderHandlers } from '../../src/server/routes/reminders';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

let db: NodeSQLiteAdapter;

function openDB(): NodeSQLiteAdapter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-reminders-'));
  const adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  return adapter;
}

const req = (extra: Record<string, unknown>) =>
  ({ query: {}, headers: {}, body: {}, rawBody: new Uint8Array(), params: {}, ...extra }) as never;

async function restart(): Promise<void> {
  resetReminderCaches();
  await hydrateRemindersFromRepo();
}

const sqlRows = (): number =>
  Number(db.query<{ c: number }>('SELECT COUNT(*) c FROM reminders')[0]?.c);

beforeEach(() => {
  db = openDB();
  setReminderRepository(new SQLiteReminderRepository(db));
  resetReminderState();
});

describe('REQ-02: a deleted reminder stays deleted', () => {
  it('through the route: gone from SQL, absent and unfired after a restart', async () => {
    const r = await createReminderDurable({
      message: 'p',
      due_at: Date.now() - 1000,
      persona: 'general',
    });
    const res = await makeReminderHandlers().remove(req({ params: { id: r.id } }));
    expect((res as { body: unknown }).body).toEqual({ deleted: true });
    expect(sqlRows()).toBe(0);

    await restart();

    expect(getReminder(r.id)).toBeNull();
    expect(fireMissedReminders(Date.now())).toEqual([]);
  });

  it('the same text and time can be created again', async () => {
    const due = Date.now() + 60_000;
    const r = await createReminderDurable({ message: 'p', due_at: due, persona: 'general' });
    deleteReminder(r.id);
    const again = await createReminderDurable({ message: 'p', due_at: due, persona: 'general' });
    expect(again.id).not.toBe(r.id);
  });

  it('removes a row the cache has lost, which is how a forget meets one', async () => {
    const r = await createReminderDurable({
      message: 'p',
      due_at: Date.now() + 1,
      persona: 'general',
    });
    resetReminderCaches();
    expect(await deleteReminderDurable(r.id)).toBe(false);
    expect(sqlRows()).toBe(0);
  });
});

describe('REQ-08: recurring reminders keep going', () => {
  it('firing a daily reminder makes the next one, due after now', async () => {
    const now = Date.now();
    await createReminderDurable({
      message: 'daily',
      due_at: now - 3 * MS_DAY,
      persona: 'general',
      recurring: 'daily',
    });

    expect(fireMissedReminders(now)).toHaveLength(1);

    const live = listByPersona('general').filter((r) => r.status === 'pending');
    expect(live).toHaveLength(1);
    expect(live[0]!.due_at).toBeGreaterThan(now);
    expect(live[0]!.due_at).toBeLessThanOrEqual(now + MS_DAY);
    expect(live[0]!.recurring).toBe('daily');
  });

  it('fires again a day later, once per day, not once per day missed', async () => {
    const now = Date.now();
    await createReminderDurable({
      message: 'daily',
      due_at: now - 3 * MS_DAY,
      persona: 'general',
      recurring: 'daily',
    });
    fireMissedReminders(now);
    expect(fireMissedReminders(now + 10)).toEqual([]);
    expect(fireMissedReminders(now + MS_DAY + 1)).toHaveLength(1);
  });

  it('survives a restart: the next occurrence is on disk', async () => {
    const now = Date.now();
    await createReminderDurable({
      message: 'daily',
      due_at: now - 1000,
      persona: 'general',
      recurring: 'daily',
    });
    fireMissedReminders(now);
    await new Promise((r) => setTimeout(r, 5));
    await restart();
    expect(fireMissedReminders(now + MS_DAY + 1)).toHaveLength(1);
  });

  it('a late Done on a fired occurrence does not start a second chain', async () => {
    const now = Date.now();
    const r = await createReminderDurable({
      message: 'daily',
      due_at: now - 1000,
      persona: 'general',
      recurring: 'daily',
    });
    fireMissedReminders(now);
    completeReminder(r.id);
    expect(
      listByPersona('general').filter((x) => x.completed === 0 && x.status === 'pending'),
    ).toHaveLength(1);
    expect(listPending(now)).toEqual([]);
  });

  it('Done on an unfired recurring reminder skips forward past now', async () => {
    const now = Date.now();
    const r = await createReminderDurable({
      message: 'daily',
      due_at: now - 5 * MS_DAY,
      persona: 'general',
      recurring: 'daily',
    });
    const next = completeReminder(r.id);
    expect(next?.due_at).toBeGreaterThan(Date.now() - 1000);
    expect(listPending(now)).toEqual([]);
  });
});

describe('REQ-11: a throwing fire callback', () => {
  it('loses nothing: the rest of the batch fires, and the one that threw fires again', async () => {
    await createReminderDurable({ message: 'a', due_at: Date.now() - 2000, persona: 'general' });
    await createReminderDurable({ message: 'b', due_at: Date.now() - 1000, persona: 'general' });

    const fired = fireMissedReminders(Date.now(), (r) => {
      if (r.message === 'a') throw new Error('post failed');
    });

    expect(fired.map((r) => r.message)).toEqual(['b']);
    expect(fireMissedReminders(Date.now()).map((r) => r.message)).toEqual(['a']);
  });
});

describe('REQ-14: acting on a finished reminder', () => {
  it('snooze answers 409 and changes nothing', async () => {
    const r = await createReminderDurable({
      message: 'x',
      due_at: Date.now() + 1000,
      persona: 'general',
    });
    completeReminder(r.id);
    const res = await makeReminderHandlers().snooze(
      req({ params: { id: r.id }, body: { snooze_ms: 60_000 } }),
    );
    expect((res as { status: number }).status).toBe(409);
    expect(getReminder(r.id)?.status).toBe('completed');
  });

  it('a second Done makes no second occurrence', async () => {
    const r = await createReminderDurable({
      message: 'x',
      due_at: Date.now() + 1000,
      persona: 'general',
      recurring: 'daily',
    });
    expect(completeReminder(r.id)).not.toBeNull();
    expect(completeReminder(r.id)).toBeNull();
    expect(listByPersona('general')).toHaveLength(2);
  });
});

describe('REQ-15: the dedup index follows the reminder', () => {
  it('a snooze moves the key: the old time is free, the new time is the same reminder', async () => {
    const due = Date.now() + 1000;
    const r = await createReminderDurable({ message: 'y', due_at: due, persona: 'general' });
    snoozeReminder(r.id, 60_000, due);
    const moved = getReminder(r.id)!.due_at;

    const atNew = await createReminderDurable({ message: 'y', due_at: moved, persona: 'general' });
    expect(atNew.id).toBe(r.id);

    const atOld = await createReminderDurable({ message: 'y', due_at: due, persona: 'general' });
    expect(atOld.id).not.toBe(r.id);
    expect(atOld.due_at).toBe(due);
  });

  it('a manual create over a completed reminder reopens it', async () => {
    const due = Date.now() + 100_000;
    const r = await createReminderDurable({ message: 'z', due_at: due, persona: 'general' });
    completeReminder(r.id);

    const again = await createReminderDurable({ message: 'z', due_at: due, persona: 'general' });

    expect(again.id).toBe(r.id);
    expect(again.completed).toBe(0);
    expect(again.status).toBe('pending');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await restart();
    expect(getReminder(r.id)?.completed).toBe(0);
  });

  it('a re-ingested source item does not bring back what the owner finished', async () => {
    const due = Date.now() + 100_000;
    const input = { message: 'z', due_at: due, persona: 'general', source_item_id: 'stg-1' };
    const r = await createReminderDurable(input);
    completeReminder(r.id);
    expect((await createReminderDurable(input)).completed).toBe(1);
  });
});
