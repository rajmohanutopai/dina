/**
 * Task 5.21 — cancel handler aborts in-flight LLM calls.
 *
 * Brain's `/api/v1/ask` endpoint kicks off LLM calls that may take
 * many seconds (multi-turn reasoning, provider cold start, long
 * contexts). If the caller cancels — either via a `/api/v1/ask/:id/
 * cancel` endpoint or because the HTTP connection dropped — we must
 * abort the LLM call too, not just return a stale response.
 *
 * Without this registry, a cancelled ask would:
 *   (a) Continue consuming LLM tokens → wasted provider spend.
 *   (b) Eventually mark the ask `complete` when the LLM finishes,
 *       mutating a record the caller thought was cancelled.
 *
 * **Design**: for each active LLM call, register an `AbortController`
 * keyed by the ask's request_id. The LLM adapter's request-side
 * signals (`fetch(url, {signal})`, provider-SDK abort support) get
 * the registered signal. When the caller cancels, `cancel(requestId)`
 * aborts the signal → in-flight `fetch` / SDK call rejects
 * immediately → ask handler catches the abort, marks ask
 * `failed` via `AskRegistry` (5.19).
 *
 * **Duplicate register** aborts the prior controller before replacing
 * — a duplicate request_id from the same sender is a protocol bug
 * (ask registry should have caught it), so we shut down the prior
 * work rather than silently shadow it.
 *
 * **Graceful shutdown** (task 4.9): `abortAll()` cancels every
 * in-flight call so LLM connections close cleanly on SIGTERM.
 *
 * **Relation to `CancelRegistry`** (task 4.48): the MsgBox cancel
 * registry keys by `(senderDid, requestId)` for inbound RPC
 * cancellation; this registry keys by single `requestId` because
 * Brain only ever has one local sender (itself) and the ask id is
 * globally unique per Brain instance. Same primitive, different
 * scope.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5c task 5.21.
 */

export type LlmCancelReason = 'aborted' | 'not_found';

export interface LlmCancelRegistration {
  /** AbortSignal the LLM adapter wires into its outbound call. */
  readonly signal: AbortSignal;
  /**
   * Clean up the registration after the LLM call settles (success
   * or failure). Idempotent — safe to call even after `cancel()`.
   */
  unregister(): void;
}

export interface LlmCancelRegistryOptions {
  /** Diagnostic hook. Fires on register / cancel / abortAll. */
  onEvent?: (event: LlmCancelEvent) => void;
}

export type LlmCancelEvent =
  | { kind: 'registered'; requestId: string }
  | { kind: 'unregistered'; requestId: string }
  | { kind: 'cancelled'; requestId: string }
  | { kind: 'replaced'; requestId: string }
  | { kind: 'abort_all'; count: number };

/**
 * Per-Brain registry of in-flight LLM cancel tokens. Keyed by
 * ask / request_id.
 */
export class LlmCancelRegistry {
  private readonly controllers = new Map<string, AbortController>();
  private readonly onEvent?: (event: LlmCancelEvent) => void;

  constructor(opts: LlmCancelRegistryOptions = {}) {
    this.onEvent = opts.onEvent;
  }

  /**
   * Register a fresh AbortController for `requestId`. Returns
   * `{signal, unregister}` — the adapter hands `signal` to the LLM
   * client (fetch `{signal}`, SDK abort hook); `unregister` is
   * called in the ask handler's finally block after the call settles.
   *
   * **Duplicate register** aborts the prior controller first (see
   * module doc for rationale).
   */
  register(requestId: string): LlmCancelRegistration {
    if (!requestId || requestId.length === 0) {
      throw new Error('LlmCancelRegistry.register: requestId is required');
    }
    const existing = this.controllers.get(requestId);
    if (existing !== undefined) {
      existing.abort();
      this.onEvent?.({ kind: 'replaced', requestId });
    }
    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    this.onEvent?.({ kind: 'registered', requestId });
    const unregister = (): void => {
      // Only remove if the current stored controller IS ours — a
      // later register() that replaced us must not be unregistered
      // by our own finally block.
      if (this.controllers.get(requestId) === controller) {
        this.controllers.delete(requestId);
        this.onEvent?.({ kind: 'unregistered', requestId });
      }
    };
    return { signal: controller.signal, unregister };
  }

  /**
   * Cancel the in-flight LLM call for `requestId`. Returns
   * `'aborted'` on success, `'not_found'` when no call is registered.
   *
   * Does NOT remove the entry — the handler's `unregister()` in its
   * finally block handles cleanup after the aborted call rejects.
   * That ordering avoids a race where a fresh register() between the
   * abort and the removal would see an empty slot and think it's the
   * first registration.
   */
  cancel(requestId: string): LlmCancelReason {
    const controller = this.controllers.get(requestId);
    if (controller === undefined) return 'not_found';
    controller.abort();
    this.onEvent?.({ kind: 'cancelled', requestId });
    return 'aborted';
  }

  /**
   * Probe: is there an active cancellation token for this request?
   * Used by admin UI + /readyz for in-flight count.
   */
  has(requestId: string): boolean {
    return this.controllers.has(requestId);
  }

  /** Count of active cancel tokens. */
  size(): number {
    return this.controllers.size;
  }

  /**
   * Graceful-shutdown hook — aborts every pending LLM call. Returns
   * the count aborted. Clears the registry so subsequent
   * `unregister()` calls are no-ops (they compare identity, and the
   * stored controllers are gone).
   */
  abortAll(): number {
    const count = this.controllers.size;
    for (const [requestId, controller] of this.controllers) {
      controller.abort();
      this.onEvent?.({ kind: 'cancelled', requestId });
    }
    this.controllers.clear();
    this.onEvent?.({ kind: 'abort_all', count });
    return count;
  }
}
