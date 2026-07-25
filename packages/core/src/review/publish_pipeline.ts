/**
 * Runtime-neutral PeerLens publish pipeline.
 *
 * Core owns the durable job state machine. The runtime supplies only two
 * policy-free adapters: a writer that performs one idempotent PDS write and an
 * error classifier. Mobile and Home Node Lite use this same claim/lease/retry
 * implementation, so their outboxes cannot drift.
 */

import {
  MAX_PUBLISH_ATTEMPTS,
  PUBLISH_CLAIM_LEASE_MS,
  publishBackoffMs,
  type ClassifiedError,
  type PublishJob,
} from './publish_job';

import type { ReviewPublishRepository } from './publish_job_repository';

export interface PublishReceipt {
  uri: string;
  cid: string;
}

export type ReviewRecordWriter = (
  job: PublishJob,
  record: Record<string, unknown>,
) => Promise<PublishReceipt>;

export type ReviewPublishErrorClassifier = (error: unknown) => ClassifiedError;

export interface PublishClaimedReviewDeps {
  repo: ReviewPublishRepository;
  publish: ReviewRecordWriter;
  classifyError: ReviewPublishErrorClassifier;
  now?: () => number;
}

export type PublishClaimedReviewResult =
  | { kind: 'published'; uri: string; cid: string }
  | { kind: 'requeued'; error: ClassifiedError }
  | { kind: 'failed'; error: ClassifiedError }
  | { kind: 'lost' };

const CORRUPT_JOB: ClassifiedError = {
  class: 'permanent',
  code: 'lexicon_invalid',
  message: 'stored review record is not valid JSON',
};

const RETRIES_EXHAUSTED: ClassifiedError = {
  class: 'permanent',
  code: 'retries_exhausted',
  message: 'retries exhausted',
};

/**
 * Publish one already-claimed job and apply its fenced terminal transition.
 * A stale worker can never alter a row after another worker reclaims its lease.
 */
export async function publishClaimedReview(
  job: PublishJob,
  deps: PublishClaimedReviewDeps,
): Promise<PublishClaimedReviewResult> {
  const claimedAt = job.claimedAt;
  if (claimedAt === null) return { kind: 'lost' };

  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(job.recordJSON);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('record is not an object');
    }
    record = parsed as Record<string, unknown>;
  } catch {
    const failed = deps.repo.fail(job.jobId, CORRUPT_JOB, (deps.now ?? Date.now)(), claimedAt);
    return failed ? { kind: 'failed', error: CORRUPT_JOB } : { kind: 'lost' };
  }

  const now = deps.now ?? Date.now;
  try {
    const receipt = await deps.publish(job, record);
    return deps.repo.complete(job.jobId, receipt.uri, receipt.cid, now(), claimedAt)
      ? { kind: 'published', ...receipt }
      : { kind: 'lost' };
  } catch (error) {
    const classified = deps.classifyError(error);
    const at = now();
    if (classified.class === 'permanent') {
      return deps.repo.fail(job.jobId, classified, at, claimedAt)
        ? { kind: 'failed', error: classified }
        : { kind: 'lost' };
    }

    const attempts = job.attempts + 1;
    if (attempts >= MAX_PUBLISH_ATTEMPTS) {
      const exhausted: ClassifiedError = {
        ...RETRIES_EXHAUSTED,
        message: classified.message,
      };
      return deps.repo.fail(job.jobId, exhausted, at, claimedAt)
        ? { kind: 'failed', error: exhausted }
        : { kind: 'lost' };
    }

    return deps.repo.requeue(
      job.jobId,
      attempts,
      at + publishBackoffMs(attempts),
      classified,
      at,
      claimedAt,
    )
      ? { kind: 'requeued', error: classified }
      : { kind: 'lost' };
  }
}

export interface ReviewPublishTickDeps extends Omit<PublishClaimedReviewDeps, 'now'> {
  ownerDid: string;
  now?: () => number;
}

export interface ReviewPublishTickResult {
  reclaimed: number;
  published: number;
  requeued: number;
  failed: number;
}

/** Run one bounded, single-flight drain pass for one owning DID. */
export async function runReviewPublishTick(
  deps: ReviewPublishTickDeps,
): Promise<ReviewPublishTickResult> {
  const result: ReviewPublishTickResult = {
    reclaimed: 0,
    published: 0,
    requeued: 0,
    failed: 0,
  };
  const now = deps.now ?? Date.now;

  result.reclaimed = deps.repo.reclaimExpiredLeases(deps.ownerDid, now());
  for (const due of deps.repo.listDue(deps.ownerDid, now())) {
    if (!deps.repo.claim(due.jobId, now(), PUBLISH_CLAIM_LEASE_MS)) continue;
    const job = deps.repo.getById(due.jobId);
    if (job === null || job.claimedAt === null) continue;

    if (job.attempts >= MAX_PUBLISH_ATTEMPTS) {
      if (deps.repo.fail(job.jobId, RETRIES_EXHAUSTED, now(), job.claimedAt)) {
        result.failed++;
      }
      continue;
    }

    const outcome = await publishClaimedReview(job, deps);
    if (outcome.kind === 'published') result.published++;
    else if (outcome.kind === 'requeued') result.requeued++;
    else if (outcome.kind === 'failed') result.failed++;
  }
  return result;
}
