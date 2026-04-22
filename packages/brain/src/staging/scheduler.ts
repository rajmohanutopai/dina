/**
 * Staging drain scheduler (GAP-RT-01 bootstrap-layer).
 *
 * Mirrors the shape of `core/workflow/BridgePendingSweeper`: injectable
 * timer pair, idempotent `start()` / `stop()`, single-tick-in-flight
 * tracker for deterministic `flush()` in tests, best-effort observer
 * hooks. The scheduler drives `runStagingDrainTick` on a cadence; the
 * function itself has no timer awareness.
 *
 * Why a class instead of a bare `setInterval` in bootstrap? Three
 * reasons:
 *   - Lifecycle parity with the other sweepers (`TaskExpirySweeper`,
 *     `LeaseExpirySweeper`, `BridgePendingSweeper`).
 *   - Deterministic test flush via `flush()` — timer tests were
 *     painful before this pattern landed for the bridge sweeper.
 *   - One place to attach `onTick` / `onError` hooks; the bootstrap
 *     just wires telemetry.
 */

import {
  runStagingDrainTick,
  type StagingDrainCoreClient,
  type StagingDrainOptions,
  type StagingDrainTickResult,
} from './drain';

export interface StagingDrainSchedulerOptions {
  core: StagingDrainCoreClient;
  /** Per-tick options forwarded into `runStagingDrainTick`. */
  drain?: Omit<StagingDrainOptions, 'logger'>;
  /** How often the scheduler runs. Default `10_000` ms. */
  intervalMs?: number;
  /**
   * Per-tick observer. Receives the tick result. Useful for metrics /
   * backpressure decisions. Errors thrown here are swallowed so the
   * loop survives a bad observer.
   */
  onTick?: (result: StagingDrainTickResult) => void;
  /** Structured logger forwarded into the drain and used for ticks. */
  logger?: (entry: Record<string, unknown>) => void;
  /** Called when a tick throws unexpectedly. Silent by default. */
  onError?: (err: unknown) => void;
  /** Injectable timer pair. Node + browsers + RN all provide the built-ins. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 10_000;

export class StagingDrainScheduler {
  private readonly core: StagingDrainCoreClient;
  private readonly drainOpts: Omit<StagingDrainOptions, 'logger'>;
  private readonly intervalMs: number;
  private readonly onTick: (r: StagingDrainTickResult) => void;
  private readonly onError: (err: unknown) => void;
  private readonly log: (entry: Record<string, unknown>) => void;
  private readonly setIntervalFn: NonNullable<StagingDrainSchedulerOptions['setInterval']>;
  private readonly clearIntervalFn: NonNullable<StagingDrainSchedulerOptions['clearInterval']>;

  private handle: unknown | null = null;
  private tickInFlight: Promise<StagingDrainTickResult> | null = null;

  constructor(options: StagingDrainSchedulerOptions) {
    if (!options.core) {
      throw new Error('StagingDrainScheduler: core is required');
    }
    this.core = options.core;
    this.drainOpts = options.drain ?? {};
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (this.intervalMs <= 0) {
      throw new Error(`StagingDrainScheduler: intervalMs must be > 0 (got ${this.intervalMs})`);
    }
    this.onTick =
      options.onTick ??
      ((): void => {
        /* silenced */
      });
    this.onError =
      options.onError ??
      ((): void => {
        /* silenced */
      });
    this.log =
      options.logger ??
      ((): void => {
        /* no-op */
      });
    this.setIntervalFn =
      options.setInterval ?? ((fn, ms): ReturnType<typeof setInterval> => setInterval(fn, ms));
    this.clearIntervalFn =
      options.clearInterval ?? ((h): void => clearInterval(h as ReturnType<typeof setInterval>));
  }

  start(): void {
    if (this.handle !== null) return;
    this.tickInFlight = this.runTick();
    this.handle = this.setIntervalFn(() => {
      this.tickInFlight = this.runTick();
    }, this.intervalMs);
    // Don't hold the Node process open for tests / CI.
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

  async runTick(): Promise<StagingDrainTickResult> {
    // Coalesce concurrent callers (scheduled timer + manual `flush`)
    // onto the same in-flight tick so observers fire once per batch.
    if (this.tickInFlight !== null) {
      return this.tickInFlight;
    }
    const tick = (async (): Promise<StagingDrainTickResult> => {
      let result: StagingDrainTickResult = { claimed: 0, stored: 0, failed: 0, results: [] };
      try {
        result = await runStagingDrainTick(this.core, {
          ...this.drainOpts,
          logger: this.log,
        });
      } catch (err) {
        this.onError(err);
        this.log({
          event: 'staging.drain.tick_failed',
          error: err instanceof Error ? err.message : String(err),
        });
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
