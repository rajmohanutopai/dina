/**
 * Releasing a prior manifest's lifecycle lane once its last order finishes
 * (§9.13 — WS-3.8).
 *
 * `releaseContinuity` was written, tested, and called by nothing. Continuity
 * authorizations are created with `expiresAt: null` on purpose — no clock knows
 * when an order ends — so without a caller a prior plugin CID kept authority
 * over this node's lifecycle lane FOREVER. Every update left another one
 * behind.
 *
 * WHY A SWEEP AND NOT AN EVENT. The moment a lane becomes releasable is the
 * moment the LAST order it serves goes terminal, and that happens inside the
 * lifecycle engine — a commerce concern that must not reach into the plugin
 * registry to revoke authority. A periodic check keeps the two apart, and the
 * cost of learning late is a stale CID answering for orders it legitimately
 * served, which is the harmless direction.
 *
 * FAIL-SAFE IN ONE DIRECTION. `releaseContinuity` re-reads the open-order
 * count itself and refuses when it is non-zero, so this sweep cannot revoke a
 * lane that is still needed even if its own view is stale. What it can do is
 * miss a release for one interval, which costs nothing.
 */

/** What the sweep needs from the plugin side, injected to keep Core pure. */
export interface ContinuityReleaseDeps {
  /** Prior-CID lanes that might now be releasable. */
  releasable: () => readonly { installId: string; previousCid: string; capabilityId: string }[];
  /** The coordinator's own release, which re-checks the count and may refuse. */
  release: (
    installId: string,
    previousCid: string,
    capabilityId: string,
  ) => { released: boolean; openOrders: number };
  onReleased?: (entry: { installId: string; previousCid: string; capabilityId: string }) => void;
}

export interface ContinuityReleaseSweeperOptions extends ContinuityReleaseDeps {
  intervalMs: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class ContinuityReleaseSweeper {
  private handle: unknown = null;
  private readonly options: ContinuityReleaseSweeperOptions;

  constructor(options: ContinuityReleaseSweeperOptions) {
    if (options.intervalMs <= 0) {
      throw new Error(
        `ContinuityReleaseSweeper: intervalMs must be > 0 (got ${String(options.intervalMs)})`,
      );
    }
    this.options = options;
  }

  /** One pass. Returns how many lanes were released. */
  sweep(): number {
    let released = 0;
    for (const entry of this.options.releasable()) {
      // The coordinator decides. A sweep that made the decision itself would
      // be a second opinion about whether a buyer is still owed an answer.
      const verdict = this.options.release(entry.installId, entry.previousCid, entry.capabilityId);
      if (verdict.released) {
        released += 1;
        this.options.onReleased?.(entry);
      }
    }
    return released;
  }

  start(): void {
    if (this.handle !== null) return;
    const set = this.options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.handle = set(() => {
      // A throw inside a timer would take the tick down permanently and
      // silently. The lane it failed on is retried next pass.
      try {
        this.sweep();
      } catch {
        /* next pass */
      }
    }, this.options.intervalMs);
    // A maintenance tick must never be the reason a process stays alive. On
    // Node the handle is a Timeout with `unref`; on Hermes and under injected
    // fakes it is a plain number with none, so this is a capability probe
    // rather than a platform check. The sibling sweepers do the same.
    const maybeTimeout = this.handle as { unref?: () => void };
    if (typeof maybeTimeout.unref === 'function') maybeTimeout.unref();
  }

  stop(): void {
    if (this.handle === null) return;
    const clear = this.options.clearInterval ?? ((h) => clearInterval(h as never));
    clear(this.handle);
    this.handle = null;
  }
}
