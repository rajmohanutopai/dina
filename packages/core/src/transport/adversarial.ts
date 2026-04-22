/**
 * Adversarial transport validation — payload size limits, replay detection.
 *
 * Validates inbound D2D messages before processing:
 * - Size limit: 1 MiB default (configurable)
 * - Empty payloads rejected
 * - Message ID replay detection with 24-hour TTL cache
 *
 * Source: core/test/transport_adversarial_test.go
 */

/** Default maximum payload size: 1 MiB. */
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** Default replay cache TTL: 24 hours in seconds. */
const DEFAULT_REPLAY_TTL = 86400;

/** Replay cache: message ID → timestamp (seconds) when recorded. */
const replayCache = new Map<string, number>();

/**
 * Validate a D2D payload before processing (size, format).
 *
 * @param payload - Raw payload bytes
 * @returns { valid, reason? }
 */
export function validateInboundPayload(payload: Uint8Array): { valid: boolean; reason?: string } {
  if (!payload || payload.length === 0) {
    return { valid: false, reason: 'empty payload' };
  }

  if (isPayloadOversized(payload)) {
    return {
      valid: false,
      reason: `payload exceeds ${DEFAULT_MAX_BYTES} bytes (got ${payload.length})`,
    };
  }

  return { valid: true };
}

/**
 * Check if a payload exceeds the maximum allowed size.
 * Default: 1 MiB (1,048,576 bytes). Exactly 1 MiB is allowed.
 *
 * @param payload - Raw payload bytes
 * @param maxBytes - Custom maximum (default: 1 MiB)
 */
export function isPayloadOversized(payload: Uint8Array, maxBytes?: number): boolean {
  const limit = maxBytes ?? DEFAULT_MAX_BYTES;
  return payload.length > limit;
}

/**
 * Check if a message ID has been seen before (replay detection).
 * Returns true if the ID is in the cache (replayed).
 */
export function isReplayedMessage(messageId: string): boolean {
  return replayCache.has(messageId);
}

/**
 * Record a message ID in the replay cache.
 */
export function recordMessageId(messageId: string): void {
  replayCache.set(messageId, Math.floor(Date.now() / 1000));
}

/**
 * Purge replay cache entries older than TTL.
 *
 * @param ttlSeconds - TTL in seconds (default: 24 hours)
 * @returns count of purged entries
 */
export function purgeReplayCache(ttlSeconds?: number): number {
  const ttl = ttlSeconds ?? DEFAULT_REPLAY_TTL;
  const now = Math.floor(Date.now() / 1000);
  let purged = 0;

  for (const [id, recordedAt] of replayCache.entries()) {
    if (now - recordedAt > ttl) {
      replayCache.delete(id);
      purged++;
    }
  }

  return purged;
}

/** Clear replay cache (for testing). */
export function clearReplayCache(): void {
  replayCache.clear();
}
