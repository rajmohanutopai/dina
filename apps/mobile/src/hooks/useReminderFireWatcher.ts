/**
 * `useReminderFireWatcher` — periodic in-foreground tick that fires
 * past-due reminders and posts each one to the chat thread as a
 * `'reminder'`-typed message (5.64). Without this, reminders only
 * surface in the Reminders tab; the chat surface stays silent even
 * when the user explicitly /remembered something for "tomorrow at 9".
 *
 * **Scope**: foreground-only. The OS-level scheduler that fires
 * notifications when the app is backgrounded is task 5.60–5.61
 * (`expo-notifications`). This hook is the in-app fallback so the
 * chat tab catches up the moment the user opens it.
 *
 * **Why a hook + setInterval, not a service-layer subscription**:
 * `@dina/core/reminders` exposes `fireMissedReminders`
 * as a pull function — no event stream. Driving it on a 30 s tick
 * inside the chat tab's lifecycle keeps the dependency one-way
 * (UI → core, not the reverse) and stays cheap (the function is a
 * single Map walk; reminders rarely number above a few dozen).
 *
 * **Idempotency**: `fireMissedReminders` only returns reminders whose
 * status is still `'pending'` AND whose `due_at <= now`. Once
 * fired, the reminder transitions to `'fired'` and the next tick
 * skips it. So even if the hook re-mounts or two screens both call
 * it, no duplicate chat messages.
 */

import { useEffect } from 'react';
import { fireMissedReminders, type Reminder } from '@dina/core/reminders';
import { postReminderCard } from '@dina/brain/chat';
import { appendNotification } from '@dina/brain/notifications';
import { watchFiredReminders } from './reminder_transport';

const DEFAULT_TICK_MS = 30_000;
const FALLBACK_THREAD_ID = 'main';

/**
 * IN-PROCESS one-shot fire — fires past-due reminders against the local
 * reminder service and posts each to `threadId`. **Native / test only.**
 *
 * ⚠️ Do NOT call this from a web/SPA path: in the browser the reminder
 * store lives in core-server, not the page, so firing locally would hit
 * an empty store + double-fire against the server's fire loop. The
 * production fire path is {@link useReminderFireWatcher} →
 * `watchFiredReminders` (native timer in-process; web subscribes to the
 * server's SSE stream). This helper exists only because RTL isn't
 * installed, so tests drive the fire→thread mapping directly.
 *
 * Returns the number of reminders fired this call.
 */
export function fireRemindersToThread(
  threadId: string = FALLBACK_THREAD_ID,
  nowMs: number = Date.now(),
): number {
  let count = 0;
  fireMissedReminders(nowMs, (r) => {
    postReminder(threadId, r);
    count += 1;
  });
  return count;
}

export interface UseReminderFireWatcherOptions {
  /** Tick cadence in ms. Default 30 s — balance freshness vs battery. */
  tickMs?: number;
  /**
   * Thread to post fire-time messages into. Default `'main'`. Future
   * multi-thread work can route per-persona reminders to per-persona
   * threads via this option.
   */
  threadId?: string;
  /**
   * Disable the watcher entirely (tests / unmount paths). When
   * false, the effect early-returns and never schedules.
   */
  enabled?: boolean;
}

/**
 * Mount once at the chat-tab root. Returns nothing — the effect
 * subscribes to the reminder store via setInterval and fans fired
 * reminders into the chat thread automatically.
 */
export function useReminderFireWatcher(opts: UseReminderFireWatcherOptions = {}): void {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const threadId = opts.threadId ?? FALLBACK_THREAD_ID;
  const enabled = opts.enabled !== false;

  useEffect(() => {
    if (!enabled) return;
    // Platform seam: native runs an in-process foreground timer
    // (`fireMissedReminders`); web subscribes to the brain-server's SSE
    // stream (the server fires). Either way each fired reminder lands in
    // the chat thread + notifications inbox via `postReminder`.
    return watchFiredReminders((r) => postReminder(threadId, r), tickMs);
  }, [tickMs, threadId, enabled]);
}

function postReminder(threadId: string, r: Reminder): void {
  // Render the fired reminder as a chat card via the shared mapping
  // (`postReminderCard`). Omitting `scheduled` yields the fired variant
  // — relative-time header + Snooze / Mark-done actions.
  postReminderCard(threadId, r);

  // Mirror to the unified notifications inbox (5.66). The reminder id
  // doubles as the inbox id so re-firing the same reminder (e.g. cold-
  // start replay before status flips to 'fired') upserts rather than
  // duplicating. Deep-link routes to the originating chat thread; the
  // inline card there already handles "Mark done" / "Snooze".
  appendNotification({
    id: `nt-rem-${r.id}`,
    kind: 'reminder',
    title: r.message,
    body: r.persona !== '' && r.persona !== 'general' ? `/${r.persona}` : '',
    sourceId: r.id,
    deepLink: `dina://chat/${threadId}?focus=${r.id}`,
  });
}
