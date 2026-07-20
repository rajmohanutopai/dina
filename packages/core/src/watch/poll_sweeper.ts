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

import { type WorkflowTask } from '../workflow/domain';

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
  private stopped = false;

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
    this.stopped = false;
    void this.guardedTick();
    this.handle = this.setIntervalFn(() => {
      void this.guardedTick();
    }, this.intervalMs);
    const maybeTimeout = this.handle as { unref?: () => void };
    if (typeof maybeTimeout.unref === 'function') maybeTimeout.unref();
  }

  /**
   * SINGLE-FLIGHT tick (81B-08). A timer fire that lands while the previous tick's
   * async poll is still unresolved COALESCES onto the in-flight promise instead of
   * launching (and overwriting `tickInFlight` with) a second overlapping iteration.
   * Overlap would both duplicate polls/sends and orphan the older promise from
   * `flush()`. Once stopped, no new tick starts. The finally clears the field only
   * if it still points at this tick, so `flush()` can observe completion.
   */
  private guardedTick(): Promise<WatchPollSweepResult> {
    if (this.tickInFlight !== null) return this.tickInFlight;
    if (this.stopped) return Promise.resolve({ polled: [], skipped: [], errors: [] });
    const p = this.runTick().finally(() => {
      if (this.tickInFlight === p) this.tickInFlight = null;
    });
    this.tickInFlight = p;
    return p;
  }

  stop(): void {
    this.stopped = true;
    if (this.handle === null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  /** Await quiescence of the in-flight tick (call AFTER `stop()` so no new tick
   *  starts). Guarantees no poll/send is still running after teardown. */
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

    let due: WorkflowTask[];
    try {
      // R4-05 — query DUE watches directly (next_run_at set and <= now, ordered
      // by due time). Paused (null) / future rows are excluded by the query, so
      // they can never hide a due watch behind a fixed page. Bounded per tick;
      // most-overdue-first ordering guarantees eventual firing across ticks.
      due = this.repo.listDueWatches(nowSec, this.batchLimit);
    } catch (err) {
      result.errors.push(err);
      this.onError(err);
      return result;
    }

    for (const task of due) {
      // The value this tick fired on — the CAS anchor for rescheduling (R4-04).
      const firedNextRun = task.next_run_at;

      const payload = parseWatchPollPayload(task.payload);
      if (payload === null) {
        result.skipped.push(task);
        // R5-06 — a malformed row is due-ordered at the HEAD of `listDueWatches`
        // and its payload can't self-heal, so leaving next_run_at untouched would
        // re-select it every tick and starve later valid due watches. PAUSE it
        // (clear next_run_at) so it drops out of the due query; `onMalformed`
        // surfaces it to the owner. Best-effort — a failed pause is isolated.
        try {
          this.repo.setWatchNextRun(task.id, null, nowMs);
        } catch (err) {
          result.errors.push(err);
          this.onError(err);
        }
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
      // R4-04 — reschedule via CAS on the value we fired. If a pause set
      // next_run_at=null (or a resume/steer changed it) WHILE this poll was in
      // flight, the CAS misses and we do NOT resurrect the schedule — an
      // in-flight poll can never silently undo the owner's pause. A transient
      // send failure still reschedules (retries next interval; never wedged).
      if (firedNextRun !== undefined) {
        try {
          this.repo.rescheduleWatch(
            task.id,
            firedNextRun,
            nowSec + payload.poll_interval_sec,
            nowMs,
          );
        } catch (err) {
          result.errors.push(err);
          this.onError(err);
        }
      }
    }
    return result;
  }
}
