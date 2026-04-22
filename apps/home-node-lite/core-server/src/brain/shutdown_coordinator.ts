/**
 * Task 5.6 — Graceful shutdown coordinator.
 *
 * When the brain-server receives SIGTERM (k8s pod eviction,
 * `docker compose down`, systemd stop), it must shut down in the
 * correct ORDER:
 *
 *   1. **Stop accepting new HTTP requests** — remove the Fastify
 *      server from the load-balancer so no new work arrives.
 *   2. **Stop background loops** (Guardian, MsgBox polling,
 *      scratchpad sweeper) — they don't need to be mid-iteration
 *      when we close dependencies.
 *   3. **Flush notifications** — the engagement buffer should
 *      reach the briefing pipeline before we close down.
 *   4. **Drain in-flight asks** — the ask registry's in-flight
 *      requests should either complete OR be demoted to
 *      `pending_approval` / `failed` before we close.
 *   5. **Close external clients** (Core, PDS, AppView).
 *   6. **Release the keystore** / any SQLite connections.
 *
 * Every step has a per-step time budget. The overall shutdown
 * deadline (default 30s, same as Docker's SIGKILL grace period)
 * bounds the total — any step that exceeds its budget is
 * abandoned + logged; the coordinator moves on to the next.
 *
 * **Structured report**: every step's outcome goes into the
 * returned report so ops dashboards can render "shutdown
 * completed in 4.2s; notify-flush took 1.1s".
 *
 * **Never throws**: one step crashing doesn't abort the shutdown.
 * The goal is to finish the shutdown gracefully even on partial
 * failure; escalating an exception would leave later steps
 * unexecuted.
 *
 * **One-shot**: `run()` may only be called once. Subsequent calls
 * throw — prevents double-close on SIGTERM storms.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5a task 5.6.
 */

export interface ShutdownStep {
  /** Stable name used in the report + logs. */
  name: string;
  /** Per-step timeout. Defaults to the coordinator's. */
  timeoutMs?: number;
  /**
   * Close / drain / stop work. MUST be idempotent — the caller
   * might retry specific steps. May throw; the coordinator
   * catches + records.
   */
  close(): Promise<void>;
}

export interface StepResult {
  name: string;
  status: 'ok' | 'failed' | 'timeout' | 'skipped';
  durationMs: number;
  error: string | null;
}

export interface ShutdownReport {
  status: 'clean' | 'degraded';
  startedAtMs: number;
  durationMs: number;
  /** Steps in the order they ran. */
  steps: StepResult[];
  /** Whether the overall deadline was hit. */
  deadlineExceeded: boolean;
}

export interface ShutdownCoordinatorOptions {
  /** Overall deadline. Default 30s (matches Docker SIGKILL grace). */
  overallDeadlineMs?: number;
  /** Default per-step timeout when the step doesn't specify. Default 5s. */
  defaultStepTimeoutMs?: number;
  /** Injectable clock. */
  nowMsFn?: () => number;
  /** Injectable timers. */
  setTimerFn?: (fn: () => void, ms: number) => unknown;
  clearTimerFn?: (handle: unknown) => void;
  /** Diagnostic hook. */
  onEvent?: (event: ShutdownEvent) => void;
}

export type ShutdownEvent =
  | { kind: 'started'; stepCount: number }
  | { kind: 'step_started'; name: string }
  | { kind: 'step_ok'; name: string; durationMs: number }
  | { kind: 'step_failed'; name: string; error: string; durationMs: number }
  | { kind: 'step_timeout'; name: string; timeoutMs: number }
  | { kind: 'step_skipped'; name: string; reason: 'deadline_exceeded' }
  | { kind: 'deadline_exceeded'; elapsedMs: number }
  | { kind: 'finished'; status: 'clean' | 'degraded'; durationMs: number };

export const DEFAULT_OVERALL_DEADLINE_MS = 30_000;
export const DEFAULT_STEP_TIMEOUT_MS = 5_000;

/**
 * The shutdown orchestrator. Register steps in reverse-dependency
 * order (stop HTTP first → then loops → then flush notifications
 * → then drain asks → then close clients → then release keystore)
 * and call `run()` on SIGTERM.
 */
export class ShutdownCoordinator {
  private readonly steps: ShutdownStep[] = [];
  private readonly overallDeadlineMs: number;
  private readonly defaultStepTimeoutMs: number;
  private readonly nowMsFn: () => number;
  private readonly setTimerFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimerFn: (handle: unknown) => void;
  private readonly onEvent?: (event: ShutdownEvent) => void;
  private hasRun = false;

  constructor(opts: ShutdownCoordinatorOptions = {}) {
    this.overallDeadlineMs = opts.overallDeadlineMs ?? DEFAULT_OVERALL_DEADLINE_MS;
    this.defaultStepTimeoutMs = opts.defaultStepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    this.setTimerFn =
      opts.setTimerFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimerFn =
      opts.clearTimerFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onEvent = opts.onEvent;
  }

  /**
   * Register a step. Order of registration is the order of
   * execution. Throws on duplicate name or after `run()`.
   */
  register(step: ShutdownStep): void {
    if (this.hasRun) {
      throw new Error('ShutdownCoordinator: cannot register after run()');
    }
    if (!step || typeof step !== 'object') {
      throw new TypeError('ShutdownCoordinator: step required');
    }
    if (typeof step.name !== 'string' || step.name === '') {
      throw new TypeError('ShutdownCoordinator: step.name required');
    }
    if (typeof step.close !== 'function') {
      throw new TypeError('ShutdownCoordinator: step.close required');
    }
    if (this.steps.some((s) => s.name === step.name)) {
      throw new Error(`ShutdownCoordinator: step "${step.name}" already registered`);
    }
    this.steps.push(step);
  }

  /** Count of registered steps. */
  size(): number {
    return this.steps.length;
  }

  /**
   * Run the shutdown. Executes every step in order, respecting
   * per-step + overall deadlines. Returns a structured report.
   * Throws if called twice.
   */
  async run(): Promise<ShutdownReport> {
    if (this.hasRun) {
      throw new Error('ShutdownCoordinator: run() already called');
    }
    this.hasRun = true;
    const startedAtMs = this.nowMsFn();
    this.onEvent?.({ kind: 'started', stepCount: this.steps.length });

    const results: StepResult[] = [];
    let deadlineExceeded = false;

    for (const step of this.steps) {
      const elapsed = this.nowMsFn() - startedAtMs;
      if (elapsed >= this.overallDeadlineMs) {
        // Out of budget — mark remaining steps as skipped.
        deadlineExceeded = true;
        this.onEvent?.({
          kind: 'deadline_exceeded',
          elapsedMs: elapsed,
        });
        this.onEvent?.({
          kind: 'step_skipped',
          name: step.name,
          reason: 'deadline_exceeded',
        });
        results.push({
          name: step.name,
          status: 'skipped',
          durationMs: 0,
          error: 'overall deadline exceeded before step started',
        });
        continue;
      }

      // Per-step timeout is min(step.timeoutMs, remaining overall budget).
      const remaining = this.overallDeadlineMs - elapsed;
      const stepTimeoutMs = Math.max(
        1,
        Math.min(step.timeoutMs ?? this.defaultStepTimeoutMs, remaining),
      );
      const stepStart = this.nowMsFn();
      this.onEvent?.({ kind: 'step_started', name: step.name });
      const outcome = await this.runStep(step, stepTimeoutMs);
      const durationMs = this.nowMsFn() - stepStart;
      if (outcome.kind === 'ok') {
        results.push({ name: step.name, status: 'ok', durationMs, error: null });
        this.onEvent?.({ kind: 'step_ok', name: step.name, durationMs });
      } else if (outcome.kind === 'timeout') {
        results.push({
          name: step.name,
          status: 'timeout',
          durationMs,
          error: `timed out after ${stepTimeoutMs}ms`,
        });
        this.onEvent?.({
          kind: 'step_timeout',
          name: step.name,
          timeoutMs: stepTimeoutMs,
        });
      } else {
        results.push({
          name: step.name,
          status: 'failed',
          durationMs,
          error: outcome.error,
        });
        this.onEvent?.({
          kind: 'step_failed',
          name: step.name,
          error: outcome.error,
          durationMs,
        });
      }
    }

    const durationMs = this.nowMsFn() - startedAtMs;
    const status: ShutdownReport['status'] = results.every((r) => r.status === 'ok')
      ? 'clean'
      : 'degraded';
    this.onEvent?.({ kind: 'finished', status, durationMs });
    return {
      status,
      startedAtMs,
      durationMs,
      steps: results,
      deadlineExceeded,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────

  private async runStep(
    step: ShutdownStep,
    timeoutMs: number,
  ): Promise<{ kind: 'ok' } | { kind: 'timeout' } | { kind: 'failed'; error: string }> {
    let timerHandle: unknown = null;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timerHandle = this.setTimerFn(() => resolve('timeout'), timeoutMs);
    });
    try {
      const raceResult = await Promise.race([
        step.close().then(() => ({ kind: 'ok' as const })),
        timeoutPromise.then(() => ({ kind: 'timeout' as const })),
      ]);
      return raceResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: 'failed', error: msg };
    } finally {
      if (timerHandle !== null) this.clearTimerFn(timerHandle);
    }
  }
}
