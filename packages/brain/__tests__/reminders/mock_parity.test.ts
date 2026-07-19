/**
 * Parity gate: MockCoreClient's reminder behaviour vs the REAL reminder
 * service. The mock is the test double brain + lite-server tests run
 * against; if it drifts from real Core, regressions hide (this is exactly
 * how the round-4 dedup/snooze/fire drift slipped in). Rather than re-
 * assert each rule twice, this drives identical operations through both
 * and asserts the SAME outcome — so any future divergence fails here.
 *
 * (Closes the bug *class*, per "contract tests over scenario tests".)
 */

import {
  createReminder,
  snoozeReminder,
  fireMissedReminders,
  listByPersona,
  listPending,
  getReminder,
  resetReminderState,
} from '@dina/core/reminders';
import { MockCoreClient } from '@dina/test-harness';

describe('MockCoreClient ⇄ real reminder service parity', () => {
  beforeEach(() => resetReminderState());
  afterEach(() => resetReminderState());

  it('dedup includes message: two different-message reminders at the same time → 2 (both stores)', () => {
    const due = Date.now() + 60_000;
    // Real service
    const r1 = createReminder({ message: 'call mom', due_at: due, persona: 'general' });
    const r2 = createReminder({ message: 'take meds', due_at: due, persona: 'general' });
    const realDistinct = r1.id !== r2.id;
    const realCount = listByPersona('general').length;

    // Mock
    const mock = new MockCoreClient();
    return (async () => {
      const m1 = await mock.reminderCreate({ message: 'call mom', due_at: due, persona: 'general' });
      const m2 = await mock.reminderCreate({ message: 'take meds', due_at: due, persona: 'general' });
      const mockDistinct = m1.id !== m2.id;
      const mockCount = (await mock.reminderListByPersona('general')).length;

      expect(realDistinct).toBe(true);
      expect(mockDistinct).toBe(realDistinct); // parity
      expect(mockCount).toBe(realCount); // both = 2
      expect(realCount).toBe(2);
    })();
  });

  it('dedup collapses an identical reminder → 1 (both stores)', async () => {
    const due = Date.now() + 60_000;
    const a1 = createReminder({ message: 'same', due_at: due, persona: 'general' });
    const a2 = createReminder({ message: 'same', due_at: due, persona: 'general' });

    const mock = new MockCoreClient();
    const b1 = await mock.reminderCreate({ message: 'same', due_at: due, persona: 'general' });
    const b2 = await mock.reminderCreate({ message: 'same', due_at: due, persona: 'general' });

    expect(a1.id).toBe(a2.id);
    expect(b1.id).toBe(b2.id); // parity: both dedup
    expect(listByPersona('general')).toHaveLength(1);
    expect(await mock.reminderListByPersona('general')).toHaveLength(1);
  });

  it('snooze bases off max(due_at, now): a past-due reminder moves past now+snooze (both stores)', async () => {
    const snoozeMs = 60_000;
    const pastDue = Date.now() - 5_000;

    const real = createReminder({ message: 'overdue', due_at: pastDue, persona: 'general' });
    snoozeReminder(real.id, snoozeMs);
    const realNewDue = getReminder(real.id)!.due_at;

    const mock = new MockCoreClient();
    const m = await mock.reminderCreate({ message: 'overdue', due_at: pastDue, persona: 'general' });
    await mock.reminderSnooze(m.id, snoozeMs);
    const mockNewDue = (await mock.reminderListByPersona('general'))[0]!.due_at;

    // The defining property: snoozing a PAST-due reminder bases off `now`,
    // so the new due_at exceeds (old due_at + snoozeMs). The old buggy mock
    // (due_at += snoozeMs) would land exactly AT pastDue + snoozeMs.
    expect(realNewDue).toBeGreaterThan(pastDue + snoozeMs);
    expect(mockNewDue).toBeGreaterThan(pastDue + snoozeMs); // parity
  });

  it('fire includes snoozed reminders (both stores)', async () => {
    const now = Date.now();
    // Real: create, snooze into the past, then fire.
    const real = createReminder({ message: 'ring', due_at: now - 10_000, persona: 'general' });
    snoozeReminder(real.id, -5_000); // snoozeMs negative → due_at stays past, status='snoozed'
    const realFired = fireMissedReminders(now).map((r) => r.id);

    const mock = new MockCoreClient();
    const m = await mock.reminderCreate({ message: 'ring', due_at: now - 10_000, persona: 'general' });
    await mock.reminderSnooze(m.id, -5_000);
    const mockFired = (await mock.reminderFireMissed(now)).map((r) => r.id);

    // Both fire the snoozed-into-the-past reminder (pending-only would miss it).
    expect(realFired).toContain(real.id);
    expect(mockFired).toContain(m.id); // parity
  });
});
