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
  currentDataScope,
  isGuidedDemoScope,
  runReviewPublishTick as runSharedReviewPublishTick,
  type ReviewPublishRepository,
} from '@dina/core';

import { classifyPublishError } from './classify_publish_error';
import { publishAttestationToPDS } from './publish_attestation';
import type { PublishAttemptDeps } from './publish_attempt';

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

/**
 * Run ONE worker pass for the booted identity. No-op under a guided-demo scope.
 */
export async function runReviewPublishTick(deps: ReviewPublishWorkerDeps): Promise<DrainResult> {
  const result: DrainResult = { reclaimed: 0, published: 0, requeued: 0, failed: 0 };
  const isDemo = deps.isDemoScope ?? (() => isGuidedDemoScope(currentDataScope()));
  if (isDemo()) return result; // never publish real reviews under the demo scope
  const publishToPDS = deps.publishToPDS ?? publishAttestationToPDS;
  return runSharedReviewPublishTick({
    repo: deps.repo,
    ownerDid: deps.did,
    publish: (job, record) =>
      publishToPDS(deps.publisher, job.ownerDid, record, job.rkey),
    classifyError: classifyPublishError,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
}
