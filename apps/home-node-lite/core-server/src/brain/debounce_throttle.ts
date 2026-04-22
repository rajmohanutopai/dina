/**
 * Debounce + throttle — pure function-wrapping rate-limit helpers.
 *
 * Two patterns, both commonly needed in ingest + notify pipelines:
 *
 *   - `debounce(fn, ms)` — collapse bursts into a single call
 *     after the burst settles. Every new call resets the timer;
 *     only the last argument set fires.
 *
 *   - `throttle(fn, ms, {leading?, trailing?})` — rate-limits
 *     calls so `fn` fires at most once per `ms` window. Leading
 *     invocation fires immediately (default true); trailing
 *     invocation fires at the end of the window if more calls
 *     arrived during it (default true).
 *
 * **Injectable timer + clock** — tests drive behavior without
 * real setTimeout. Production uses the host timer functions.
 *
 * **Returned handle**:
 *
 *   - `.cancel()` — drops any pending invocation.
 *   - `.flush()` — fires pending invocation immediately.
 *   - `.pending()` — true when there's a deferred call queued.
 *
 * **Never swallow the latest args silently**: on cancel the last
 * pending call is DROPPED; flush delivers it.
 */

export type TimerHandle = unknown;

export interface DebounceThrottleTimerFns {
  setTimerFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimerFn?: (handle: TimerHandle) => void;
  nowMsFn?: () => number;
}

export interface DebounceOptions extends DebounceThrottleTimerFns {
  /** Max total wait before forcing a call. `null` disables. Default null. */
  maxWaitMs?: number | null;
}

export interface ThrottleOptions extends DebounceThrottleTimerFns {
  leading?: boolean;
  trailing?: boolean;
}

export interface Debounced<T extends unknown[]> {
  (...args: T): void;
  cancel(): void;
  flush(): void;
  pending(): boolean;
}

export interface Throttled<T extends unknown[]> {
  (...args: T): void;
  cancel(): void;
  flush(): void;
  pending(): boolean;
}

export class DebounceThrottleError extends Error {
  constructor(
    public readonly code: 'invalid_fn' | 'invalid_ms',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'DebounceThrottleError';
  }
}

/**
 * Wrap `fn` in a debouncer. Calls only fire `ms` after the last
 * invocation settles; intermediate calls are discarded. The last
 * args win.
 */
export function debounce<T extends unknown[]>(
  fn: (...args: T) => void,
  ms: number,
  opts: DebounceOptions = {},
): Debounced<T> {
  if (typeof fn !== 'function') {
    throw new DebounceThrottleError('invalid_fn', 'fn must be a function');
  }
  if (!Number.isFinite(ms) || ms < 0) {
    throw new DebounceThrottleError('invalid_ms', 'ms must be a non-negative number');
  }
  const setTimer = opts.setTimerFn ?? ((f, t) => setTimeout(f, t));
  const clearTimer = opts.clearTimerFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const nowMsFn = opts.nowMsFn ?? (() => Date.now());
  const maxWaitMs = opts.maxWaitMs ?? null;
  if (maxWaitMs !== null && (!Number.isFinite(maxWaitMs) || maxWaitMs < ms)) {
    throw new DebounceThrottleError('invalid_ms', 'maxWaitMs must be ≥ ms or null');
  }

  let timer: TimerHandle | null = null;
  let maxTimer: TimerHandle | null = null;
  let lastArgs: T | null = null;
  let burstStartedMs = 0;

  const fire = (): void => {
    if (lastArgs === null) return;
    const args = lastArgs;
    lastArgs = null;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (maxTimer !== null) {
      clearTimer(maxTimer);
      maxTimer = null;
    }
    fn(...args);
  };

  const debounced = ((...args: T) => {
    lastArgs = args;
    const now = nowMsFn();
    if (timer !== null) clearTimer(timer);
    timer = setTimer(fire, ms);
    if (maxWaitMs !== null) {
      if (maxTimer === null) {
        burstStartedMs = now;
        maxTimer = setTimer(fire, maxWaitMs);
      } else if (now - burstStartedMs >= maxWaitMs) {
        // Safety net — shouldn't hit because timer fires on time.
        fire();
      }
    }
  }) as Debounced<T>;

  debounced.cancel = (): void => {
    lastArgs = null;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (maxTimer !== null) {
      clearTimer(maxTimer);
      maxTimer = null;
    }
  };

  debounced.flush = (): void => {
    fire();
  };

  debounced.pending = (): boolean => lastArgs !== null;

  return debounced;
}

/**
 * Wrap `fn` in a throttler. Fires at most once per `ms` window.
 * Leading + trailing both default to true.
 */
export function throttle<T extends unknown[]>(
  fn: (...args: T) => void,
  ms: number,
  opts: ThrottleOptions = {},
): Throttled<T> {
  if (typeof fn !== 'function') {
    throw new DebounceThrottleError('invalid_fn', 'fn must be a function');
  }
  if (!Number.isFinite(ms) || ms < 0) {
    throw new DebounceThrottleError('invalid_ms', 'ms must be a non-negative number');
  }
  const setTimer = opts.setTimerFn ?? ((f, t) => setTimeout(f, t));
  const clearTimer = opts.clearTimerFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const nowMsFn = opts.nowMsFn ?? (() => Date.now());
  const leading = opts.leading !== false;
  const trailing = opts.trailing !== false;
  if (!leading && !trailing) {
    throw new DebounceThrottleError('invalid_ms', 'at least one of leading/trailing must be true');
  }

  let timer: TimerHandle | null = null;
  /** null = never fired. Sentinel separates "first call" from "fired at t=0". */
  let lastFireMs: number | null = null;
  let trailingArgs: T | null = null;

  const fireTrailing = (): void => {
    timer = null;
    if (trailingArgs !== null && trailing) {
      const args = trailingArgs;
      trailingArgs = null;
      lastFireMs = nowMsFn();
      fn(...args);
    } else {
      trailingArgs = null;
    }
  };

  const throttled = ((...args: T) => {
    const now = nowMsFn();
    const remaining = lastFireMs === null ? -1 : ms - (now - lastFireMs);
    if (remaining <= 0) {
      // Past the window OR first call ever.
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (leading) {
        lastFireMs = now;
        fn(...args);
        trailingArgs = null;
      } else {
        trailingArgs = args;
        timer = setTimer(fireTrailing, ms);
      }
    } else {
      // Inside the window; queue trailing invocation.
      trailingArgs = args;
      if (timer === null && trailing) {
        timer = setTimer(fireTrailing, remaining);
      }
    }
  }) as Throttled<T>;

  throttled.cancel = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    trailingArgs = null;
    lastFireMs = null;
  };

  throttled.flush = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (trailingArgs !== null) {
      const args = trailingArgs;
      trailingArgs = null;
      lastFireMs = nowMsFn();
      fn(...args);
    }
  };

  throttled.pending = (): boolean => trailingArgs !== null;

  return throttled;
}
