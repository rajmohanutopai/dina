/**
 * Deep-link handler for OS notification taps (task 5.68).
 *
 * Pulled out of `app/_layout.tsx` so it's testable without React
 * Testing Library. The layout's `addNotificationResponseReceivedListener`
 * + cold-start `getLastNotificationResponseAsync` paths both feed into
 * `handleNotificationTap(data, deps)`.
 *
 * Contract: callers extract `notification.request.content.data` and
 * pass it as `data`. The handler:
 *   - Marks the inbox entry read iff `data.inboxId` is a non-empty string.
 *   - Routes to `data.deepLink` iff non-empty (via `deps.routerPush`).
 *   - Returns `{ marked, navigated }` so tests can assert without
 *     spinning up the router.
 */

export interface NotificationTapDeps {
  routerPush: (path: string) => void;
  markRead: (inboxId: string) => boolean;
}

export interface NotificationTapResult {
  marked: boolean;
  navigated: boolean;
}

export function handleNotificationTap(
  data: Record<string, unknown> | null | undefined,
  deps: NotificationTapDeps,
): NotificationTapResult {
  if (data === null || data === undefined) return { marked: false, navigated: false };
  let marked = false;
  if (typeof data.inboxId === 'string' && data.inboxId !== '') {
    marked = deps.markRead(data.inboxId);
  }
  let navigated = false;
  if (typeof data.deepLink === 'string' && data.deepLink !== '') {
    deps.routerPush(data.deepLink);
    navigated = true;
  }
  return { marked, navigated };
}
