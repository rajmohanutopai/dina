/**
 * Lease-expiry sweeper — OPENCLAW-002.
 *
 * Periodically reverts `delegation` tasks whose agent lease has expired
 * (the claiming dina-agent died, got disconnected, or dropped its heartbeat)
 * back to `queued`, so the next `POST /v1/workflow/tasks/claim` can pick
 * them up.
 *
 * Runs inside Core alongside the repository — unlike `ApprovalReconciler`
 * (which lives in Brain and talks to Core over HTTP), this sweeper touches
 * the store directly via `WorkflowRepository.expireLeasedTasks`. The repo
 * method handles the atomic `running → queued` transition + event append
 * in a single transaction; this class is only responsible for scheduling.
 *
 * Agent-pull cadence: leases default to 30 s (see `extractLeaseMs` in
 * `server/routes/workflow.ts`), with heartbeats every 5-10 s. The sweeper
 * default of 60 s keeps stuck tasks at most a lease-plus-tick behind —
 * short enough that reclaim feels responsive, long enough to avoid
 * hammering SQLite when the agent fleet is healthy.
 */

import type { WorkflowTask } from './domain';
import type { WorkflowRepository } from './repository';

/** Options for `LeaseExpirySweeper`. */
export interface LeaseExpirySweeperOptions {
  repository: WorkflowRepository;
  /**
   * How often the sweeper runs. Default `60_000` ms. Production should
   * keep this below `2 × max(leaseMs)` so an agent crash surfaces within
   * one sweep cycle.
   */
  intervalMs?: number;
  /** Wall-clock source, ms. Default `Date.now`. */
  nowMsFn?: () => number;
  /**
   * Per-tick hook fired once per reverted task. Useful for metrics +
   * audit logging. Exceptions are swallowed so a faulty observer cannot
   * break the sweeper loop.
   */
  onReverted?: (task: WorkflowTask) => void;
  /**
   * Called when a tick throws unexpectedly (e.g. repository error).
   * Defaults to silent — callers that care wire a logger.
   */
  onError?: (err: unknown) => void;
  /**
   * Injectable `setInterval` / `clearInterval`. Node + browsers provide
   * both built-ins; tests substitute deterministic fakes.
   */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;

/** Observable outcome of a single sweep tick. */
export interface LeaseExpirySweepResult {
  reverted: WorkflowTask[];
  errors: unknown[];
}

export class LeaseExpirySweeper {
  private readonly repo: WorkflowRepository;
  private readonly intervalMs: number;
  private readonly nowMsFn: () => number;
  private readonly onReverted: (t: WorkflowTask) => void;
  private readonly onError: (err: unknown) => void;
  private readonly setIntervalFn: NonNullable<LeaseExpirySweeperOptions['setInterval']>;
  private readonly clearIntervalFn: NonNullable<LeaseExpirySweeperOptions['clearInterval']>;

  private handle: unknown | null = null;
  private tickInFlight: Promise<LeaseExpirySweepResult> | null = null;

  constructor(options: LeaseExpirySweeperOptions) {
    if (!options.repository) {
      throw new Error('LeaseExpirySweeper: repository is required');
    }
    this.repo = options.repository;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (this.intervalMs <= 0) {
      throw new Error(`LeaseExpirySweeper: intervalMs must be > 0 (got ${this.intervalMs})`);
    }
    this.nowMsFn = options.nowMsFn ?? Date.now;
    this.onReverted =
      options.onReverted ??
      (() => {
        /* silenced */
      });
    this.onError =
      options.onError ??
      (() => {
        /* silenced */
      });
    this.setIntervalFn = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn =
      options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  /**
   * Start the sweeper. Fires one tick immediately (so a process that just
   * booted catches leases that expired while it was down), then schedules
   * subsequent ticks every `intervalMs`. Idempotent.
   */
  start(): void {
    if (this.handle !== null) return;
    this.tickInFlight = this.runTick();
    this.handle = this.setIntervalFn(() => {
      this.tickInFlight = this.runTick();
    }, this.intervalMs);
    const maybeTimeout = this.handle as { unref?: () => void };
    if (typeof maybeTimeout.unref === 'function') {
      maybeTimeout.unref();
    }
  }

  /** Stop the sweeper. Idempotent. An in-flight tick runs to completion. */
  stop(): void {
    if (this.handle === null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  /**
   * Await the currently-in-flight tick. Returns once no tick is pending.
   * Useful in tests + at shutdown; does NOT start the loop.
   */
  async flush(): Promise<void> {
    while (this.tickInFlight !== null) {
      const current = this.tickInFlight;
      try {
        await current;
      } catch {
        /* surfaced via onError during the tick */
      }
      if (this.tickInFlight === current) {
        this.tickInFlight = null;
        return;
      }
    }
  }

  /**
   * Run a single sweep. Exposed so tests can drive the sweeper without
   * starting the loop and operators can trigger a manual sweep from a
   * debug endpoint.
   */
  async runTick(): Promise<LeaseExpirySweepResult> {
    const result: LeaseExpirySweepResult = { reverted: [], errors: [] };
    let reverted: WorkflowTask[];
    try {
      reverted = this.repo.expireLeasedTasks(this.nowMsFn());
    } catch (err) {
      result.errors.push(err);
      this.onError(err);
      return result;
    }
    result.reverted = reverted;
    for (const task of reverted) {
      try {
        this.onReverted(task);
      } catch (err) {
        // Never let an observer break the sweeper loop.
        result.errors.push(err);
        this.onError(err);
      }
    }
    return result;
  }
}
