/**
 * D2D outbox drainer — durable background retry (issues.txt §1).
 *
 * On boot: `recoverOutboxOnBoot()` reclaims rows a crash left in
 * `sending` (lease expired) back to `pending`.
 *
 * While alive: a periodic worker (`startOutboxDrainer`) claims due
 * messages, hands each to the boot-wired re-delivery function, and
 * records the outcome — `markSent` on success, exponential-backoff
 * `recordFailure` otherwise, dead-letter at max attempts / TTL.
 *
 * The re-delivery function (`setOutboxRedeliverFn`) re-resolves the
 * recipient's DID document / endpoint and re-seals the semantic body —
 * it is wired at boot from the same signing identity the live send path
 * uses (see home-node `makeOutboxRedeliver`). Without it the drainer is
 * a no-op (e.g. a Core with no sender identity).
 */

import { appendAudit } from '../audit/service';
import { claimDue, markSent, recordFailure, resetStaleSending, sweepTerminal } from './outbox';
import type { D2DOutboxRow } from './outbox_repository';

/** Outcome of a single re-delivery attempt. */
export interface RedeliverOutcome {
  delivered: boolean;
  error?: string;
}

/** Re-delivery function: re-resolve + re-seal + deliver one queued row. */
export type OutboxRedeliverFn = (row: D2DOutboxRow) => Promise<RedeliverOutcome>;

let redeliverFn: OutboxRedeliverFn | null = null;
/** DID used as the audit actor for dead-letter events. */
let auditActorDID = 'system';

/** Wire the re-delivery function (boot). */
export function setOutboxRedeliverFn(fn: OutboxRedeliverFn | null, selfDID?: string): void {
  redeliverFn = fn;
  if (selfDID) auditActorDID = selfDID;
}

/** Reset injected state (tests). */
export function resetRetryState(): void {
  redeliverFn = null;
  auditActorDID = 'system';
}

/** How long a claimed row stays leased before it's reclaimable. */
const LEASE_MS = 60_000;
/** Max rows drained per tick. */
const DRAIN_BATCH = 25;

export interface DrainResult {
  attempted: number;
  delivered: number;
  failed: number;
  dead: number;
}

/**
 * Drain all currently-due outbox messages once.
 *
 * No-op (returns zeros) when no re-delivery function is wired. Each
 * message is attempted independently — one failure never stops the rest.
 */
export async function drainOutbox(now?: number): Promise<DrainResult> {
  const t = now ?? Date.now();
  const result: DrainResult = { attempted: 0, delivered: 0, failed: 0, dead: 0 };
  if (redeliverFn === null) return result;

  const claimed = claimDue(t, LEASE_MS, DRAIN_BATCH);
  for (const row of claimed) {
    result.attempted++;
    let outcome: RedeliverOutcome;
    try {
      outcome = await redeliverFn(row);
    } catch (err) {
      outcome = { delivered: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (outcome.delivered) {
      markSent(row.id, t);
      result.delivered++;
      continue;
    }

    const terminal = recordFailure(row, outcome.error ?? 'delivery_failed', t);
    if (terminal === 'dead') {
      result.dead++;
      appendAudit(
        auditActorDID,
        'd2d_outbox_dead',
        row.targetDID,
        `type=${row.messageType} id=${row.id} attempts=${row.attempts + 1} error=${(outcome.error ?? 'delivery_failed').slice(0, 120)}`,
      );
    } else {
      result.failed++;
    }
  }
  return result;
}

/**
 * Reclaim crashed-mid-send rows on boot. Returns the count reset.
 * Call once after storage init, before starting the periodic drainer.
 */
export function recoverOutboxOnBoot(now?: number): number {
  return resetStaleSending(now);
}

export interface DrainerHandle {
  /** Stop the periodic worker. */
  stop(): void;
}

export interface StartOutboxDrainerOptions {
  /** Drain interval in ms (default 30 s). */
  intervalMs?: number;
  /** Sweep terminal rows every N ticks (default every 120 ticks ≈ 1 h). */
  sweepEveryTicks?: number;
  /** Optional error sink for a drain that throws. */
  onError?: (err: unknown) => void;
}

/**
 * Start the periodic drainer. Runs an immediate drain, then every
 * `intervalMs`. Returns a handle whose `stop()` clears the timer.
 *
 * Safe to call without a wired re-delivery function — it just no-ops
 * each tick until one is set.
 */
export function startOutboxDrainer(opts: StartOutboxDrainerOptions = {}): DrainerHandle {
  const intervalMs = opts.intervalMs ?? 30_000;
  const sweepEveryTicks = opts.sweepEveryTicks ?? 120;
  let ticks = 0;
  let stopped = false;
  // Re-entrancy guard: if a drain (network re-delivery) runs longer than
  // `intervalMs`, skip the overlapping tick rather than run two drains that
  // race on `sweepTerminal` + the counters. Lease-based claiming already
  // prevents double-delivery; this keeps the bookkeeping clean.
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await drainOutbox();
      ticks++;
      if (ticks % sweepEveryTicks === 0) sweepTerminal();
    } catch (err) {
      opts.onError?.(err);
    } finally {
      running = false;
    }
  };

  // Fire-and-forget the first drain; subsequent runs on the interval.
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  // Don't keep the Node event loop alive on account of the drainer.
  (timer as { unref?: () => void }).unref?.();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
