/**
 * The staging sweeper: runs `sweep` and drains parked memories, at start and on
 * a timer, on every host.
 *
 * Without it a memory caught by an app kill, a Brain crash or a model outage
 * never reached the vault, and a memory routed to a persona that did not exist
 * yet waited for ever. Both boots start one (`sweep_wiring.test.ts`).
 *
 * The drain lives here, not at the persona open paths, for two reasons: there
 * are several of those paths on each host, and the registry opens a persona
 * before its vault DB is ready. A store that fails stays `pending_unlock` and
 * the next tick tries again, so a late vault only delays the memory.
 *
 * Runs in Core, beside the repository. Logs nothing itself; the host's observers
 * get counts only.
 */

import { listPersonas } from '../persona/service';

import { drainForPersonaWithEffects, sweep } from './service';

import type { StagingSweepResult } from './repository';

/** Shorter than a lease by far, so a lapsed row waits about a minute at most. */
export const DEFAULT_STAGING_SWEEP_INTERVAL_MS = 60_000;

export interface StagingSweepTick extends StagingSweepResult {
  drained: number;
  remindersCreated: number;
}

export interface StagingSweeperOptions {
  intervalMs?: number;
  /** Fires once per tick. Metadata only: counts. */
  onTick?: (result: StagingSweepTick) => void;
  /** Fires when a tick throws. A failed tick never stops the timer. */
  onError?: (err: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class StagingSweeper {
  private readonly intervalMs: number;
  private readonly onTick: (result: StagingSweepTick) => void;
  private readonly onError: (err: unknown) => void;
  private readonly setIntervalFn: NonNullable<StagingSweeperOptions['setInterval']>;
  private readonly clearIntervalFn: NonNullable<StagingSweeperOptions['clearInterval']>;
  private handle: unknown | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(options: StagingSweeperOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_STAGING_SWEEP_INTERVAL_MS;
    if (this.intervalMs <= 0) {
      throw new Error(`StagingSweeper: intervalMs must be > 0 (got ${this.intervalMs})`);
    }
    this.onTick = options.onTick ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
    this.setIntervalFn = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn =
      options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  /** Sweep now, for what the last run left behind, then on the interval. Idempotent. */
  start(): void {
    if (this.handle !== null) return;
    void this.runTick();
    this.handle = this.setIntervalFn(() => void this.runTick(), this.intervalMs);
    (this.handle as { unref?: () => void } | null)?.unref?.();
  }

  stop(): void {
    if (this.handle === null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  /** Wait for a tick in flight. */
  async flush(): Promise<void> {
    await this.inFlight;
  }

  /** One tick. Overlapping calls share it. Never rejects. */
  runTick(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const tick = this.tickOnce().finally(() => {
      if (this.inFlight === tick) this.inFlight = null;
    });
    this.inFlight = tick;
    return tick;
  }

  private async tickOnce(): Promise<void> {
    try {
      const swept = sweep();
      let drained = 0;
      let remindersCreated = 0;
      for (const persona of listPersonas()) {
        if (!persona.isOpen) continue;
        const result = await drainForPersonaWithEffects(persona.name);
        drained += result.drained;
        remindersCreated += result.remindersCreated;
      }
      this.onTick({ ...swept, drained, remindersCreated });
    } catch (err) {
      this.onError(err);
    }
  }
}
