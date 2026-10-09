/**
 * Foreground time, measured from app-state changes (REAL_LIFE_FIXES §14.4 A):
 * a session starts when the app becomes active and is credited when it
 * leaves, with checkpoints on a timer in between. A timer that fires late
 * after a suspension credits nothing, because leaving the foreground ended
 * the session; short sessions are credited in full when they end.
 */

export interface ForegroundMeterOptions {
  /** Is the app in the foreground now? (Read once, at start.) */
  isActive: () => boolean;
  /** Subscribe to foreground changes; returns the unsubscribe. */
  subscribe?: (onChange: (active: boolean) => void) => () => void;
  /** Called with each measured span of foreground time, in ms. */
  onCredit: (ms: number) => void;
  nowMs?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  checkpointMs?: number;
}

/** Start measuring; returns the stop function (which credits the open span). */
export function startForegroundMeter(o: ForegroundMeterOptions): () => void {
  const now = o.nowMs ?? Date.now;
  let activeSince: number | null = o.isActive() ? now() : null;
  const checkpoint = (): void => {
    if (activeSince === null) return;
    const t = now();
    if (t > activeSince) o.onCredit(t - activeSince);
    activeSince = t;
  };
  const unsubscribe =
    o.subscribe?.((active) => {
      if (active) {
        if (activeSince === null) activeSince = now();
      } else {
        checkpoint();
        activeSince = null;
      }
    }) ?? (() => undefined);
  const set = o.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clear = o.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const handle = set(checkpoint, o.checkpointMs ?? 15_000);
  return () => {
    checkpoint();
    unsubscribe();
    clear(handle);
  };
}
