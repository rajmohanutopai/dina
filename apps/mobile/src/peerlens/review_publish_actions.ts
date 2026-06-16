/**
 * UI actions on a publish job — shared by the inline chat card and the Outbox
 * screen so both drive the SAME durable state machine. Cancel/dismiss deletes
 * the job (the card then reverts to its editable draft); retry resets a
 * dead-letter and drains immediately.
 */

import { getBootedNode } from '../hooks/useNodeBootstrap';

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
 * Dismiss a `published` receipt: delete the row. The review IS public (this only
 * drops the local "Publishing…" placeholder the reviewer dashboard shows while
 * AppView indexes it). Unlike `cancelReviewPublishJob` (discard, queued/failed
 * only), this prunes — the row is already `published`. Returns false if the repo
 * isn't wired. (No CAS: prune is unconditional; callers pass a receipt jobId.)
 */
export function dismissReviewPublishReceipt(jobId: string): boolean {
  const repo = getReviewPublishRepository();
  if (repo === null) return false;
  repo.prune(jobId);
  return true;
}

/**
 * Retention sweep: prune the booted identity's `published` receipts older than
 * `olderThanMs` (by receipt time). Backstop for receipts the reviewer dashboard
 * never got to reconcile (published, then the user never reopened the profile),
 * so they don't accumulate. No-op without a repo / booted node.
 */
export function pruneStaleReviewReceipts(olderThanMs: number): number {
  const repo = getReviewPublishRepository();
  const node = getBootedNode();
  if (repo === null || node === null || node.did.length === 0) return 0;
  // `prunePublished` takes an ABSOLUTE cutoff (deletes receipts with
  // `updated_at < cutoff`); convert the TTL DURATION to `now − ttl`.
  return repo.prunePublished(node.did, Date.now() - olderThanMs);
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
