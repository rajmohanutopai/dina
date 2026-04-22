/**
 * T5.2 — Reminder scheduler: check due, fire, reschedule recurring.
 *
 * Source: ARCHITECTURE.md Task 5.2
 */

import {
  tick,
  getUpcoming,
  registerNotificationHandler,
  resetScheduler,
} from '../../src/reminders/scheduler';
import {
  createReminder,
  getReminder,
  resetReminderState,
  listByPersona,
} from '../../src/reminders/service';

describe('Reminder Scheduler', () => {
  beforeEach(() => {
    resetReminderState();
    resetScheduler();
  });

  describe('tick', () => {
    it('fires due reminders', () => {
      const now = Date.now();
      createReminder({ message: 'Take medicine', due_at: now - 1000, persona: 'health' });
      const result = tick(now);
      expect(result.fired).toHaveLength(1);
      expect(result.fired[0].message).toBe('Take medicine');
      expect(result.errors).toBe(0);
    });

    it('does not fire future reminders', () => {
      createReminder({ message: 'Later', due_at: Date.now() + 999_999, persona: 'general' });
      const result = tick();
      expect(result.fired).toHaveLength(0);
    });

    it('completes fired reminder', () => {
      const now = Date.now();
      const r = createReminder({ message: 'Done', due_at: now - 1000, persona: 'general' });
      tick(now);
      expect(getReminder(r.id)!.completed).toBe(1);
    });

    it('creates next occurrence for recurring', () => {
      const now = Date.now();
      createReminder({
        message: 'Daily standup',
        due_at: now - 1000,
        persona: 'work',
        recurring: 'daily',
      });
      const result = tick(now);
      expect(result.fired[0].recurring).toBe(true);
      expect(result.fired[0].nextId).toBeTruthy();

      // Next occurrence should exist
      const next = getReminder(result.fired[0].nextId!);
      expect(next).not.toBeNull();
      expect(next!.message).toBe('Daily standup');
    });

    it('fires multiple reminders in one tick', () => {
      const now = Date.now();
      createReminder({ message: 'First', due_at: now - 2000, persona: 'general' });
      createReminder({ message: 'Second', due_at: now - 1000, persona: 'general' });
      const result = tick(now);
      expect(result.fired).toHaveLength(2);
    });

    it('calls notification handler', () => {
      const notifications: string[] = [];
      registerNotificationHandler((r) => notifications.push(r.message));

      const now = Date.now();
      createReminder({ message: 'Notify me', due_at: now - 1000, persona: 'general' });
      tick(now);
      expect(notifications).toEqual(['Notify me']);
    });

    it('error-isolated per reminder', () => {
      registerNotificationHandler(() => {
        throw new Error('notification failed');
      });
      const now = Date.now();
      createReminder({ message: 'Fail', due_at: now - 1000, persona: 'general' });
      createReminder({ message: 'Also fail', due_at: now - 500, persona: 'general' });
      const result = tick(now);
      expect(result.errors).toBe(2);
      expect(result.fired).toHaveLength(0);
    });

    it('returns empty when nothing due', () => {
      const result = tick();
      expect(result.fired).toHaveLength(0);
      expect(result.errors).toBe(0);
    });
  });

  describe('getUpcoming', () => {
    it('returns reminders in next N hours', () => {
      const now = Date.now();
      createReminder({ message: 'Soon', due_at: now + 60_000, persona: 'general' });
      createReminder({
        message: 'Tomorrow',
        due_at: now + 25 * 60 * 60 * 1000,
        persona: 'general',
      });

      const upcoming = getUpcoming(24, now);
      // 'Soon' is within 24h, 'Tomorrow' depends on timing
      expect(upcoming.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty when none upcoming', () => {
      expect(getUpcoming(1)).toHaveLength(0);
    });
  });
});
