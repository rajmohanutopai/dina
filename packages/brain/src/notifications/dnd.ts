/**
 * DND policy for notification delivery (task 5.69).
 *
 * Encodes the user's "do not disturb" preferences as a single function
 * that callers consult before scheduling a push notification. The
 * scheduler in `notifications/local.ts` (task 5.60) and the inbox
 * bridges (5.66) read it; the inbox itself does NOT — every fired
 * notification still lands in the unified log so the user can catch
 * up later. DND only suppresses the *interruption* (push banner),
 * not the *record*.
 *
 * **Three tiers, three rules** (Silence First — see §35.1 of
 * `ARCHITECTURE.md`):
 *   - **Tier 1 fiduciary** — interrupts always. The Tier-1
 *     invariant overrides every DND setting; this is what task 5.49
 *     pins as the safety contract.
 *   - **Tier 2 solicited** — interrupts unless we're inside the
 *     configured quiet-hours window.
 *   - **Tier 3 engagement** — interrupts only when `muteEngagement`
 *     is false AND we're outside quiet hours. Default `muteEngagement`
 *     is true so engagement notifications bundle into the daily
 *     briefing (5.46–5.48) instead of pinging the device.
 *
 * **Why brain-side, not mobile-side?** DND is a logical policy that
 * applies to every consumer (mobile, CLI, future surfaces). Living
 * brain-side means the same rule fires regardless of who reads it.
 * The mobile settings screen will mutate via `setDND` but the
 * invariants are checked here.
 */

export type NotificationTier = 1 | 2 | 3;

export interface DNDState {
  /** When true, Tier-3 (engagement) notifications never push. They
   *  still land in the unified inbox; just no banner / sound /
   *  badge-pulse. Default true — Silence First. */
  muteEngagement: boolean;
  /** Quiet-hours window. Format `'HH:MM'` (24-hour, local). When
   *  start === end, the window is empty (no quiet hours). When
   *  start > end, the window wraps midnight (e.g. `22:00`–`07:00`). */
  quietHoursStart: string;
  quietHoursEnd: string;
}

export const DEFAULT_DND_STATE: DNDState = Object.freeze({
  muteEngagement: true,
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
});

let state: DNDState = { ...DEFAULT_DND_STATE };

export function getDND(): DNDState {
  return { ...state };
}

/**
 * Update the DND state. Partial-merge: omit fields you don't want to
 * change. Returns the new state.
 */
export function setDND(partial: Partial<DNDState>): DNDState {
  const next: DNDState = { ...state };
  if (partial.muteEngagement !== undefined) next.muteEngagement = partial.muteEngagement;
  if (partial.quietHoursStart !== undefined) {
    if (!isValidHHMM(partial.quietHoursStart)) {
      throw new Error(
        `setDND: quietHoursStart must be 'HH:MM' (got ${JSON.stringify(partial.quietHoursStart)})`,
      );
    }
    next.quietHoursStart = partial.quietHoursStart;
  }
  if (partial.quietHoursEnd !== undefined) {
    if (!isValidHHMM(partial.quietHoursEnd)) {
      throw new Error(
        `setDND: quietHoursEnd must be 'HH:MM' (got ${JSON.stringify(partial.quietHoursEnd)})`,
      );
    }
    next.quietHoursEnd = partial.quietHoursEnd;
  }
  state = next;
  return { ...state };
}

export function resetDND(): void {
  state = { ...DEFAULT_DND_STATE };
}

/**
 * Decide whether a notification at the given tier should fire a push
 * banner right now.
 *
 * @param tier 1 | 2 | 3 — fiduciary | solicited | engagement.
 * @param now Optional `Date` injection for tests (defaults to
 *   `new Date()`). Local-time fields are used for the comparison.
 * @returns true if the push should fire; false if DND suppresses it.
 *
 * **Tier 1 invariant**: this function returns true for Tier 1
 * regardless of any setting. Anyone changing this (e.g. to add a
 * "panic mute" mode for Tier 1) MUST update the invariant test that
 * pins this behaviour and explicitly justify the change in review.
 */
export function shouldDeliverNotification(tier: NotificationTier, now: Date = new Date()): boolean {
  if (tier === 1) return true; // fiduciary — never gated

  const inQuietHours = isInQuietHours(state.quietHoursStart, state.quietHoursEnd, now);

  if (tier === 3) {
    // Engagement: muted by EITHER muteEngagement OR quiet hours.
    if (state.muteEngagement) return false;
    if (inQuietHours) return false;
    return true;
  }

  // Tier 2 solicited: suppressed only during quiet hours.
  return !inQuietHours;
}

// ---------------------------------------------------------------------------
// Internals — exported for unit-testing the time-window math without
// going through `shouldDeliverNotification`.
// ---------------------------------------------------------------------------

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidHHMM(s: string): boolean {
  return typeof s === 'string' && HHMM_RE.test(s);
}

export function parseHHMM(s: string): number {
  const m = HHMM_RE.exec(s);
  if (m === null) throw new Error(`parseHHMM: invalid 'HH:MM' (got ${JSON.stringify(s)})`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh * 60 + mm;
}

/**
 * Is `now` (local time) inside the `[start, end)` quiet-hours window?
 *
 * - `start === end` → empty window (no quiet hours). Returns false.
 * - `start < end`   → simple in-day window (e.g. 09:00–17:00).
 * - `start > end`   → wraps midnight (e.g. 22:00–07:00). The "in" set
 *   is `[start, 24:00) ∪ [00:00, end)`.
 */
export function isInQuietHours(start: string, end: string, now: Date): boolean {
  const startMin = parseHHMM(start);
  const endMin = parseHHMM(end);
  if (startMin === endMin) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // Wraps midnight.
  return nowMin >= startMin || nowMin < endMin;
}
