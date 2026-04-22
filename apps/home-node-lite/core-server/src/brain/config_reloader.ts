/**
 * Task 5.13 — periodic `service_config` reload (60s).
 *
 * Brain reads its service-configuration block (persona list,
 * capability schemas, policy flags, provider keys) from Core on
 * startup + keeps it fresh by polling every 60s. A config change
 * (persona added, capability published, policy tier bumped) must
 * propagate without a Brain restart.
 *
 * **Pattern**:
 *   1. Fetch — call `fetchFn` to pull the current config.
 *   2. Compare — hash-equal the fetched config against the cached
 *      copy via `equalsFn` (default: JSON-stable equality).
 *   3. Swap + notify — on change, replace the cached copy + fire
 *      `changed` with both old + new so downstream listeners can
 *      diff (e.g. persona-added / persona-removed).
 *   4. Survive errors — a fetch failure leaves the cache intact +
 *      fires `fetch_failed`; the next tick retries (backoff handled
 *      by the underlying `SupervisedLoop`).
 *
 * **Satisfies `ManagedLoop`** — plug straight into
 * `BrainLoopRegistry` (task 5.56) so `startAll()`/`stopAll()` own
 * the lifecycle alongside the Guardian + other loops.
 *
 * **Generic**: `<T>` is the config shape. This module has no
 * knowledge of what's inside — it's a reusable change-detection
 * poller.
 *
 * **`getCurrent()`** returns the last-fetched value (or `null` if
 * no successful fetch has completed yet). Readers should call it
 * on each access rather than caching — the current value rotates
 * atomically on successful reload.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5b task 5.13.
 */

import {
  SupervisedLoop,
  type SupervisedLoopEvent,
  type SupervisedLoopOptions,
} from '../supervision/supervised_loop';

export type ConfigFetchFn<T> = (signal?: AbortSignal) => Promise<T>;

/** Returns true when two configs are considered equal. Default: JSON stable hash. */
export type ConfigEqualsFn<T> = (a: T, b: T) => boolean;

export interface ConfigReloaderOptions<T> {
  /** Stable name used in events. Required. */
  name: string;
  fetchFn: ConfigFetchFn<T>;
  /** Equality predicate. Defaults to deep JSON compare. */
  equalsFn?: ConfigEqualsFn<T>;
  /** Cadence in ms. Default 60 000. */
  intervalMs?: number;
  /** Diagnostic hook. */
  onEvent?: (event: ConfigReloaderEvent<T>) => void;
  /** Timer + clock injection — forwarded to the underlying SupervisedLoop. */
  setTimerFn?: (fn: () => void, ms: number) => unknown;
  clearTimerFn?: (handle: unknown) => void;
  nowMsFn?: () => number;
}

export type ConfigReloaderEvent<T> =
  | { kind: 'first_load'; config: T }
  | { kind: 'unchanged' }
  | { kind: 'changed'; previous: T; next: T }
  | { kind: 'fetch_failed'; error: string }
  | SupervisedLoopEvent;

export const DEFAULT_RELOAD_INTERVAL_MS = 60_000;

export class ConfigReloader<T> {
  private readonly fetchFn: ConfigFetchFn<T>;
  private readonly equalsFn: ConfigEqualsFn<T>;
  private readonly onEvent?: (event: ConfigReloaderEvent<T>) => void;
  private readonly loop: SupervisedLoop;
  private current: T | null = null;
  private lastFetchOk = false;

  constructor(opts: ConfigReloaderOptions<T>) {
    if (typeof opts?.name !== 'string' || opts.name.trim() === '') {
      throw new TypeError('ConfigReloader: name is required');
    }
    if (typeof opts.fetchFn !== 'function') {
      throw new TypeError('ConfigReloader: fetchFn is required');
    }
    this.fetchFn = opts.fetchFn;
    this.equalsFn = opts.equalsFn ?? defaultEquals;
    this.onEvent = opts.onEvent;

    const loopOpts: SupervisedLoopOptions = {
      name: opts.name,
      iteration: (signal?: AbortSignal) => this.runOnce(signal),
      intervalMs: opts.intervalMs ?? DEFAULT_RELOAD_INTERVAL_MS,
      onEvent: (e: SupervisedLoopEvent) => this.onEvent?.(e),
    };
    if (opts.setTimerFn !== undefined) loopOpts.setTimerFn = opts.setTimerFn;
    if (opts.clearTimerFn !== undefined) loopOpts.clearTimerFn = opts.clearTimerFn;
    if (opts.nowMsFn !== undefined) loopOpts.nowMsFn = opts.nowMsFn;
    this.loop = new SupervisedLoop(loopOpts);
  }

  /**
   * Return the most recently fetched config, or `null` if no
   * successful fetch has completed yet. Safe to call at any time —
   * swap is atomic per iteration.
   */
  getCurrent(): T | null {
    return this.current;
  }

  /** True when the most recent fetch succeeded. */
  isReady(): boolean {
    return this.lastFetchOk;
  }

  /**
   * Force an immediate out-of-band reload. Useful after a
   * targeted config write (admin UI "apply change now" button) —
   * avoids waiting up to `intervalMs` for the polling tick. Returns
   * a promise that resolves after the fetch + compare completes.
   */
  async reloadNow(): Promise<void> {
    await this.runOnce();
  }

  /** Start the periodic loop. Matches `ManagedLoop.start`. */
  start(): void {
    this.loop.start();
  }

  /** Stop gracefully — resolves after the in-flight iteration. */
  async stop(): Promise<void> {
    await this.loop.stop();
  }

  /** True while the loop is active. Matches `ManagedLoop.isRunning`. */
  isRunning(): boolean {
    return this.loop.isRunning();
  }

  // ── Internals ────────────────────────────────────────────────────────

  private async runOnce(signal?: AbortSignal): Promise<void> {
    let next: T;
    try {
      next = await this.fetchFn(signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onEvent?.({ kind: 'fetch_failed', error: msg });
      this.lastFetchOk = false;
      throw err; // propagate so SupervisedLoop counts the failure + backs off
    }

    if (this.current === null) {
      this.current = next;
      this.lastFetchOk = true;
      this.onEvent?.({ kind: 'first_load', config: next });
      return;
    }

    if (this.equalsFn(this.current, next)) {
      this.lastFetchOk = true;
      this.onEvent?.({ kind: 'unchanged' });
      return;
    }

    const previous = this.current;
    this.current = next;
    this.lastFetchOk = true;
    this.onEvent?.({ kind: 'changed', previous, next });
  }
}

// ── Internals ──────────────────────────────────────────────────────────

/**
 * Deep equality via stable JSON serialisation. Handles object key
 * ordering by recursively sorting keys before stringification, so
 * `{a:1,b:2}` and `{b:2,a:1}` compare equal.
 */
export function defaultEquals<T>(a: T, b: T): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs: string[] = [];
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    pairs.push(JSON.stringify(k) + ':' + stableStringify(v));
  }
  return '{' + pairs.join(',') + '}';
}
