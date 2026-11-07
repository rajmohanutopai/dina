/**
 * Adversarial transport validation — payload size limits, replay detection.
 *
 * Validates inbound D2D messages before processing:
 * - Size limit: 1 MiB default (configurable)
 * - Empty payloads rejected
 * - Message ID replay detection: seen keys persist (replay_repository.ts),
 *   and messages older than the 24-hour window are refused
 *
 * Source: core/test/transport_adversarial_test.go
 */

import {
  getReplayRepository,
  InMemoryReplayRepository,
  type ReplayRepository,
} from './replay_repository';

/** Default maximum payload size: 1 MiB. */
const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * Replay window: 24 hours in seconds. A message older than this is refused
 * outright, so the seen-key store only has to remember a day.
 */
const DEFAULT_REPLAY_TTL = 86400;

/** Slack for a sender whose clock runs a little ahead of ours. */
const REPLAY_HOLD_SLACK = 300;

/** Used until boot wires the SQLite store (tests, early boot). */
const memoryReplay = new InMemoryReplayRepository();

function activeReplay(): ReplayRepository {
  return getReplayRepository() ?? memoryReplay;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * `created_time` in Unix seconds. TS senders stamp milliseconds, the legacy
 * Go stack seconds; anything below 1e11 is read as seconds.
 */
function createdSeconds(createdTime: number): number {
  return createdTime < 1e11 ? Math.floor(createdTime) : Math.floor(createdTime / 1000);
}

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
 * Returns true if the ID is held (replayed).
 */
export function isReplayedMessage(messageId: string): boolean {
  return activeReplay().has(messageId, nowSeconds());
}

/**
 * True when a message's `created_time` is older than the replay window, or
 * not a number. The seen-key store forgets keys after the window, so such a
 * message can no longer be told apart from a replay and is refused.
 */
export function isStaleMessage(createdTime: unknown, ttlSeconds?: number): boolean {
  if (typeof createdTime !== 'number' || !Number.isFinite(createdTime)) return true;
  const ttl = ttlSeconds ?? DEFAULT_REPLAY_TTL;
  return createdSeconds(createdTime) < nowSeconds() - ttl;
}

/**
 * Record a message ID as seen. With the message's `created_time`, the key is
 * held until that message would fail `isStaleMessage` anyway, so a sender
 * whose clock runs ahead cannot outlast the hold.
 */
export function recordMessageId(messageId: string, createdTime?: number): void {
  const now = nowSeconds();
  const created =
    typeof createdTime === 'number' && Number.isFinite(createdTime)
      ? createdSeconds(createdTime)
      : now;
  activeReplay().record(messageId, Math.max(now, created) + DEFAULT_REPLAY_TTL + REPLAY_HOLD_SLACK);
}

/**
 * Purge seen keys whose hold has ended.
 *
 * @returns count of purged entries
 */
export function purgeReplayCache(): number {
  return activeReplay().purgeExpired(nowSeconds());
}

/** Clear replay cache (for testing). */
export function clearReplayCache(): void {
  activeReplay().clear();
}
