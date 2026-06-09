/**
 * UI binding for `submitReviewPublish` — resolves the booted node + the global
 * publish-job repo so the write form and the inline chat card call ONE function
 * with just the record/draft/rkey. Keeps the dev test-inject shortcut working
 * (it's just a different `publishToPDS`, so the job machinery is identical in dev
 * and prod).
 */

import { getReviewPublishRepository } from '@dina/core';

import { getBootedNode } from '../hooks/useNodeBootstrap';

import { INJECT_SENTINEL_PUBLISHER, injectPublish, isTestPublishConfigured } from './inject_publish';
import { submitReviewPublish, type SubmitOutcome } from './submit_review_publish';

import type { AttestationDraftBody } from './review_draft_body';

export interface SubmitReviewUIInput {
  readonly rkey: string;
  readonly record: Record<string, unknown>;
  readonly draft: AttestationDraftBody;
  readonly threadId?: string;
  readonly draftId?: string;
}

/** Local job id — stable per submit; doubles as the durable PK. */
function generateJobId(): string {
  return `pub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function submitReviewFromUI(input: SubmitReviewUIInput): Promise<SubmitOutcome> {
  const repo = getReviewPublishRepository();
  const node = getBootedNode();
  if (repo === null || node === null) {
    return { kind: 'error', code: 'unknown', message: 'Local node is not ready yet.' };
  }
  // In dev/E2E the inject endpoint stands in for a PDS account: there's a way to
  // publish even with no real PDS publisher, so pass a sentinel so the credential
  // gate doesn't reject the publish. In prod (inject off) this is just the real
  // publisher, and `undefined` ⇒ no_credentials as before.
  const injectActive = isTestPublishConfigured();
  const publisher = node.pdsPublisher ?? (injectActive ? INJECT_SENTINEL_PUBLISHER : undefined);
  return submitReviewPublish({
    did: node.did,
    publisher,
    rkey: input.rkey,
    record: input.record,
    draft: input.draft,
    threadId: input.threadId,
    draftId: input.draftId,
    repo,
    nowMs: Date.now(),
    newJobId: generateJobId,
    publishToPDS: injectActive ? injectPublish : undefined,
  });
}
