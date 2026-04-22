/**
 * Reminder scheduler — check and fire due reminders.
 *
 * Runs as a periodic tick (every ~30s or on app foreground):
 *   1. List pending reminders where due_at <= now
 *   2. Fire each (invoke notification callback)
 *   3. Complete fired reminders (creates next occurrence for recurring)
 *
 * Background-safe: never throws, errors per-reminder are isolated.
 *
 * Source: ARCHITECTURE.md Task 5.2
 */

import { listPending, completeReminder, type Reminder } from './service';

export interface FireResult {
  reminderId: string;
  message: string;
  persona: string;
  recurring: boolean;
  nextId?: string;
}

export interface TickResult {
  fired: FireResult[];
  errors: number;
}

/** Injectable notification handler (platform-specific). */
export type NotificationHandler = (reminder: Reminder) => void;

let notificationHandler: NotificationHandler | null = null;

/** Register the notification handler (platform layer). */
export function registerNotificationHandler(handler: NotificationHandler): void {
  notificationHandler = handler;
}

/** Reset (for testing). */
export function resetScheduler(): void {
  notificationHandler = null;
}

/**
 * Tick: check for due reminders and fire them.
 *
 * Call periodically (every ~30s) or on app foreground.
 * Error-isolated per reminder — one failure doesn't stop others.
 */
export function tick(now?: number): TickResult {
  const pending = listPending(now);
  const result: TickResult = { fired: [], errors: 0 };

  for (const reminder of pending) {
    try {
      // Fire notification
      if (notificationHandler) {
        notificationHandler(reminder);
      }

      // Complete (creates next for recurring)
      const next = completeReminder(reminder.id);

      result.fired.push({
        reminderId: reminder.id,
        message: reminder.message,
        persona: reminder.persona,
        recurring: reminder.recurring !== '',
        nextId: next?.id,
      });
    } catch {
      result.errors++;
    }
  }

  return result;
}

/**
 * Get upcoming reminders (not yet due) for the next N hours.
 *
 * Useful for showing "upcoming" in the Reminders tab.
 */
export function getUpcoming(hoursAhead: number = 24, now?: number): Reminder[] {
  const currentTime = now ?? Date.now();
  const windowEnd = currentTime + hoursAhead * 60 * 60 * 1000;
  return listPending(windowEnd);
}
