/**
 * Local notifications — reminder fires → notification at correct priority.
 *
 * Priority mapping from guardian tiers:
 *   Tier 1 (fiduciary)  → high: heads-up, sound
 *   Tier 2 (solicited)  → default: notification shade
 *   Tier 3 (engagement) → low: bundled in briefing (no push)
 *
 * In-memory scheduler for now. expo-notifications will be wired in
 * when native modules are installed (Task 5.1).
 *
 * Source: ARCHITECTURE.md Task 5.1
 */

export type NotificationChannel = 'fiduciary' | 'solicited' | 'engagement';

export interface ScheduledNotification {
  id: string;
  title: string;
  body: string;
  channel: NotificationChannel;
  triggerAt: number;
}

/** In-memory scheduled notifications. */
const scheduled = new Map<string, ScheduledNotification>();
let idCounter = 0;

/** Map a guardian priority tier to a notification channel. */
export function tierToChannel(tier: 1 | 2 | 3): NotificationChannel {
  switch (tier) {
    case 1:
      return 'fiduciary';
    case 2:
      return 'solicited';
    case 3:
      return 'engagement';
  }
}

/** Schedule a local notification at a specific time. Returns notification ID. */
export function scheduleNotification(
  title: string,
  body: string,
  channel: NotificationChannel,
  triggerAt: number,
): string {
  const id = `notif-${++idCounter}`;
  scheduled.set(id, { id, title, body, channel, triggerAt });
  return id;
}

/** Cancel a previously scheduled notification. */
export function cancelNotification(notificationId: string): void {
  scheduled.delete(notificationId);
}

/** Reschedule all pending reminders (call on app launch). Returns count. */
export function rescheduleAllReminders(): number {
  return scheduled.size;
}

/** Get all scheduled notifications (for testing). */
export function getScheduled(): ScheduledNotification[] {
  return [...scheduled.values()];
}

/** Reset (for testing). */
export function resetNotifications(): void {
  scheduled.clear();
  idCounter = 0;
}
