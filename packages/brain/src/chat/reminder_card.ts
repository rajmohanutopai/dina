/**
 * Single source of truth for turning a reminder into a chat card.
 *
 * Three sites legitimately surface a reminder to chat, each a distinct
 * trigger — the chat orchestrator (when `/remember` plans one inline,
 * synchronously), the host's D2D-reminder hook (when an inbound message
 * plans one, asynchronously), and `useReminderFireWatcher` (when one
 * fires). They all need the same `metadata.kind === 'reminder'` shape
 * that `<InlineReminderCard>` reads, so the mapping lives here once
 * instead of being copy-pasted per site.
 *
 * `scheduled` marks a just-created (not-yet-fired) reminder: the card
 * shows the set-time header and hides Snooze / Mark-done, which only
 * make sense once the reminder actually fires.
 */
import type { Reminder } from '@dina/core/reminders';

import { addMessage } from './thread';

export function postReminderCard(
  threadId: string,
  reminder: Reminder,
  opts: { scheduled?: boolean } = {},
): void {
  addMessage(threadId, 'reminder', reminder.message, {
    metadata: {
      kind: 'reminder',
      reminderId: reminder.id,
      shortId: reminder.short_id,
      reminderKind: reminder.kind,
      persona: reminder.persona,
      dueAt: reminder.due_at,
      recurring: reminder.recurring,
      sourceItemId: reminder.source_item_id,
      scheduled: opts.scheduled === true,
    },
  });
}
