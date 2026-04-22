/**
 * Event stream — typed pub/sub primitive.
 *
 * Almost every primitive in the brain package exposes an `onEvent`
 * callback. When multiple consumers want the same event (e.g.
 * admin UI live-tail + Prometheus counter + audit log), they need a
 * shared stream they can subscribe to independently.
 *
 * This primitive is that stream:
 *
 *   stream.emit(event)            → broadcasts synchronously.
 *   stream.subscribe(fn, opts?)   → returns `{unsubscribe}`.
 *   stream.subscribeAsync(fn)     → awaits handler completion when
 *                                   emitAsync is used.
 *   stream.emitAsync(event)       → awaits every async handler
 *                                   in parallel; returns
 *                                   `{delivered, failed}` counts.
 *
 * **Error isolation**: a handler that throws is caught; remaining
 * handlers still receive the event. The error fires via the
 * optional `onError` callback so ops tools can log it.
 *
 * **Filter predicate** (optional per-subscriber) — `filter: (event)
 * => boolean`. False skips the handler.
 *
 * **Unsubscribe is idempotent** + handler can unsubscribe itself
 * mid-emit without affecting the current broadcast (snapshot of
 * subscribers taken at emit time).
 */

export interface SubscribeOptions<E> {
  /** Only deliver events for which filter returns true. */
  filter?: (event: E) => boolean;
}

export interface Subscription {
  unsubscribe(): void;
  readonly active: boolean;
}

export type EventStreamErrorFn = (error: unknown, stage: 'emit') => void;

export interface EventStreamOptions {
  onError?: EventStreamErrorFn;
}

export interface EmitAsyncResult {
  delivered: number;
  failed: number;
}

interface Handler<E> {
  fn: (event: E) => void | Promise<void>;
  filter: ((event: E) => boolean) | undefined;
  active: boolean;
}

export class EventStream<E> {
  private readonly handlers = new Set<Handler<E>>();
  private readonly onError?: EventStreamErrorFn;

  constructor(opts: EventStreamOptions = {}) {
    this.onError = opts.onError;
  }

  size(): number {
    return this.handlers.size;
  }

  /**
   * Register a synchronous handler. Returns a subscription that can
   * be individually unsubscribed.
   */
  subscribe(fn: (event: E) => void, opts: SubscribeOptions<E> = {}): Subscription {
    if (typeof fn !== 'function') {
      throw new TypeError('EventStream.subscribe: fn must be a function');
    }
    if (opts.filter !== undefined && typeof opts.filter !== 'function') {
      throw new TypeError('EventStream.subscribe: filter must be a function');
    }
    const handler: Handler<E> = {
      fn,
      filter: opts.filter,
      active: true,
    };
    this.handlers.add(handler);
    return {
      get active() {
        return handler.active;
      },
      unsubscribe: () => {
        if (handler.active) {
          handler.active = false;
          this.handlers.delete(handler);
        }
      },
    };
  }

  /**
   * Register an async handler. Functionally identical to `subscribe`
   * but documents intent — paired with `emitAsync` the caller awaits
   * completion.
   */
  subscribeAsync(
    fn: (event: E) => Promise<void>,
    opts: SubscribeOptions<E> = {},
  ): Subscription {
    return this.subscribe(fn as (event: E) => void, opts);
  }

  /**
   * Broadcast synchronously. Each handler's result is discarded —
   * thrown errors are routed to `onError`.
   *
   * Snapshot of handlers is taken at emit time; self-unsubscribing
   * handlers affect only subsequent emits.
   */
  emit(event: E): void {
    const snapshot = [...this.handlers];
    for (const h of snapshot) {
      if (!h.active) continue;
      if (h.filter && !h.filter(event)) continue;
      try {
        const out = h.fn(event);
        // Swallow any promise from a sync handler — caller should use
        // emitAsync if they want to await.
        void out;
      } catch (err) {
        this.onError?.(err, 'emit');
      }
    }
  }

  /**
   * Broadcast and await every async handler in parallel. Handlers
   * that throw are caught + counted as `failed`. Returns tallies.
   */
  async emitAsync(event: E): Promise<EmitAsyncResult> {
    const snapshot = [...this.handlers].filter((h) => h.active && (!h.filter || h.filter(event)));
    const results = await Promise.allSettled(snapshot.map(async (h) => h.fn(event)));
    let delivered = 0;
    let failed = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') delivered += 1;
      else {
        failed += 1;
        this.onError?.(r.reason, 'emit');
      }
    }
    return { delivered, failed };
  }

  /** Remove every subscriber. */
  clear(): void {
    for (const h of this.handlers) h.active = false;
    this.handlers.clear();
  }
}
