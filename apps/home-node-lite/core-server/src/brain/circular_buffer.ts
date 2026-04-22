/**
 * Circular buffer — generic fixed-capacity ring.
 *
 * Used by:
 *
 *   - `BrainLogger` sinks that want a "last N lines" tail for
 *     admin-UI live-display.
 *   - Recent-event stores for ops dashboards.
 *   - Unbounded-looking in-memory queues that need cheap cap.
 *
 * **O(1) push + drop-oldest-on-overflow**. No Array.shift() — index
 * arithmetic on a fixed-size backing array. `snapshot()` returns a
 * defensive copy in insertion order (oldest → newest).
 *
 * **Iteration**: `forEach(fn)` walks oldest-to-newest without
 * copying. `*[Symbol.iterator]()` returns a generator producing the
 * same order.
 *
 * **Size vs capacity**: `size()` is items currently retained;
 * `capacity` is the fixed max. Once full, every `push` overwrites
 * the oldest slot.
 *
 * **Never throws on push** — the only failure mode is construction
 * with invalid capacity (must be positive integer).
 */

export interface CircularBufferOptions {
  capacity: number;
}

export class CircularBuffer<T> {
  private readonly data: Array<T | undefined>;
  private readonly cap: number;
  private head = 0;   // next write position
  private count = 0;

  constructor(opts: CircularBufferOptions) {
    if (!opts || typeof opts !== 'object') {
      throw new TypeError('CircularBuffer: opts required');
    }
    if (!Number.isInteger(opts.capacity) || opts.capacity < 1) {
      throw new RangeError('CircularBuffer: capacity must be a positive integer');
    }
    this.cap = opts.capacity;
    this.data = new Array<T | undefined>(opts.capacity);
  }

  get capacity(): number {
    return this.cap;
  }

  size(): number {
    return this.count;
  }

  isEmpty(): boolean {
    return this.count === 0;
  }

  isFull(): boolean {
    return this.count === this.cap;
  }

  /**
   * Push `value`. When full, overwrites the oldest slot and returns
   * the evicted value. Otherwise returns `undefined`.
   */
  push(value: T): T | undefined {
    const overwriting = this.count === this.cap;
    let evicted: T | undefined;
    if (overwriting) {
      evicted = this.data[this.head];
    }
    this.data[this.head] = value;
    this.head = (this.head + 1) % this.cap;
    if (!overwriting) this.count += 1;
    return evicted;
  }

  /**
   * Pop the NEWEST entry (stack-like). Returns undefined when empty.
   */
  popNewest(): T | undefined {
    if (this.count === 0) return undefined;
    this.head = (this.head - 1 + this.cap) % this.cap;
    const value = this.data[this.head];
    this.data[this.head] = undefined;
    this.count -= 1;
    return value;
  }

  /**
   * Shift the OLDEST entry (queue-like). Returns undefined when empty.
   */
  shiftOldest(): T | undefined {
    if (this.count === 0) return undefined;
    const tail = (this.head - this.count + this.cap) % this.cap;
    const value = this.data[tail];
    this.data[tail] = undefined;
    this.count -= 1;
    return value;
  }

  /** Peek at the newest without removing. */
  peekNewest(): T | undefined {
    if (this.count === 0) return undefined;
    const idx = (this.head - 1 + this.cap) % this.cap;
    return this.data[idx];
  }

  /** Peek at the oldest without removing. */
  peekOldest(): T | undefined {
    if (this.count === 0) return undefined;
    const idx = (this.head - this.count + this.cap) % this.cap;
    return this.data[idx];
  }

  /**
   * Snapshot in insertion order (oldest → newest). Defensive copy —
   * caller may mutate the returned array freely.
   */
  snapshot(): T[] {
    if (this.count === 0) return [];
    const out: T[] = new Array(this.count);
    const tail = (this.head - this.count + this.cap) % this.cap;
    for (let i = 0; i < this.count; i++) {
      out[i] = this.data[(tail + i) % this.cap] as T;
    }
    return out;
  }

  /**
   * Return the LAST `n` entries (newest first in the result), up to
   * the buffer's current size.
   */
  tail(n: number): T[] {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError('tail: n must be a non-negative integer');
    }
    if (n === 0 || this.count === 0) return [];
    const take = Math.min(n, this.count);
    const out: T[] = new Array(take);
    for (let i = 0; i < take; i++) {
      out[i] = this.data[(this.head - 1 - i + this.cap) % this.cap] as T;
    }
    return out;
  }

  /** Walk oldest-to-newest without copying. */
  forEach(fn: (value: T, index: number) => void): void {
    const tail = (this.head - this.count + this.cap) % this.cap;
    for (let i = 0; i < this.count; i++) {
      fn(this.data[(tail + i) % this.cap] as T, i);
    }
  }

  *[Symbol.iterator](): IterableIterator<T> {
    const tail = (this.head - this.count + this.cap) % this.cap;
    for (let i = 0; i < this.count; i++) {
      yield this.data[(tail + i) % this.cap] as T;
    }
  }

  clear(): void {
    for (let i = 0; i < this.cap; i++) this.data[i] = undefined;
    this.head = 0;
    this.count = 0;
  }
}
