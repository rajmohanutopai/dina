/**
 * `submitReviewPublish` — the ONE entrypoint both the inline chat-draft card and
 * the write form call to publish a review (docs/PEERLENS_PUBLISH_JOBS_DESIGN.md
 * §4). No card-specific publish path, no test-inject-only path. It validates,
 * gates on credentials + the per-DID cap, creates the durable job, then runs ONE
 * inline publish attempt so an online user sees instant success/failure; a
 * transient failure leaves the job queued for the worker.
 */

import {
  MAX_PUBLISH_QUEUE,
  PUBLISH_CLAIM_LEASE_MS,
  currentDataScope,
  isGuidedDemoScope,
  type PublishErrorCode,
  type ReviewPublishRepository,
} from '@dina/core';

import { describePublishErrorCode } from './classify_publish_error';
import { attemptClaimedPublish } from './publish_attempt';
import { lexiconErrorFor } from './publish_attestation';

import type { AttestationDraftBody } from './review_draft_body';
import type { PDSPublisher } from '@dina/brain';

export interface SubmitReviewInput {
  readonly did: string;
  /** Present iff a PDS account is configured; `undefined` ⇒ no credentials
   *  (hard error — we do NOT queue). A configured-but-offline PDS still passes a
   *  publisher; the inline attempt fails network-retryable and the job queues. */
  readonly publisher: PDSPublisher | undefined;
  /** Stable AT-rkey (idempotent retries / edit-replace). */
  readonly rkey: string;
  /** Attestation record body WITHOUT `$type` (the publish path adds it). */
  readonly record: Record<string, unknown>;
  /** Minimal body the Outbox/card render. */
  readonly draft: AttestationDraftBody;
  /** Originating inline chat draft (the card finds its job by this back-reference). */
  readonly threadId?: string;
  readonly draftId?: string;

  // ── injectable seams (production defaults bound at the call site) ──
  readonly repo: ReviewPublishRepository;
  /** Caller-stamped now (the app passes `Date.now()`); used for `created_at`. */
  readonly nowMs: number;
  readonly newJobId: () => string;
  readonly publishToPDS?: Parameters<typeof attemptClaimedPublish>[1]['publishToPDS'];
  readonly isDemoScope?: () => boolean;
  readonly now?: () => number;
}

export type SubmitOutcome =
  | { kind: 'published'; uri: string; cid: string }
  | { kind: 'queued'; jobId: string }
  | { kind: 'error'; code: PublishErrorCode; message: string }
  | { kind: 'no_credentials' }
  | { kind: 'cap_exceeded' }
  | { kind: 'demo_scope' };

export async function submitReviewPublish(input: SubmitReviewInput): Promise<SubmitOutcome> {
  const isDemo = input.isDemoScope ?? (() => isGuidedDemoScope(currentDataScope()));

  // 0. Never create a real publish job under a guided-demo scope.
  if (isDemo()) return { kind: 'demo_scope' };

  // 1. Local lexicon validation — reject BEFORE persisting anything.
  if (lexiconErrorFor(input.record) !== null) {
    return { kind: 'error', code: 'lexicon_invalid', message: describePublishErrorCode('lexicon_invalid') };
  }

  // 2. Credential gate (locked): no configured PDS account → hard error, no queue.
  if (input.publisher === undefined) return { kind: 'no_credentials' };

  // 3. Per-identity cap (counts only THIS DID's active jobs).
  if (input.repo.countActive(input.did) >= MAX_PUBLISH_QUEUE) return { kind: 'cap_exceeded' };

  // 4. Create the durable job (single atomic write; carries thread/draft link).
  const jobId = input.newJobId();
  input.repo.create({
    jobId,
    ownerDid: input.did,
    rkey: input.rkey,
    recordJSON: JSON.stringify(input.record),
    draftJSON: JSON.stringify(input.draft),
    threadId: input.threadId,
    draftId: input.draftId,
    createdAt: input.nowMs,
  });

  // 5. Inline fast-path: claim + one attempt for instant feedback. Offline →
  // the attempt fails network-retryable and the job stays queued for the worker.
  if (!input.repo.claim(jobId, input.nowMs, PUBLISH_CLAIM_LEASE_MS)) {
    return { kind: 'queued', jobId }; // already claimed elsewhere — worker owns it
  }
  const job = input.repo.getById(jobId);
  if (job === null) return { kind: 'queued', jobId }; // vanished (raced) — defensive

  const res = await attemptClaimedPublish(job, {
    repo: input.repo,
    publisher: input.publisher,
    publishToPDS: input.publishToPDS,
    now: input.now,
  });
  if (res.kind === 'published') return { kind: 'published', uri: res.uri, cid: res.cid };
  if (res.kind === 'requeued') return { kind: 'queued', jobId };
  return { kind: 'error', code: res.error.code, message: describePublishErrorCode(res.error.code) };
}
