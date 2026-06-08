/**
 * Project the durable publish job for an inline chat draft. The card reads its
 * post-submit state (queued / publishing / failed / published) straight off the
 * job row found by the (thread, draft) back-reference, and re-renders whenever
 * the repo changes (Deviation #1/#2 — the card is a projection, not an owner).
 */

import { useEffect, useState } from 'react';

import { getReviewPublishRepository, type PublishJob } from '@dina/core';

import { getBootedNode } from '../hooks/useNodeBootstrap';

function readJob(threadId: string | undefined, draftId: string | undefined): PublishJob | null {
  if (threadId === undefined || draftId === undefined) return null;
  const repo = getReviewPublishRepository();
  const node = getBootedNode();
  if (repo === null || node === null || node.did.length === 0) return null;
  return repo.findLatestForDraft(node.did, threadId, draftId);
}

export function useReviewPublishJob(
  threadId: string | undefined,
  draftId: string | undefined,
): PublishJob | null {
  const [job, setJob] = useState<PublishJob | null>(() => readJob(threadId, draftId));

  useEffect(() => {
    setJob(readJob(threadId, draftId)); // re-read on identity change
    const repo = getReviewPublishRepository();
    if (repo === null) return;
    return repo.subscribe(() => setJob(readJob(threadId, draftId)));
  }, [threadId, draftId]);

  return job;
}
