/**
 * The ONE place a claimed publish job is attempted and its outcome recorded as
 * a transition — shared by the inline submit fast-path and the durable worker
 * (docs/PEERLENS_PUBLISH_JOBS_DESIGN.md §5/§9). Keeping it in one function is
 * what guarantees the immediate path and the worker apply identical retry +
 * receipt rules.
 */

import {
  publishClaimedReview,
  type PublishJob,
  type PublishClaimedReviewResult,
  type ReviewPublishRepository,
} from '@dina/core';

import { classifyPublishError } from './classify_publish_error';
import { publishAttestationToPDS } from './publish_attestation';

import type { PDSPublisher } from '@dina/brain';

export interface PublishAttemptDeps {
  readonly repo: ReviewPublishRepository;
  readonly publisher: PDSPublisher;
  /** Injectable for tests; defaults to the real sovereign PDS publish. */
  readonly publishToPDS?: (
    pds: PDSPublisher,
    expectedDid: string,
    record: Record<string, unknown>,
    rkey: string,
  ) => Promise<{ uri: string; cid: string }>;
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

export type PublishAttemptResult = PublishClaimedReviewResult;

/**
 * Attempt to publish a job that is ALREADY claimed (`status='publishing'`), and
 * record the result as the next transition. EVERY transition is a CAS guarded on
 * `status='publishing'`: if it returns false (the lease lapsed and another tick
 * reclaimed the row) we return `lost` rather than asserting an outcome we didn't
 * durably apply.
 *   - success    → `published` (receipt on the row; pruned if no chat card needs it)
 *   - retryable  → `requeued` with `attempts++` + backoff
 *   - permanent / retries exhausted → `failed`
 *   - CAS lost   → `lost`
 */
export async function attemptClaimedPublish(
  job: PublishJob,
  deps: PublishAttemptDeps,
): Promise<PublishAttemptResult> {
  const publishToPDS = deps.publishToPDS ?? publishAttestationToPDS;
  return publishClaimedReview(job, {
    repo: deps.repo,
    publish: (_job, record) =>
      publishToPDS(deps.publisher, job.ownerDid, record, job.rkey),
    classifyError: classifyPublishError,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
}
