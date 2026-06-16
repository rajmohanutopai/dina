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
  | { kind: 'failed'; error: ClassifiedError }
  /** The CAS transition didn't apply — the lease expired mid-write and another
   *  tick reclaimed the row. This attempt makes no claim about durable state;
   *  the owning tick records the real outcome (re-publish is idempotent). */
  | { kind: 'lost' };

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
  const now = deps.now ?? Date.now;
  // The lease token this attempt owns. Every terminal transition is FENCED on it
  // (`AND claimed_at=?`): if the lease lapsed mid-write and another tick reclaimed
  // + re-claimed the row, our claimedAt no longer matches → the CAS returns false
  // → `lost`, so we never complete/requeue/fail a DIFFERENT attempt's row. A
  // not-yet-claimed job should never reach here; treat it as lost defensively.
  const claimedAt = job.claimedAt;
  if (claimedAt === null) return { kind: 'lost' };
  try {
    const record = JSON.parse(job.recordJSON) as Record<string, unknown>;
    const { uri, cid } = await publishToPDS(deps.publisher, job.ownerDid, record, job.rkey);
    // CAS publishing→published, recording the receipt (uri/cid) ON the row — and
    // KEEP the row for BOTH chat-card and full-form publishes. The chat card
    // projects it as its receipt; the reviewer dashboard projects full-form
    // `published` rows inline as "Publishing…" until AppView indexes the review.
    // (prune-when-listed: the dashboard reconcile-prunes the receipt once the
    // review's URI shows in the authored list, with `prunePublished` TTL as the
    // backstop — so these no longer leak the way the old inline prune guarded.)
    // False ⇒ the lease lapsed mid-write and another tick reclaimed it: the
    // review IS public (idempotent rkey) but this attempt didn't own the
    // transition → report `lost`, don't claim a publish we didn't durably set.
    if (!deps.repo.complete(job.jobId, uri, cid, now(), claimedAt)) return { kind: 'lost' };
    return { kind: 'published', uri, cid };
  } catch (err) {
    const c = classifyPublishError(err);
    const t = now();
    if (c.class === 'permanent') {
      return deps.repo.fail(job.jobId, c, t, claimedAt) ? { kind: 'failed', error: c } : { kind: 'lost' };
    }
    const nextAttempts = job.attempts + 1;
    if (nextAttempts >= MAX_PUBLISH_ATTEMPTS) {
      const exhausted: ClassifiedError = {
        class: 'permanent',
        code: 'retries_exhausted',
        message: c.message,
      };
      return deps.repo.fail(job.jobId, exhausted, t, claimedAt)
        ? { kind: 'failed', error: exhausted }
        : { kind: 'lost' };
    }
    return deps.repo.requeue(job.jobId, nextAttempts, t + publishBackoffMs(nextAttempts), c, t, claimedAt)
      ? { kind: 'requeued', error: c }
      : { kind: 'lost' };
  }
}
