/**
 * Task 5.48 — priority enum re-exports from `@dina/protocol`.
 *
 * Dina uses ONE priority enum across three subsystems:
 *
 *   - **NotifyDispatcher** (5.47) — routes the notification by
 *     priority (fiduciary: interrupt-now; solicited: send/defer by
 *     DND policy; engagement: buffer for briefing).
 *   - **NudgeAssembler** (5.39) — classifies the nudge so the
 *     downstream dispatcher knows how to deliver it.
 *   - **GuardianLoop** (5.30) — each inbound event is classified
 *     into one of the three tiers before processing.
 *
 * Previously each subsystem defined its own local type alias with
 * the same three strings. That's a footgun — adding a fourth tier
 * would need three separate changes with three chances to drift.
 * This module centralises the enum: everything re-exports from
 * `@dina/protocol`, so the canonical source stays in the protocol
 * package + no subsystem holds a divergent copy.
 *
 * **Import form** — callers should import from `./priority`, not
 * from `@dina/protocol` directly. This keeps the boundary explicit
 * (if the protocol package ever splits its priority tokens for
 * notify vs. nudge vs. guardian, the shim centralises the
 * adjustment here, not in a dozen modules).
 *
 * **Constants** — `NOTIFY_PRIORITY_*` strings are re-exported as
 * frozen literals so callers can write `NOTIFY_PRIORITY_FIDUCIARY`
 * instead of `'fiduciary' as const`. Using the constants makes
 * the linter catch typos.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5f task 5.48.
 */

export {
  NOTIFY_PRIORITY_FIDUCIARY,
  NOTIFY_PRIORITY_SOLICITED,
  NOTIFY_PRIORITY_ENGAGEMENT,
  type NotifyPriority,
} from '@dina/protocol';

import type { NotifyPriority } from '@dina/protocol';

/**
 * Priority ordering from "most urgent" → "least urgent". Useful
 * for comparators + UI rendering (e.g. tests that need to verify
 * fiduciary events fire before solicited).
 */
export const PRIORITY_RANK: Readonly<Record<NotifyPriority, number>> =
  Object.freeze({
    fiduciary: 0,
    solicited: 1,
    engagement: 2,
  });

/**
 * Compare two priorities: negative if `a` is more urgent than `b`,
 * positive if less, zero if equal. Sort-function compatible.
 */
export function comparePriority(a: NotifyPriority, b: NotifyPriority): number {
  return PRIORITY_RANK[a] - PRIORITY_RANK[b];
}

/** True when `a` is strictly more urgent than `b`. */
export function isMoreUrgent(a: NotifyPriority, b: NotifyPriority): boolean {
  return PRIORITY_RANK[a] < PRIORITY_RANK[b];
}
