/**
 * Outbox retry orchestrator — background retry of failed D2D deliveries.
 *
 * Runs periodically: get pending messages → attempt delivery → mark result.
 * Error isolation per message — one failure doesn't stop others.
 *
 * Source: ARCHITECTURE.md Task 6.14
 */

import {
  getPendingForRetry,
  markDelivered,
  markFailed,
  deleteExpired,
  type OutboxEntry,
} from './outbox';
import { deliverMessage, type ServiceType } from './delivery';

export interface RetryResult {
  attempted: number;
  delivered: number;
  failed: number;
  expired: number;
}

/** Default outbox TTL in seconds (24 hours). */
const OUTBOX_TTL_S = 24 * 60 * 60;

/** Injectable delivery function (for testing). */
let deliveryFn: ((recipientDID: string, payload: Uint8Array) => Promise<boolean>) | null = null;

/** Register a delivery function (for testing). */
export function setRetryDeliveryFn(
  fn: (recipientDID: string, payload: Uint8Array) => Promise<boolean>,
): void {
  deliveryFn = fn;
}

/** Reset (for testing). */
export function resetRetryState(): void {
  deliveryFn = null;
}

/**
 * Retry all pending outbox messages.
 *
 * Gets messages where nextRetryAt <= now, attempts delivery,
 * marks as delivered or failed. Also sweeps expired messages.
 *
 * Error-isolated: each message is retried independently.
 */
export async function retryPendingOutbox(now?: number): Promise<RetryResult> {
  const result: RetryResult = { attempted: 0, delivered: 0, failed: 0, expired: 0 };

  // 1. Sweep expired messages first
  result.expired = deleteExpired(OUTBOX_TTL_S, now);

  // 2. Get messages ready for retry
  const pending = getPendingForRetry(now);

  for (const entry of pending) {
    result.attempted++;

    try {
      const success = deliveryFn ? await deliveryFn(entry.recipientDID, entry.payload) : false;

      if (success) {
        markDelivered(entry.id);
        result.delivered++;
      } else {
        markFailed(entry.id);
        result.failed++;
      }
    } catch {
      // Delivery threw — mark as failed for backoff
      try {
        markFailed(entry.id);
      } catch {
        /* entry might have been expired/deleted */
      }
      result.failed++;
    }
  }

  return result;
}

/**
 * Get the current outbox retry status.
 */
export function getRetryStatus(now?: number): { pending: number; nextRetryIn?: number } {
  const pending = getPendingForRetry(now);
  if (pending.length === 0) {
    return { pending: 0 };
  }

  const nextEntry = pending[0];
  const currentTime = now ?? Date.now();
  const nextRetryIn = Math.max(0, nextEntry.nextRetryAt - currentTime);

  return { pending: pending.length, nextRetryIn };
}
