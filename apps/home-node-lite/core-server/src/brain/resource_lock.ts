/**
 * Resource lock — async mutex for serialising access to in-memory state.
 *
 * When multiple async callers race for a shared resource (e.g. a
 * cache the caller fills lazily, or a config-reload atomic swap),
 * they need to serialise. Node's single-threaded model doesn't help
 * past `await` boundaries — two callers can interleave freely.
 *
 * This primitive provides a FIFO mutex:
 *
 *   - `acquire({timeoutMs?, signal?})` — returns a release handle.
 *     Callers `release()` exactly once when done. If every prior
 *     holder is still running, queue + await.
 *   - `withLock(fn, opts?)` — convenience that runs `fn` under the
 *     lock + always releases, even on throw.
 *   - `isLocked()` + `queueSize()` — introspection.
 *
 * **Timeout**: `acquire` rejects with `LockTimeoutError` after
 * `timeoutMs` if it hasn't been granted. The waiter is pulled from
 * the queue so it doesn't grab the lock later.
 *
 * **AbortSignal**: if the signal fires while queued, the waiter
 * rejects with `LockAbortedError` + is removed from the queue.
 *
 * **Re-entrancy is NOT supported**: the mutex is non-recursive; the
 * same caller calling `acquire` twice without releasing will
 * deadlock itself. Contract documented + callers should use
 * `withLock` to avoid leaks.
 *
 * **Never loses the lock**: even if a release handler throws, the
 * lock moves on to the next waiter via the try/finally in `withLock`
 * + an explicit release-only-once guard in the handle.
 */

export interface LockAcquireOptions {
  /** Max ms to wait in the queue. Rejects with LockTimeoutError past this. */
  timeoutMs?: number;
  /** Abort signal — rejects with LockAbortedError when fired. */
  signal?: AbortSignal;
}

export interface LockReleaseHandle {
  /** Release the lock. Idempotent — second+ calls are no-ops. */
  release(): void;
  /** Whether the lock is already released. */
  readonly released: boolean;
}

export class LockTimeoutError extends Error {
  constructor(public readonly waitedMs: number) {
    super(`[lock_timeout] acquire timed out after ${waitedMs}ms`);
    this.name = 'LockTimeoutError';
  }
}

export class LockAbortedError extends Error {
  constructor() {
    super('[lock_aborted] acquire aborted');
    this.name = 'LockAbortedError';
  }
}

interface Waiter {
  resolve: (handle: LockReleaseHandle) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | null;
}

export interface ResourceLockOptions {
  /** Injectable timer fns — production uses setTimeout/clearTimeout. */
  setTimerFn?: (fn: () => void, ms: number) => unknown;
  clearTimerFn?: (handle: unknown) => void;
}

export class ResourceLock {
  private locked = false;
  private readonly waiters: Waiter[] = [];
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(opts: ResourceLockOptions = {}) {
    this.setTimer =
      opts.setTimerFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      opts.clearTimerFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  isLocked(): boolean {
    return this.locked;
  }

  queueSize(): number {
    return this.waiters.length;
  }

  /**
   * Acquire the lock. Resolves with a release handle. Rejects on
   * timeout or abort.
   */
  async acquire(opts: LockAcquireOptions = {}): Promise<LockReleaseHandle> {
    if (opts.signal?.aborted) {
      throw new LockAbortedError();
    }
    if (!this.locked) {
      this.locked = true;
      return this.makeHandle();
    }

    return await new Promise<LockReleaseHandle>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: null,
        signal: opts.signal,
        onAbort: null,
      };

      if (opts.timeoutMs !== undefined) {
        if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0) {
          reject(new TypeError('timeoutMs must be a non-negative finite number'));
          return;
        }
        const started = Date.now();
        waiter.timer = this.setTimer(() => {
          this.removeWaiter(waiter);
          reject(new LockTimeoutError(Date.now() - started));
        }, opts.timeoutMs) as ReturnType<typeof setTimeout>;
      }

      if (opts.signal) {
        waiter.onAbort = () => {
          this.removeWaiter(waiter);
          reject(new LockAbortedError());
        };
        opts.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }

      this.waiters.push(waiter);
    });
  }

  /**
   * Run `fn` under the lock. Always releases, even on throw.
   * Convenience wrapper over `acquire` + try/finally.
   */
  async withLock<T>(
    fn: () => Promise<T> | T,
    opts: LockAcquireOptions = {},
  ): Promise<T> {
    const handle = await this.acquire(opts);
    try {
      return await fn();
    } finally {
      handle.release();
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  private makeHandle(): LockReleaseHandle {
    let released = false;
    const handle: LockReleaseHandle = {
      get released() {
        return released;
      },
      release: () => {
        if (released) return;
        released = true;
        this.grantNext();
      },
    };
    return handle;
  }

  private grantNext(): void {
    const next = this.waiters.shift();
    if (!next) {
      this.locked = false;
      return;
    }
    this.cleanupWaiter(next);
    // Lock stays true; handle the next waiter.
    next.resolve(this.makeHandle());
  }

  private removeWaiter(w: Waiter): void {
    const idx = this.waiters.indexOf(w);
    if (idx >= 0) this.waiters.splice(idx, 1);
    this.cleanupWaiter(w);
  }

  private cleanupWaiter(w: Waiter): void {
    if (w.timer !== null) {
      this.clearTimer(w.timer);
      w.timer = null;
    }
    if (w.signal && w.onAbort) {
      w.signal.removeEventListener('abort', w.onAbort);
      w.onAbort = null;
    }
  }
}
