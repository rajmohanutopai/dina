/**
 * Task 4.49 — idempotency cache for inbound MsgBox RPCs.
 *
 * The MsgBox relay's at-least-once delivery guarantee means inbound
 * RPC requests can arrive multiple times (the relay retries after a
 * dropped ACK, a peer reconnects and re-delivers the queue, etc.).
 * The idempotency cache tracks request_ids we've already processed
 * + the previously-computed response, so a re-delivery returns the
 * cached response instead of re-running the handler. This matters
 * for non-idempotent handlers (vault/store, notify, persona/unlock)
 * where double-execution has user-visible side effects.
 *
 * **Replay window** (TTL): entries expire after `ttlMs` (default
 * 5 minutes — matches the timestamp validator's ±5 min window). Past
 * that point the request is rejected upstream anyway, so the cache
 * entry is no longer useful + reclaiming memory is safe.
 *
 * **Keying**: `request_id` is caller-chosen (per the CoreRPCRequest
 * shape in `@dina/protocol`) and scoped to a sender DID — two
 * different senders can legitimately use the same request_id without
 * conflict. The cache key is therefore `${senderDid}:${requestId}`.
 *
 * **LRU eviction**: hard cap `maxEntries` (default 10_000) prevents
 * unbounded memory growth if the relay starts firehosing unique
 * ids. Oldest entry gets dropped on overflow.
 *
 * **Response storage**: callers pass the CoreRPCResponse to
 * `recordResponse()`. On replay the cached response is returned
 * AS-IS — the handler is NOT re-run, which means a handler that
 * reads stale state (e.g. "get-current-time") would return stale
 * state on replay. Per the MsgBox semantics, request_id is the
 * authoritative identity marker; replay returning the exact response
 * of the original is the correct semantics.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4f task 4.49.
 */

import type { CoreRPCResponse } from '@dina/protocol';
import { TIMESTAMP_WINDOW_MS } from '../auth/timestamp_window';

/**
 * **Replay window**, expressed in minutes (task 4.83).
 *
 * The idempotency cache must live AT LEAST as long as the timestamp-
 * window validator accepts signatures — otherwise a signed request
 * that's still acceptable (within ±5 min) could arrive, miss the
 * cache (evicted too soon), and get double-executed by the handler.
 * Keeping the cache ≥ timestamp window closes that gap.
 *
 * Expressed in minutes here — not the ambiguous "a while" that earlier
 * design notes used — so ops can reason about it without decoding
 * milliseconds.
 */
export const IDEMPOTENCY_TTL_MINUTES = 5;

/** Derived from {@link IDEMPOTENCY_TTL_MINUTES} to prevent drift. */
export const DEFAULT_IDEMPOTENCY_TTL_MS = IDEMPOTENCY_TTL_MINUTES * 60 * 1000;

/** Hard cap on cache entries (LRU-evicted past this). */
export const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 10_000;

/**
 * Minimum acceptable TTL — equal to the timestamp validator's window.
 * Construction rejects any smaller value to prevent the double-
 * execution gap described above.
 */
export const MIN_IDEMPOTENCY_TTL_MS = TIMESTAMP_WINDOW_MS;

export interface IdempotencyCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  nowMsFn?: () => number;
}

export interface CachedEntry {
  response: CoreRPCResponse;
  expiresAtMs: number;
}

/**
 * LRU + TTL cache of seen request_ids → stored responses. Scoped by
 * senderDid so two senders reusing the same request_id don't collide.
 */
export class IdempotencyCache {
  private readonly entries = new Map<string, CachedEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly nowMsFn: () => number;

  constructor(opts: IdempotencyCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_IDEMPOTENCY_MAX_ENTRIES;
    this.nowMsFn = opts.nowMsFn ?? Date.now;
    if (this.ttlMs <= 0) {
      throw new Error(`IdempotencyCache: ttlMs must be > 0 (got ${this.ttlMs})`);
    }
    if (this.ttlMs < MIN_IDEMPOTENCY_TTL_MS) {
      throw new Error(
        `IdempotencyCache: ttlMs (${this.ttlMs}ms) must be >= MIN_IDEMPOTENCY_TTL_MS (${MIN_IDEMPOTENCY_TTL_MS}ms) — otherwise replay window and idempotency cache diverge, causing double-execution`,
      );
    }
    if (this.maxEntries <= 0) {
      throw new Error(
        `IdempotencyCache: maxEntries must be > 0 (got ${this.maxEntries})`,
      );
    }
  }

  /** Introspection: the TTL in whole minutes (rounded down). Useful for /readyz + ops logging. */
  ttlMinutes(): number {
    return Math.floor(this.ttlMs / (60 * 1000));
  }

  /**
   * Check if we've already processed this `(senderDid, requestId)`. If
   * yes and the entry hasn't expired, returns the cached response so
   * the caller can re-send it. If no (or expired), returns null —
   * caller runs the handler normally and then calls `recordResponse`.
   */
  lookup(senderDid: string, requestId: string): CoreRPCResponse | null {
    const key = this.key(senderDid, requestId);
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    const now = this.nowMsFn();
    if (entry.expiresAtMs <= now) {
      this.entries.delete(key);
      return null;
    }
    // LRU bump: re-insert to move to end. `Map.set` on an existing
    // key replaces the value but keeps insertion order — we need to
    // delete + set to move.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.response;
  }

  /**
   * Record the response from handling a fresh RPC. Pair with a prior
   * `lookup()` that returned null. If called for a key that's already
   * cached, the OLD entry wins (caller handled an RPC they shouldn't
   * have — bug elsewhere, but fail safe here).
   */
  recordResponse(senderDid: string, requestId: string, response: CoreRPCResponse): void {
    if (requestId !== response.request_id) {
      throw new Error(
        `IdempotencyCache.recordResponse: request_id mismatch (${requestId} vs response.${response.request_id})`,
      );
    }
    const key = this.key(senderDid, requestId);
    const now = this.nowMsFn();
    const existing = this.entries.get(key);
    // Only skip when a LIVE entry is present — expired entries are
    // treated as absent so a re-record rebuilds them (matches the
    // semantics the lookup side already honors).
    if (existing !== undefined && existing.expiresAtMs > now) return;
    this.entries.set(key, { response, expiresAtMs: now + this.ttlMs });
    this.evictIfNeeded(now);
  }

  /** Drop expired entries (lazy — called at eviction time). */
  private evictIfNeeded(now: number): void {
    if (this.entries.size <= this.maxEntries) return;
    // Walk insertion order (oldest-first); stop when we're below the cap.
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) break;
      // Prefer dropping expired entries first.
      if (entry.expiresAtMs <= now) {
        this.entries.delete(key);
      } else {
        // Oldest live entry — sacrifice it.
        this.entries.delete(key);
      }
    }
  }

  /** For /readyz + tests. */
  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private key(senderDid: string, requestId: string): string {
    // `:` is a safe separator because DIDs conform to
    // `did:<method>:<id>` and request_ids are caller-chosen — worst
    // case a request_id containing `:` collides with nothing
    // legitimate because the senderDid prefix disambiguates.
    return `${senderDid}::${requestId}`;
  }
}
