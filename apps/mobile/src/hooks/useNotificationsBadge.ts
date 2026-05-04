/**
 * Tab-bar badge counts for notification surfaces (task 5.69).
 *
 * Subscribes to the unified notifications inbox and returns a number
 * + a formatted display string for `Tabs.Screen({tabBarBadge})`. The
 * formatter caps at "9+" so a 12-character "12 unread approvals"
 * doesn't blow out the tab bar layout on small screens.
 *
 * **Per-kind filtering**: pass a `kind` to scope the count (e.g.
 * `'approval'` for the Approvals tab badge). Omit for the global
 * Notifications-tab badge that aggregates everything.
 *
 * Pure formatter `formatBadgeCount(n)` is exported separately so unit
 * tests can pin the cap behaviour without spinning up React (RTL
 * isn't installed — same pattern as `useReminderFireWatcher`'s
 * `fireRemindersToThread`).
 */

import { useEffect, useState } from 'react';
import {
  getUnreadCount,
  subscribeNotifications,
  type NotificationKind,
} from '@dina/brain/notifications';

/**
 * Cap counts above 9 to "9+" — the tab-bar badge widget renders as a
 * tiny dot, so any wider string overflows. Returns `undefined` for
 * zero so callers can pass it directly to `tabBarBadge` (which hides
 * the badge when undefined).
 */
export function formatBadgeCount(count: number): string | undefined {
  if (!Number.isFinite(count) || count <= 0) return undefined;
  if (count > 9) return '9+';
  return String(Math.floor(count));
}

/**
 * Live-subscribed unread-count hook. Re-renders the calling component
 * when the inbox changes (append / markRead). When `kind` is passed,
 * the count filters to that kind only.
 *
 * Returns the raw number; pair with `formatBadgeCount` at the call
 * site to feed into `tabBarBadge`.
 */
export function useUnreadCount(kind?: NotificationKind): number {
  const [count, setCount] = useState<number>(() => getUnreadCount(kind));

  useEffect(() => {
    // Pull the current count on mount in case it changed between
    // useState's initializer and the effect setup.
    setCount(getUnreadCount(kind));

    const off = subscribeNotifications((event) => {
      // Both append + markRead can shift the unread count; recompute
      // on every event. Walk is O(n) over an N typically <100, cheap.
      if (event.type === 'appended' || event.type === 'marked_read') {
        setCount(getUnreadCount(kind));
      }
    });

    return off;
  }, [kind]);

  return count;
}

/**
 * Convenience wrapper: returns the formatted badge string directly.
 * Tab-bar callers can do `tabBarBadge: useUnreadBadge('approval')`.
 */
export function useUnreadBadge(kind?: NotificationKind): string | undefined {
  return formatBadgeCount(useUnreadCount(kind));
}
