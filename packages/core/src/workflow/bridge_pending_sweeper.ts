/**
 * Bridge-pending sweeper — periodically retries `service.response`
 * envelopes that failed to send on the first attempt.
 *
 * Main-dina 4848a934 introduced this durability layer: on delegation
 * completion, `WorkflowService.bridgeServiceQueryCompletion` stashes a
 * `bridge_pending:<ctx>` marker in the task's `internal_stash`
 * column BEFORE calling the ResponseBridgeSender. On success the stash
 * is cleared. On failure (transient network, MsgBox reconnecting, etc.)
 * the stash sits until this sweeper fires and retries the send.
 *
 * Without this retry path a single transient D2D failure would leave
 * the requester hanging until TTL with no signal, because the provider
 * task is already terminal.
 *
 * Mirrors the shape of `TaskExpirySweeper` / `LeaseExpirySweeper`:
 * injectable clock + scheduler, best-effort observer hooks, idempotent
 * start/stop, single tick-in-flight tracker for `flush()`.
 */

import type { WorkflowService } from './service';

export interface BridgePendingSweeperOptions {
  service: WorkflowService;
  /** How often the sweeper runs. Default `15_000` ms (twice TaskExpiry cadence
   *  because a stuck bridge is more time-sensitive — the requester is
   *  actively waiting). */
  intervalMs?: number;
  /** Max tasks to retry per tick. Default 50. */
  batchSize?: number;
  /**
   * Per-tick observer: receives the count of stashes cleared (resends
   * that actually delivered) plus any errors surfaced by the retry
   * loop. Useful for metrics / audit. Errors thrown by the observer
   * are swallowed.
   */
  onTick?: (result: { cleared: number; errors: unknown[] }) => void;
  /** Called when a tick throws unexpectedly. Silent by default. */
  onError?: (err: unknown) => void;
  /** Injectable timer pair. Node + browsers + RN all provide the built-ins. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 50;

export interface BridgePendingSweepResult {
  cleared: number;
  errors: unknown[];
}

export class BridgePendingSweeper {
  private readonly service: WorkflowService;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly onTick: (r: BridgePendingSweepResult) => void;
  private readonly onError: (err: unknown) => void;
  private readonly setIntervalFn: NonNullable<BridgePendingSweeperOptions['setInterval']>;
  private readonly clearIntervalFn: NonNullable<BridgePendingSweeperOptions['clearInterval']>;

  private handle: unknown | null = null;
  private tickInFlight: Promise<BridgePendingSweepResult> | null = null;

  constructor(options: BridgePendingSweeperOptions) {
    if (!options.service) {
      throw new Error('BridgePendingSweeper: service is required');
    }
    this.service = options.service;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (this.intervalMs <= 0) {
      throw new Error(`BridgePendingSweeper: intervalMs must be > 0 (got ${this.intervalMs})`);
    }
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (this.batchSize <= 0) {
      throw new Error(`BridgePendingSweeper: batchSize must be > 0 (got ${this.batchSize})`);
    }
    this.onTick =
      options.onTick ??
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
    // Don't hold the Node process open for tests.
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

  async runTick(): Promise<BridgePendingSweepResult> {
    // Review #6: when a tick is already in flight (another caller —
    // scheduled timer, `drainOnce`, etc. — started one that hasn't
    // resolved), return THAT tick's promise instead of firing a
    // second `onTick`. Metrics consumers now see one event per real
    // batch, not one per caller.
    if (this.tickInFlight !== null) {
      return this.tickInFlight;
    }
    const tick = (async () => {
      const result: BridgePendingSweepResult = { cleared: 0, errors: [] };
      try {
        result.cleared = await this.service.retryPendingBridges(this.batchSize);
      } catch (err) {
        result.errors.push(err);
        this.onError(err);
      }
      try {
        this.onTick(result);
      } catch {
        /* observer errors never break the loop */
      }
      return result;
    })();
    this.tickInFlight = tick;
    tick.finally(() => {
      if (this.tickInFlight === tick) this.tickInFlight = null;
    });
    return tick;
  }
}
