/**
 * Idempotency cache keyed by `(sender_did, request_id)`.
 *
 * Purpose: on `MsgBox` transport, a peer may re-send the same RPC packet
 * (retry after timeout, spotty radio, etc.). The bridge must serve the
 * same response body without re-executing the inner HTTP request. This
 * cache stores the response for a bounded TTL (default 5 minutes) so
 * retries within that window short-circuit.
 *
 * Eviction: lazy on read (past-deadline entries are treated as absent) +
 * periodic compaction that drops the oldest-expired entries. No
 * background timer — callers (or tests) advance time via `nowMsFn` and
 * the cache recomputes eligibility each lookup.
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md CORE-P0-009.
 */

import type { RPCInnerResponse } from './types';

/** Default TTL: 5 minutes in ms. */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

export interface IdempotencyCacheOptions {
  /** Returns the current time in ms. Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /** Per-entry TTL in ms. Defaults to `DEFAULT_IDEMPOTENCY_TTL_MS`. */
  ttlMs?: number;
  /**
   * Hard cap on cache size. Oldest entries are evicted first when the
   * cache exceeds this bound. Defaults to 10_000 — deliberately large
   * since each entry is small (headers + < 1 MiB body).
   */
  maxEntries?: number;
}

interface CacheEntry {
  response: RPCInnerResponse;
  expiresAtMs: number;
}

/**
 * In-memory idempotency cache. Thread-safety is not a concern under
 * Node's single-threaded event loop — all mutations are synchronous.
 */
export class IdempotencyCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly nowMsFn: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: IdempotencyCacheOptions = {}) {
    this.nowMsFn = options.nowMsFn ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.maxEntries = options.maxEntries ?? 10_000;
    if (this.ttlMs <= 0) {
      throw new Error('IdempotencyCache: ttlMs must be positive');
    }
    if (this.maxEntries <= 0) {
      throw new Error('IdempotencyCache: maxEntries must be positive');
    }
  }

  /** Look up a cached response. Returns `null` on miss or expired entry. */
  get(senderDid: string, requestId: string): RPCInnerResponse | null {
    const key = this.key(senderDid, requestId);
    const entry = this.store.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAtMs <= this.nowMsFn()) {
      this.store.delete(key);
      return null;
    }
    return entry.response;
  }

  /** Store a response. Sets `expiresAtMs = now + ttlMs`. */
  put(senderDid: string, requestId: string, response: RPCInnerResponse): void {
    const key = this.key(senderDid, requestId);
    const expiresAtMs = this.nowMsFn() + this.ttlMs;
    this.store.set(key, { response, expiresAtMs });
    if (this.store.size > this.maxEntries) {
      this.evictOldest();
    }
  }

  /** Current entry count (for tests + metrics). */
  size(): number {
    return this.store.size;
  }

  /** Drop all entries. For shutdown / tests. */
  clear(): void {
    this.store.clear();
  }

  private key(senderDid: string, requestId: string): string {
    // Delimiter is `\x00` so no DID-or-request-id value can accidentally
    // collide into the same key.
    return `${senderDid}\x00${requestId}`;
  }

  /** Sweep past-deadline entries; evict oldest after. Called after overflow. */
  private evictOldest(): void {
    const now = this.nowMsFn();
    for (const [k, v] of this.store) {
      if (v.expiresAtMs <= now) this.store.delete(k);
    }
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
    }
  }
}
