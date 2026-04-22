/**
 * Rate limiter — pure token-bucket primitive.
 *
 * A classic token-bucket with injected clock. Used by:
 *
 *   - Incoming HTTP throttling per (DID / API key / IP).
 *   - LLM-call guardrails per (persona / provider) to prevent runaway
 *     loops from burning through the daily token budget (complements
 *     `token_ledger.ts` which tracks *tokens*; this one tracks
 *     *calls*).
 *   - Agent-safety layer: rate-limit agent-initiated ops so a
 *     compromised agent can't spam the gatekeeper.
 *
 * **Pure** — no timers, no intervals. Every `consume()` computes the
 * current capacity from `(now - lastRefillMs) × refillPerMs`, applies
 * the request, and updates the bucket. The injected `nowMsFn` drives
 * all time.
 *
 * **Per-key state** — one bucket per key, created lazily on first
 * access. Unused keys stay in memory until `reset(key)` or `clear()`.
 *
 * **Never throws** from `consume()` — structured outcome tells the
 * caller whether to allow + how long until the next slot.
 *
 * **Burst vs. sustained** — capacity caps burst; refillPerSec caps
 * sustained. A caller that allows 60 req/min with no burst sets
 * `{capacity: 60, refillPerSec: 1}`; burst-tolerant caller with same
 * sustained rate sets `{capacity: 200, refillPerSec: 1}`.
 */

export interface RateLimiterOptions {
  /** Max tokens in the bucket at any time. */
  capacity: number;
  /** Tokens refilled per second. Can be fractional (e.g. 0.5 = 1/2s). */
  refillPerSec: number;
  /** Injectable clock. Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /** Initial bucket level for new keys. Defaults to `capacity` (full). */
  initialTokens?: number;
}

export interface ConsumeResult {
  allowed: boolean;
  /** Current tokens remaining AFTER this consume. */
  tokensRemaining: number;
  /**
   * If not allowed: ms until enough tokens refill to cover this
   * request. Zero when `allowed: true`.
   */
  retryAfterMs: number;
}

export interface BucketSnapshot {
  key: string;
  tokens: number;
  capacity: number;
  refillPerSec: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefillMs: number }>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly nowMsFn: () => number;
  private readonly initialTokens: number;

  constructor(opts: RateLimiterOptions) {
    if (!opts || typeof opts !== 'object') {
      throw new TypeError('RateLimiter: opts required');
    }
    if (!Number.isFinite(opts.capacity) || opts.capacity <= 0) {
      throw new RangeError('RateLimiter: capacity must be > 0');
    }
    if (!Number.isFinite(opts.refillPerSec) || opts.refillPerSec <= 0) {
      throw new RangeError('RateLimiter: refillPerSec must be > 0');
    }
    this.capacity = opts.capacity;
    this.refillPerMs = opts.refillPerSec / 1000;
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    const initial = opts.initialTokens ?? opts.capacity;
    if (!Number.isFinite(initial) || initial < 0 || initial > opts.capacity) {
      throw new RangeError('RateLimiter: initialTokens must be in [0, capacity]');
    }
    this.initialTokens = initial;
  }

  /**
   * Try to consume `cost` tokens from `key`'s bucket. Default cost
   * is 1. Returns structured outcome.
   */
  consume(key: string, cost = 1): ConsumeResult {
    if (typeof key !== 'string' || key === '') {
      throw new TypeError('consume: key must be a non-empty string');
    }
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new RangeError('consume: cost must be a positive number');
    }
    if (cost > this.capacity) {
      // Asking for more than the bucket could ever hold → never allowed.
      return { allowed: false, tokensRemaining: 0, retryAfterMs: Number.POSITIVE_INFINITY };
    }

    const bucket = this.touchBucket(key);
    this.refill(bucket);
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return {
        allowed: true,
        tokensRemaining: bucket.tokens,
        retryAfterMs: 0,
      };
    }
    // Not enough tokens. Compute how long until we have `cost`.
    const missing = cost - bucket.tokens;
    const retryAfterMs = Math.ceil(missing / this.refillPerMs);
    return {
      allowed: false,
      tokensRemaining: bucket.tokens,
      retryAfterMs,
    };
  }

  /** Peek at a bucket's current level without consuming. */
  peek(key: string): ConsumeResult {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      return {
        allowed: true,
        tokensRemaining: this.initialTokens,
        retryAfterMs: 0,
      };
    }
    const view = { ...bucket };
    this.refill(view);
    return {
      allowed: view.tokens >= 1,
      tokensRemaining: view.tokens,
      retryAfterMs:
        view.tokens >= 1 ? 0 : Math.ceil((1 - view.tokens) / this.refillPerMs),
    };
  }

  /** Remove one key's bucket. Returns true if it existed. */
  reset(key: string): boolean {
    return this.buckets.delete(key);
  }

  /** Remove every bucket. */
  clear(): void {
    this.buckets.clear();
  }

  /** Count of tracked keys. */
  size(): number {
    return this.buckets.size;
  }

  /** Read-only snapshot of every bucket — for admin UI + debug. */
  snapshot(): BucketSnapshot[] {
    const refillPerSec = this.refillPerMs * 1000;
    return Array.from(this.buckets.entries()).map(([key, b]) => ({
      key,
      tokens: b.tokens,
      capacity: this.capacity,
      refillPerSec,
      lastRefillMs: b.lastRefillMs,
    }));
  }

  // ── Internals ────────────────────────────────────────────────────────

  private touchBucket(key: string): { tokens: number; lastRefillMs: number } {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        tokens: this.initialTokens,
        lastRefillMs: this.nowMsFn(),
      };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private refill(bucket: { tokens: number; lastRefillMs: number }): void {
    const now = this.nowMsFn();
    const dt = now - bucket.lastRefillMs;
    if (dt <= 0) return;
    const refill = dt * this.refillPerMs;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + refill);
    bucket.lastRefillMs = now;
  }
}
