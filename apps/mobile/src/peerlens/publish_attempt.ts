/**
 * The ONE place a claimed publish job is attempted and its outcome recorded as
 * a transition — shared by the inline submit fast-path and the durable worker
 * (docs/PEERLENS_PUBLISH_JOBS_DESIGN.md §5/§9). Keeping it in one function is
 * what guarantees the immediate path and the worker apply identical retry +
 * receipt rules.
 */

import {
  MAX_PUBLISH_ATTEMPTS,
  publishBackoffMs,
  type ClassifiedError,
  type PublishJob,
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

export type PublishAttemptResult =
  | { kind: 'published'; uri: string; cid: string }
  | { kind: 'requeued'; error: ClassifiedError }
  | { kind: 'failed'; error: ClassifiedError };

/**
 * Attempt to publish a job that is ALREADY claimed (`status='publishing'`), and
 * record the result as the next transition:
 *   - success    → `published` receipt-on-message + prune, atomically
 *   - retryable  → `requeued` with `attempts++` + backoff
 *   - permanent / retries exhausted → `failed`
 */
export async function attemptClaimedPublish(
  job: PublishJob,
  deps: PublishAttemptDeps,
): Promise<PublishAttemptResult> {
  const publishToPDS = deps.publishToPDS ?? publishAttestationToPDS;
  const now = deps.now ?? Date.now;
  try {
    const record = JSON.parse(job.recordJSON) as Record<string, unknown>;
    const { uri, cid } = await publishToPDS(deps.publisher, job.ownerDid, record, job.rkey);
    // `complete` records the receipt (uri/cid) ON the job row and CAS-guards on
    // status='publishing': a job reclaimed mid-write (lease expired) makes this a
    // no-op rather than resurrecting a published row — the reclaimed job
    // re-publishes idempotently via the stable rkey and completes next time.
    // The card projects the `published` state straight off this row (Deviation
    // #2), so there is no chat-message write to couple here.
    deps.repo.complete(job.jobId, uri, cid, now());
    return { kind: 'published', uri, cid };
  } catch (err) {
    const c = classifyPublishError(err);
    const t = now();
    if (c.class === 'permanent') {
      deps.repo.fail(job.jobId, c, t);
      return { kind: 'failed', error: c };
    }
    const nextAttempts = job.attempts + 1;
    if (nextAttempts >= MAX_PUBLISH_ATTEMPTS) {
      const exhausted: ClassifiedError = {
        class: 'permanent',
        code: 'retries_exhausted',
        message: c.message,
      };
      deps.repo.fail(job.jobId, exhausted, t);
      return { kind: 'failed', error: exhausted };
    }
    deps.repo.requeue(job.jobId, nextAttempts, t + publishBackoffMs(nextAttempts), c, t);
    return { kind: 'requeued', error: c };
  }
}
