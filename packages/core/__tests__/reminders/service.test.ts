/**
 * T2.61 — Reminder service: CRUD, dedup, recurring, pending list.
 *
 * Source: ARCHITECTURE.md Section 2.61
 */

import {
  createReminder,
  createReminderDurable,
  getReminder,
  getByShortId,
  listPending,
  nextPending,
  fireMissedReminders,
  listByPersona,
  completeReminder,
  snoozeReminder,
  deleteReminder,
  resetReminderState,
  hydrateRemindersFromRepo,
} from '../../src/reminders/service';
import type { ReminderRepository } from '../../src/reminders/repository';
import { setReminderRepository } from '../../src/reminders/repository';
import type { Reminder } from '../../src/reminders/service';

describe('Reminder Service', () => {
  beforeEach(() => resetReminderState());

  describe('createReminder', () => {
    it('creates a reminder with generated ID', () => {
      const r = createReminder({
        message: 'Buy milk',
        due_at: Date.now() + 60_000,
        persona: 'general',
      });
      expect(r.id).toMatch(/^rem-[0-9a-f]{32}$/); // 16 random bytes = 32 hex chars (matching Go)
      expect(r.message).toBe('Buy milk');
      expect(r.status).toBe('pending');
      expect(r.completed).toBe(0);
    });

    it('defaults kind to manual', () => {
      const r = createReminder({ message: 'Test', due_at: Date.now(), persona: 'general' });
      expect(r.kind).toBe('manual');
    });

    it('accepts custom kind and source', () => {
      const r = createReminder({
        message: 'Birthday',
        due_at: Date.now(),
        persona: 'general',
        kind: 'birthday',
        source: 'gmail',
        source_item_id: 'email-123',
      });
      expect(r.kind).toBe('birthday');
      expect(r.source).toBe('gmail');
      expect(r.source_item_id).toBe('email-123');
    });

    it('stores persona', () => {
      const r = createReminder({ message: 'Test', due_at: Date.now(), persona: 'health' });
      expect(r.persona).toBe('health');
    });

    it('supports recurring frequencies', () => {
      const r = createReminder({
        message: 'Daily standup',
        due_at: Date.now(),
        persona: 'work',
        recurring: 'daily',
      });
      expect(r.recurring).toBe('daily');
    });
  });

  describe('createReminderDurable (HTTP-route path — durable-at-ack)', () => {
    afterEach(() => setReminderRepository(null));

    /** A ReminderRepository whose `create` outcome the test controls. */
    function stubRepo(onCreate: (r: Reminder) => Promise<void>): ReminderRepository {
      return {
        create: onCreate,
        get: async () => null,
        listPending: async () => [],
        listByPersona: async () => [],
        listAll: async () => [],
        update: async () => {},
        remove: async () => false,
      };
    }

    it('persists (awaits create) then returns the reminder', async () => {
      const persisted: Reminder[] = [];
      setReminderRepository(stubRepo(async (r) => { persisted.push(r); }));
      const r = await createReminderDurable({
        message: 'Pay rent',
        due_at: Date.now() + 60_000,
        persona: 'general',
      });
      // The durable write happened BEFORE the ack, and the row is live.
      expect(persisted.map((x) => x.id)).toEqual([r.id]);
      expect(listByPersona('general').map((x) => x.id)).toEqual([r.id]);
    });

    it('leaves nothing in memory + throws when the SQL write fails', async () => {
      setReminderRepository(stubRepo(async () => { throw new Error('disk full'); }));
      await expect(
        createReminderDurable({ message: 'x', due_at: Date.now() + 1000, persona: 'general' }),
      ).rejects.toThrow(/durable create failed: disk full/);
      // SQL-first registration: the in-memory row is only added AFTER the
      // write resolves, so a failed write leaves no phantom reminder.
      expect(listByPersona('general')).toHaveLength(0);
    });

    it('coalesces concurrent identical creates onto ONE write + outcome (#2)', async () => {
      let writes = 0;
      let resolveWrite: (() => void) | undefined;
      // Hold the first write open so the duplicate races while it's pending.
      const gate = new Promise<void>((res) => {
        resolveWrite = res;
      });
      setReminderRepository(
        stubRepo(async () => {
          writes++;
          await gate;
        }),
      );
      const input = { message: 'call mom', due_at: Date.now() + 1000, persona: 'general' };
      const p1 = createReminderDurable(input);
      const p2 = createReminderDurable(input); // concurrent duplicate, write still pending
      resolveWrite!();
      const [r1, r2] = await Promise.all([p1, p2]);

      // Both callers get the SAME reminder, and only ONE SQL write happened
      // — the duplicate never acked off a not-yet-persisted in-memory row.
      expect(r2.id).toBe(r1.id);
      expect(writes).toBe(1);
      expect(listByPersona('general')).toHaveLength(1);
    });

    it('a concurrent duplicate also fails when the single shared write fails (#2)', async () => {
      setReminderRepository(stubRepo(async () => { throw new Error('disk full'); }));
      const input = { message: 'x', due_at: Date.now() + 1000, persona: 'general' };
      const results = await Promise.allSettled([
        createReminderDurable(input),
        createReminderDurable(input),
      ]);
      // Neither caller gets a false success off the other's pending write.
      for (const r of results) expect(r.status).toBe('rejected');
      expect(listByPersona('general')).toHaveLength(0);
    });

    it('with no repo wired behaves like createReminder (in-memory IS the truth)', async () => {
      const r = await createReminderDurable({
        message: 'no-repo',
        due_at: Date.now() + 1000,
        persona: 'general',
      });
      expect(listByPersona('general').map((x) => x.id)).toEqual([r.id]);
    });
  });

  describe('dedup', () => {
    it('prevents a true duplicate (same source_item_id, kind, due_at, persona, message)', () => {
      const dueAt = Date.now() + 60_000;
      const r1 = createReminder({
        message: 'Birthday',
        due_at: dueAt,
        persona: 'general',
        kind: 'birthday',
        source_item_id: 'email-123',
      });
      const r2 = createReminder({
        message: 'Birthday', // identical → genuine duplicate (e.g. re-ingest)
        due_at: dueAt,
        persona: 'general',
        kind: 'birthday',
        source_item_id: 'email-123',
      });
      expect(r1.id).toBe(r2.id); // same reminder returned
    });

    it('allows two DIFFERENT-message reminders from the same source at the same time', () => {
      // One email can legitimately yield two distinct reminders ("dentist
      // appointment" + "bring insurance card") at the same due_at. message
      // is part of the dedup identity, so the second is NOT dropped.
      const dueAt = Date.now() + 60_000;
      const r1 = createReminder({
        message: 'Dentist appointment',
        due_at: dueAt,
        persona: 'general',
        kind: 'event',
        source_item_id: 'email-9',
      });
      const r2 = createReminder({
        message: 'Bring insurance card',
        due_at: dueAt,
        persona: 'general',
        kind: 'event',
        source_item_id: 'email-9',
      });
      expect(r1.id).not.toBe(r2.id);
    });

    it('does NOT collide two different MANUAL reminders at the same time (#1)', () => {
      // The /ask path passes no source_item_id and kind=manual; before the
      // fix, "call mom at 5" and "take medicine at 5" shared a dedup key and
      // the second was silently dropped.
      const dueAt = Date.now() + 60_000;
      const r1 = createReminder({ message: 'call mom', due_at: dueAt, persona: 'general' });
      const r2 = createReminder({ message: 'take medicine', due_at: dueAt, persona: 'general' });
      expect(r1.id).not.toBe(r2.id);
      expect(listByPersona('general')).toHaveLength(2);
    });

    it('still dedups an identical manual reminder (double-submit)', () => {
      const dueAt = Date.now() + 60_000;
      const r1 = createReminder({ message: 'call mom', due_at: dueAt, persona: 'general' });
      const r2 = createReminder({ message: 'call mom', due_at: dueAt, persona: 'general' });
      expect(r1.id).toBe(r2.id);
      expect(listByPersona('general')).toHaveLength(1);
    });

    it('allows same kind+source_item_id in different persona', () => {
      const dueAt = Date.now() + 60_000;
      const r1 = createReminder({
        message: 'A',
        due_at: dueAt,
        persona: 'general',
        kind: 'birthday',
        source_item_id: 'x',
      });
      const r2 = createReminder({
        message: 'B',
        due_at: dueAt,
        persona: 'health',
        kind: 'birthday',
        source_item_id: 'x',
      });
      expect(r1.id).not.toBe(r2.id);
    });

    it('allows same kind+persona with different due_at', () => {
      const r1 = createReminder({
        message: 'A',
        due_at: 1000,
        persona: 'general',
        kind: 'birthday',
        source_item_id: 'x',
      });
      const r2 = createReminder({
        message: 'B',
        due_at: 2000,
        persona: 'general',
        kind: 'birthday',
        source_item_id: 'x',
      });
      expect(r1.id).not.toBe(r2.id);
    });
  });

  describe('listPending', () => {
    it('returns due reminders', () => {
      const pastDue = Date.now() - 60_000;
      createReminder({ message: 'Due', due_at: pastDue, persona: 'general' });
      createReminder({ message: 'Future', due_at: Date.now() + 999_999, persona: 'general' });
      const pending = listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].message).toBe('Due');
    });

    it('excludes completed reminders', () => {
      const r = createReminder({ message: 'Done', due_at: Date.now() - 1000, persona: 'general' });
      completeReminder(r.id);
      expect(listPending()).toHaveLength(0);
    });

    it('sorted by due_at ascending', () => {
      const now = Date.now();
      createReminder({ message: 'Later', due_at: now - 1000, persona: 'general' });
      createReminder({ message: 'Earlier', due_at: now - 5000, persona: 'general' });
      const pending = listPending();
      expect(pending[0].message).toBe('Earlier');
      expect(pending[1].message).toBe('Later');
    });

    it('returns empty when none pending', () => {
      expect(listPending()).toEqual([]);
    });
  });

  describe('listByPersona', () => {
    it('returns reminders for specific persona', () => {
      createReminder({ message: 'General', due_at: Date.now(), persona: 'general' });
      createReminder({ message: 'Health', due_at: Date.now(), persona: 'health' });
      expect(listByPersona('general')).toHaveLength(1);
      expect(listByPersona('health')).toHaveLength(1);
    });

    it('includes completed reminders', () => {
      const r = createReminder({ message: 'Done', due_at: Date.now(), persona: 'general' });
      completeReminder(r.id);
      expect(listByPersona('general')).toHaveLength(1);
    });
  });

  describe('completeReminder', () => {
    it('marks reminder as completed', () => {
      const r = createReminder({ message: 'Task', due_at: Date.now(), persona: 'general' });
      completeReminder(r.id);
      expect(getReminder(r.id)!.completed).toBe(1);
      expect(getReminder(r.id)!.status).toBe('completed');
    });

    it('creates next occurrence for recurring daily', () => {
      const dueAt = Date.now();
      const r = createReminder({
        message: 'Standup',
        due_at: dueAt,
        persona: 'work',
        recurring: 'daily',
      });
      const next = completeReminder(r.id);
      expect(next).not.toBeNull();
      expect(next!.due_at).toBe(dueAt + 86_400_000);
      expect(next!.recurring).toBe('daily');
    });

    it('creates next occurrence for recurring weekly', () => {
      const dueAt = Date.now();
      const r = createReminder({
        message: 'Review',
        due_at: dueAt,
        persona: 'work',
        recurring: 'weekly',
      });
      const next = completeReminder(r.id);
      expect(next!.due_at).toBe(dueAt + 7 * 86_400_000);
    });

    it('returns null for non-recurring reminder', () => {
      const r = createReminder({ message: 'Once', due_at: Date.now(), persona: 'general' });
      expect(completeReminder(r.id)).toBeNull();
    });

    it('throws for unknown ID', () => {
      expect(() => completeReminder('rem-nonexistent')).toThrow('not found');
    });
  });

  describe('snoozeReminder', () => {
    it('pushes due_at forward by snoozeMs from max(due_at, now)', () => {
      const dueAt = Date.now();
      const r = createReminder({ message: 'Snooze me', due_at: dueAt, persona: 'general' });
      // Pin `now` to dueAt so the assertion is deterministic. With
      // dueAt >= now, base is dueAt and the new due_at is dueAt + ms.
      snoozeReminder(r.id, 600_000, dueAt); // 10 min
      expect(getReminder(r.id)!.due_at).toBe(dueAt + 600_000);
      expect(getReminder(r.id)!.status).toBe('snoozed');
    });

    it('snoozes from now when due_at is already past', () => {
      const NOW = 1_700_000_000_000;
      const r = createReminder({
        message: 'Already late',
        due_at: NOW - 2 * 60 * 60 * 1000, // 2h overdue
        persona: 'general',
      });
      snoozeReminder(r.id, 60 * 60 * 1000, NOW); // snooze 1h from now
      // Without max(due_at, now), the new due_at would be NOW - 1h
      // (still past) and the watcher would re-fire immediately.
      expect(getReminder(r.id)!.due_at).toBe(NOW + 60 * 60 * 1000);
    });

    it('throws for unknown ID', () => {
      expect(() => snoozeReminder('rem-missing', 1000)).toThrow('not found');
    });

    it('re-fires after the new due_at elapses', () => {
      // Pins the snooze → re-fire round-trip. Without this, snoozed
      // reminders silently disappear forever (status flipped to
      // 'snoozed', listPending only returned 'pending').
      const NOW = 1_700_000_000_000;
      const r = createReminder({
        message: 'Snooze then fire',
        due_at: NOW - 1000,
        persona: 'general',
      });
      // Initial fire flips status to 'fired'.
      const fired1 = fireMissedReminders(NOW);
      expect(fired1).toHaveLength(1);

      // User snoozes 1h from NOW. (Pinned `now` so the test is
      // deterministic — the default `Date.now()` would be the real
      // wall-clock and would push due_at far past the assertion
      // bounds below.)
      snoozeReminder(r.id, 60 * 60 * 1000, NOW);
      expect(getReminder(r.id)!.status).toBe('snoozed');

      // Tick before new due_at — must NOT fire.
      expect(fireMissedReminders(NOW + 30 * 60 * 1000)).toHaveLength(0);

      // Tick after new due_at — must fire again.
      const fired2 = fireMissedReminders(NOW + 2 * 60 * 60 * 1000);
      expect(fired2).toHaveLength(1);
      expect(fired2[0]!.id).toBe(r.id);
    });
  });

  describe('deleteReminder', () => {
    it('removes reminder', () => {
      const r = createReminder({ message: 'Del', due_at: Date.now(), persona: 'general' });
      expect(deleteReminder(r.id)).toBe(true);
      expect(getReminder(r.id)).toBeNull();
    });

    it('returns false for unknown ID', () => {
      expect(deleteReminder('rem-missing')).toBe(false);
    });
  });

  describe('nextPending (matching Go NextPending)', () => {
    it('returns null when no reminders exist', () => {
      expect(nextPending()).toBeNull();
    });

    it('returns the single earliest due reminder', () => {
      const now = Date.now();
      createReminder({ message: 'Later', due_at: now - 1000, persona: 'general' });
      createReminder({ message: 'Earliest', due_at: now - 5000, persona: 'general' });
      createReminder({ message: 'Recent', due_at: now - 2000, persona: 'general' });

      const next = nextPending(now);
      expect(next).not.toBeNull();
      expect(next!.message).toBe('Earliest');
    });

    it('ignores future reminders', () => {
      const now = Date.now();
      createReminder({ message: 'Future', due_at: now + 60000, persona: 'general' });
      expect(nextPending(now)).toBeNull();
    });

    it('ignores completed reminders', () => {
      const now = Date.now();
      const r = createReminder({ message: 'Done', due_at: now - 1000, persona: 'general' });
      completeReminder(r.id);
      expect(nextPending(now)).toBeNull();
    });

    it('returns only one even when multiple are due', () => {
      const now = Date.now();
      createReminder({ message: 'A', due_at: now - 1000, persona: 'general' });
      createReminder({ message: 'B', due_at: now - 2000, persona: 'general' });
      const next = nextPending(now);
      expect(next).not.toBeNull();
      // Should be the earliest (B), and it's a single result not an array
      expect(next!.message).toBe('B');
    });
  });

  describe('fireMissedReminders (startup recovery)', () => {
    it('fires all past-due reminders', () => {
      const now = Date.now();
      createReminder({ message: 'Missed A', due_at: now - 5000, persona: 'general' });
      createReminder({ message: 'Missed B', due_at: now - 3000, persona: 'general' });
      createReminder({ message: 'Future', due_at: now + 60000, persona: 'general' });

      const fired = fireMissedReminders(now);
      expect(fired).toHaveLength(2);
      expect(fired.map((r) => r.message).sort()).toEqual(['Missed A', 'Missed B']);
    });

    it('marks fired reminders as status "fired"', () => {
      const now = Date.now();
      const r = createReminder({ message: 'Overdue', due_at: now - 1000, persona: 'general' });
      fireMissedReminders(now);
      expect(getReminder(r.id)!.status).toBe('fired');
    });

    it('returns empty when no missed reminders', () => {
      const now = Date.now();
      createReminder({ message: 'Future', due_at: now + 60000, persona: 'general' });
      expect(fireMissedReminders(now)).toHaveLength(0);
    });

    it('invokes onFire callback for each fired reminder', () => {
      const now = Date.now();
      createReminder({ message: 'A', due_at: now - 1000, persona: 'general' });
      createReminder({ message: 'B', due_at: now - 2000, persona: 'general' });

      const messages: string[] = [];
      fireMissedReminders(now, (r) => messages.push(r.message));
      expect(messages).toHaveLength(2);
    });

    it('does not fire already-completed reminders', () => {
      const now = Date.now();
      const r = createReminder({ message: 'Done', due_at: now - 1000, persona: 'general' });
      completeReminder(r.id);
      expect(fireMissedReminders(now)).toHaveLength(0);
    });
  });

  describe('short_id', () => {
    it('generates a 4-char short_id on creation', () => {
      const r = createReminder({ message: 'Test', due_at: Date.now(), persona: 'general' });
      expect(r.short_id).toMatch(/^[0-9a-f]{4}$/);
    });

    it('different reminders get different short_ids', () => {
      const r1 = createReminder({
        message: 'First',
        due_at: Date.now() + 1000,
        persona: 'general',
        kind: 'a',
      });
      const r2 = createReminder({
        message: 'Second',
        due_at: Date.now() + 2000,
        persona: 'general',
        kind: 'b',
      });
      expect(r1.short_id).not.toBe(r2.short_id);
    });

    it('getByShortId returns the correct reminder', () => {
      const r = createReminder({ message: 'Find me', due_at: Date.now(), persona: 'general' });
      const found = getByShortId(r.short_id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(r.id);
      expect(found!.message).toBe('Find me');
    });

    it('getByShortId is case-insensitive', () => {
      const r = createReminder({ message: 'Case test', due_at: Date.now(), persona: 'general' });
      const upper = r.short_id.toUpperCase();
      const found = getByShortId(upper);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(r.id);
    });

    it('getByShortId returns null for unknown short_id', () => {
      expect(getByShortId('zzzz')).toBeNull();
    });

    it('deleted reminder not found by short_id', () => {
      const r = createReminder({ message: 'To delete', due_at: Date.now(), persona: 'general' });
      const shortId = r.short_id;
      deleteReminder(r.id);
      expect(getByShortId(shortId)).toBeNull();
    });

    it('short_id is stable (same reminder always has same short_id)', () => {
      const r = createReminder({ message: 'Stable', due_at: Date.now(), persona: 'general' });
      const first = r.short_id;
      const fetched = getReminder(r.id);
      expect(fetched!.short_id).toBe(first);
    });
  });

  describe('hydrateRemindersFromRepo (cold-start hydration)', () => {
    /**
     * Stand-in repository that holds rows in a plain array. Mirrors
     * `SQLiteReminderRepository`'s observable surface — `listAll` is
     * the only method `hydrateRemindersFromRepo` calls. The real
     * SQLite-backed test would also stress the row-mapping; this test
     * isolates the hydration behaviour so a regression is unambiguous.
     */
    function inMemoryRepo(rows: Reminder[]): ReminderRepository {
      return {
        async create() {
          /* not used by hydrate */
        },
        async get(id) {
          return rows.find((r) => r.id === id) ?? null;
        },
        async listPending() {
          return rows;
        },
        async listByPersona(p) {
          return rows.filter((r) => r.persona === p);
        },
        async listAll() {
          return rows;
        },
        async update() {
          /* not used by hydrate */
        },
        async remove() {
          return false;
        },
      };
    }

    afterEach(() => setReminderRepository(null));

    it('rebuilds in-memory Map from SQL rows so listPending/listByPersona find them', async () => {
      const persisted: Reminder[] = [
        {
          id: 'rem-' + 'a'.repeat(32),
          short_id: 'a1b2',
          message: "Maya's birthday",
          due_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
          recurring: '',
          completed: 0,
          created_at: Date.now() - 1_000_000,
          source_item_id: 'staging-1',
          source: 'reminder_planner',
          persona: 'general',
          timezone: 'America/Los_Angeles',
          kind: 'birthday',
          status: 'pending',
        },
        {
          id: 'rem-' + 'b'.repeat(32),
          short_id: 'b3c4',
          message: 'Office party',
          due_at: Date.now() + 60 * 24 * 60 * 60 * 1000,
          recurring: '',
          completed: 0,
          created_at: Date.now() - 500_000,
          source_item_id: 'staging-2',
          source: 'reminder_planner',
          persona: 'work',
          timezone: 'America/Los_Angeles',
          kind: 'appointment',
          status: 'pending',
        },
      ];

      // Pre-condition: Map empty (cold start), SQL has the rows.
      expect(listPending(Date.now() + 365 * 24 * 60 * 60 * 1000)).toEqual([]);
      setReminderRepository(inMemoryRepo(persisted));

      const loaded = await hydrateRemindersFromRepo();
      expect(loaded).toBe(2);

      // Post-condition: every read path the UI uses now sees the rows.
      const pending = listPending(Date.now() + 365 * 24 * 60 * 60 * 1000);
      expect(pending).toHaveLength(2);
      expect(pending.map((r) => r.id).sort()).toEqual(persisted.map((r) => r.id).sort());

      // Persona filter still works post-hydration.
      expect(listByPersona('general')).toHaveLength(1);
      expect(listByPersona('work')).toHaveLength(1);

      // Short-ID lookup index was repopulated — `getByShortId` is what
      // CLI/admin commands like `snooze a1b2` use; without rebuilding
      // it during hydration, those commands silently fail to find
      // persisted reminders.
      expect(getByShortId('a1b2')?.id).toBe(persisted[0].id);
    });

    it('is idempotent — re-hydrating skips already-loaded rows', async () => {
      const persisted: Reminder[] = [
        {
          id: 'rem-' + 'c'.repeat(32),
          short_id: 'c5d6',
          message: 'Idempotency check',
          due_at: Date.now() + 24 * 60 * 60 * 1000,
          recurring: '',
          completed: 0,
          created_at: Date.now(),
          source_item_id: 'staging-3',
          source: 'reminder_planner',
          persona: 'general',
          timezone: 'UTC',
          kind: 'manual',
          status: 'pending',
        },
      ];
      setReminderRepository(inMemoryRepo(persisted));

      expect(await hydrateRemindersFromRepo()).toBe(1);
      // Second call must not double-insert or throw on dedup-index
      // collision — ensures the boot path is safe to call after a
      // hot-reload that re-runs init without clearing the Map.
      expect(await hydrateRemindersFromRepo()).toBe(0);
      expect(listByPersona('general')).toHaveLength(1);
    });

    it('returns 0 when no SQL repository is wired (test harness, pre-unlock)', async () => {
      setReminderRepository(null);
      expect(await hydrateRemindersFromRepo()).toBe(0);
    });
  });

  describe('SQL write-through on status mutation (MT-29-I1 / MT-43-I2)', () => {
    /**
     * Fake repository that records every `update(id, partial)` call
     * AND mutates its in-memory rows so a follow-up `listAll` reflects
     * the writes. Mirrors the read-after-write contract a real
     * SQLite-backed repo provides: hydration after a status flip MUST
     * see the new status, otherwise cold launches re-fire stale rows.
     */
    function recordingRepo(rows: Reminder[]): {
      repo: ReminderRepository;
      updates: Array<{ id: string; updates: Partial<Reminder> }>;
    } {
      const updates: Array<{ id: string; updates: Partial<Reminder> }> = [];
      const repo: ReminderRepository = {
        async create(r) {
          rows.push({ ...r });
        },
        async get(id) {
          return rows.find((r) => r.id === id) ?? null;
        },
        async listPending(now) {
          return rows.filter(
            (r) => r.completed === 0 && r.status === 'pending' && r.due_at <= now,
          );
        },
        async listByPersona(p) {
          return rows.filter((r) => r.persona === p);
        },
        async listAll() {
          return rows.map((r) => ({ ...r }));
        },
        async update(id, partial) {
          updates.push({ id, updates: partial });
          const row = rows.find((r) => r.id === id);
          if (row) Object.assign(row, partial);
        },
        async remove() {
          return false;
        },
      };
      return { repo, updates };
    }

    afterEach(() => setReminderRepository(null));

    it('fireMissedReminders writes status=fired through to SQL', async () => {
      const rows: Reminder[] = [];
      const { repo, updates } = recordingRepo(rows);
      setReminderRepository(repo);

      const r = createReminder({
        message: 'Past-due',
        due_at: Date.now() - 60_000,
        persona: 'general',
      });
      // Let the create's fire-and-forget write resolve.
      await Promise.resolve();

      const fired = fireMissedReminders();
      expect(fired).toHaveLength(1);
      expect(fired[0].status).toBe('fired');
      // Drain the fire-and-forget update Promise.
      await Promise.resolve();

      const fireUpdate = updates.find((u) => u.id === r.id && u.updates.status === 'fired');
      expect(fireUpdate).toBeDefined();
    });

    it('a fired reminder does not re-fire after cold-launch hydration (MT-29-I1)', async () => {
      const rows: Reminder[] = [];
      const { repo } = recordingRepo(rows);
      setReminderRepository(repo);

      // Session 1: create + fire.
      createReminder({
        message: 'Verify MT-29-I1',
        due_at: Date.now() - 60_000,
        persona: 'general',
      });
      await Promise.resolve();
      expect(fireMissedReminders()).toHaveLength(1);
      await Promise.resolve();

      // Session 2: simulate a cold launch — clear the in-memory Map,
      // re-hydrate from SQL. Without the write-through the SQL row
      // still says status='pending' and the row would re-fire. With
      // the write-through it's 'fired' and the next tick is a no-op.
      resetReminderState();
      setReminderRepository(repo);
      await hydrateRemindersFromRepo();

      expect(fireMissedReminders()).toHaveLength(0);
    });

    it('completeReminder writes status=completed and completed=1 to SQL', async () => {
      const rows: Reminder[] = [];
      const { repo, updates } = recordingRepo(rows);
      setReminderRepository(repo);

      const r = createReminder({
        message: 'Buy milk',
        due_at: Date.now() + 60_000,
        persona: 'general',
      });
      await Promise.resolve();

      completeReminder(r.id);
      await Promise.resolve();

      const completeUpdate = updates.find(
        (u) => u.id === r.id && u.updates.status === 'completed' && u.updates.completed === 1,
      );
      expect(completeUpdate).toBeDefined();
    });

    it('snoozeReminder writes status=snoozed and the new due_at to SQL', async () => {
      const rows: Reminder[] = [];
      const { repo, updates } = recordingRepo(rows);
      setReminderRepository(repo);

      const dueAt = Date.now() - 60_000;
      const r = createReminder({
        message: 'Snooze me',
        due_at: dueAt,
        persona: 'general',
      });
      await Promise.resolve();

      const NOW = Date.now();
      snoozeReminder(r.id, 60 * 60 * 1000, NOW);
      await Promise.resolve();

      const snoozeUpdate = updates.find((u) => u.id === r.id && u.updates.status === 'snoozed');
      expect(snoozeUpdate).toBeDefined();
      expect(snoozeUpdate!.updates.due_at).toBe(NOW + 60 * 60 * 1000);
    });
  });
});
