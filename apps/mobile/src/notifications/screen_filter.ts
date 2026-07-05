/**
 * Notifications-screen filter logic (task 5.67).
 *
 * Pulled into its own module so the screen's filter chips can be
 * tested without rendering the full screen. Pure function; one input,
 * one output.
 */

import type { NotificationItem } from '@dina/brain/notifications';

export type FilterKey = 'all' | 'unread' | 'reminder' | 'needs_action' | 'requests';

export function applyNotificationFilter(
  items: NotificationItem[],
  filter: FilterKey,
): NotificationItem[] {
  switch (filter) {
    case 'all':
      return items;
    case 'unread':
      return items.filter((i) => i.readAt === null);
    case 'reminder':
      return items.filter((i) => i.kind === 'reminder');
    case 'requests':
      // The owner-private contact-service decision log is NOT a NotificationItem
      // (it is a quiet, reviewable log, never a push). The screen sources those
      // rows separately; this view has no notification items of its own.
      return [];
    case 'needs_action':
      // "Needs action" = every item that asks the user for a decision:
      // service-approval (`approval`), ask-approval / agent-validation /
      // locked-vault prompts (`ask_approval`). These two notification
      // kinds are exactly the action-bearing families (reminders, nudges,
      // and briefings are informational), so this predicate captures the
      // full set the spec enumerates (spec 5.2).
      return items.filter((i) => i.kind === 'approval' || i.kind === 'ask_approval');
  }
}
