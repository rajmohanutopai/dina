/**
 * Approval-task reconciliation loop — BRAIN-P2-V.
 *
 * Finds `approval` tasks whose `expires_at` has passed, sends an
 * `unavailable` D2D response to the requester, then fails the task so
 * Brain + Core agree that it's done.
 *
 * Runs:
 *   - Immediately on `start()` (picks up any tasks queued while Brain was
 *     offline).
 *   - Every 5 minutes (configurable).
 *
 * Ordering: oldest-first so bursty expiry can't starve long-running tasks.
 *
 * Source: brain/src/main.py (reconcile_approvals loop, commit 9c01611).
 */

import type { CoreClient, WorkflowTask } from '@dina/core';

/**
 * The 3-method slice of `CoreClient` the reconciler actually uses.
 * Kept narrow so future CoreClient additions don't widen this contract.
 */
export type ApprovalReconcilerCoreClient = Pick<
  CoreClient,
  'listWorkflowTasks' | 'sendServiceRespond' | 'failWorkflowTask'
>;

/** Options for `ApprovalReconciler`. */
export interface ApprovalReconcilerOptions {
  coreClient: ApprovalReconcilerCoreClient;
  /**
   * How often the loop runs. Default `300_000` (5 minutes) — matches the
   * Python reference. Tests pass smaller values.
   */
  intervalMs?: number;
  /**
   * Maximum tasks processed per tick. Default 100. A hard cap prevents a
   * backlog from monopolising the loop.
   */
  batchSize?: number;
  /** Wall-clock source, ms. Default `Date.now`. */
  nowMsFn?: () => number;
  /**
   * Called with each expired task after its response has been sent. Useful
   * for metrics + logging.
   */
  onExpired?: (task: WorkflowTask, outcome: 'sent' | 'send_failed' | 'fail_failed') => void;
  /** Called on unexpected loop errors. Defaults to silent. */
  onError?: (err: unknown) => void;
  /**
   * Injectable setInterval/clearInterval pair. Node / browsers both
   * support the built-ins — tests override with deterministic fakes.
   */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_BATCH_SIZE = 100;

/**
 * A single reconciliation tick's outcome. Useful for tests + diagnostics.
 */
export interface ReconciliationTickResult {
  discovered: number;
  sent: number;
  sendFailed: number;
  failFailed: number;
  errors: unknown[];
}

export class ApprovalReconciler {
  private readonly core: ApprovalReconcilerCoreClient;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly nowMsFn: () => number;
  private readonly onExpired: (t: WorkflowTask, o: 'sent' | 'send_failed' | 'fail_failed') => void;
  private readonly onError: (err: unknown) => void;
  private readonly setIntervalFn: NonNullable<ApprovalReconcilerOptions['setInterval']>;
  private readonly clearIntervalFn: NonNullable<ApprovalReconcilerOptions['clearInterval']>;

  private handle: unknown | null = null;
  /**
   * Monotonic tick counter — used only by the batchSize=1 path to
   * alternate between `pending_approval` and `queued` sweeps so a
   * single tick never exceeds the caller's budget (review #17).
   */
  private tickCount = 0;
  /** Promise for the in-flight tick, if any — used for deterministic `flush()`. */
  private tickInFlight: Promise<ReconciliationTickResult> | null = null;

  constructor(options: ApprovalReconcilerOptions) {
    if (!options.coreClient) {
      throw new Error('ApprovalReconciler: coreClient is required');
    }
    this.core = options.coreClient;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.nowMsFn = options.nowMsFn ?? Date.now;
    this.onExpired =
      options.onExpired ??
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
    if (this.intervalMs <= 0) {
      throw new Error(`ApprovalReconciler: intervalMs must be > 0 (got ${this.intervalMs})`);
    }
    if (this.batchSize <= 0) {
      throw new Error(`ApprovalReconciler: batchSize must be > 0 (got ${this.batchSize})`);
    }
  }

  /**
   * Start the loop. Fires one tick immediately, then schedules subsequent
   * ticks every `intervalMs`. Idempotent — calling while already started
   * is a no-op (doesn't spawn a second interval).
   */
  start(): void {
    if (this.handle !== null) return;
    // Kick off an immediate tick. Swallow the promise — `flush()` can be
    // awaited by tests / shutdown code if they need determinism.
    this.tickInFlight = this.runTick();
    this.handle = this.setIntervalFn(() => {
      this.tickInFlight = this.runTick();
    }, this.intervalMs);
    // `setInterval` in Node returns a `Timeout` with `.unref()`. Don't
    // keep the event loop alive just for this sweeper — production code
    // runs inside a long-lived server which holds the loop open anyway.
    const maybeTimeout = this.handle as { unref?: () => void };
    if (typeof maybeTimeout.unref === 'function') {
      maybeTimeout.unref();
    }
  }

  /** Stop the loop. Idempotent. In-flight tick runs to completion. */
  stop(): void {
    if (this.handle === null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  /**
   * Await the currently-in-flight tick (or the next one if any). Useful
   * in tests + at shutdown. Does NOT start the loop.
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
        // No new tick was scheduled during our await.
        this.tickInFlight = null;
        return;
      }
    }
  }

  /**
   * Run a single reconciliation pass. Exposed so tests can exercise the
   * logic without starting the loop and so operators can trigger a manual
   * sweep from a debug endpoint.
   */
  async runTick(): Promise<ReconciliationTickResult> {
    const result: ReconciliationTickResult = {
      discovered: 0,
      sent: 0,
      sendFailed: 0,
      failFailed: 0,
      errors: [],
    };
    // Scan both `pending_approval` (operator never approved) AND
    // `queued` (operator approved but delegation never ran). Split
    // the per-tick batch budget evenly across the two list calls so
    // a single tick still processes at most `batchSize` tasks total
    // (issue #20 — previously each call used the full budget,
    // doubling the per-tick work under load).
    let tasks: WorkflowTask[];
    try {
      // Review #17: split evenly but NEVER exceed the caller's
      // per-tick budget. Previously `Math.max(1, ...)` on both halves
      // meant batchSize=1 produced {half:1, remaining:1} = 2 tasks
      // per tick — double the advertised budget. The fix: when
      // batchSize=1 route the whole budget to one state per tick
      // (alternating via `tickCount`) so the sum never overshoots.
      let half: number;
      let remaining: number;
      if (this.batchSize <= 1) {
        // Alternate between pending_approval and queued on each tick
        // so both states get swept over time, but never more than
        // one task per tick.
        const which = this.tickCount % 2;
        half = which === 0 ? 1 : 0;
        remaining = which === 0 ? 0 : 1;
      } else {
        half = Math.floor(this.batchSize / 2);
        remaining = this.batchSize - half;
      }
      this.tickCount++;
      const pending =
        half > 0
          ? await this.core.listWorkflowTasks({
              kind: 'approval',
              state: 'pending_approval',
              limit: half,
            })
          : [];
      const queued =
        remaining > 0
          ? await this.core.listWorkflowTasks({
              kind: 'approval',
              state: 'queued',
              limit: remaining,
            })
          : [];
      tasks = [...pending, ...queued];
    } catch (err) {
      result.errors.push(err);
      this.onError(err);
      return result;
    }
    if (tasks.length === 0) return result;

    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const expired = tasks
      .filter((t) => t.expires_at !== undefined && t.expires_at <= nowSec)
      // Oldest-first — prevents starvation when bursts land.
      .sort((a, b) => (a.expires_at ?? 0) - (b.expires_at ?? 0));
    result.discovered = expired.length;

    for (const task of expired) {
      await this.processOne(task, result);
    }
    return result;
  }

  /**
   * Per-task reconciliation: send `unavailable`. When the send
   * succeeds, `/v1/service/respond` has already marked the task
   * `completed` on our behalf — calling failWorkflowTask after that
   * would be a double-terminate attempt on an already-terminal task
   * (returns 409). We only fall through to `failWorkflowTask` when
   * the send itself failed, so the task doesn't stay stuck in
   * `pending_approval`/`queued` forever. Issue #13.
   */
  private async processOne(task: WorkflowTask, out: ReconciliationTickResult): Promise<void> {
    try {
      await this.core.sendServiceRespond(task.id, {
        status: 'unavailable',
        error: 'approval_expired',
      });
      out.sent += 1;
      this.onExpired(task, 'sent');
      // Success path: /v1/service/respond already completed the task.
      // Do NOT call failWorkflowTask — it would 409.
      return;
    } catch (err) {
      out.sendFailed += 1;
      out.errors.push(err);
      this.onError(err);
      this.onExpired(task, 'send_failed');
    }

    // Send failed — fall back to an explicit fail so the task
    // doesn't sit stuck. Best-effort; isolate any error from fail too.
    try {
      await this.core.failWorkflowTask(task.id, 'approval_expired');
    } catch (err) {
      out.failFailed += 1;
      out.errors.push(err);
      this.onError(err);
      this.onExpired(task, 'fail_failed');
    }
  }
}
