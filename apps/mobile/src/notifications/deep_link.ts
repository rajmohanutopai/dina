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
  'runs',
  'subscriptions',
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

/**
 * Normalise an approval deep link to `/notifications?filter=needs_action`
 * (Brain emits `dina://approvals` / `dina://approvals/<id>`, but the
 * standalone Approvals screen was merged into the Activity tab — approval
 * cards are now actionable inline on the "Needs action" filter). We land
 * taps on that filter directly, not Activity's default "Unread", so the
 * actionable card is on screen. The scheme is stripped so the link reaches
 * its in-app page. Pure transform — the allowlist is applied by
 * `resolveSafeDeepLink` (the root segment is still `notifications`).
 */
function normaliseDeepLinkPath(link: string): string {
  const approvalMatch = link.match(/^(?:dina:\/\/)?\/?approvals(?:\/[^/?#]+)?(?:[/?#]|$)/);
  if (approvalMatch !== null) return '/notifications?filter=needs_action';
  // Briefing producers retain rows in Activity, but the mobile app has no
  // briefing-detail route. Land on the durable Activity record instead of an
  // Expo Router 404.
  const briefingMatch = link.match(/^(?:dina:\/\/)?\/?briefings(?:\/[^/?#]+)?(?:[/?#]|$)/);
  if (briefingMatch !== null) return '/notifications?filter=all';
  if (link.startsWith('dina://')) return `/${link.slice('dina://'.length)}`;
  return link;
}

/**
 * THE single safe deep-link resolver — every untrusted `deepLink` push (OS
 * notification taps, the Notifications screen, briefing cards) MUST go through
 * this. Normalises the link (approval → `/notifications`, scheme strip) THEN
 * applies the allowlist (`safeDeepLink`): returns a safe internal path, or
 * `null` to reject (external scheme, or a non-allowlisted/sensitive route such
 * as `/vault/...`). Callers MUST no-op on `null`.
 */
export function resolveSafeDeepLink(raw: string): string | null {
  return safeDeepLink(normaliseDeepLinkPath(raw));
}

export interface ColdStartDeepLinkDeps {
  getInitialURL: () => Promise<string | null>;
  routerReplace: (path: string) => void;
}

/**
 * iOS fallback for a cold-launch URL that Expo Router's synchronous linking
 * registry did not retain. This deliberately reuses the same narrow allowlist
 * as notification taps; OAuth and all sensitive/external routes remain owned
 * by their existing flows.
 */
export async function handleColdStartDeepLink(deps: ColdStartDeepLinkDeps): Promise<boolean> {
  try {
    const raw = await deps.getInitialURL();
    if (raw === null) return false;
    const safe = resolveSafeDeepLink(raw);
    if (safe === null) return false;
    deps.routerReplace(safe);
    return true;
  } catch {
    // Startup navigation is best-effort; a linking failure must not brick boot.
    return false;
  }
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
    const safe = resolveSafeDeepLink(data.deepLink);
    if (safe !== null) {
      deps.routerPush(safe);
      navigated = true;
    }
  }
  return { marked, navigated };
}
