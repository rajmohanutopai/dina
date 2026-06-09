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

  // The existing job for THIS submission (if any) drives both the dedup
  // projection and the failed-supersede. Keyed by the chat back-reference when
  // there is one, else by (did, rkey) — full-form submits carry no thread/draft,
  // and the rkey is stable per compose session, so a corrected re-submit
  // supersedes the stale failed job instead of leaving a duplicate that its "Try
  // again" could publish. Captured once — every step below is synchronous until
  // the inline attempt, so it can't change underneath us.
  const existing =
    input.threadId !== undefined && input.draftId !== undefined
      ? input.repo.findLatestForDraft(input.did, input.threadId, input.draftId)
      : input.repo.findLatestForRkey(input.did, input.rkey);

  // 1. Already published → idempotent receipt — ONLY when found via the chat
  // back-reference (thread+draft). A re-rendered / double-tapped chat card
  // re-submits the SAME draft and must get its receipt back, never republish.
  // We deliberately do NOT short-circuit a published row found by RKEY: full-form
  // published jobs are pruned, so such a row is a RETAINED CHAT RECEIPT that
  // merely shares the rkey — and the reviewer EDIT flow re-submits (no
  // thread/draft) with the original's rkey precisely to REPLACE the record, so
  // returning the old receipt here would silently drop the user's edit.
  if (
    input.threadId !== undefined &&
    input.draftId !== undefined &&
    existing?.status === 'published'
  ) {
    return { kind: 'published', uri: existing.publishedUri ?? '', cid: existing.publishedCid ?? '' };
  }

  // 2. Credential gate — BEFORE the queued projection. If this boot has no PDS
  // account (credentials removed / not configured), surface the hard
  // no_credentials state so the user gets a setup prompt, rather than returning
  // `queued` for a job the worker can never drain (it also skips without a publisher).
  if (input.publisher === undefined) return { kind: 'no_credentials' };

  // 3. Already in flight → project it; don't mint a second job (double-tap /
  // re-render race / form+inline both publishing the same draft → duplicates).
  if (existing?.status === 'queued' || existing?.status === 'publishing') {
    return { kind: 'queued', jobId: existing.jobId };
  }

  // 4. Local lexicon validation — reject BEFORE persisting anything.
  if (lexiconErrorFor(input.record) !== null) {
    return { kind: 'error', code: 'lexicon_invalid', message: describePublishErrorCode('lexicon_invalid') };
  }

  // 5. Per-identity cap (counts only THIS DID's active jobs).
  if (input.repo.countActive(input.did) >= MAX_PUBLISH_QUEUE) return { kind: 'cap_exceeded' };

  // 6+7. SUPERSEDE a stale failed attempt + create the replacement ATOMICALLY.
  // Supersede only NOW that every gate above has passed, so a rejected re-submit
  // (lexicon/cap) never destroys the user's existing failed row (their only
  // retry/dismiss handle). The failed row never published, so replacing it is
  // safe; leaving it would let its "Try again" publish a second record after the
  // replacement succeeds.
  //
  // Pre-serialize the JSON BEFORE the transaction so a `JSON.stringify` throw
  // can't leave the discard committed with no replacement. The discard + create
  // run in ONE repo transaction: if the insert throws, the discard rolls back
  // and the failed row survives — never a window with neither job present.
  const recordJSON = JSON.stringify(input.record);
  const draftJSON = JSON.stringify(input.draft);
  const jobId = input.newJobId();
  const staleFailedId = existing?.status === 'failed' ? existing.jobId : null;
  input.repo.transaction(() => {
    if (staleFailedId !== null) input.repo.discard(staleFailedId);
    input.repo.create({
      jobId,
      ownerDid: input.did,
      rkey: input.rkey,
      recordJSON,
      draftJSON,
      threadId: input.threadId,
      draftId: input.draftId,
      createdAt: input.nowMs,
    });
  });

  // 8. Inline fast-path: claim + one attempt for instant feedback. Offline →
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
  if (res.kind === 'failed') {
    return { kind: 'error', code: res.error.code, message: describePublishErrorCode(res.error.code) };
  }
  // `requeued` (transient) or `lost` (lease reclaimed mid-write) → the job is in
  // flight / owned by the worker; surface it as queued.
  return { kind: 'queued', jobId };
}
