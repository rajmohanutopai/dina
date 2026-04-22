/**
 * Background timer management — fire when active, stop when backgrounded,
 * resume on foreground.
 *
 * Maps server Go goroutines to mobile timer lifecycle:
 *   staging_sweep (5m), outbox_retry (30s), replay_cache (5m),
 *   pairing_purge (1m), watchdog (30s), trace_purge (10m).
 *
 * Source: mobile-specific (no direct server equivalent).
 */

export interface TimerConfig {
  name: string;
  intervalMs: number;
  handler: () => void | Promise<void>;
}

interface RegisteredTimer {
  id: string;
  config: TimerConfig;
  handle?: ReturnType<typeof setInterval>;
}

const timers = new Map<string, RegisteredTimer>();
let active = false;
let nextId = 1;

/** Register a background timer. Returns timer ID. */
export function registerTimer(config: TimerConfig): string {
  const id = `timer-${nextId++}`;
  timers.set(config.name, { id, config });
  return id;
}

/** Start all registered timers. */
export function startTimers(): void {
  for (const timer of timers.values()) {
    if (!timer.handle) {
      timer.handle = setInterval(timer.config.handler, timer.config.intervalMs);
    }
  }
  active = true;
}

/** Stop all timers (app backgrounded). */
export function stopTimers(): void {
  for (const timer of timers.values()) {
    if (timer.handle) {
      clearInterval(timer.handle);
      timer.handle = undefined;
    }
  }
  active = false;
}

/** Resume all timers (app foregrounded). */
export function resumeTimers(): void {
  startTimers();
}

/** Check if timers are currently running. */
export function areTimersActive(): boolean {
  return active;
}

/** Get list of registered timer names. */
export function getRegisteredTimers(): string[] {
  return Array.from(timers.keys());
}

/** Clear all timers (for testing). */
export function clearTimers(): void {
  stopTimers();
  timers.clear();
  active = false;
  nextId = 1;
}
