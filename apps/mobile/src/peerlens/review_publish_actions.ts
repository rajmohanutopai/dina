/**
 * UI actions on a publish job — shared by the inline chat card and the Outbox
 * screen so both drive the SAME durable state machine. Cancel/dismiss deletes
 * the job (the card then reverts to its editable draft); retry resets a
 * dead-letter and drains immediately.
 */

import { getReviewPublishRepository } from '@dina/core';

import { canDrainReviewPublish, drainReviewPublishNow } from './review_publish_autodrain';

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
 *
 * No-op unless a drain can actually publish (`canDrainReviewPublish`). If there's
 * no PDS publisher (credentials gone) or we're under a guided-demo scope, the
 * worker would only no-op — so resetting would strand the job as an undrainable
 * `queued` row, hiding both the failure copy and the "Try again" handle and
 * bypassing the submit-time credential/demo gates. We leave it `failed` so the
 * user keeps the error + can retry once a publisher is available again.
 *
 * @returns `true` if the job was reset + a drain ran; `false` if it couldn't.
 */
export async function retryReviewPublishJob(jobId: string): Promise<boolean> {
  const repo = getReviewPublishRepository();
  if (repo === null || !canDrainReviewPublish()) return false;
  // Honor the CAS: `retry` only succeeds from `failed`. A double-tap / stale UI
  // where the row is already dismissed or re-queued returns false — don't drain
  // or report a reset that never happened.
  if (!repo.retry(jobId, Date.now())) return false;
  await drainReviewPublishNow();
  return true;
}
