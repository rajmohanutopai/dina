/**
 * Reminder background wiring — connects the scheduler tick() to
 * the background timer system.
 *
 * Call `startReminderScheduler()` during app startup.
 * The scheduler fires every 30 seconds (matching Go's reminder loop
 * idle poll interval of 60s, but more responsive for mobile UX).
 *
 * When the app is backgrounded, timers are stopped via stopTimers().
 * When foregrounded, timers resume via resumeTimers().
 *
 * Source: GAP_ANALYSIS.md §A18 + §A66 — tick() existed but nothing called it.
 */

import { registerTimer } from '../background/timers';
import { tick } from './scheduler';

/** Default tick interval: 30 seconds. */
const REMINDER_TICK_INTERVAL_MS = 30_000;

/** Whether the reminder scheduler has been registered. */
let registered = false;

/**
 * Register the reminder scheduler with the background timer system.
 *
 * Idempotent — calling multiple times is safe.
 * After registration, call `startTimers()` to begin ticking.
 */
export function startReminderScheduler(): string {
  if (registered) return 'reminder_scheduler'; // already registered

  const timerId = registerTimer({
    name: 'reminder_scheduler',
    intervalMs: REMINDER_TICK_INTERVAL_MS,
    handler: () => {
      tick();
    },
  });

  registered = true;
  return timerId;
}

/** Reset registration state (for testing). */
export function resetReminderScheduler(): void {
  registered = false;
}
