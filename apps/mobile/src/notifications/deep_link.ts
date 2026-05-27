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

/**
 * Route roots a notification may navigate to. Deliberately NARROW: only the
 * non-sensitive surfaces notifications legitimately target. Sensitive/identity
 * screens (admin, recovery-phrase, paired-devices, settings, ai-providers,
 * vault, policy) are excluded — a notification's `deepLink` can be influenced
 * by remote/peer data (PeerLens cosign inbox, D2D-sourced briefing items), so
 * it must not be able to drive the user to a screen where they could be
 * social-engineered into a sensitive action.
 */
const ALLOWED_DEEP_LINK_ROOTS: ReadonlySet<string> = new Set([
  'chat',
  'peerlens',
  'reminders',
  'notifications',
  'approvals', // shows the pending-approvals list; navigating there auto-approves nothing
]);

/**
 * Validate an untrusted notification `deepLink` to a safe INTERNAL navigation
 * target, or `null` to reject. Accepts the app's own `dina://<root>/…` scheme
 * or a relative `/<root>/…` path; rejects every other scheme (https:, tel:,
 * sms:, javascript:, other-app deep links) so a metadata-controlled
 * notification can't launch an external target, and requires the leading
 * route segment to be allowlisted.
 */
export function safeDeepLink(raw: string): string | null {
  let path: string;
  if (raw.startsWith('dina://')) {
    path = raw.slice('dina://'.length);
  } else if (raw.startsWith('/')) {
    path = raw.slice(1);
  } else {
    return null; // any other scheme or bare value → reject
  }
  const root = (path.split(/[/?#]/)[0] ?? '').toLowerCase();
  return ALLOWED_DEEP_LINK_ROOTS.has(root) ? raw : null;
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
    const safe = safeDeepLink(data.deepLink);
    if (safe !== null) {
      deps.routerPush(safe);
      navigated = true;
    }
  }
  return { marked, navigated };
}
