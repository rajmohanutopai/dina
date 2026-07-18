/**
 * WatchPollSweeper (PSVC-0) — the poll-mode fire loop
 * (PUSH_SERVICES_ARCHITECTURE.md Phase 0 / §3.2; DINA_WORKFLOW_CONTROL_PLANE §6).
 *
 * On each tick it finds every `kind='watch'`, `state='running'` task whose
 * `next_run_at` (SECONDS) is due, fires it through the injected `onPoll`
 * callback (which composes + sends the ordinary `service.query` — Core never
 * calls out itself, exactly like `TaskExpirySweeper.onExpired`), then reschedules
 * `next_run_at = now + poll_interval_sec`. Rescheduling on `now` (not
 * `oldNextRunAt + interval`) means a device that was asleep past several
 * intervals fires ONCE on wake, not a backlog burst (§6 "conservative poll
 * intervals"). Paused watches (`next_run_at` null) and cancelled watches
 * (state ≠ running) are never fired.
 *
 * Best-effort and self-healing: a malformed payload or an `onPoll` throw is
 * isolated via `onError` and the watch is STILL rescheduled, so one bad poll
 * never wedges the loop. Mirrors `TaskExpirySweeper` (injectable clock +
 * scheduler, idempotent start/stop, `flush`).
 */

import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../workflow/domain';

import { parseWatchPollPayload, type WatchPollPayload } from './payload';

import type { WorkflowRepository } from '../workflow/repository';


/** Composes + sends the `service.query` for a due watch. Wired by the platform
 *  (Brain/transport) — the sweeper only invokes it. May be async. */
export type WatchPollHandler = (task: WorkflowTask, payload: WatchPollPayload) => void | Promise<void>;

export interface WatchPollSweeperOptions {
  repository: WorkflowRepository;
  /** Composes + sends the poll query. Default is a silent no-op (dev/test). */
  onPoll?: WatchPollHandler;
  /** How often the sweeper runs. Default `30_000` ms. */
  intervalMs?: number;
  /** Max watches examined per tick. Default `200`. */
  batchLimit?: number;
  /** Wall-clock source (ms). Default `Date.now`. */
  nowMsFn?: () => number;
  /** Fired when a watch's payload is malformed and it is skipped. */
  onMalformed?: (task: WorkflowTask) => void;
  /** Fired on an unexpected error (repository / onPoll throw). Silent by default. */
  onError?: (err: unknown) => void;
  /** Injectable timer pair. Node + browsers + RN all provide the built-ins. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface WatchPollSweepResult {
  /** Watches fired this tick. */
  polled: WorkflowTask[];
  /** Malformed-payload watches skipped this tick. */
  skipped: WorkflowTask[];
  errors: unknown[];
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_LIMIT = 200;

export class WatchPollSweeper {
  private readonly repo: WorkflowRepository;
  private readonly onPoll: WatchPollHandler;
  private readonly intervalMs: number;
  private readonly batchLimit: number;
  private readonly nowMsFn: () => number;
  private readonly onMalformed: (t: WorkflowTask) => void;
  private readonly onError: (err: unknown) => void;
  private readonly setIntervalFn: NonNullable<WatchPollSweeperOptions['setInterval']>;
  private readonly clearIntervalFn: NonNullable<WatchPollSweeperOptions['clearInterval']>;

  private handle: unknown | null = null;
  private tickInFlight: Promise<WatchPollSweepResult> | null = null;

  constructor(options: WatchPollSweeperOptions) {
    if (!options.repository) throw new Error('WatchPollSweeper: repository is required');
    this.repo = options.repository;
    this.onPoll =
      options.onPoll ??
      (() => {
        /* silenced */
      });
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (this.intervalMs <= 0) {
      throw new Error(`WatchPollSweeper: intervalMs must be > 0 (got ${this.intervalMs})`);
    }
    this.batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
    this.nowMsFn = options.nowMsFn ?? Date.now;
    this.onMalformed =
      options.onMalformed ??
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
    if (typeof maybeTimeout.unref === 'function') maybeTimeout.unref();
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

  async runTick(): Promise<WatchPollSweepResult> {
    const result: WatchPollSweepResult = { polled: [], skipped: [], errors: [] };
    const nowMs = this.nowMsFn();
    const nowSec = Math.floor(nowMs / 1000);

    let running: WorkflowTask[];
    try {
      running = this.repo.listByKindAndState(
        WorkflowTaskKind.Watch,
        WorkflowTaskState.Running,
        this.batchLimit,
      );
    } catch (err) {
      result.errors.push(err);
      this.onError(err);
      return result;
    }

    for (const task of running) {
      // A null/0/unset next_run_at is a PAUSE (never due); the future ones are
      // not yet due. Only fire watches at or past their cadence.
      const nextRun = task.next_run_at;
      if (nextRun === undefined || nextRun === 0 || nextRun > nowSec) continue;

      const payload = parseWatchPollPayload(task.payload);
      if (payload === null) {
        result.skipped.push(task);
        try {
          this.onMalformed(task);
        } catch (err) {
          result.errors.push(err);
          this.onError(err);
        }
        continue;
      }

      try {
        await this.onPoll(task, payload);
        result.polled.push(task);
      } catch (err) {
        result.errors.push(err);
        this.onError(err);
      }
      // Reschedule regardless of the poll outcome (a transient send failure just
      // retries next interval; never wedge the watch).
      try {
        this.repo.setWatchNextRun(task.id, nowSec + payload.poll_interval_sec, nowMs);
      } catch (err) {
        result.errors.push(err);
        this.onError(err);
      }
    }
    return result;
  }
}
