/**
 * Commerce admission recovery sweeper (§9.9 step 3).
 *
 * `CommerceAdmissionEngine.recoverAdmissions()` is what turns an expired
 * `pre_effect` reservation into a real `rejected(decision_timeout)` and
 * refunds the capacity it was holding. It was written, tested, and never
 * called: the only callers in the repository were its own tests, so on a
 * running node no reservation ever timed out. Every abandoned order held its
 * quote capacity indefinitely and answered the buyer `received_processing`
 * for ever. The engine was correct; nothing ran it.
 *
 * WHY IT RESOLVES THE RUNTIME PER TICK rather than taking an engine.
 * Commerce composes after storage and stays disabled entirely on a node with
 * no published epoch (§16.2). A sweeper that captured an engine at wiring
 * time would either be unbuildable on those nodes or would pin whatever
 * happened to exist at that instant — and it must also stop cleanly when the
 * runtime is torn down on identity change. Reading it per tick makes "there
 * is no commerce here" an ordinary quiet tick rather than a boot-order
 * problem.
 *
 * Shape follows `TaskExpirySweeper` deliberately: injectable clock and timer,
 * idempotent start/stop, observer hooks that cannot break the loop.
 */

import type { AdmissionRecoverySweep } from './admission';

export interface CommerceAdmissionSweeperOptions {
  /**
   * Resolved per tick, never captured. Returns null when this node has no
   * commerce runtime, which is the normal state for a node without a
   * published epoch.
   */
  engine: () => { recoverAdmissions: () => AdmissionRecoverySweep } | null;
  /** How often the sweeper runs. Default `60_000` ms. */
  intervalMs?: number;
  /** Fired once per order decided `rejected(decision_timeout)`. */
  onTimedOut?: (purchaseOrderId: string) => void;
  /**
   * Fired for an expired reservation the sweep could NOT resolve.
   *
   * Separate from `onError` because it is not an exception: the sweep
   * succeeded and found a row it cannot decide. Left unreported it is
   * invisible, and invisible is how a held quote never comes back.
   */
  onStuck?: (skip: { purchaseOrderId: string; reason: string }) => void;
  /** Called when a tick throws. Silent by default. */
  onError?: (err: unknown) => void;
  /** Injectable timer pair. Node, browsers and RN all provide the built-ins. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;

export class CommerceAdmissionSweeper {
  private readonly engine: CommerceAdmissionSweeperOptions['engine'];
  private readonly intervalMs: number;
  private readonly onTimedOut: (purchaseOrderId: string) => void;
  private readonly onStuck: (skip: { purchaseOrderId: string; reason: string }) => void;
  private readonly onError: (err: unknown) => void;
  private readonly setIntervalFn: NonNullable<CommerceAdmissionSweeperOptions['setInterval']>;
  private readonly clearIntervalFn: NonNullable<CommerceAdmissionSweeperOptions['clearInterval']>;

  private handle: unknown | null = null;

  constructor(options: CommerceAdmissionSweeperOptions) {
    this.engine = options.engine;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (this.intervalMs <= 0) {
      throw new Error(`CommerceAdmissionSweeper: intervalMs must be > 0 (got ${this.intervalMs})`);
    }
    this.onTimedOut =
      options.onTimedOut ??
      (() => {
        /* silenced */
      });
    this.onStuck =
      options.onStuck ??
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
    this.runTick();
    this.handle = this.setIntervalFn(() => {
      this.runTick();
    }, this.intervalMs);
    const maybeTimeout = this.handle as { unref?: () => void };
    if (typeof maybeTimeout.unref === 'function') maybeTimeout.unref();
  }

  stop(): void {
    if (this.handle === null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  /** One sweep. Returns null when there is no commerce runtime to sweep. */
  runTick(): AdmissionRecoverySweep | null {
    let engine: { recoverAdmissions: () => AdmissionRecoverySweep } | null;
    try {
      engine = this.engine();
    } catch (err) {
      // The resolver itself can throw — on a server node `currentEpoch()` is
      // fail-closed until the epoch record is published (§16.2). That is a
      // node with commerce disabled, not a sweeper fault.
      this.onError(err);
      return null;
    }
    if (engine === null) return null;
    let sweep: AdmissionRecoverySweep;
    try {
      sweep = engine.recoverAdmissions();
    } catch (err) {
      this.onError(err);
      return null;
    }
    // Observers run AFTER the sweep's own transaction has committed, and each
    // is isolated: a logger that throws must not lose the rest of the report.
    for (const purchaseOrderId of sweep.timedOut) {
      try {
        this.onTimedOut(purchaseOrderId);
      } catch (err) {
        this.onError(err);
      }
    }
    for (const skip of sweep.stuck) {
      try {
        this.onStuck(skip);
      } catch (err) {
        this.onError(err);
      }
    }
    return sweep;
  }
}
