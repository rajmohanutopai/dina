/**
 * TTL map — Map<K, V> with per-entry TTL.
 *
 * Common use: small caches that need "hold this for N seconds,
 * then forget" without a dedicated scheduler. Used by:
 *
 *   - Short-lived nonce replay protection.
 *   - Session-token caches.
 *   - Staged intent → review queue correlation (expires if never ack'd).
 *
 * **Per-entry TTL** — each `set(k, v, {ttlMs?})` optionally overrides
 * the default TTL. Missing override → default TTL.
 *
 * **Lazy sweep** — `get / has / size / entries()` sweep expired first
 * so callers never see stale values. Sweeping is O(N) per op in the
 * worst case but N is typically small (nonce caches are sized to the
 * expected burst).
 *
 * **Event stream** — `onExpire` fires for every auto-removed entry.
 * Useful for metrics (e.g. "nonce cache expired 42 entries / minute").
 *
 * **Injected clock** — deterministic tests.
 */

export interface TtlMapOptions<K> {
  /** Default TTL applied when `set` doesn't override. Required. */
  defaultTtlMs: number;
  /** Injectable clock. Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /** Fires for every expired auto-removal. */
  onExpire?: (key: K, reason: 'ttl' | 'capacity') => void;
  /** Max retained entries. When full, oldest-inserted evicted. Default unlimited. */
  maxEntries?: number;
}

export interface TtlSetOptions {
  /** Override default TTL for this entry. */
  ttlMs?: number;
}

interface Entry<V> {
  value: V;
  expiresAtMs: number;
}

export class TtlMap<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private readonly defaultTtlMs: number;
  private readonly nowMsFn: () => number;
  private readonly onExpire?: (key: K, reason: 'ttl' | 'capacity') => void;
  private readonly maxEntries: number | null;

  constructor(opts: TtlMapOptions<K>) {
    if (!opts || typeof opts !== 'object') {
      throw new TypeError('TtlMap: opts required');
    }
    if (!Number.isFinite(opts.defaultTtlMs) || opts.defaultTtlMs <= 0) {
      throw new RangeError('defaultTtlMs must be > 0');
    }
    this.defaultTtlMs = opts.defaultTtlMs;
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    this.onExpire = opts.onExpire;
    if (opts.maxEntries !== undefined) {
      if (!Number.isInteger(opts.maxEntries) || opts.maxEntries < 1) {
        throw new RangeError('maxEntries must be a positive integer');
      }
      this.maxEntries = opts.maxEntries;
    } else {
      this.maxEntries = null;
    }
  }

  /** Count of retained entries (after sweeping expired). */
  size(): number {
    this.sweepExpired();
    return this.entries.size;
  }

  /** Does the map have a live (non-expired) entry for `key`. */
  has(key: K): boolean {
    this.sweepExpired();
    return this.entries.has(key);
  }

  /** Get the live value for `key`, or undefined. */
  get(key: K): V | undefined {
    this.sweepExpired();
    return this.entries.get(key)?.value;
  }

  /** Peek expiry timestamp for `key`. Returns undefined when missing. */
  expiresAt(key: K): number | undefined {
    this.sweepExpired();
    return this.entries.get(key)?.expiresAtMs;
  }

  /**
   * Store `value` under `key`. Optional per-entry TTL override.
   * Refreshing an existing key extends its lifetime.
   */
  set(key: K, value: V, opts: TtlSetOptions = {}): void {
    const ttl = opts.ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new RangeError('ttlMs must be > 0');
    }
    this.sweepExpired();
    const now = this.nowMsFn();
    // Delete first so reinsert moves to the back of insertion order (for FIFO eviction).
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAtMs: now + ttl });
    this.enforceCapacity();
  }

  /** Remove a key. Returns true when it existed. */
  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  /** Drop every entry. */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Iterable entries (insertion order, live only). Defensive —
   * callers mutating the returned array don't affect the store.
   */
  entriesSnapshot(): Array<[K, V]> {
    this.sweepExpired();
    const out: Array<[K, V]> = [];
    for (const [k, e] of this.entries) out.push([k, e.value]);
    return out;
  }

  /** Force a sweep now. Returns the number of entries dropped. */
  sweepExpired(): number {
    const now = this.nowMsFn();
    let dropped = 0;
    for (const [k, e] of this.entries) {
      if (e.expiresAtMs <= now) {
        this.entries.delete(k);
        dropped += 1;
        this.onExpire?.(k, 'ttl');
      }
    }
    return dropped;
  }

  /** `for...of` iteration over live entries, insertion order. */
  *[Symbol.iterator](): IterableIterator<[K, V]> {
    this.sweepExpired();
    for (const [k, e] of this.entries) yield [k, e.value];
  }

  // ── Internals ────────────────────────────────────────────────────────

  private enforceCapacity(): void {
    if (this.maxEntries === null) return;
    while (this.entries.size > this.maxEntries) {
      const first = this.entries.keys().next();
      if (first.done) break;
      const k = first.value as K;
      this.entries.delete(k);
      this.onExpire?.(k, 'capacity');
    }
  }
}
