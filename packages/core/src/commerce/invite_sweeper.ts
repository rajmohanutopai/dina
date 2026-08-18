/**
 * §8's invite tick — resolves stuck exchanges (compensating revocation
 * past the offer TTL, ack re-send while awaiting activation proof,
 * teardown past the proof window).
 *
 * ALWAYS STARTED, never optional, for the reason `sweepers.ts` narrates:
 * an optional duty is one a composition root eventually forgets. It
 * resolves the installed invite service per tick and a node with none
 * ticks quietly.
 */

import { getInviteService } from './invite_compose';

export interface InviteSweeperOptions {
  /** Hourly by default: the windows are day-scale. */
  intervalMs?: number;
  onSweep?: (outcome: { revoked: number; ackResent: number }) => void;
  onError?: (err: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export const DEFAULT_INVITE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export class InviteSweeper {
  private handle: unknown = null;

  constructor(private readonly options: InviteSweeperOptions = {}) {}

  start(): void {
    if (this.handle !== null) return;
    const timer = this.options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.handle = timer(() => {
      void this.tick();
    }, this.options.intervalMs ?? DEFAULT_INVITE_SWEEP_INTERVAL_MS);
    // Never hold a process open for housekeeping.
    (this.handle as { unref?: () => void } | null)?.unref?.();
  }

  async tick(): Promise<void> {
    const service = getInviteService();
    if (service === null) return;
    try {
      const outcome = await service.sweep();
      if (outcome.revoked > 0 || outcome.ackResent > 0) this.options.onSweep?.(outcome);
    } catch (err) {
      this.options.onError?.(err);
    }
  }

  stop(): void {
    if (this.handle === null) return;
    const clear =
      this.options.clearInterval ??
      ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
    clear(this.handle);
    this.handle = null;
  }
}
