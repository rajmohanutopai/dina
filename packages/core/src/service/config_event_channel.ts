/**
 * Core → Brain configuration-change event channel.
 *
 * Fires on every successful PUT `/v1/service/config` so Brain can trigger
 * the re-publish flow (see `packages/brain/src/service/config_sync.ts`).
 *
 * Design goals:
 *   - **Buffered**: events arriving before Brain subscribes are queued up
 *     to `maxQueueSize` (default 16). When Brain subscribes for the first
 *     time, the queue is flushed to it in order. Additional events after
 *     subscription bypass the queue and go straight to subscribers.
 *   - **Drop-oldest when full**: overflow dequeues the oldest event so
 *     fresh state is always retained. Drop-events emit an observable
 *     warning so operators can tune queue size.
 *   - **Multi-subscriber**: multiple listeners are supported. Each
 *     listener sees every event exactly once.
 *   - **Error-isolated**: a failing listener never stops other listeners
 *     from receiving the event.
 *
 * Source: core/internal/service/service_config.go — `config_changed`
 *         event publish + Brain `config_sync.ts` (DEF-7).
 */

export type ConfigEventKind = 'config_changed';

export interface ConfigChangedEvent {
  type: ConfigEventKind;
  /** Wall-clock timestamp of the change (ms). */
  timestamp: number;
}

export type ConfigEventListener = (event: ConfigChangedEvent) => void;

export interface ConfigEventChannelOptions {
  /**
   * Maximum events queued while no subscribers are active. When exceeded,
   * the oldest event is dropped (and `onDrop` fires). Default 16.
   */
  maxQueueSize?: number;
  /**
   * Invoked when a queued event is evicted to make room for a new one.
   * Useful for metrics / operator warnings.
   */
  onDrop?: (dropped: ConfigChangedEvent) => void;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  nowMsFn?: () => number;
}

const DEFAULT_MAX_QUEUE_SIZE = 16;

export class ConfigEventChannel {
  private readonly listeners = new Set<ConfigEventListener>();
  private readonly queue: ConfigChangedEvent[] = [];
  private readonly maxQueueSize: number;
  private readonly onDrop: (dropped: ConfigChangedEvent) => void;
  private readonly nowMsFn: () => number;

  constructor(options: ConfigEventChannelOptions = {}) {
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    if (!Number.isInteger(this.maxQueueSize) || this.maxQueueSize <= 0) {
      throw new Error(
        `ConfigEventChannel: maxQueueSize must be a positive integer (got ${this.maxQueueSize})`,
      );
    }
    this.onDrop =
      options.onDrop ??
      (() => {
        /* silenced by default */
      });
    this.nowMsFn = options.nowMsFn ?? Date.now;
  }

  /**
   * Emit a `config_changed` event. If any listeners are subscribed, they
   * receive it immediately; otherwise it lands in the buffered queue.
   */
  emitConfigChanged(): ConfigChangedEvent {
    const event: ConfigChangedEvent = {
      type: 'config_changed',
      timestamp: this.nowMsFn(),
    };
    this.emit(event);
    return event;
  }

  /**
   * Emit a pre-built event. Exported so callers that construct events
   * elsewhere (audit replay, integration tests) can route through the same
   * path as fresh emissions.
   */
  emit(event: ConfigChangedEvent): void {
    if (this.listeners.size === 0) {
      this.enqueue(event);
      return;
    }
    this.dispatchToListeners(event);
  }

  /**
   * Subscribe a listener. On first call (or any subsequent call while the
   * queue is non-empty) the caller receives every buffered event in order
   * BEFORE returning — this is how Brain reliably picks up config changes
   * that arrived before it booted.
   *
   * Returns a disposer that removes the listener.
   */
  subscribe(listener: ConfigEventListener): () => void {
    this.listeners.add(listener);
    // Drain the queue to this listener synchronously.
    if (this.queue.length > 0) {
      const buffered = this.queue.splice(0, this.queue.length);
      for (const event of buffered) {
        this.deliverSafely(listener, event);
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Number of buffered events awaiting a subscriber. Tests + diagnostics. */
  queueSize(): number {
    return this.queue.length;
  }

  /** Number of active subscribers. */
  listenerCount(): number {
    return this.listeners.size;
  }

  /** Reset — clears queue + listeners. Tests only. */
  reset(): void {
    this.listeners.clear();
    this.queue.length = 0;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private enqueue(event: ConfigChangedEvent): void {
    if (this.queue.length >= this.maxQueueSize) {
      const dropped = this.queue.shift();
      if (dropped !== undefined) {
        // Swallow listener errors so a bad metrics observer never breaks
        // the enqueue path.
        try {
          this.onDrop(dropped);
        } catch {
          /* silenced */
        }
      }
    }
    this.queue.push(event);
  }

  private dispatchToListeners(event: ConfigChangedEvent): void {
    for (const l of this.listeners) {
      this.deliverSafely(l, event);
    }
  }

  private deliverSafely(listener: ConfigEventListener, event: ConfigChangedEvent): void {
    try {
      listener(event);
    } catch {
      /* isolated — one broken subscriber never stops the fan-out. */
    }
  }
}

// ---------------------------------------------------------------------------
// Process-level default instance (convention: startup wires it, everything
// else reaches it through the accessor). Matches the pattern used by
// `service/windows.ts`.
// ---------------------------------------------------------------------------

let _instance: ConfigEventChannel | null = null;

/** Lazy singleton — created on first access. */
export function configEventChannel(): ConfigEventChannel {
  if (_instance === null) {
    _instance = new ConfigEventChannel();
  }
  return _instance;
}

/** Swap or reset the default instance. Tests + alt wiring only. */
export function setConfigEventChannel(c: ConfigEventChannel | null): void {
  _instance = c;
}

/** Clear the default instance (rebuild on next access). Tests only. */
export function resetConfigEventChannel(): void {
  _instance?.reset();
  _instance = null;
}
