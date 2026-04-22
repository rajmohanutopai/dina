/**
 * Nonce replay cache — prevents Ed25519 request replay attacks.
 *
 * Double-buffer design: two Sets alternate. On rotation, the "old" buffer
 * is discarded and the "current" becomes "old". A nonce is checked against
 * both buffers but only inserted into "current".
 *
 * Safety features (matching Go's _NonceCache):
 *   - Auto-rotation on time threshold (default 300s = 5 minutes)
 *   - Auto-rotation on size threshold (default 100,000 entries)
 *   - Prevents unbounded memory growth under DoS
 *
 * Source: core/internal/middleware/nonce.go, brain/src/adapter/signing.py
 */

/** Default rotation interval: 5 minutes (matches timestamp window). */
const DEFAULT_ROTATION_INTERVAL_MS = 300_000;

/** Default max entries before forced rotation (DoS protection). */
const DEFAULT_MAX_ENTRIES = 100_000;

export class NonceCache {
  private current: Set<string> = new Set();
  private previous: Set<string> = new Set();
  private lastRotation: number = Date.now();

  private readonly rotationIntervalMs: number;
  private readonly maxEntries: number;

  constructor(options?: { rotationIntervalMs?: number; maxEntries?: number }) {
    this.rotationIntervalMs = options?.rotationIntervalMs ?? DEFAULT_ROTATION_INTERVAL_MS;
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * Check if a nonce has been seen. If not, record it. If yes, reject.
   *
   * Auto-rotates on time threshold (5 minutes) or size threshold (100K entries).
   *
   * @param nonce - Hex string nonce from X-Nonce header
   * @returns true if nonce is fresh (not seen before), false if replayed
   */
  check(nonce: string): boolean {
    if (!nonce || nonce.length === 0) {
      return false; // empty nonce always rejected
    }

    // Auto-rotate if time or size threshold exceeded
    this.maybeRotate();

    // Check both buffers
    if (this.current.has(nonce) || this.previous.has(nonce)) {
      return false; // replay detected
    }

    // Fresh — record in current buffer
    this.current.add(nonce);
    return true;
  }

  /**
   * Rotate the double buffer.
   *
   * Discard the previous buffer and promote current → previous.
   * Can be called manually or triggered automatically by check().
   */
  rotate(): void {
    this.previous = this.current;
    this.current = new Set();
    this.lastRotation = Date.now();
  }

  /** Number of nonces currently tracked (both buffers). */
  size(): number {
    return this.current.size + this.previous.size;
  }

  /**
   * Auto-rotate if either threshold is exceeded:
   * - Time: rotationIntervalMs since last rotation (default 5 min)
   * - Size: current buffer exceeds maxEntries (default 100K)
   */
  private maybeRotate(): void {
    const now = Date.now();
    if (
      now - this.lastRotation >= this.rotationIntervalMs ||
      this.current.size >= this.maxEntries
    ) {
      this.rotate();
    }
  }
}
