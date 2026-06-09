/**
 * Project the durable publish job for an inline chat draft. The card reads its
 * post-submit state (queued / publishing / failed / published) straight off the
 * job row found by the (thread, draft) back-reference, and re-renders whenever
 * the repo changes (Deviation #1/#2 — the card is a projection, not an owner).
 */

import { useEffect, useState } from 'react';

import {
  getReviewPublishRepository,
  subscribeReviewPublishRegistry,
  type PublishJob,
} from '@dina/core';

import { getBootedNode, subscribeBootedNode } from '../hooks/useNodeBootstrap';

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
    let unsubRepo: (() => void) | undefined;
    // (Re)bind to whatever repo is current: re-read + re-subscribe. Called on
    // mount AND whenever the global repo is swapped — so a card that mounted
    // before createNode wired the repo (repo was null → no subscription) picks
    // it up once it's installed, instead of staying frozen on the null read.
    const bind = (): void => {
      setJob(readJob(threadId, draftId));
      unsubRepo?.();
      unsubRepo = getReviewPublishRepository()?.subscribe(() =>
        setJob(readJob(threadId, draftId)),
      );
    };
    bind();
    // Re-bind on EITHER the repo being (re)installed OR the booted node becoming
    // ready: the readJob() depends on both, and during boot the repo registry
    // fires before getBootedNode() is assigned (so the first bind reads a null
    // node). subscribeBootedNode catches that second half.
    const unsubRegistry = subscribeReviewPublishRegistry(bind);
    const unsubNode = subscribeBootedNode(bind);
    return () => {
      unsubRepo?.();
      unsubRegistry();
      unsubNode();
    };
  }, [threadId, draftId]);

  return job;
}
