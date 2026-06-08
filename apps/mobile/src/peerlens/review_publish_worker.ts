/**
 * The PeerLens publish worker (drain) — replaces the old KV autodrain
 * (docs/PEERLENS_PUBLISH_JOBS_DESIGN.md §9). One tick: refuse to run under a
 * guided-demo scope, reap crashed leases, then claim + attempt each due job
 * (shared `attemptClaimedPublish`, so policy matches the inline path). Single-
 * flight is structural — the claim is a CAS, so overlapping ticks can't both
 * take the same row.
 *
 * `runReviewPublishTick` is the testable core; `startReviewPublishWorker`
 * (wired at boot, A6) schedules it on boot + every app foreground.
 */

import {
  MAX_PUBLISH_ATTEMPTS,
  PUBLISH_CLAIM_LEASE_MS,
  currentDataScope,
  isGuidedDemoScope,
  type ClassifiedError,
  type ReviewPublishRepository,
} from '@dina/core';

import { attemptClaimedPublish, type PublishAttemptDeps } from './publish_attempt';

import type { PDSPublisher } from '@dina/brain';

export interface ReviewPublishWorkerDeps {
  readonly repo: ReviewPublishRepository;
  readonly did: string;
  readonly publisher: PDSPublisher;
  readonly publishToPDS?: PublishAttemptDeps['publishToPDS'];
  readonly isDemoScope?: () => boolean;
  readonly now?: () => number;
}

export interface DrainResult {
  reclaimed: number;
  published: number;
  requeued: number;
  failed: number;
}

const RETRIES_EXHAUSTED: ClassifiedError = {
  class: 'permanent',
  code: 'retries_exhausted',
  message: 'retries exhausted',
};

/**
 * Run ONE worker pass for the booted identity. No-op under a guided-demo scope.
 */
export async function runReviewPublishTick(deps: ReviewPublishWorkerDeps): Promise<DrainResult> {
  const result: DrainResult = { reclaimed: 0, published: 0, requeued: 0, failed: 0 };
  const isDemo = deps.isDemoScope ?? (() => isGuidedDemoScope(currentDataScope()));
  if (isDemo()) return result; // never publish real reviews under the demo scope
  const now = deps.now ?? Date.now;

  // 1. Reap leases whose owner crashed mid-publish (publishing → queued).
  result.reclaimed = deps.repo.reclaimExpiredLeases(deps.did, now());

  // 2. Claim + attempt each due job. The claim is a CAS → single-flight.
  for (const due of deps.repo.listDue(deps.did, now())) {
    if (!deps.repo.claim(due.jobId, now(), PUBLISH_CLAIM_LEASE_MS)) continue; // lost to another claimer
    const job = deps.repo.getById(due.jobId);
    if (job === null) continue; // discarded between listDue and claim

    // A job reclaimed past the attempt cap is dead-lettered without re-publishing.
    if (job.attempts >= MAX_PUBLISH_ATTEMPTS) {
      deps.repo.fail(job.jobId, RETRIES_EXHAUSTED, now());
      result.failed++;
      continue;
    }

    const res = await attemptClaimedPublish(job, {
      repo: deps.repo,
      publisher: deps.publisher,
      publishToPDS: deps.publishToPDS,
      now: deps.now,
    });
    if (res.kind === 'published') result.published++;
    else if (res.kind === 'requeued') result.requeued++;
    else result.failed++;
  }
  return result;
}
