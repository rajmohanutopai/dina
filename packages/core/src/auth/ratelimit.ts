/**
 * Per-DID rate limiter (mobile adaptation — not per-IP).
 *
 * On mobile, Core only sees localhost (Brain) and MsgBox WS (relayed).
 * Per-IP rate limiting is meaningless. Per-DID is the correct equivalent.
 *
 * Uses a fixed-window counter: each DID gets a bucket that resets
 * after windowSeconds. Simpler than sliding window and sufficient
 * for mobile where request volume is low.
 *
 * Source: core/internal/middleware/ratelimit.go (adapted)
 */

export interface RateLimitConfig {
  /** Max requests per window per DID. Default: 50. */
  maxRequests: number;
  /** Window size in seconds. Default: 60. */
  windowSeconds: number;
  /**
   * Ceilings for named DIDs that differ from `maxRequests`;
   * `Number.POSITIVE_INFINITY` exempts one. The A2A gateway carries every
   * outside client's calls under one DID, so it is exempt: a shared bucket
   * would let a few busy clients throttle all the rest (design §4.1).
   */
  perDidMax?: Readonly<Record<string, number>>;
}

interface Bucket {
  count: number;
  windowStart: number; // ms timestamp
}

export class PerDIDRateLimiter {
  private readonly config: RateLimitConfig;
  private readonly buckets = new Map<string, Bucket>();

  constructor(config: RateLimitConfig = { maxRequests: 50, windowSeconds: 60 }) {
    this.config = config;
  }

  /** How many DIDs hold a bucket: only callers Core knows spend one. */
  get tracked(): number {
    return this.buckets.size;
  }

  /** The DIDs with a ceiling of their own (`Infinity`: exempt), as configured. */
  ceilings(): Readonly<Record<string, number>> {
    return { ...(this.config.perDidMax ?? {}) };
  }

  /**
   * Check if a DID is within its rate limit. Consumes one request token.
   *
   * @param did - Caller's DID
   * @returns true if allowed, false if rate-limited
   */
  allow(did: string): boolean {
    const now = Date.now();
    const bucket = this.getOrCreateBucket(did, now);

    if (bucket.count >= this.maxFor(did)) {
      return false;
    }

    bucket.count++;
    return true;
  }

  /** Reset the rate limit for a specific DID. */
  reset(did: string): void {
    this.buckets.delete(did);
  }

  /** Get remaining requests for a DID in the current window. */
  remaining(did: string): number {
    const now = Date.now();
    const bucket = this.buckets.get(did);

    if (!bucket) {
      return this.maxFor(did);
    }

    // Window expired — full quota
    if (now - bucket.windowStart >= this.config.windowSeconds * 1000) {
      return this.maxFor(did);
    }

    return Math.max(0, this.maxFor(did) - bucket.count);
  }

  private maxFor(did: string): number {
    const named = this.config.perDidMax;
    return named !== undefined && Object.prototype.hasOwnProperty.call(named, did)
      ? (named[did] ?? this.config.maxRequests)
      : this.config.maxRequests;
  }

  /**
   * Get or create a bucket for a DID, resetting if the window has expired.
   */
  private getOrCreateBucket(did: string, now: number): Bucket {
    const existing = this.buckets.get(did);

    if (existing && now - existing.windowStart < this.config.windowSeconds * 1000) {
      return existing;
    }

    // New window
    const bucket: Bucket = { count: 0, windowStart: now };
    this.buckets.set(did, bucket);
    return bucket;
  }
}
