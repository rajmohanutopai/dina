/**
 * UI actions on a publish job — shared by the inline chat card and the Outbox
 * screen so both drive the SAME durable state machine. Cancel/dismiss deletes
 * the job (the card then reverts to its editable draft); retry resets a
 * dead-letter and drains immediately.
 */

import { getReviewPublishRepository } from '@dina/core';

import { drainReviewPublishNow } from './review_publish_autodrain';

/**
 * Cancel a queued review or dismiss a failed one: delete the job. The inline
 * card (a projection) then falls back to its editable draft; the Outbox row
 * disappears. No-op on a `publishing` job (the repo refuses — the write is on
 * the wire) or when the repo isn't wired.
 */
export function cancelReviewPublishJob(jobId: string): boolean {
  const repo = getReviewPublishRepository();
  return repo !== null && repo.discard(jobId);
}

/**
 * "Try again" on a failed / dead-lettered job: reset its attempts to `queued`
 * and run a worker pass now so it republishes without waiting for a foreground.
 */
export async function retryReviewPublishJob(jobId: string): Promise<void> {
  const repo = getReviewPublishRepository();
  if (repo === null) return;
  repo.retry(jobId, Date.now());
  await drainReviewPublishNow();
}
