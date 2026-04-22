/**
 * Task 4.44 — MsgBox client reconnect exponential backoff, 30s cap.
 *
 * The MsgBox WebSocket client re-attempts after connection failures
 * (initial connect failure, auth_success timeout, peer-initiated
 * close, network drop). Each failure increments the attempt counter;
 * each successful auth resets it to 0.
 *
 * **Why 30s cap (not the 60s `@dina/core.computeReconnectDelay`
 * default)**: MsgBox relays load-balance aggressively; a fresh
 * reconnect lands on a freshly-routed peer which may be healthier
 * than the one we just lost. Capping at 30s halves the worst-case
 * time-to-next-healthy-peer vs. 60s, at the cost of at most one
 * extra reconnect attempt per outage. For a user-facing relay,
 * latency of recovery matters more than relay load.
 *
 * **Delay schedule**:
 *   attempt 0 → 1_000 ms
 *   attempt 1 → 2_000
 *   attempt 2 → 4_000
 *   attempt 3 → 8_000
 *   attempt 4 → 16_000
 *   attempt 5 → 30_000 (capped)
 *   attempt 6+ → 30_000 (stays at cap)
 *
 * Delegates to `@dina/net-node.computeReconnectDelay` (task 3.38),
 * overriding the cap to 30s. `ReconnectPolicy` wraps the helper in a
 * stateful class that tracks `attempt` across failure/success events
 * and exposes injectable hooks for logging + tests.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4f task 4.44.
 */

import { computeReconnectDelay } from '@dina/net-node';

/** 30-second cap per task 4.44 (tighter than net-node's 60s default). */
export const MSGBOX_RECONNECT_MAX_DELAY_MS = 30_000;
/** Start at 1 second — matches `@dina/core.msgbox_ws` canonical schedule. */
export const MSGBOX_RECONNECT_BASE_DELAY_MS = 1_000;
/** Exponent doubles attempts 0..5 before hitting the cap. */
export const MSGBOX_RECONNECT_BACKOFF_FACTOR = 2;

export interface ReconnectPolicyOptions {
  /** Override the base delay. Default 1_000 ms. */
  baseDelayMs?: number;
  /** Override the cap. Default 30_000 ms. */
  maxDelayMs?: number;
  /** Override the factor. Default 2. */
  backoffFactor?: number;
  /**
   * Optional per-attempt jitter (0..1 → ±(jitter * delay)). Default 0
   * — deterministic schedule. Production deployments may set a small
   * jitter (e.g. 0.1) to avoid synchronized reconnect storms across
   * clients.
   */
  jitter?: number;
  /** Pseudo-random source for jitter. Default `Math.random`. */
  random?: () => number;
  /** Diagnostic hook (called on every failure + success). */
  onEvent?: (event: ReconnectEvent) => void;
}

export type ReconnectEvent =
  | { kind: 'failure'; attempt: number; nextDelayMs: number }
  | { kind: 'success'; attemptsUsed: number };

/**
 * Stateful reconnect policy. Caller invokes `recordFailure()` after
 * a failed connect / auth, then waits `nextDelayMs()` before retry.
 * On successful auth, caller invokes `recordSuccess()` to reset the
 * counter.
 */
export class ReconnectPolicy {
  private attempt = 0;
  private readonly opts: Required<Pick<ReconnectPolicyOptions, 'baseDelayMs' | 'maxDelayMs' | 'backoffFactor' | 'jitter' | 'random'>>;
  private readonly onEvent?: (event: ReconnectEvent) => void;

  constructor(opts: ReconnectPolicyOptions = {}) {
    this.opts = {
      baseDelayMs: opts.baseDelayMs ?? MSGBOX_RECONNECT_BASE_DELAY_MS,
      maxDelayMs: opts.maxDelayMs ?? MSGBOX_RECONNECT_MAX_DELAY_MS,
      backoffFactor: opts.backoffFactor ?? MSGBOX_RECONNECT_BACKOFF_FACTOR,
      jitter: opts.jitter ?? 0,
      random: opts.random ?? Math.random,
    };
    this.onEvent = opts.onEvent;
  }

  /** Current failure count. Reset by `recordSuccess`. */
  currentAttempt(): number {
    return this.attempt;
  }

  /**
   * Delay to wait BEFORE the NEXT reconnect attempt. Does NOT
   * increment — caller records the failure separately. Useful for
   * logging/UX ("reconnecting in Xs...") without committing to the
   * attempt yet.
   */
  nextDelayMs(): number {
    return computeReconnectDelay(this.attempt, {
      baseDelayMs: this.opts.baseDelayMs,
      maxDelayMs: this.opts.maxDelayMs,
      backoffFactor: this.opts.backoffFactor,
      jitter: this.opts.jitter,
      random: this.opts.random,
    });
  }

  /** Increment the attempt counter. Returns the new delay for the next retry. */
  recordFailure(): number {
    const delay = this.nextDelayMs();
    this.attempt += 1;
    this.onEvent?.({ kind: 'failure', attempt: this.attempt, nextDelayMs: delay });
    return delay;
  }

  /** Reset on a successful (auth_success confirmed) connect. */
  recordSuccess(): void {
    const attemptsUsed = this.attempt;
    this.attempt = 0;
    this.onEvent?.({ kind: 'success', attemptsUsed });
  }
}
