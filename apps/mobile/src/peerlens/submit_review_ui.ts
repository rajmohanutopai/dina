/**
 * UI binding for `submitReviewPublish` — resolves the booted node + the global
 * publish-job repo so the write form and the inline chat card call ONE function
 * with just the record/draft/rkey. Keeps the dev test-inject shortcut working
 * (it's just a different `publishToPDS`, so the job machinery is identical in dev
 * and prod).
 */

import { getReviewPublishRepository } from '@dina/core';

import { getBootedNode } from '../hooks/useNodeBootstrap';

import {
  injectAttestation,
  isTestPublishConfigured,
  type InjectAttestationRequest,
} from './appview_runtime';
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

/**
 * Dev/E2E publish: write straight into AppView's DB via the test-inject endpoint
 * instead of the PDS. Same `(uri, cid)` shape, so the job completes identically.
 * Active only when `EXPO_PUBLIC_DINA_TEST_INJECT_TOKEN` is set (404s in prod).
 */
async function injectPublish(
  _pds: unknown,
  did: string,
  record: Record<string, unknown>,
  rkey: string,
): Promise<{ uri: string; cid: string }> {
  const result = await injectAttestation({
    authorDid: did,
    rkey,
    cid: `bafyreim${Date.now().toString(36)}`,
    record: record as InjectAttestationRequest['record'],
  });
  return { uri: result.uri, cid: result.cid };
}

export async function submitReviewFromUI(input: SubmitReviewUIInput): Promise<SubmitOutcome> {
  const repo = getReviewPublishRepository();
  const node = getBootedNode();
  if (repo === null || node === null) {
    return { kind: 'error', code: 'unknown', message: 'Local node is not ready yet.' };
  }
  return submitReviewPublish({
    did: node.did,
    publisher: node.pdsPublisher, // undefined ⇒ no_credentials (unless inject overrides the write)
    rkey: input.rkey,
    record: input.record,
    draft: input.draft,
    threadId: input.threadId,
    draftId: input.draftId,
    repo,
    nowMs: Date.now(),
    newJobId: generateJobId,
    publishToPDS: isTestPublishConfigured() ? injectPublish : undefined,
  });
}
