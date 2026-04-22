/**
 * Task-expiry sweeper — calls `WorkflowRepository.expireTasks` on a
 * periodic cadence. Covers the missing requester-side TTL enforcement
 * (issue #9). Without this sweeper running, service_query tasks whose
 * TTL elapses stay stuck in `created` / `running` forever: the requester
 * sees neither a response nor a timeout.
 *
 * Mirrors the shape of `LeaseExpirySweeper` — injectable clock +
 * scheduler, best-effort observer hooks, idempotent start/stop.
 *
 * Runs inside Core alongside the repository. `createNode.start()`
 * starts one by default so every bootstrapped node has live TTL
 * enforcement on both the requester and provider sides.
 */

import type { WorkflowTask } from './domain';
import type { WorkflowRepository } from './repository';

export interface TaskExpirySweeperOptions {
  repository: WorkflowRepository;
  /** How often the sweeper runs. Default `30_000` ms. */
  intervalMs?: number;
  /** Wall-clock source (ms). Default `Date.now`. */
  nowMsFn?: () => number;
  /**
   * Per-tick hook fired once per expired task. Useful for metrics +
   * audit logging. Observer errors never break the loop.
   */
  onExpired?: (task: WorkflowTask) => void;
  /** Called when a tick throws unexpectedly (repository error). Silent by default. */
  onError?: (err: unknown) => void;
  /** Injectable timer pair. Node + browsers + RN all provide the built-ins. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 30_000;

export interface TaskExpirySweepResult {
  expired: WorkflowTask[];
  errors: unknown[];
}

export class TaskExpirySweeper {
  private readonly repo: WorkflowRepository;
  private readonly intervalMs: number;
  private readonly nowMsFn: () => number;
  private readonly onExpired: (t: WorkflowTask) => void;
  private readonly onError: (err: unknown) => void;
  private readonly setIntervalFn: NonNullable<TaskExpirySweeperOptions['setInterval']>;
  private readonly clearIntervalFn: NonNullable<TaskExpirySweeperOptions['clearInterval']>;

  private handle: unknown | null = null;
  private tickInFlight: Promise<TaskExpirySweepResult> | null = null;

  constructor(options: TaskExpirySweeperOptions) {
    if (!options.repository) {
      throw new Error('TaskExpirySweeper: repository is required');
    }
    this.repo = options.repository;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (this.intervalMs <= 0) {
      throw new Error(`TaskExpirySweeper: intervalMs must be > 0 (got ${this.intervalMs})`);
    }
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
  }

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

  stop(): void {
    if (this.handle === null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

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

  async runTick(): Promise<TaskExpirySweepResult> {
    const result: TaskExpirySweepResult = { expired: [], errors: [] };
    let expired: WorkflowTask[];
    try {
      const nowMs = this.nowMsFn();
      const nowSec = Math.floor(nowMs / 1000);
      expired = this.repo.expireTasks(nowSec, nowMs);
    } catch (err) {
      result.errors.push(err);
      this.onError(err);
      return result;
    }
    result.expired = expired;
    for (const task of expired) {
      try {
        this.onExpired(task);
      } catch (err) {
        result.errors.push(err);
        this.onError(err);
      }
    }
    return result;
  }
}
