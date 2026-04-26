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
 * `@dina/core/src/reminders/service.ts` exposes `fireMissedReminders`
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
import { fireMissedReminders, type Reminder } from '@dina/core/src/reminders/service';
import { addMessage } from '@dina/brain/src/chat/thread';
import { appendNotification } from '@dina/brain/src/notifications/inbox';

const DEFAULT_TICK_MS = 30_000;
const FALLBACK_THREAD_ID = 'main';

/**
 * Pure function — fires past-due reminders and posts each to
 * `threadId` as a `'reminder'`-typed message. Exposed for direct
 * testing (RTL isn't installed) and for callers that want to drive
 * the watcher manually (e.g. an app-foreground hook in 5.61).
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

    const tick = (): void => {
      try {
        fireRemindersToThread(threadId);
      } catch {
        /* swallow — a misbehaving reminder shouldn't break the loop */
      }
    };

    // Fire once immediately so a freshly opened tab catches up
    // without a 30 s wait, then on cadence.
    tick();
    const handle = setInterval(tick, tickMs);
    return () => clearInterval(handle);
  }, [tickMs, threadId, enabled]);
}

function postReminder(threadId: string, r: Reminder): void {
  // Carry structured metadata so `<InlineReminderCard>` can render a
  // tappable "Mark done" / "Snooze" card. `kind: 'reminder'`
  // discriminates from other `'reminder'`-typed sources if any
  // appear in the future.
  addMessage(threadId, 'reminder', r.message, {
    metadata: {
      kind: 'reminder',
      reminderId: r.id,
      shortId: r.short_id,
      reminderKind: r.kind,
      persona: r.persona,
      dueAt: r.due_at,
      recurring: r.recurring,
      sourceItemId: r.source_item_id,
    },
  });

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
