/**
 * Notifications-screen filter logic (task 5.67).
 *
 * Pulled into its own module so the screen's filter chips can be
 * tested without rendering the full screen. Pure function; one input,
 * one output.
 */

import type { NotificationItem } from '@dina/brain/notifications';

export type FilterKey = 'all' | 'unread' | 'reminder' | 'approval';

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
    case 'approval':
      // The two approval families both surface here so users see one
      // unified Approvals filter.
      return items.filter((i) => i.kind === 'approval' || i.kind === 'ask_approval');
  }
}
