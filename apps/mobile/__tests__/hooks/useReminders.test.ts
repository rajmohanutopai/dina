/**
 * T5.6 — Reminders tab: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 5.6
 */

import {
  getUpcomingReminders,
  getOverdueReminders,
  getPersonaReminders,
  groupByDay,
  dismissReminder,
  snoozeReminderBy,
  removeReminder,
  getSnoozePresets,
  getReminderCounts,
  resetReminders,
} from '../../src/hooks/useReminders';
import { createReminder, resetReminderState } from '../../../core/src/reminders/service';

// Anchor NOW to noon local time so `NOW + HOUR` always stays on the
// same day regardless of when the test happens to run. Using
// `Date.now()` here flaked nightly: a run that started within an
// hour of midnight wrapped `NOW + HOUR` into the next calendar day,
// and the "labels today and tomorrow" test below saw the new day's
// label in `groups[0]`. Pinning to noon makes the assertion
// time-of-day independent.
const _now = new Date();
_now.setHours(12, 0, 0, 0);
const NOW = _now.getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

function addReminder(
  message: string,
  dueAt: number,
  opts?: { persona?: string; recurring?: '' | 'daily' | 'weekly' | 'monthly' },
) {
  return createReminder({
    message,
    due_at: dueAt,
    persona: opts?.persona ?? 'general',
    recurring: opts?.recurring,
  });
}

describe('Reminders Tab Hook (5.6)', () => {
  beforeEach(() => resetReminders());

  describe('getUpcomingReminders', () => {
    it('returns empty when no reminders', () => {
      expect(getUpcomingReminders(NOW)).toHaveLength(0);
    });

    it('returns pending reminders sorted by due date', () => {
      addReminder('Later', NOW + 2 * HOUR);
      addReminder('Soon', NOW + 1 * HOUR);

      const upcoming = getUpcomingReminders(NOW);
      expect(upcoming).toHaveLength(2);
      expect(upcoming[0].message).toBe('Soon');
      expect(upcoming[1].message).toBe('Later');
    });

    it('includes overdue reminders', () => {
      addReminder('Overdue', NOW - HOUR);
      const upcoming = getUpcomingReminders(NOW);
      expect(upcoming).toHaveLength(1);
      expect(upcoming[0].isOverdue).toBe(true);
    });
  });

  describe('getOverdueReminders', () => {
    it('only returns past-due reminders', () => {
      addReminder('Past', NOW - HOUR);
      addReminder('Future', NOW + HOUR);

      const overdue = getOverdueReminders(NOW);
      expect(overdue).toHaveLength(1);
      expect(overdue[0].message).toBe('Past');
      expect(overdue[0].isOverdue).toBe(true);
    });
  });

  describe('getPersonaReminders', () => {
    it('filters by persona', () => {
      addReminder('Work task', NOW + HOUR, { persona: 'work' });
      addReminder('General task', NOW + HOUR, { persona: 'general' });

      expect(getPersonaReminders('work', NOW)).toHaveLength(1);
      expect(getPersonaReminders('work', NOW)[0].message).toBe('Work task');
    });
  });

  describe('UI fields', () => {
    it('formats due label for upcoming', () => {
      addReminder('In 30 min', NOW + 30 * 60_000);
      const items = getUpcomingReminders(NOW);
      expect(items[0].dueLabel).toMatch(/30m/);
    });

    it('formats due label for overdue', () => {
      addReminder('Past', NOW - HOUR);
      const items = getUpcomingReminders(NOW);
      expect(items[0].dueLabel).toBe('Overdue');
    });

    it('shows recurring label', () => {
      addReminder('Daily standup', NOW + HOUR, { recurring: 'daily' });
      const items = getUpcomingReminders(NOW);
      expect(items[0].isRecurring).toBe(true);
      expect(items[0].recurringLabel).toContain('daily');
    });

    it('no recurring label for one-time', () => {
      addReminder('Once', NOW + HOUR);
      expect(getUpcomingReminders(NOW)[0].isRecurring).toBe(false);
      expect(getUpcomingReminders(NOW)[0].recurringLabel).toBe('');
    });

    it('includes persona badge', () => {
      addReminder('Health check', NOW + HOUR, { persona: 'health' });
      expect(getUpcomingReminders(NOW)[0].persona).toBe('health');
    });
  });

  describe('groupByDay', () => {
    it('groups reminders by date', () => {
      addReminder('Today A', NOW + HOUR);
      addReminder('Today B', NOW + 2 * HOUR);
      addReminder('Tomorrow', NOW + DAY + HOUR);

      const groups = groupByDay(getUpcomingReminders(NOW));
      expect(groups.length).toBeGreaterThanOrEqual(2);
      expect(groups[0].reminders.length).toBeGreaterThanOrEqual(1);
    });

    it('labels today and tomorrow', () => {
      addReminder('Now', NOW + HOUR);
      const groups = groupByDay(getUpcomingReminders(NOW));
      expect(groups[0].label).toBe('Today');
    });
  });

  describe('dismissReminder', () => {
    it('completes a reminder', () => {
      const r = addReminder('Dismiss me', NOW - HOUR);
      const result = dismissReminder(r.id);

      expect(result.dismissed).toBe(true);
      expect(getOverdueReminders(NOW)).toHaveLength(0);
    });

    it('recurring reminder creates next occurrence', () => {
      const r = addReminder('Weekly', NOW - HOUR, { recurring: 'weekly' });
      const result = dismissReminder(r.id);

      expect(result.dismissed).toBe(true);
      expect(result.nextId).toBeTruthy();
    });
  });

  describe('snoozeReminderBy', () => {
    it('snoozes by 1 hour', () => {
      const r = addReminder('Snooze me', NOW - HOUR);
      expect(snoozeReminderBy(r.id, 'one_hour')).toBe(true);

      // Should no longer be overdue
      expect(getOverdueReminders(NOW)).toHaveLength(0);
    });

    it('snoozes by tomorrow', () => {
      const r = addReminder('Tomorrow', NOW - HOUR);
      expect(snoozeReminderBy(r.id, 'tomorrow')).toBe(true);
    });

    it('returns false for nonexistent', () => {
      expect(snoozeReminderBy('fake-id', 'one_hour')).toBe(false);
    });
  });

  describe('removeReminder', () => {
    it('permanently deletes', () => {
      const r = addReminder('Delete me', NOW + HOUR);
      expect(removeReminder(r.id)).toBe(true);
      expect(getUpcomingReminders(NOW)).toHaveLength(0);
    });
  });

  describe('getSnoozePresets + counts', () => {
    it('returns 3 presets', () => {
      expect(getSnoozePresets()).toHaveLength(3);
    });

    it('getReminderCounts', () => {
      addReminder('Past', NOW - HOUR);
      addReminder('Future', NOW + HOUR);

      const counts = getReminderCounts(NOW);
      expect(counts.overdue).toBe(1);
      expect(counts.upcoming).toBe(2); // includes overdue in upcoming
    });
  });
});
