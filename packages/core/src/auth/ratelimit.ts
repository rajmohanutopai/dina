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
}

interface Bucket {
  count: number;
  windowStart: number; // ms timestamp
}

export class PerDIDRateLimiter {
  private readonly config: RateLimitConfig;
  private readonly buckets: Map<string, Bucket> = new Map();

  constructor(config: RateLimitConfig = { maxRequests: 50, windowSeconds: 60 }) {
    this.config = config;
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

    if (bucket.count >= this.config.maxRequests) {
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
      return this.config.maxRequests;
    }

    // Window expired — full quota
    if (now - bucket.windowStart >= this.config.windowSeconds * 1000) {
      return this.config.maxRequests;
    }

    return Math.max(0, this.config.maxRequests - bucket.count);
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
