/**
 * Task 4.23 — nonce replay guard, wrapping `@dina/core`'s
 * `NonceReplayCache` in the home-node-auth ergonomics.
 *
 * Motivation: `NonceReplayCache.accept(sender, recipient, nonce)`
 * takes a recipient DID as part of the key because the canonical
 * signing payload binds recipient-DID into its input. In a Core
 * server, the recipient is **always the home node's own DID**, so the
 * auth middleware shouldn't have to thread it explicitly on every
 * call. `NonceGuard` binds the recipient DID at construction and
 * exposes a single `observe(senderDid, nonce)` call.
 *
 * **Cache scope.** A single NonceGuard instance per server process.
 * `@dina/core`'s `NonceReplayCache` is in-memory; when we move to
 * multi-node Core deployments, the cache can swap for a Redis-backed
 * impl behind the same interface. Today single-process is the target.
 *
 * **Window alignment.** The default TTL (5 min) matches the
 * timestamp-window validator from task 4.22 — any request whose
 * timestamp was accepted will have its nonce still tracked. Caller
 * can override for test scenarios.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4c task 4.23.
 */

import {
  NonceReplayCache,
  DEFAULT_NONCE_TTL_MS,
  type NonceReplayCacheOptions,
} from '@dina/core';

export interface NonceGuardOptions {
  /** Home node's own DID — bound as the "recipient" for every observe. */
  homeNodeDid: string;
  /** Delegated to the underlying NonceReplayCache. */
  ttlMs?: number;
  maxEntries?: number;
  /** Deterministic clock for tests. */
  nowMsFn?: () => number;
}

export type NonceObservation =
  | { ok: true }
  | { ok: false; reason: 'replay' };

/**
 * Thin facade over `NonceReplayCache` that binds `recipientDid` to the
 * home node's DID and narrows the API surface to the single call the
 * auth middleware needs.
 */
export class NonceGuard {
  private readonly cache: NonceReplayCache;
  private readonly homeNodeDid: string;

  constructor(opts: NonceGuardOptions) {
    if (!opts.homeNodeDid || opts.homeNodeDid.length === 0) {
      throw new Error('NonceGuard: homeNodeDid is required');
    }
    this.homeNodeDid = opts.homeNodeDid;
    const cacheOpts: NonceReplayCacheOptions = {
      ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
      ...(opts.maxEntries !== undefined ? { maxEntries: opts.maxEntries } : {}),
      ...(opts.nowMsFn !== undefined ? { nowMsFn: opts.nowMsFn } : {}),
    };
    this.cache = new NonceReplayCache(cacheOpts);
  }

  /**
   * Record a first sighting of `(senderDid, nonce)`. Returns `{ok: true}`
   * on accept, `{ok: false, reason: 'replay'}` on a live duplicate.
   *
   * The nonce has already been shape-validated upstream
   * (`extractSignedHeaders`: 32 lowercase hex chars) — this check only
   * guards against replay within the TTL window.
   */
  observe(senderDid: string, nonce: string): NonceObservation {
    const accepted = this.cache.accept(senderDid, this.homeNodeDid, nonce);
    return accepted ? { ok: true } : { ok: false, reason: 'replay' };
  }

  /** For /readyz probes and tests. */
  size(): number {
    return this.cache.size();
  }

  /** Tests only. */
  clear(): void {
    this.cache.clear();
  }
}

/** Re-export for callers that want the TTL constant without pulling core. */
export { DEFAULT_NONCE_TTL_MS };
