/**
 * QueryWindow — time-limited authorization windows for public-service D2D traffic.
 *
 * Public-service D2D traffic bypasses the contacts-only gate. A window tracks
 * `(peerDID, queryID, capability) → expiry` entries that authorize specific
 * `service.query` / `service.response` messages to skip the contact gate.
 *
 * Two instances are used at runtime:
 *   - `providerWindow`: opened when a `service.query` is accepted from a
 *     stranger. The provider's `service.response` uses `reserve`/`commit` to
 *     consume the window without allowing duplicate sends.
 *   - `requesterWindow`: opened when a `service.query` is sent to a public
 *     service. The requester's inbound `service.response` uses
 *     `checkAndConsume` to accept exactly one reply.
 *
 * Source: core/internal/service/query_window.go
 *
 * Notes on the port:
 *   - Go uses `sync.Mutex`; JS is single-threaded at the bytecode level and
 *     every method here is synchronous, so no locking primitive is needed.
 *     All operations remain linearisable by virtue of the event loop.
 *   - Time is injectable via the `nowFn` option so tests can exercise expiry
 *     deterministically without `setTimeout` flakiness.
 *   - `CleanupLoop` is replaced by a pair of methods (`startCleanupLoop` /
 *     `stopCleanupLoop`) returning a disposer — there is no `context.Context`
 *     equivalent in stock Node; callers clean up with the returned handle.
 */

/** Options for `QueryWindow`. */
export interface QueryWindowOptions {
  /**
   * Returns the current time in milliseconds since the Unix epoch. Defaults
   * to `Date.now`. Injected for tests.
   */
  nowFn?: () => number;
}

interface WindowEntry {
  capability: string;
  /** Absolute expiry timestamp (ms since epoch). */
  expiresAt: number;
  /** True iff a pending send has claimed this window. */
  reserved: boolean;
}

/**
 * In-memory, single-process query-window store. All methods are synchronous.
 *
 * Acceptable for ephemeral public-service traffic; not durable across process
 * restarts. Durability lives in the workflow-task layer, not here.
 */
export class QueryWindow {
  private readonly entries = new Map<string, WindowEntry>();
  private readonly nowFn: () => number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: QueryWindowOptions = {}) {
    this.nowFn = options.nowFn ?? Date.now;
  }

  /**
   * Open a new window entry. If an entry already exists for the same
   * `(peerDID, queryID)`, it is overwritten (last-write-wins, matching Go).
   *
   * @param ttlMs Time-to-live in milliseconds.
   */
  open(peerDID: string, queryID: string, capability: string, ttlMs: number): void {
    const key = windowKey(peerDID, queryID, capability);
    this.entries.set(key, {
      capability,
      expiresAt: this.nowFn() + ttlMs,
      reserved: false,
    });
  }

  /**
   * Atomically mark an entry as reserved iff it exists, is not expired, is
   * not already reserved, and its capability matches. Returns `true` if the
   * caller won the reservation.
   *
   * Used at provider-side egress gate 1 to prevent two concurrent
   * `service.response` sends from both passing the gate.
   */
  reserve(peerDID: string, queryID: string, capability: string): boolean {
    const key = windowKey(peerDID, queryID, capability);
    const entry = this.entries.get(key);
    if (!entry || entry.reserved || this.isExpired(entry) || entry.capability !== capability) {
      return false;
    }
    entry.reserved = true;
    return true;
  }

  /**
   * Consume a previously reserved entry (deletes it). Called after successful
   * outbox enqueue. No-op if the entry is missing, not reserved, or if the
   * capability does not match.
   */
  commit(peerDID: string, queryID: string, capability: string): void {
    const key = windowKey(peerDID, queryID, capability);
    const entry = this.entries.get(key);
    if (entry && entry.reserved && entry.capability === capability) {
      this.entries.delete(key);
    }
  }

  /**
   * Undo a reservation without consuming the entry. Called when the send
   * pipeline fails before enqueue. The entry becomes eligible for retry.
   */
  release(peerDID: string, queryID: string, capability: string): void {
    const key = windowKey(peerDID, queryID, capability);
    const entry = this.entries.get(key);
    if (entry && entry.reserved && entry.capability === capability) {
      entry.reserved = false;
    }
  }

  /**
   * Return `true` and delete the entry iff it exists, is not expired, and the
   * capability matches. One-shot; subsequent calls for the same key return
   * `false`.
   *
   * Used on the requester side for inbound `service.response` acceptance —
   * no reservation phase because inbound processing is single-threaded per
   * connection.
   */
  checkAndConsume(peerDID: string, queryID: string, capability: string): boolean {
    const key = windowKey(peerDID, queryID, capability);
    const entry = this.entries.get(key);
    if (!entry || this.isExpired(entry) || entry.capability !== capability) {
      return false;
    }
    this.entries.delete(key);
    return true;
  }

  /** Number of live (non-removed) entries. Useful for tests and metrics. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Non-consuming existence check — returns `true` iff an entry exists, is
   * not expired, and its capability matches. Unlike `checkAndConsume` this
   * does NOT delete the entry, so ingress pipelines can use it as a
   * pre-flight gate without burning the one-shot authorisation.
   */
  peek(peerDID: string, queryID: string, capability: string): boolean {
    const key = windowKey(peerDID, queryID, capability);
    const entry = this.entries.get(key);
    if (!entry || this.isExpired(entry) || entry.capability !== capability) {
      return false;
    }
    return true;
  }

  /** Remove expired entries. Returns the number removed. */
  cleanup(): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Strict expiry check — matches Go semantics where `time.Now().After(expiry)`
   * returns `false` at the instant of expiry. An entry is "expired" only
   * strictly after its `expiresAt`.
   */
  private isExpired(entry: WindowEntry): boolean {
    return this.nowFn() > entry.expiresAt;
  }

  /**
   * Start a periodic expiry sweeper. Returns a disposer function; calling it
   * or `stopCleanupLoop` stops the sweeper. Idempotent — a second call while
   * already running returns the same disposer without resetting the interval.
   *
   * @param intervalMs Sweep interval in milliseconds. Must be > 0.
   */
  startCleanupLoop(intervalMs: number): () => void {
    if (intervalMs <= 0) {
      throw new Error(`QueryWindow: cleanup interval must be > 0 (got ${intervalMs})`);
    }
    if (this.cleanupTimer !== null) {
      return () => this.stopCleanupLoop();
    }
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, intervalMs);
    // Do not keep the Node event loop alive solely for this sweeper.
    if (typeof (this.cleanupTimer as { unref?: () => void }).unref === 'function') {
      (this.cleanupTimer as { unref: () => void }).unref();
    }
    return () => this.stopCleanupLoop();
  }

  /** Stop the periodic sweeper started by `startCleanupLoop`. Idempotent. */
  stopCleanupLoop(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

/**
 * Compose the map key for `(peerDID, queryID, capability)`. Including
 * capability in the key (issue #20) prevents collisions when a requester
 * reuses the same queryID against two different capabilities on the
 * same peer — e.g. `eta_query` and `status_query` with query_id="42".
 * The NUL byte separator cannot appear in any of the three fields
 * (DIDs, UUID-shaped query IDs, and capability names are all ASCII).
 */
function windowKey(peerDID: string, queryID: string, capability: string): string {
  return `${peerDID}\x00${queryID}\x00${capability}`;
}
