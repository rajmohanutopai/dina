/**
 * Task 4.48 — cancel frame → abort in-flight MsgBox RPC.
 *
 * When the remote sender decides it no longer cares about a
 * long-running inbound RPC (user navigated away, deadline expired,
 * etc.), it sends a `cancel` frame referencing the `request_id`. The
 * Core server must abort the in-flight handler + release resources
 * (DB locks, network waits, long-running LLM calls) promptly.
 *
 * **Implementation**: each fresh inbound RPC registers an
 * `AbortController` under its `(senderDid, requestId)` key before
 * dispatching to the CoreRouter. The handler receives the
 * `AbortSignal` and MUST honor it for any operation that could
 * legitimately take longer than a few hundred ms. When a cancel
 * frame arrives, `cancel()` finds the matching controller and calls
 * `.abort()` — the handler sees the signal + returns early.
 *
 * **Key scoping**: same as the idempotency cache (task 4.49) —
 * `${senderDid}::${requestId}`. Different senders with the same
 * request_id don't collide.
 *
 * **Lifecycle**: `register()` → `signal` flows into the handler →
 * handler completes or aborts → caller invokes `unregister()` to
 * free the controller. Forgetting to unregister leaks the controller
 * until process exit; the `size()` probe exists to surface leaks.
 *
 * **Cancel of an unknown id**: the `cancel()` result tells the
 * caller whether the controller was found — `"aborted"` if yes,
 * `"not_found"` if the RPC already completed or never registered. The
 * latter is normal + expected (ordering race between the sender's
 * cancel frame and the ack of completion); callers log + continue.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4f task 4.48.
 */

export interface RegisteredRPC {
  signal: AbortSignal;
  /** Caller MUST call this when the handler completes (success or error). */
  unregister: () => void;
}

export type CancelResult = 'aborted' | 'not_found';

/**
 * In-memory registry of inbound RPCs that are currently executing.
 * Operations are O(1) via a Map.
 */
export class CancelRegistry {
  private readonly inFlight = new Map<string, AbortController>();

  /**
   * Register an RPC. Returns an `AbortSignal` to pass into the
   * handler + an `unregister` closure the caller invokes on
   * completion. `register` on an existing key replaces the prior
   * controller AFTER aborting it — a duplicate request_id from the
   * same sender in-flight is a protocol-level bug; this behavior
   * ensures the NEW handler gets a fresh signal while the PRIOR
   * handler sees `.aborted === true` and exits.
   */
  register(senderDid: string, requestId: string): RegisteredRPC {
    const key = this.key(senderDid, requestId);
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      existing.abort();
    }
    const controller = new AbortController();
    this.inFlight.set(key, controller);
    return {
      signal: controller.signal,
      unregister: () => {
        // Only delete if this is still the registered controller —
        // a subsequent register() may have taken its place.
        if (this.inFlight.get(key) === controller) {
          this.inFlight.delete(key);
        }
      },
    };
  }

  /**
   * Abort the in-flight RPC matching `(senderDid, requestId)`.
   * Returns `'aborted'` if the controller was found, `'not_found'`
   * if it had already completed or was never registered.
   */
  cancel(senderDid: string, requestId: string): CancelResult {
    const key = this.key(senderDid, requestId);
    const controller = this.inFlight.get(key);
    if (controller === undefined) return 'not_found';
    controller.abort();
    this.inFlight.delete(key);
    return 'aborted';
  }

  /**
   * Abort ALL in-flight RPCs. Called during graceful shutdown (task
   * 4.9) so handlers see the abort signal + release resources
   * instead of the process ripping them out with prejudice.
   */
  abortAll(): number {
    const n = this.inFlight.size;
    for (const controller of this.inFlight.values()) {
      controller.abort();
    }
    this.inFlight.clear();
    return n;
  }

  /** For /readyz + leak detection. */
  size(): number {
    return this.inFlight.size;
  }

  /** True iff the (senderDid, requestId) currently has an active controller. */
  has(senderDid: string, requestId: string): boolean {
    return this.inFlight.has(this.key(senderDid, requestId));
  }

  private key(senderDid: string, requestId: string): string {
    return `${senderDid}::${requestId}`;
  }
}
