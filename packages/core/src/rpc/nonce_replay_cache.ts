/**
 * Nonce replay cache for `/forward` MsgBox messages.
 *
 * Each forward message carries a canonical signature over
 * `(sender_did, recipient_did, nonce, created_time)`. A previously-seen
 * nonce from the same sender IS a replay regardless of signature
 * validity — reject without dispatching. The recipient DID is part of
 * the canonical signature so the same nonce reused against a different
 * recipient still looks distinct on the wire (important for sharded
 * MsgBox deployments where multiple recipients share an inbox).
 *
 * Storage: in-memory LRU with TTL. Production `MsgBox` retains seen
 * nonces for the signature freshness window (default 5 min — matches
 * idempotency cache).
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md CORE-P0-010.
 */

/** Default TTL: 5 minutes in ms — matches signature freshness window. */
export const DEFAULT_NONCE_TTL_MS = 5 * 60 * 1000;

export interface NonceReplayCacheOptions {
  nowMsFn?: () => number;
  ttlMs?: number;
  /** Hard cap on concurrent remembered nonces. Default 50_000. */
  maxEntries?: number;
}

export class NonceReplayCache {
  private readonly seen = new Map<string, number>(); // key → expiresAtMs
  private readonly nowMsFn: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: NonceReplayCacheOptions = {}) {
    this.nowMsFn = options.nowMsFn ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_NONCE_TTL_MS;
    this.maxEntries = options.maxEntries ?? 50_000;
    if (this.ttlMs <= 0) {
      throw new Error('NonceReplayCache: ttlMs must be positive');
    }
    if (this.maxEntries <= 0) {
      throw new Error('NonceReplayCache: maxEntries must be positive');
    }
  }

  /**
   * Check-and-remember. Returns `true` when the nonce is **accepted**
   * (first sighting), `false` when it is a replay and should be dropped.
   * Recipient DID is part of the key because the canonical signature
   * includes it.
   */
  accept(senderDid: string, recipientDid: string, nonce: string): boolean {
    const key = this.key(senderDid, recipientDid, nonce);
    const now = this.nowMsFn();
    const existingDeadline = this.seen.get(key);
    if (existingDeadline !== undefined) {
      if (existingDeadline > now) return false; // live replay
      this.seen.delete(key); // expired, drop + re-accept below
    }
    this.seen.set(key, now + this.ttlMs);
    if (this.seen.size > this.maxEntries) {
      this.evictOldest(now);
    }
    return true;
  }

  size(): number {
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
  }

  private key(senderDid: string, recipientDid: string, nonce: string): string {
    return `${senderDid}\x00${recipientDid}\x00${nonce}`;
  }

  private evictOldest(now: number): void {
    for (const [k, v] of this.seen) {
      if (v <= now) this.seen.delete(k);
    }
    while (this.seen.size > this.maxEntries) {
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey === undefined) break;
      this.seen.delete(oldestKey);
    }
  }
}
