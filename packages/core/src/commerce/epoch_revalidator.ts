/**
 * §16.2's bounded-interval epoch re-verification, on a tick.
 *
 * `CommerceEpochService.revalidate()` decides whether this node may go on
 * signing at the epoch it cached at boot. Something has to ask it. Without a
 * tick the method is a capability nobody exercises, and the spec sentence it
 * implements — "Signing nodes also re-verify the live epoch on a bounded
 * interval, so a forgotten pre-restore node converges" — describes nothing
 * that happens.
 *
 * WHY IT RESOLVES THE SERVICE PER TICK. The epoch service is installed only
 * once publication succeeds, and it is torn down on identity change; a
 * revalidator that captured one at wiring time would either be unbuildable on
 * a node whose repo was unreachable at boot or would keep re-reading a
 * service the node has stopped using. Reading it per tick makes "commerce is
 * not established here" an ordinary quiet tick.
 *
 * WHY TICKS DO NOT OVERLAP. The read is network-bound and the interval is
 * not: a repo that takes longer to answer than the tick period would stack
 * requests against exactly the repo that is already struggling. One in
 * flight at a time, and a slow read simply delays the next attempt.
 *
 * Shape follows `CommerceAdmissionSweeper` deliberately: injectable clock and
 * timer, idempotent start/stop, observer hooks that cannot break the loop.
 */

import type { EpochRevalidation } from './epoch_service';

export interface CommerceEpochRevalidatorOptions {
  /**
   * Resolved per tick, never captured. Returns null on a node with no
   * established epoch, which is the normal state for a node that has never
   * traded or whose repo was unreachable at boot.
   */
  service: () => { revalidateIfDue: () => Promise<EpochRevalidation | null> } | null;
  /**
   * How often the revalidator WAKES. Not the re-read cadence — the service
   * owns that (`revalidateIfDue`), so this can be short enough to notice a
   * due re-read promptly without making the reads themselves frequent.
   * Default `60_000` ms.
   */
  intervalMs?: number;
  /** Fired for every tick that actually re-read the live record. */
  onOutcome?: (outcome: EpochRevalidation) => void;
  /** Called when a tick throws. Silent by default. */
  onError?: (err: unknown) => void;
  /** Injectable timer pair. Node, browsers and RN all provide the built-ins. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;

export class CommerceEpochRevalidator {
  private readonly service: CommerceEpochRevalidatorOptions['service'];
  private readonly intervalMs: number;
  private readonly onOutcome: (outcome: EpochRevalidation) => void;
  private readonly onError: (err: unknown) => void;
  private readonly setIntervalFn: NonNullable<CommerceEpochRevalidatorOptions['setInterval']>;
  private readonly clearIntervalFn: NonNullable<CommerceEpochRevalidatorOptions['clearInterval']>;

  private handle: unknown | null = null;
  private inFlight = false;

  constructor(options: CommerceEpochRevalidatorOptions) {
    this.service = options.service;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (this.intervalMs <= 0) {
      throw new Error(
        `CommerceEpochRevalidator: intervalMs must be > 0 (got ${String(this.intervalMs)})`,
      );
    }
    this.onOutcome =
      options.onOutcome ??
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
    void this.runTick();
    this.handle = this.setIntervalFn(() => {
      void this.runTick();
    }, this.intervalMs);
    const maybeTimeout = this.handle as { unref?: () => void };
    if (typeof maybeTimeout.unref === 'function') maybeTimeout.unref();
  }

  stop(): void {
    if (this.handle === null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  /** One tick. Returns null when nothing was re-read this pass. */
  async runTick(): Promise<EpochRevalidation | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      let service: { revalidateIfDue: () => Promise<EpochRevalidation | null> } | null;
      try {
        service = this.service();
      } catch (err) {
        this.onError(err);
        return null;
      }
      if (service === null) return null;

      let outcome: EpochRevalidation | null;
      try {
        outcome = await service.revalidateIfDue();
      } catch (err) {
        this.onError(err);
        return null;
      }
      if (outcome === null) return null;
      // The observer is isolated: a logger that throws must not stop the next
      // tick, and it must not turn a completed re-read into a failed one.
      try {
        this.onOutcome(outcome);
      } catch (err) {
        this.onError(err);
      }
      return outcome;
    } finally {
      this.inFlight = false;
    }
  }
}
