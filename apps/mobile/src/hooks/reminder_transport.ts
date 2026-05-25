/**
 * Reminder data transport — NATIVE peer (in-process).
 *
 * On mobile the app runs a full Home Node in-process, so reminder
 * reads/actions hit the in-process reminder service directly — no HTTP
 * hop. The web peer (`reminder_transport.web.ts`) implements the same
 * async surface over the brain-server's `/api/v1/reminders` API, because
 * in the browser the reminder store lives in core-server's process, not
 * the page. `useReminders` imports THIS module (Metro resolves `.web.ts`
 * for web builds) so the Reminders tab + InlineReminderCard work on both
 * targets without branching. Mirrors `chat_transport.ts` /
 * `chat_transport.web.ts`.
 *
 * The surface is async on both peers (web is HTTP); native wraps the sync
 * service calls in resolved promises — one microtask, no behaviour change.
 */

import {
  listPending,
  listByPersona,
  completeReminder,
  snoozeReminder,
  deleteReminder,
  fireMissedReminders,
  resetReminderState,
  type Reminder,
} from '@dina/core/reminders';

const DEFAULT_FIRE_TICK_MS = 30_000;

export async function transportListPending(now?: number): Promise<Reminder[]> {
  return listPending(now);
}

export async function transportListByPersona(persona: string): Promise<Reminder[]> {
  return listByPersona(persona);
}

/** Returns the next occurrence for a recurring reminder, else null. */
export async function transportComplete(id: string): Promise<Reminder | null> {
  return completeReminder(id);
}

/** `now` is forwarded for deterministic native tests; the web peer ignores
 *  it (the server stamps its own clock). */
export async function transportSnooze(id: string, snoozeMs: number, now?: number): Promise<void> {
  snoozeReminder(id, snoozeMs, now);
}

export async function transportDelete(id: string): Promise<boolean> {
  return deleteReminder(id);
}

/**
 * Watch for fired reminders. NATIVE: a foreground timer fires past-due
 * reminders in-process (`fireMissedReminders`) and invokes `onFired` per
 * one. WEB: subscribes to the brain-server's SSE stream instead (the
 * server owns firing). Returns a disposer. `tickMs` is the native cadence;
 * the web peer ignores it (server-driven).
 */
export function watchFiredReminders(
  onFired: (reminder: Reminder) => void,
  tickMs: number = DEFAULT_FIRE_TICK_MS,
): () => void {
  const tick = (): void => {
    try {
      fireMissedReminders(Date.now(), onFired);
    } catch {
      /* a misbehaving reminder shouldn't break the loop */
    }
  };
  tick(); // immediate catch-up on mount
  const handle = setInterval(tick, tickMs);
  return () => clearInterval(handle);
}

/** Test-only reset of the in-process store. No-op on the web peer. */
export function transportReset(): void {
  resetReminderState();
}
