/**
 * Project the Outbox: every publish job for the booted identity that's still
 * in play (queued / publishing / failed), FIFO. Re-renders on any repo change.
 * The Outbox screen is a pure projection of this — no separate mirror.
 */

import { useEffect, useState } from 'react';

import { getReviewPublishRepository, type PublishJob } from '@dina/core';

import { getBootedNode } from '../hooks/useNodeBootstrap';

function readOutbox(): PublishJob[] {
  const repo = getReviewPublishRepository();
  const node = getBootedNode();
  if (repo === null || node === null || node.did.length === 0) return [];
  return repo.listForOwner(node.did);
}

export function useReviewPublishOutbox(): PublishJob[] {
  const [rows, setRows] = useState<PublishJob[]>(() => readOutbox());

  useEffect(() => {
    setRows(readOutbox());
    const repo = getReviewPublishRepository();
    if (repo === null) return;
    return repo.subscribe(() => setRows(readOutbox()));
  }, []);

  return rows;
}
