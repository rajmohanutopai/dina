/**
 * Staging loop — composition primitive over `staging_processor`.
 *
 * `processStagingInput` is the pure decision half. This module is
 * the IO orchestrator:
 *
 *   while running:
 *     task = claimFn()                 # Core `/v1/staging/claim`
 *     if task is null: sleep + continue
 *     decision = processStagingInput(task, options)
 *     if accept: storeFn(decision) → resolveFn(task.id)
 *     if reject: failFn(task.id, reason)
 *     if review: enqueueReviewFn(decision) → resolveFn(task.id)
 *
 * **IO shape** — every Core side-effect is an injected async function
 * so the loop is 100% testable without a running Core:
 *
 *   - `claimFn() → Promise<PendingStagingTask | null>` — leases one.
 *   - `storeFn(decision) → Promise<{ ok, vaultItemId? }>` — persists accept.
 *   - `enqueueReviewFn(decision) → Promise<{ ok, reviewId? }>` — puts review task
 *     on the operator queue.
 *   - `resolveFn(taskId, outcome) → Promise<void>` — marks the staging task
 *     complete.
 *   - `failFn(taskId, reason) → Promise<void>` — marks failed.
 *
 * **Why a loop, not one-shot**: Brain's staging-task queue is
 * asynchronous. The loop runs continuously on the background supervisor
 * (task 5.56 `BrainLoopRegistry`). A single `tick()` method does one
 * complete claim→decide→act cycle so tests can step through deterministically.
 *
 * **Error isolation per tick**: a transient Core failure on store /
 * resolve doesn't crash the loop — the tick returns `{kind: 'io_error'}`
 * and the supervisor's retry policy handles backoff. The claim itself
 * failing is handled the same way.
 *
 * **Cancellation**: `run({signal})` watches an AbortSignal; each tick
 * checks the flag before making the next call. `stop()` flips an
 * internal flag the loop honours at the same boundary.
 *
 * **Never throws** from `tick()` — all failure modes are tagged.
 */

import {
  processStagingInput,
  type StagingDecision,
  type StagingInput,
  type StagingOptions,
} from './staging_processor';

/** Lease record returned by `claimFn`. Mirrors `/v1/staging/claim` shape. */
export interface PendingStagingTask {
  /** Staging task id — echoed back on resolve / fail. */
  taskId: string;
  /** The input the processor will consume. */
  input: StagingInput;
  /** Lease expiry (unix ms). The supervisor may extend. */
  leaseExpiresMs?: number;
}

export interface StagingLoopIO {
  claimFn: () => Promise<PendingStagingTask | null>;
  storeFn: (decision: StagingDecision) => Promise<{ ok: boolean; vaultItemId?: string; error?: string }>;
  enqueueReviewFn: (decision: StagingDecision) => Promise<{ ok: boolean; reviewId?: string; error?: string }>;
  resolveFn: (taskId: string, outcome: 'accepted' | 'reviewed' | 'rejected') => Promise<void>;
  failFn: (taskId: string, reason: string) => Promise<void>;
}

export type TickResult =
  | { kind: 'idle' }
  | { kind: 'accepted'; taskId: string; vaultItemId: string | null; decision: StagingDecision }
  | { kind: 'reviewed'; taskId: string; reviewId: string | null; decision: StagingDecision }
  | { kind: 'rejected'; taskId: string; reason: string; decision: StagingDecision }
  | { kind: 'io_error'; stage: 'claim' | 'store' | 'review' | 'resolve' | 'fail'; error: string; taskId?: string };

export type StagingLoopEvent =
  | { kind: 'tick_started' }
  | { kind: 'tick_completed'; result: TickResult }
  | { kind: 'loop_started' }
  | { kind: 'loop_stopped'; reason: 'manual' | 'aborted' };

export interface StagingLoopOptions {
  io: StagingLoopIO;
  /** Decision options passed through to `processStagingInput`. */
  decisionOptions?: StagingOptions;
  /** Diagnostic hook. */
  onEvent?: (event: StagingLoopEvent) => void;
  /** Sleep ms between idle ticks (no task claimed). Default 500. */
  idleSleepMs?: number;
  /** Injectable sleeper (for tests). Defaults to real setTimeout. */
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const DEFAULT_IDLE_SLEEP_MS = 500;

export class StagingLoop {
  private readonly io: StagingLoopIO;
  private readonly decisionOptions: StagingOptions;
  private readonly onEvent?: (event: StagingLoopEvent) => void;
  private readonly idleSleepMs: number;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private running = false;

  constructor(opts: StagingLoopOptions) {
    validateIO(opts?.io);
    this.io = opts.io;
    this.decisionOptions = opts.decisionOptions ?? {};
    this.onEvent = opts.onEvent;
    this.idleSleepMs = opts.idleSleepMs ?? DEFAULT_IDLE_SLEEP_MS;
    this.sleepFn = opts.sleepFn ?? defaultSleep;
    if (!Number.isFinite(this.idleSleepMs) || this.idleSleepMs < 0) {
      throw new RangeError('idleSleepMs must be non-negative finite');
    }
  }

  /** Run one complete claim → decide → act cycle. Never throws. */
  async tick(): Promise<TickResult> {
    this.onEvent?.({ kind: 'tick_started' });
    let task: PendingStagingTask | null;
    try {
      task = await this.io.claimFn();
    } catch (err) {
      const result: TickResult = {
        kind: 'io_error',
        stage: 'claim',
        error: extractMessage(err),
      };
      this.onEvent?.({ kind: 'tick_completed', result });
      return result;
    }
    if (task === null) {
      const result: TickResult = { kind: 'idle' };
      this.onEvent?.({ kind: 'tick_completed', result });
      return result;
    }

    const decision = processStagingInput(task.input, this.decisionOptions);

    if (decision.disposition === 'reject') {
      // Reject: fail the task with the decision's reason.
      try {
        await this.io.failFn(task.taskId, decision.reason);
      } catch (err) {
        const result: TickResult = {
          kind: 'io_error',
          stage: 'fail',
          error: extractMessage(err),
          taskId: task.taskId,
        };
        this.onEvent?.({ kind: 'tick_completed', result });
        return result;
      }
      const result: TickResult = {
        kind: 'rejected',
        taskId: task.taskId,
        reason: decision.reason,
        decision,
      };
      this.onEvent?.({ kind: 'tick_completed', result });
      return result;
    }

    if (decision.disposition === 'review') {
      // Review: enqueue + resolve staging as reviewed.
      let reviewId: string | null = null;
      try {
        const review = await this.io.enqueueReviewFn(decision);
        if (!review.ok) {
          return await this.ioErrorDuringResolve('review', review.error ?? 'enqueue failed', task.taskId);
        }
        reviewId = review.reviewId ?? null;
      } catch (err) {
        return await this.ioErrorDuringResolve('review', extractMessage(err), task.taskId);
      }
      try {
        await this.io.resolveFn(task.taskId, 'reviewed');
      } catch (err) {
        const result: TickResult = {
          kind: 'io_error',
          stage: 'resolve',
          error: extractMessage(err),
          taskId: task.taskId,
        };
        this.onEvent?.({ kind: 'tick_completed', result });
        return result;
      }
      const result: TickResult = {
        kind: 'reviewed',
        taskId: task.taskId,
        reviewId,
        decision,
      };
      this.onEvent?.({ kind: 'tick_completed', result });
      return result;
    }

    // Accept
    let vaultItemId: string | null = null;
    try {
      const store = await this.io.storeFn(decision);
      if (!store.ok) {
        return await this.ioErrorDuringResolve('store', store.error ?? 'store failed', task.taskId);
      }
      vaultItemId = store.vaultItemId ?? null;
    } catch (err) {
      return await this.ioErrorDuringResolve('store', extractMessage(err), task.taskId);
    }
    try {
      await this.io.resolveFn(task.taskId, 'accepted');
    } catch (err) {
      const result: TickResult = {
        kind: 'io_error',
        stage: 'resolve',
        error: extractMessage(err),
        taskId: task.taskId,
      };
      this.onEvent?.({ kind: 'tick_completed', result });
      return result;
    }
    const result: TickResult = {
      kind: 'accepted',
      taskId: task.taskId,
      vaultItemId,
      decision,
    };
    this.onEvent?.({ kind: 'tick_completed', result });
    return result;
  }

  /**
   * Run the loop until `stop()` or the supplied `AbortSignal` fires.
   * Sleeps `idleSleepMs` between idle ticks to avoid a hot loop.
   */
  async run(opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.running) throw new Error('StagingLoop.run: already running');
    this.running = true;
    this.onEvent?.({ kind: 'loop_started' });
    const signal = opts.signal;
    try {
      while (this.running) {
        if (signal?.aborted) break;
        const result = await this.tick();
        if (!this.running) break;
        if (signal?.aborted) break;
        if (result.kind === 'idle' || result.kind === 'io_error') {
          await this.sleepFn(this.idleSleepMs, signal);
        }
      }
    } finally {
      const reason: 'manual' | 'aborted' = signal?.aborted ? 'aborted' : 'manual';
      this.running = false;
      this.onEvent?.({ kind: 'loop_stopped', reason });
    }
  }

  /** Request the loop to exit at the next safe boundary. */
  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Internals ────────────────────────────────────────────────────────

  private async ioErrorDuringResolve(
    stage: 'store' | 'review',
    error: string,
    taskId: string,
  ): Promise<TickResult> {
    // Best-effort: tell Core the task failed so the lease doesn't
    // linger. Ignore errors from failFn — we've already got a failure.
    try {
      await this.io.failFn(taskId, `${stage}_failed: ${error}`);
    } catch {
      /* swallow — we've reported the original error below */
    }
    const result: TickResult = { kind: 'io_error', stage, error, taskId };
    this.onEvent?.({ kind: 'tick_completed', result });
    return result;
  }
}

// ── Internals ──────────────────────────────────────────────────────────

function validateIO(io: StagingLoopIO | undefined): void {
  if (!io || typeof io !== 'object') {
    throw new TypeError('StagingLoop: io is required');
  }
  for (const key of ['claimFn', 'storeFn', 'enqueueReviewFn', 'resolveFn', 'failFn'] as const) {
    if (typeof io[key] !== 'function') {
      throw new TypeError(`StagingLoop: io.${key} must be a function`);
    }
  }
}

function extractMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    // Unref so a pending idle sleep doesn't keep the process alive.
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
