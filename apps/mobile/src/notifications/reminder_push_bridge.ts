/**
 * Reminder → OS-push bridge (5.60 producer wiring).
 *
 * When a reminder is created (via `/remember`, the Reminders tab, or
 * the post-publish auto-planner), schedule an OS-level notification
 * for `due_at` so the user gets a banner even when the app is
 * backgrounded or killed. The kv_store mirror in `local.ts` keeps
 * the schedule re-issuable across cold starts (5.61).
 *
 * **Why mobile-side, not core?** The OS scheduler is a mobile
 * concept; brain/core stay platform-agnostic. The bridge is the
 * one-way wire: core emits events, mobile consumes.
 *
 * **Idempotency**: the OS schedule's identifier is `notif-rem-<id>`,
 * derived from the reminder id. Recreating a reminder with the same
 * id (e.g. dedup hit returning the existing reminder) means the
 * subscriber fires again, but `scheduleNotification` upserts on
 * identifier so no duplicate banner queues.
 *
 * **Past-due behaviour**: when `due_at` is already past, the bridge
 * still schedules (clamped to ≥1s by `scheduleNotification`) so a
 * user-created "remind me about X 5 minutes ago" prompt fires
 * immediately. The fire-watcher hook would catch it next tick anyway,
 * but the OS path gives a banner if the chat tab isn't foregrounded.
 *
 * **Guided-demo isolation**: this bridge is the ONLY reminder→OS path,
 * so it's where demo isolation must hold. A demo reminder (e.g. "Emma's
 * birthday is Nov 7") is a scoped, local-only row that teardown deletes
 * — but the OS scheduler lives OUTSIDE the data scope, so a scheduled
 * `notif-rem-<id>` would survive teardown and fire a banner with fake
 * demo content weeks later. The reminder event payload carries no scope
 * (`Reminder` has no `data_scope`), but the demo holds the process-global
 * scope for its whole run and `createReminder` fans this event out
 * synchronously while still in that scope — so `currentDataScope()` here
 * is the demo scope for a demo reminder. We suppress at this choke point
 * (don't schedule, don't mirror) rather than schedule-then-cancel: there
 * is nothing to leak and nothing to clean up. The in-app chat reminder
 * card still demonstrates the feature during the demo. Mirrors the
 * inbox's scope-stamping and the topic-touch no-op in demo scope.
 */

import { currentDataScope, isGuidedDemoScope } from '@dina/core';
import { subscribeReminderCreated, type Reminder } from '@dina/core/reminders';

import { scheduleNotification, tierToChannel } from './local';

/**
 * Map a reminder kind to a Silence-First tier. Most reminders are
 * Tier-2 (solicited — user asked for them). Health alerts and
 * payment-due are Tier-1 (fiduciary — silence would cause harm).
 * Recurring "engagement" reminders are Tier-3.
 */
function reminderTier(r: Reminder): 1 | 2 | 3 {
  if (r.kind === 'health_alert' || r.kind === 'payment_due') return 1;
  return 2;
}

/**
 * Install the bridge. Call once at boot, after `ensureChannels()`.
 * Returns a disposer; production never calls it (the listener lives
 * for the app lifetime), tests may.
 */
export function installReminderPushBridge(): () => void {
  return subscribeReminderCreated((reminder) => {
    // Guided-demo reminders never reach the OS scheduler — see the module
    // header. The demo is torn down with its scope; an OS-scheduled banner
    // would outlive it. (No teardown cancel needed: we never schedule.)
    if (isGuidedDemoScope(currentDataScope())) return;
    const tier = reminderTier(reminder);
    void scheduleNotification({
      id: `notif-rem-${reminder.id}`,
      title: reminder.message,
      body:
        reminder.persona !== '' && reminder.persona !== 'general'
          ? `/${reminder.persona}`
          : '',
      channel: tierToChannel(tier),
      triggerAt: reminder.due_at,
      data: {
        // Wired to the inbox + deep-link layer (5.66 + 5.68): tap-on-banner
        // routes back to the chat thread the reminder was for, and marks
        // the inbox entry read.
        inboxId: `nt-rem-${reminder.id}`,
        deepLink: `dina://chat/main?focus=${reminder.id}`,
        kind: 'reminder',
        reminderId: reminder.id,
      },
    });
  });
}
