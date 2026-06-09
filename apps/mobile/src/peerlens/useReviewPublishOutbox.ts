/**
 * Project the Outbox: every publish job for the booted identity that's still
 * in play (queued / publishing / failed), FIFO. Re-renders on any repo change.
 * The Outbox screen is a pure projection of this — no separate mirror.
 */

import { useEffect, useState } from 'react';

import {
  getReviewPublishRepository,
  subscribeReviewPublishRegistry,
  type PublishJob,
} from '@dina/core';

import { getBootedNode, subscribeBootedNode } from '../hooks/useNodeBootstrap';

function readOutbox(): PublishJob[] {
  const repo = getReviewPublishRepository();
  const node = getBootedNode();
  if (repo === null || node === null || node.did.length === 0) return [];
  return repo.listForOwner(node.did);
}

export function useReviewPublishOutbox(): PublishJob[] {
  const [rows, setRows] = useState<PublishJob[]>(() => readOutbox());

  useEffect(() => {
    let unsubRepo: (() => void) | undefined;
    // (Re)bind on mount AND on any repo swap, so an Outbox opened before the
    // repo was wired re-reads + subscribes once createNode installs it.
    const bind = (): void => {
      setRows(readOutbox());
      unsubRepo?.();
      unsubRepo = getReviewPublishRepository()?.subscribe(() => setRows(readOutbox()));
    };
    bind();
    // Re-bind on repo (re)install AND on the booted node becoming ready — see the
    // note in useReviewPublishJob: during boot the repo registry fires before the
    // node singleton is set, so the first read sees a null node.
    const unsubRegistry = subscribeReviewPublishRegistry(bind);
    const unsubNode = subscribeBootedNode(bind);
    return () => {
      unsubRepo?.();
      unsubRegistry();
      unsubNode();
    };
  }, []);

  return rows;
}
