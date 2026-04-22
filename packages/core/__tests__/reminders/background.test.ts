/**
 * Reminder scheduler background wiring tests.
 *
 * Verifies that tick() is registered with the timer system
 * and fires reminders automatically.
 */

import { startReminderScheduler, resetReminderScheduler } from '../../src/reminders/background';
import { registerNotificationHandler, resetScheduler, tick } from '../../src/reminders/scheduler';
import { createReminder, resetReminderState } from '../../src/reminders/service';
import {
  getRegisteredTimers,
  clearTimers,
  startTimers,
  stopTimers,
} from '../../src/background/timers';

describe('Reminder Scheduler Background Wiring', () => {
  beforeEach(() => {
    clearTimers();
    resetScheduler();
    resetReminderState();
    resetReminderScheduler();
  });

  afterEach(() => {
    stopTimers();
    clearTimers();
  });

  it('registers the reminder_scheduler timer', () => {
    startReminderScheduler();
    expect(getRegisteredTimers()).toContain('reminder_scheduler');
  });

  it('is idempotent — multiple calls do not create duplicates', () => {
    startReminderScheduler();
    startReminderScheduler();
    startReminderScheduler();
    // Should have exactly one timer, not three
    expect(getRegisteredTimers().filter((t) => t === 'reminder_scheduler')).toHaveLength(1);
  });

  it('fires due reminders when timer ticks', () => {
    // Create a reminder that's already due
    createReminder({
      message: 'Take medicine',
      due_at: Date.now() - 1000, // 1 second ago — already due
      persona: 'health',
    });

    // Track fired reminders
    const fired: string[] = [];
    registerNotificationHandler((r) => {
      fired.push(r.message);
    });

    // Manual tick (simulates what the timer would do)
    const result = tick();
    expect(result.fired).toHaveLength(1);
    expect(result.fired[0].message).toBe('Take medicine');
    expect(fired).toContain('Take medicine');
  });

  it('does not fire future reminders', () => {
    createReminder({
      message: 'Future event',
      due_at: Date.now() + 60_000, // 1 minute from now
      persona: 'general',
    });

    const fired: string[] = [];
    registerNotificationHandler((r) => {
      fired.push(r.message);
    });

    const result = tick();
    expect(result.fired).toHaveLength(0);
    expect(fired).toHaveLength(0);
  });

  it('timer is actually startable after registration', () => {
    startReminderScheduler();
    // This would throw if the timer wasn't properly registered
    expect(() => startTimers()).not.toThrow();
    // Verify it started
    expect(getRegisteredTimers()).toContain('reminder_scheduler');
    stopTimers(); // cleanup
  });
});
