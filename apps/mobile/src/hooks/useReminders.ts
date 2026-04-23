/**
 * Reminders tab data hook — list, group, dismiss, snooze.
 *
 * Provides:
 *   - Upcoming reminders sorted by due date
 *   - Overdue reminders (due_at < now)
 *   - Group by day for section list display
 *   - Dismiss (complete) a reminder
 *   - Snooze by 1h, 3h, tomorrow, or custom duration
 *   - Recurring indicator
 *   - Persona badge per reminder
 *
 * Source: ARCHITECTURE.md Task 5.6
 */

import {
  listPending,
  listByPersona,
  completeReminder,
  snoozeReminder,
  deleteReminder,
  createReminder,
  getReminder,
  resetReminderState,
  type Reminder,
} from '@dina/core/src/reminders/service';

export interface ReminderUIItem {
  id: string;
  message: string;
  dueAt: number;
  dueLabel: string;
  persona: string;
  kind: string;
  isOverdue: boolean;
  isRecurring: boolean;
  recurringLabel: string;
}

export interface ReminderGroup {
  label: string;
  date: string; // YYYY-MM-DD
  reminders: ReminderUIItem[];
}

const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;

/**
 * Get all upcoming reminders (pending, sorted by due date).
 */
export function getUpcomingReminders(now?: number): ReminderUIItem[] {
  const currentTime = now ?? Date.now();
  // Get pending with a far-future cutoff to include all
  const pending = listPending(currentTime + 365 * MS_DAY);
  return pending.map((r) => toUIItem(r, currentTime));
}

/**
 * Get overdue reminders only.
 */
export function getOverdueReminders(now?: number): ReminderUIItem[] {
  const currentTime = now ?? Date.now();
  const pending = listPending(currentTime);
  return pending.map((r) => toUIItem(r, currentTime));
}

/**
 * Get reminders for a specific persona.
 */
export function getPersonaReminders(persona: string, now?: number): ReminderUIItem[] {
  const currentTime = now ?? Date.now();
  const all = listByPersona(persona);
  return all
    .filter((r) => r.completed === 0)
    .sort((a, b) => a.due_at - b.due_at)
    .map((r) => toUIItem(r, currentTime));
}

/**
 * Group reminders by day for section list display.
 */
export function groupByDay(reminders: ReminderUIItem[]): ReminderGroup[] {
  const groups = new Map<string, ReminderUIItem[]>();

  for (const r of reminders) {
    const date = new Date(r.dueAt);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({
      label: formatDayLabel(date),
      date,
      reminders: items,
    }));
}

/**
 * Dismiss a reminder (mark as completed).
 * If recurring, returns the next occurrence.
 */
export function dismissReminder(id: string): { dismissed: boolean; nextId?: string } {
  try {
    const next = completeReminder(id);
    return { dismissed: true, nextId: next?.id };
  } catch {
    return { dismissed: false };
  }
}

/**
 * Snooze a reminder by a preset duration.
 */
export function snoozeReminderBy(
  id: string,
  preset: 'one_hour' | 'three_hours' | 'tomorrow' | 'custom',
  customMs?: number,
): boolean {
  const durations: Record<string, number> = {
    one_hour: MS_HOUR,
    three_hours: 3 * MS_HOUR,
    tomorrow: MS_DAY,
  };

  const snoozeMs = preset === 'custom' ? (customMs ?? MS_HOUR) : durations[preset];

  try {
    snoozeReminder(id, snoozeMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a reminder permanently.
 */
export function removeReminder(id: string): boolean {
  return deleteReminder(id);
}

/**
 * Get snooze preset options for the picker.
 */
export function getSnoozePresets(): Array<{ value: string; label: string }> {
  return [
    { value: 'one_hour', label: '1 hour' },
    { value: 'three_hours', label: '3 hours' },
    { value: 'tomorrow', label: 'Tomorrow' },
  ];
}

/**
 * Get reminder counts for tab badge.
 */
export function getReminderCounts(now?: number): { upcoming: number; overdue: number } {
  const currentTime = now ?? Date.now();
  return {
    upcoming: getUpcomingReminders(currentTime).length,
    overdue: getOverdueReminders(currentTime).length,
  };
}

/**
 * Reset state (for testing).
 */
export function resetReminders(): void {
  resetReminderState();
}

/** Map a Reminder to UI item. */
function toUIItem(r: Reminder, now: number): ReminderUIItem {
  return {
    id: r.id,
    message: r.message,
    dueAt: r.due_at,
    dueLabel: formatDueLabel(r.due_at, now),
    persona: r.persona,
    kind: r.kind,
    isOverdue: r.due_at < now,
    isRecurring: r.recurring !== '',
    recurringLabel: r.recurring ? `Repeats ${r.recurring}` : '',
  };
}

/** Format due date relative to now. */
function formatDueLabel(dueAt: number, now: number): string {
  const diff = dueAt - now;
  if (diff < 0) return 'Overdue';
  if (diff < MS_HOUR) return `${Math.ceil(diff / 60_000)}m`;
  if (diff < MS_DAY) return `${Math.round(diff / MS_HOUR)}h`;
  const days = Math.round(diff / MS_DAY);
  return days === 1 ? 'Tomorrow' : `${days}d`;
}

/** Format day label from YYYY-MM-DD. */
function formatDayLabel(dateStr: string): string {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  if (dateStr === todayStr) return 'Today';

  const tomorrow = new Date(today.getTime() + MS_DAY);
  const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  if (dateStr === tomorrowStr) return 'Tomorrow';

  return dateStr;
}
