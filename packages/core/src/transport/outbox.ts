/**
 * D2D outbox — durable message queue with exponential backoff retry.
 *
 * Enqueue → pending. Deliver → delivered (kept for audit). Fail → retry with
 * backoff (30s, 60s, 120s, 240s, 480s). Dead-letter after 5 retries.
 * Expire after 24h TTL (delivered and failed only).
 *
 * Source: core/test/d2d_phase2_test.go
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface OutboxEntry {
  id: string;
  recipientDID: string;
  payload: Uint8Array;
  status: 'pending' | 'delivered' | 'failed';
  retryCount: number;
  nextRetryAt: number;
  createdAt: number;
}

/** Backoff base: 30 seconds (matching Go's MarkFailed: 30s * 2^retries). */
const BASE_BACKOFF_MS = 30_000;

/** Maximum retries before dead-letter (matching Go's maxRetries = 5). */
export const MAX_RETRIES = 5;

/** Maximum outbox queue size (matching Go's default of 100). */
export const MAX_QUEUE_SIZE = 100;

/** In-memory outbox keyed by message ID. */
const outbox = new Map<string, OutboxEntry>();

/** Clear all outbox entries (for testing). */
export function clearOutbox(): void {
  outbox.clear();
}

/** Get the current outbox size (for testing). */
export function outboxSize(): number {
  return outbox.size;
}

/**
 * Compute next retry delay in ms using exponential backoff.
 *
 * Formula: 30000 * 2^retryCount (matching Go's 30s base).
 * Sequence: 30s → 60s → 120s → 240s → 480s.
 * No cap needed — MAX_RETRIES = 5 limits the max delay to ~8 minutes.
 */
export function computeBackoff(retryCount: number): number {
  return BASE_BACKOFF_MS * Math.pow(2, retryCount);
}

/**
 * Enqueue a D2D message for delivery. Returns the unique message ID.
 *
 * Message starts as 'pending' with nextRetryAt = now (immediately eligible).
 * Rejects if queue is at capacity (MAX_QUEUE_SIZE = 100, matching Go).
 *
 * @throws Error if outbox is full
 */
export function enqueueMessage(recipientDID: string, payload: Uint8Array): string {
  if (outbox.size >= MAX_QUEUE_SIZE) {
    throw new Error(
      `outbox: queue full (${MAX_QUEUE_SIZE} messages). Deliver or expire existing messages first.`,
    );
  }

  const id = `msg-${bytesToHex(randomBytes(8))}`;
  const now = Date.now();
  outbox.set(id, {
    id,
    recipientDID,
    payload,
    status: 'pending',
    retryCount: 0,
    nextRetryAt: now,
    createdAt: now,
  });
  return id;
}

/**
 * Get queue utilization as a fraction [0, 1].
 * Useful for backpressure monitoring.
 */
export function getQueueUtilization(): number {
  return outbox.size / MAX_QUEUE_SIZE;
}

/**
 * Mark a message as delivered.
 *
 * Keeps the record with status 'delivered' for audit trail
 * (matching Go which keeps delivered records). The record will be
 * cleaned up by deleteExpired after TTL.
 *
 * No-op if the message doesn't exist (idempotent).
 */
export function markDelivered(messageId: string): void {
  const entry = outbox.get(messageId);
  if (entry) {
    entry.status = 'delivered';
  }
}

/**
 * Mark a message as failed — increment retry, compute next backoff.
 *
 * After MAX_RETRIES (5), the message stays in 'failed' status and
 * is no longer eligible for retry (dead-lettered). It will be cleaned
 * up by deleteExpired after TTL.
 *
 * Throws if message not found.
 */
export function markFailed(messageId: string): void {
  const entry = outbox.get(messageId);
  if (!entry) throw new Error(`outbox: message ${messageId} not found`);

  entry.retryCount += 1;
  entry.status = 'failed';
  entry.nextRetryAt = Date.now() + computeBackoff(entry.retryCount);
}

/**
 * Check if a message has exceeded the maximum retry count (dead-lettered).
 */
export function isDeadLettered(messageId: string): boolean {
  const entry = outbox.get(messageId);
  if (!entry) return false;
  return entry.retryCount >= MAX_RETRIES;
}

/**
 * Get all pending/failed messages ready for retry (nextRetryAt <= now).
 *
 * Returns entries sorted by nextRetryAt (oldest first).
 */
export function getPendingForRetry(now?: number): OutboxEntry[] {
  const currentTime = now ?? Date.now();
  const ready: OutboxEntry[] = [];

  for (const entry of outbox.values()) {
    if (
      (entry.status === 'pending' || entry.status === 'failed') &&
      entry.retryCount < MAX_RETRIES &&
      entry.nextRetryAt <= currentTime
    ) {
      ready.push(entry);
    }
  }

  return ready.sort((a, b) => a.nextRetryAt - b.nextRetryAt);
}

/**
 * Delete messages older than TTL. Returns count deleted.
 *
 * TTL is in seconds. Checks createdAt against (now - ttl).
 */
/**
 * Delete expired messages. Returns count deleted.
 *
 * Only deletes 'delivered' or 'failed' messages past the TTL cutoff.
 * Pending messages are kept even if old (matching Go which only
 * deletes delivered|failed entries).
 */
export function deleteExpired(ttlSeconds: number, now?: number): number {
  const currentTime = now ?? Date.now();
  const cutoff = currentTime - ttlSeconds * 1000;
  let deleted = 0;

  for (const [id, entry] of outbox.entries()) {
    if (entry.createdAt < cutoff && (entry.status === 'delivered' || entry.status === 'failed')) {
      outbox.delete(id);
      deleted++;
    }
  }

  return deleted;
}

/**
 * Resume a message after approval — sets to pending for immediate retry.
 *
 * Used when a held message's approval gate clears.
 * Throws if message not found.
 */
export function resumeAfterApproval(messageId: string): void {
  const entry = outbox.get(messageId);
  if (!entry) throw new Error(`outbox: message ${messageId} not found`);

  entry.status = 'pending';
  entry.nextRetryAt = Date.now();
}
