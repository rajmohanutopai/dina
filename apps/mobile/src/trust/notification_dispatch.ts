/**
 * Cosig push-notification dispatch decision (TN-MOB-045).
 *
 * Plan §1 row 72:
 *
 *   > Notification permission for cosig? Reuse existing local-
 *   > notifications permission set up in `_layout.tsx`; cosig request
 *   > fires a local push when app is closed. **No new permission
 *   > prompt.**
 *
 * The "no new prompt" rule is the load-bearing constraint: cosig is
 * an opt-in social action (a peer asked you to endorse), not core
 * comms. Re-prompting for notification permission risks a "deny"
 * that turns off ALL Dina notifications (Sancho moments, daily
 * briefings, etc.). So if the existing permission state is anything
 * other than `granted`, we silence — even though that means the
 * cosig request will only surface via the inbox, not as a push.
 *
 * This module owns the **decision** — given the permission state,
 * the incoming cosig request, the app's lifecycle state, and the
 * current clock, return whether to fire a local push and (if so)
 * the body to fire. The runner (the D2D handler in the screen
 * layer) wires this into expo-notifications' schedule API.
 *
 * Decision rules (silence-default; "fire" is the explicit positive
 * outcome):
 *
 *   1. Permission `denied`         → silence (`permission_denied`)
 *   2. Permission `undetermined`   → silence (`permission_undetermined`)
 *      — never re-prompts. The user can grant via the Sancho-moment
 *      flow or in OS settings; cosig dispatch never asks.
 *   3. Request already expired     → silence (`request_expired`)
 *      — defensive against clock skew + delayed-delivery edge cases.
 *      AppView's expiry sweeper normally drops these upstream, but a
 *      stale push that deep-links to a closed row reads as a bug.
 *   4. App in `foreground`         → silence (`app_foreground`)
 *      — the unified inbox surface already shows the row in real
 *      time; doubling up with an OS-level push is jarring.
 *   5. Otherwise                   → fire (with title / body / deep
 *      link / data payload).
 *
 * Order matters for the `silence.reason` returned: permission gates
 * come first because they're fundamental (no point checking app
 * state if we can't fire anything anyway). Expiry-then-app-state is
 * the next-most-specific.
 *
 * Pure function. No state, no I/O. The screen wires the result into
 * expo-notifications + the inbox renderer.
 *
 * Why a separate module rather than inlining in the D2D handler:
 *   - The decision rules are tested as a unit — order, fallbacks,
 *     copy. Inline in a handler, the rules drift across each
 *     handler that handles cosig (the inbox surface, the unread-
 *     badge counter, the action sheet).
 *   - The notification copy mirrors `cosig_inbox.buildCosigInboxRow`
 *     ("Sancho asked you to co-sign their review" with "Someone"
 *     fallback) — having both surfaces share a derivation guards
 *     the title from drifting between push and inbox.
 *   - The deep-link pattern `/trust/<subjectId>` is also from
 *     `cosig_inbox`. Centralising avoids the screen layer parsing
 *     subjectIds in two different places.
 */

import type { CosigRequest } from '@dina/protocol';

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * The OS-reported permission status. Maps 1:1 to expo-notifications'
 * `PermissionStatus`. Listed explicitly here so the data layer
 * doesn't import expo-notifications (zero RN deps).
 */
export type NotificationPermissionStatus = 'granted' | 'denied' | 'undetermined';

/**
 * App lifecycle state — the runner reads `AppState.currentState`
 * (RN module) and passes it in. We model only the three positions
 * that affect dispatch behaviour:
 *   - `foreground`: user can see the screen → silence (inbox surface
 *     handles it).
 *   - `background`: app is backgrounded but the OS may schedule
 *     pushes → fire.
 *   - `inactive`: iOS-only transition state → treat as background;
 *     fire (the OS will surface the push when the user comes back).
 */
export type AppLifecycleState = 'foreground' | 'background' | 'inactive';

export type CosigSilenceReason =
  | 'permission_denied'
  | 'permission_undetermined'
  | 'request_expired'
  | 'app_foreground';

export interface CosigNotificationBody {
  /** Push title — same shape as `cosig_inbox.buildCosigInboxRow`. */
  readonly title: string;
  /**
   * Push body. The request's `reason` field if present (trimmed),
   * otherwise a generic prompt. Empty / whitespace-only `reason`
   * coerces to the generic — never render a blank push.
   */
  readonly body: string;
  /**
   * Deep link the OS should follow when the user taps the push.
   * `/trust/<encodeURIComponent(subjectId)>` — same pattern as
   * `cosig_inbox.buildCosigInboxRow.deepLink`.
   */
  readonly deepLink: string;
  /**
   * Structured payload the OS-side notification carries so the
   * screen can correlate the tap back to the request without
   * re-parsing the deep link.
   */
  readonly data: {
    readonly requestId: string;
    readonly attestationUri: string;
  };
}

export type CosigNotificationDecision =
  | { readonly kind: 'fire'; readonly body: CosigNotificationBody }
  | { readonly kind: 'silence'; readonly reason: CosigSilenceReason };

export interface DecideCosigNotificationInput {
  readonly permission: NotificationPermissionStatus;
  readonly request: CosigRequest;
  readonly senderName?: string | null;
  /**
   * `subjectId` is derived by the screen layer from
   * `request.attestationUri`. Passed in so this module doesn't have
   * to re-implement AT-URI parsing.
   */
  readonly subjectId: string;
  readonly appState: AppLifecycleState;
  /** Wall-clock — injectable for deterministic tests. */
  readonly nowMs: number;
}

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * Generic body when the request didn't carry an explicit `reason`.
 * Phrased as an open question, not a directive — matches the
 * Silence-First principle of nudging without pushing.
 */
export const GENERIC_COSIG_BODY = 'Open to take a look?';

/**
 * Sender-name fallback when the contact resolver hasn't produced a
 * display name. Consistent with `cosig_inbox.buildCosigInboxRow`.
 */
export const FALLBACK_SENDER_NAME = 'Someone';

// Module-level frozen silence constants — identity-stable so two
// silence decisions with the same reason return the same object.
const SILENCE_PERMISSION_DENIED: CosigNotificationDecision = Object.freeze({
  kind: 'silence',
  reason: 'permission_denied',
});
const SILENCE_PERMISSION_UNDETERMINED: CosigNotificationDecision = Object.freeze({
  kind: 'silence',
  reason: 'permission_undetermined',
});
const SILENCE_REQUEST_EXPIRED: CosigNotificationDecision = Object.freeze({
  kind: 'silence',
  reason: 'request_expired',
});
const SILENCE_APP_FOREGROUND: CosigNotificationDecision = Object.freeze({
  kind: 'silence',
  reason: 'app_foreground',
});

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Decide whether to fire a local push for an incoming cosig request.
 *
 * See module docstring for the silence rules + ordering. When the
 * decision is `fire`, the returned body is ready for the runner to
 * pass to expo-notifications' schedule API.
 *
 * Throws on a malformed `expiresAt` or empty `subjectId` rather than
 * coercing — silent coercion would either fire a push that
 * deep-links to a broken route, or silence based on garbage data.
 * The screen's error boundary surfaces the issue.
 */
export function decideCosigNotification(
  input: DecideCosigNotificationInput,
): CosigNotificationDecision {
  if (input.permission === 'denied') return SILENCE_PERMISSION_DENIED;
  if (input.permission === 'undetermined') return SILENCE_PERMISSION_UNDETERMINED;

  const expMs = parseISOMs(input.request.expiresAt, 'request.expiresAt');
  if (input.nowMs >= expMs) return SILENCE_REQUEST_EXPIRED;

  if (input.appState === 'foreground') return SILENCE_APP_FOREGROUND;

  // permission='granted', not expired, app not foreground → fire.
  return {
    kind: 'fire',
    body: buildBody(input),
  };
}

// ─── Internal ─────────────────────────────────────────────────────────────

function buildBody(input: DecideCosigNotificationInput): CosigNotificationBody {
  const senderName = resolveSenderName(input.senderName);
  const title = `${senderName} asked you to co-sign their review`;
  const body = resolveRequestBody(input.request.reason);
  const deepLink = buildDeepLink(input.subjectId);
  return Object.freeze({
    title,
    body,
    deepLink,
    data: Object.freeze({
      requestId: input.request.requestId,
      attestationUri: input.request.attestationUri,
    }),
  });
}

function resolveSenderName(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return FALLBACK_SENDER_NAME;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : FALLBACK_SENDER_NAME;
}

function resolveRequestBody(reason: string | undefined): string {
  if (typeof reason !== 'string') return GENERIC_COSIG_BODY;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : GENERIC_COSIG_BODY;
}

function buildDeepLink(subjectId: string): string {
  if (typeof subjectId !== 'string' || subjectId.length === 0) {
    throw new Error('decideCosigNotification: subjectId must be a non-empty string');
  }
  return `/trust/${encodeURIComponent(subjectId)}`;
}

function parseISOMs(iso: string, label: string): number {
  if (typeof iso !== 'string' || iso.length === 0) {
    throw new Error(`decideCosigNotification: ${label} must be an ISO-8601 string`);
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(
      `decideCosigNotification: ${label} is not a valid ISO-8601 datetime: "${iso}"`,
    );
  }
  return ms;
}
