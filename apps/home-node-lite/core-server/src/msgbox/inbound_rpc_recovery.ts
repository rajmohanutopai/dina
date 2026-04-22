/**
 * Task 4.50 — long-running inbound-RPC recovery.
 *
 * When the MsgBox WebSocket drops mid-execution of an inbound RPC,
 * the in-flight handler becomes a zombie: it can still complete +
 * emit a response, but the socket is gone so the response has
 * nowhere to go. Worse, on reconnect the handler may still be
 * running — resources held, replay on the sender's side is already
 * in progress via the relay's at-least-once retry, and the final
 * response from the zombie just gets dropped.
 *
 * **Correct behavior on disconnect**:
 *
 *   1. The moment the WS socket reports close/error, abort EVERY
 *      in-flight inbound RPC — they have nowhere to send a
 *      response anyway, so continuing execution is waste.
 *   2. On reconnect, start fresh: the sender will re-deliver any
 *      still-relevant RPCs (relay retry) and those hit the
 *      idempotency cache OR get freshly dispatched.
 *   3. No state leaks across the connection boundary — the
 *      CancelRegistry is cleared so subsequent `register()` calls
 *      aren't fighting zombie entries.
 *
 * This module orchestrates that cleanup on top of:
 *   - `CancelRegistry` from task 4.48 (AbortController registry)
 *   - `ReconnectPolicy` from task 4.44 (attempt count + backoff)
 *
 * **Injectable clock + logger** for deterministic testing.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4f task 4.50.
 */

import type { CancelRegistry } from './cancel_registry';

export interface RecoveryEvent {
  kind: 'abort_on_disconnect' | 'reconnect_cleanup';
  abortedCount: number;
  /** Optional reason — e.g. a close code or error message. */
  reason?: string;
}

export interface InboundRpcRecoveryOptions {
  registry: CancelRegistry;
  /** Diagnostic hook (called on every disconnect + reconnect cleanup). */
  onEvent?: (event: RecoveryEvent) => void;
}

/**
 * Tiny orchestrator wrapping the CancelRegistry with disconnect +
 * reconnect semantics. Callers (the MsgBox WS client) wire the WS's
 * close/error handler to `onDisconnect()` and the "pre-handshake"
 * cleanup on reconnect to `onReconnect()`.
 */
export class InboundRpcRecovery {
  private readonly registry: CancelRegistry;
  private readonly onEvent?: (event: RecoveryEvent) => void;

  constructor(opts: InboundRpcRecoveryOptions) {
    this.registry = opts.registry;
    this.onEvent = opts.onEvent;
  }

  /**
   * Call when the WS socket closes or errors. Aborts every in-flight
   * inbound RPC — they have nowhere to send responses, so continuing
   * wastes resources. Returns the count of aborted RPCs.
   */
  onDisconnect(reason?: string): number {
    const count = this.registry.abortAll();
    const event: RecoveryEvent = reason !== undefined
      ? { kind: 'abort_on_disconnect', abortedCount: count, reason }
      : { kind: 'abort_on_disconnect', abortedCount: count };
    this.onEvent?.(event);
    return count;
  }

  /**
   * Call before starting the reconnect handshake. Defensive double-
   * cleanup — if a prior `onDisconnect()` was missed (bug, race)
   * we still start from a clean slate. Normal flow: this is a no-op.
   */
  onReconnect(): number {
    const count = this.registry.abortAll();
    if (count > 0) {
      // Leaked state from a missed disconnect — log + count.
      const event: RecoveryEvent = {
        kind: 'reconnect_cleanup',
        abortedCount: count,
        reason: 'stale in-flight RPCs from before the reconnect',
      };
      this.onEvent?.(event);
    }
    return count;
  }

  /** How many RPCs are currently in flight (probe for /readyz). */
  inFlightCount(): number {
    return this.registry.size();
  }
}
