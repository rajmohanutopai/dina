/**
 * Bounded RPC worker pool with `submitDuplicate` dedup.
 *
 * Purpose: limit concurrent RPC executions and fold duplicate in-flight
 * requests onto the same execution promise. Without this, a peer that
 * retries a request multiple times while the first is still running
 * would spawn N parallel workers — wasteful and unsafe for side-effecty
 * paths that already have their own idempotency.
 *
 * Usage:
 *   const pool = new RPCWorkerPool({ maxConcurrent: 8 });
 *   const result = await pool.submitDuplicate(jobKey, () => doWork());
 *   // Second caller with same jobKey while first is in flight:
 *   //   awaits the SAME promise, never starts a second worker.
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md CORE-P0-011.
 */

export interface RPCWorkerPoolOptions {
  /** Maximum concurrent job executions. Further submissions queue. */
  maxConcurrent: number;
  /** Maximum queue depth. Submissions beyond this throw. Default 1000. */
  maxQueueDepth?: number;
}

export class WorkerPoolQueueFullError extends Error {
  constructor(readonly depth: number) {
    super(`RPCWorkerPool: queue full (depth=${depth})`);
    this.name = 'WorkerPoolQueueFullError';
  }
}

export class RPCWorkerPool {
  private readonly maxConcurrent: number;
  private readonly maxQueueDepth: number;
  /** Live job by key. Promise never rejects into the pool — callers get it raw. */
  private readonly inFlight = new Map<string, Promise<unknown>>();
  /** Queue of jobs waiting for a slot. */
  private readonly queue: Array<() => void> = [];
  private running = 0;

  constructor(options: RPCWorkerPoolOptions) {
    if (options.maxConcurrent <= 0) {
      throw new Error('RPCWorkerPool: maxConcurrent must be positive');
    }
    this.maxConcurrent = options.maxConcurrent;
    this.maxQueueDepth = options.maxQueueDepth ?? 1000;
  }

  /**
   * Submit a job, folding onto an existing in-flight job with the same
   * `key`. If no job is live for this key, schedule one (respecting the
   * concurrency cap). Returns the shared promise — the fulfil/reject
   * outcome is identical for every caller.
   *
   * Note: the de-duplication window is "while in flight". Once a job
   * completes, a subsequent `submitDuplicate` with the same key starts
   * a fresh execution. For post-completion dedup, layer an
   * IdempotencyCache on top.
   */
  async submitDuplicate<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      return existing as Promise<T>;
    }
    if (this.queue.length >= this.maxQueueDepth) {
      throw new WorkerPoolQueueFullError(this.queue.length);
    }
    // Wrap cleanup inside the scheduled work so there's only ONE promise
    // visible to callers — avoids dangling `.finally()` chains that
    // would surface as unhandled rejections when the job throws.
    let promise!: Promise<T>;
    const wrapped = async () => {
      try {
        return await work();
      } finally {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
        }
      }
    };
    promise = this.schedule(wrapped);
    this.inFlight.set(key, promise);
    return promise;
  }

  /** Count of jobs currently running. */
  runningCount(): number {
    return this.running;
  }

  /** Count of jobs waiting for a slot. */
  queuedCount(): number {
    return this.queue.length;
  }

  /** Count of unique in-flight keys (deduplicated). */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  private async schedule<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await work();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next !== undefined) next();
    }
  }
}
