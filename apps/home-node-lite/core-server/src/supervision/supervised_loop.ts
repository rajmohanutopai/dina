/**
 * Task 4.90 — supervision of background loops.
 *
 * Background processes on a Home Node (MsgBox poll, session sweeper,
 * idempotency cache purge, approval-request expiry) must run
 * indefinitely. Without supervision, a single unhandled throw ends
 * the loop forever — ops doesn't know until traffic fails downstream.
 * This primitive wraps an async iteration function with:
 *
 *   - **Interval-driven cadence**: runs every `intervalMs` while alive.
 *   - **Exponential-backoff restart** on uncaught throws: delay
 *     doubles (1s → 2s → 4s → 8s → cap 30s) each consecutive failure.
 *   - **Backoff reset on success**: one successful iteration drops
 *     the retry delay back to 1s, so a self-healing dependency
 *     doesn't stay in slow-retry mode forever.
 *   - **Graceful stop**: `stop()` cancels the next tick + waits for
 *     any in-flight iteration to finish.
 *   - **Event stream**: `started | iteration_ok | iteration_failed |
 *     restarting | stopped` — enough visibility for ops dashboards
 *     without coupling to a specific logger.
 *
 * **No concurrent iterations** — a tick fires only after the prior
 * iteration resolves (success OR failure). Prevents overlap on slow
 * backends.
 *
 * **Test determinism**: `setTimerFn` + `clearTimerFn` + `nowMsFn` are
 * all injectable. Production wires `setTimeout` / `clearTimeout`;
 * tests pass a mock scheduler that fires on-demand.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4l task 4.90.
 */

/** One iteration of the supervised work. Throw → supervisor restarts with backoff. */
export type IterationFn = (abortSignal?: AbortSignal) => Promise<void>;

/** Timer primitives — injectable for deterministic tests. */
export type SetTimerFn = (fn: () => void, ms: number) => unknown;
export type ClearTimerFn = (handle: unknown) => void;

export interface SupervisedLoopOptions {
  /** Stable name used in events. Required. */
  name: string;
  /** The work function. Runs on every tick. Required. */
  iteration: IterationFn;
  /** Cadence between successful iterations (ms). Default 60 000. */
  intervalMs?: number;
  /** Initial backoff on first failure (ms). Default 1000. */
  initialBackoffMs?: number;
  /** Maximum backoff (ms). Default 30 000. */
  maxBackoffMs?: number;
  /** Diagnostic hook. Fires after every state transition. */
  onEvent?: (event: SupervisedLoopEvent) => void;
  /** Injectable clock (ms). Default `Date.now`. */
  nowMsFn?: () => number;
  /** Injectable timer set. Default `setTimeout`. */
  setTimerFn?: SetTimerFn;
  /** Injectable timer clear. Default `clearTimeout`. */
  clearTimerFn?: ClearTimerFn;
}

export type SupervisedLoopEvent =
  | { kind: 'started'; name: string; atMs: number }
  | { kind: 'iteration_ok'; name: string; atMs: number; durationMs: number }
  | {
      kind: 'iteration_failed';
      name: string;
      atMs: number;
      consecutiveFailures: number;
      error: string;
    }
  | {
      kind: 'restarting';
      name: string;
      atMs: number;
      backoffMs: number;
      consecutiveFailures: number;
    }
  | { kind: 'stopped'; name: string; atMs: number };

export const DEFAULT_INTERVAL_MS = 60_000;
export const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;

export class SupervisedLoop {
  readonly name: string;
  private readonly iteration: IterationFn;
  private readonly intervalMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly nowMsFn: () => number;
  private readonly setTimerFn: SetTimerFn;
  private readonly clearTimerFn: ClearTimerFn;
  private readonly onEvent?: (event: SupervisedLoopEvent) => void;

  private running = false;
  private stopped = false;
  private timerHandle: unknown = null;
  private consecutiveFailures = 0;
  /** Promise that resolves when the current in-flight iteration finishes. */
  private inflight: Promise<void> | null = null;
  private abortController: AbortController | null = null;

  constructor(opts: SupervisedLoopOptions) {
    if (!opts.name) throw new Error('SupervisedLoop: name is required');
    if (typeof opts.iteration !== 'function') {
      throw new Error('SupervisedLoop: iteration is required');
    }
    this.name = opts.name;
    this.iteration = opts.iteration;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.initialBackoffMs = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.validateTiming();

    this.nowMsFn = opts.nowMsFn ?? Date.now;
    this.setTimerFn = opts.setTimerFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimerFn =
      opts.clearTimerFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onEvent = opts.onEvent;
  }

  private validateTiming(): void {
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error(
        `SupervisedLoop: intervalMs must be > 0 (got ${this.intervalMs})`,
      );
    }
    if (!Number.isFinite(this.initialBackoffMs) || this.initialBackoffMs <= 0) {
      throw new Error(
        `SupervisedLoop: initialBackoffMs must be > 0 (got ${this.initialBackoffMs})`,
      );
    }
    if (
      !Number.isFinite(this.maxBackoffMs) ||
      this.maxBackoffMs < this.initialBackoffMs
    ) {
      throw new Error(
        `SupervisedLoop: maxBackoffMs must be >= initialBackoffMs (got ${this.maxBackoffMs} vs ${this.initialBackoffMs})`,
      );
    }
  }

  /**
   * Start the loop. First iteration fires immediately on the next
   * turn of the event loop (zero-delay timer). Idempotent — calling
   * `start` on an already-running loop is a no-op.
   */
  start(): void {
    if (this.running) return;
    if (this.stopped) {
      throw new Error(`SupervisedLoop.${this.name}: cannot restart a stopped loop`);
    }
    this.running = true;
    this.onEvent?.({ kind: 'started', name: this.name, atMs: this.nowMsFn() });
    this.scheduleNext(0);
  }

  /**
   * Stop the loop. Cancels the next scheduled tick + awaits any
   * in-flight iteration. Safe to call multiple times.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    if (this.timerHandle !== null) {
      this.clearTimerFn(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.abortController !== null) {
      this.abortController.abort();
    }
    if (this.inflight !== null) {
      try {
        await this.inflight;
      } catch {
        // Iteration failures are already reported via `onEvent`;
        // swallow on shutdown.
      }
    }
    this.onEvent?.({ kind: 'stopped', name: this.name, atMs: this.nowMsFn() });
  }

  /** True between `start()` and `stop()`. */
  isRunning(): boolean {
    return this.running && !this.stopped;
  }

  /**
   * Count of consecutive failures since the last successful iteration.
   * Resets to 0 on any success. Useful for /readyz probes that want to
   * fail a loop that's been looping-in-backoff for too long.
   */
  failureStreak(): number {
    return this.consecutiveFailures;
  }

  // ── Internals ───────────────────────────────────────────────────────

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timerHandle = this.setTimerFn(() => {
      this.timerHandle = null;
      void this.runIteration();
    }, delayMs);
  }

  private async runIteration(): Promise<void> {
    if (!this.running) return;
    const controller = new AbortController();
    this.abortController = controller;
    const startedAt = this.nowMsFn();
    const p = (async () => {
      try {
        await this.iteration(controller.signal);
        const durationMs = this.nowMsFn() - startedAt;
        this.consecutiveFailures = 0;
        this.onEvent?.({
          kind: 'iteration_ok',
          name: this.name,
          atMs: this.nowMsFn(),
          durationMs,
        });
        this.scheduleNext(this.intervalMs);
      } catch (err) {
        this.consecutiveFailures += 1;
        const msg = err instanceof Error ? err.message : String(err);
        this.onEvent?.({
          kind: 'iteration_failed',
          name: this.name,
          atMs: this.nowMsFn(),
          consecutiveFailures: this.consecutiveFailures,
          error: msg,
        });
        const backoffMs = this.computeBackoff();
        this.onEvent?.({
          kind: 'restarting',
          name: this.name,
          atMs: this.nowMsFn(),
          backoffMs,
          consecutiveFailures: this.consecutiveFailures,
        });
        this.scheduleNext(backoffMs);
      }
    })();
    this.inflight = p;
    try {
      await p;
    } finally {
      this.inflight = null;
      this.abortController = null;
    }
  }

  private computeBackoff(): number {
    // Exponential: initial * 2^(failures - 1), capped at max.
    const raw = this.initialBackoffMs * Math.pow(2, this.consecutiveFailures - 1);
    return Math.min(raw, this.maxBackoffMs);
  }
}
