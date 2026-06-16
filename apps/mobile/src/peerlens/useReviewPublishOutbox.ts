/**
 * Project review publish jobs for the booted identity, re-rendering on any repo
 * change. Two views:
 *   - `useReviewPublishOutbox` — Outbox screen: in-play jobs (queued /
 *     publishing / failed), FIFO.
 *   - `useReviewPublishWithReceipts` — reviewer dashboard: the above PLUS
 *     `published` receipts (just-published reviews AppView hasn't indexed yet),
 *     so they show inline as "Pending" until the review lands in the list.
 */

import { useEffect, useState } from 'react';

import {
  getReviewPublishRepository,
  subscribeReviewPublishRegistry,
  type PublishJob,
} from '@dina/core';

import { getBootedNode, subscribeBootedNode } from '../hooks/useNodeBootstrap';

type Mode = 'outbox' | 'receipts';

function readJobs(mode: Mode): PublishJob[] {
  const repo = getReviewPublishRepository();
  const node = getBootedNode();
  if (repo === null || node === null || node.did.length === 0) return [];
  return mode === 'receipts'
    ? repo.listForOwnerWithReceipts(node.did)
    : repo.listForOwner(node.did);
}

function useLiveJobs(mode: Mode): PublishJob[] {
  const [rows, setRows] = useState<PublishJob[]>(() => readJobs(mode));

  useEffect(() => {
    let unsubRepo: (() => void) | undefined;
    // (Re)bind on mount AND on any repo swap, so a screen opened before the repo
    // was wired re-reads + subscribes once createNode installs it.
    const bind = (): void => {
      setRows(readJobs(mode));
      unsubRepo?.();
      unsubRepo = getReviewPublishRepository()?.subscribe(() => setRows(readJobs(mode)));
    };
    bind();
    // Re-bind on repo (re)install AND on the booted node becoming ready — during
    // boot the repo registry fires before the node singleton is set, so the first
    // read sees a null node.
    const unsubRegistry = subscribeReviewPublishRegistry(bind);
    const unsubNode = subscribeBootedNode(bind);
    return () => {
      unsubRepo?.();
      unsubRegistry();
      unsubNode();
    };
  }, [mode]);

  return rows;
}

export function useReviewPublishOutbox(): PublishJob[] {
  return useLiveJobs('outbox');
}

export function useReviewPublishWithReceipts(): PublishJob[] {
  return useLiveJobs('receipts');
}
