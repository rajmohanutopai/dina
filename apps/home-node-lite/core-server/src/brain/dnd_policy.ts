/**
 * Do Not Disturb policy — pure decision primitive.
 *
 * Silence-First's delivery layer: once `silence_classifier` classifies
 * a notification as fiduciary/solicited/engagement, the notify
 * dispatcher consults DND to decide whether to:
 *
 *   - `deliver`  — fire the notification now.
 *   - `defer`    — hold until the quiet window ends (return resumeAt).
 *   - `suppress` — drop entirely (silence-first wins).
 *
 * **Four input signals** (any subset):
 *
 *   - `quietHours` — local-time window during which most
 *     notifications defer. Fiduciary ALWAYS breaks through. Solicited
 *     obeys. Engagement suppresses.
 *   - `allowList`  — explicit sender DIDs / channels that bypass DND
 *     regardless of priority.
 *   - `blockList`  — explicit suppress list (wins over allow + priority).
 *   - `userState`  — `online` / `away` / `focus` / `offline`. Focus
 *     implies DND regardless of clock.
 *
 * **Rule order** (first match wins):
 *
 *   1. Block list → suppress.
 *   2. Allow list → deliver (bypasses DND entirely).
 *   3. Fiduciary priority → deliver (silence causes harm).
 *   4. `userState === 'offline'` → defer until state returns (caller
 *      anchors on "next-online").
 *   5. `userState === 'focus'` →
 *        solicited → defer; engagement → suppress.
 *   6. Quiet-hours window active →
 *        solicited → defer until window ends; engagement → suppress.
 *   7. Default → deliver.
 *
 * **Pure** — no IO, deterministic. `nowSec` drives the clock.
 *
 * **Quiet-hours window** supports cross-midnight windows (e.g.
 * 22:00–07:00) by checking whether `startMin` <= nowMinutes or
 * nowMinutes < `endMin` when `startMin > endMin`.
 */

import type { NotifyPriority } from './priority';

export type DndUserState = 'online' | 'away' | 'focus' | 'offline';

/** Local-time quiet window using minutes-since-midnight bounds. */
export interface QuietHours {
  /** Inclusive start minute (0..1439). */
  startMin: number;
  /** Exclusive end minute (0..1440). */
  endMin: number;
  /** IANA offset in minutes from UTC. Defaults to 0 (UTC). */
  tzOffsetMin?: number;
}

export interface DndPolicyInput {
  /** Unix seconds. */
  nowSec: number;
  /** Priority from silence_classifier. */
  priority: NotifyPriority;
  /** Sender id — DID, channel, address — checked against allow/block lists. */
  senderId?: string;
  userState?: DndUserState;
  quietHours?: QuietHours;
  allowList?: ReadonlyArray<string>;
  blockList?: ReadonlyArray<string>;
}

export type DndAction = 'deliver' | 'defer' | 'suppress';

export type DndReason =
  | 'allow_list'
  | 'fiduciary_break_through'
  | 'block_list'
  | 'user_offline'
  | 'focus_mode'
  | 'quiet_hours'
  | 'engagement_suppressed'
  | 'default_deliver';

export interface DndDecision {
  action: DndAction;
  reason: DndReason;
  /** When `defer`: unix seconds when delivery should be retried. */
  resumeAtSec?: number;
}

/**
 * Evaluate DND policy. Never throws — invalid input returns
 * `deliver` with reason `default_deliver` (conservative: if the
 * policy is broken, don't silently suppress).
 */
export function evaluateDnd(input: DndPolicyInput): DndDecision {
  if (!input || typeof input !== 'object') {
    return { action: 'deliver', reason: 'default_deliver' };
  }
  if (!Number.isFinite(input.nowSec)) {
    return { action: 'deliver', reason: 'default_deliver' };
  }
  if (
    input.priority !== 'fiduciary' &&
    input.priority !== 'solicited' &&
    input.priority !== 'engagement'
  ) {
    return { action: 'deliver', reason: 'default_deliver' };
  }

  // 1. Block list.
  if (input.senderId && input.blockList?.includes(input.senderId)) {
    return { action: 'suppress', reason: 'block_list' };
  }

  // 2. Allow list.
  if (input.senderId && input.allowList?.includes(input.senderId)) {
    return { action: 'deliver', reason: 'allow_list' };
  }

  // 3. Fiduciary breaks through every DND signal.
  if (input.priority === 'fiduciary') {
    return { action: 'deliver', reason: 'fiduciary_break_through' };
  }

  // 4. Offline.
  if (input.userState === 'offline') {
    return { action: 'defer', reason: 'user_offline' };
  }

  // 5. Focus mode.
  if (input.userState === 'focus') {
    if (input.priority === 'solicited') {
      return { action: 'defer', reason: 'focus_mode' };
    }
    return { action: 'suppress', reason: 'focus_mode' };
  }

  // 6. Quiet hours.
  if (input.quietHours && isQuietNow(input.nowSec, input.quietHours)) {
    if (input.priority === 'solicited') {
      const resumeAtSec = computeQuietEndSec(input.nowSec, input.quietHours);
      const out: DndDecision = { action: 'defer', reason: 'quiet_hours' };
      if (resumeAtSec !== null) out.resumeAtSec = resumeAtSec;
      return out;
    }
    return { action: 'suppress', reason: 'engagement_suppressed' };
  }

  return { action: 'deliver', reason: 'default_deliver' };
}

/**
 * Check whether `nowSec` falls inside the quiet window. Handles
 * cross-midnight windows (22:00–07:00) by wrapping. Pure.
 */
export function isQuietNow(nowSec: number, quiet: QuietHours): boolean {
  const validation = validateQuiet(quiet);
  if (validation !== null) return false;
  const nowMin = nowToLocalMinutes(nowSec, quiet.tzOffsetMin ?? 0);
  if (quiet.startMin === quiet.endMin) return false; // zero-length
  if (quiet.startMin < quiet.endMin) {
    return nowMin >= quiet.startMin && nowMin < quiet.endMin;
  }
  // Cross-midnight: e.g. 22:00 (1320) → 07:00 (420).
  return nowMin >= quiet.startMin || nowMin < quiet.endMin;
}

/**
 * Unix seconds at which the current quiet window ends. Returns
 * `null` when `nowSec` isn't actually in the window.
 */
export function computeQuietEndSec(nowSec: number, quiet: QuietHours): number | null {
  if (!isQuietNow(nowSec, quiet)) return null;
  const tzOffsetMin = quiet.tzOffsetMin ?? 0;
  const nowLocalMin = nowToLocalMinutes(nowSec, tzOffsetMin);
  const secondsSoFarInMinute = nowSec - Math.floor(nowSec / 60) * 60;
  // Normal window: end is today.
  if (quiet.startMin < quiet.endMin) {
    const minutesUntilEnd = quiet.endMin - nowLocalMin;
    return nowSec + minutesUntilEnd * 60 - secondsSoFarInMinute;
  }
  // Cross-midnight window.
  if (nowLocalMin >= quiet.startMin) {
    // Still before midnight; end is tomorrow.
    const minutesUntilEnd = (24 * 60 - nowLocalMin) + quiet.endMin;
    return nowSec + minutesUntilEnd * 60 - secondsSoFarInMinute;
  }
  // After midnight, still inside tail of window.
  const minutesUntilEnd = quiet.endMin - nowLocalMin;
  return nowSec + minutesUntilEnd * 60 - secondsSoFarInMinute;
}

// ── Internals ──────────────────────────────────────────────────────────

function validateQuiet(quiet: QuietHours): string | null {
  if (!Number.isInteger(quiet.startMin) || quiet.startMin < 0 || quiet.startMin > 1439) {
    return 'startMin must be integer in [0,1439]';
  }
  if (!Number.isInteger(quiet.endMin) || quiet.endMin < 0 || quiet.endMin > 1440) {
    return 'endMin must be integer in [0,1440]';
  }
  if (
    quiet.tzOffsetMin !== undefined &&
    (!Number.isFinite(quiet.tzOffsetMin) || quiet.tzOffsetMin < -1440 || quiet.tzOffsetMin > 1440)
  ) {
    return 'tzOffsetMin must be finite in [-1440,1440]';
  }
  return null;
}

function nowToLocalMinutes(nowSec: number, tzOffsetMin: number): number {
  const local = nowSec + tzOffsetMin * 60;
  const dayStart = Math.floor(local / 86400) * 86400;
  const minuteOfDay = Math.floor((local - dayStart) / 60);
  return ((minuteOfDay % 1440) + 1440) % 1440;
}
