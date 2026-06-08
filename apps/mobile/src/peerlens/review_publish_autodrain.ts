/**
 * App-level scheduler for the PeerLens publish worker — replaces the old
 * `review_outbox_autodrain`. Ticks the worker once the node is up and on every
 * app foreground (a cheap "retry on reconnect"). Started from the app root when
 * boot completes; idempotent.
 *
 * Thin glue only: it resolves the booted node + the global repo and delegates to
 * `runReviewPublishTick` (the tested logic). The resolver seams are injectable so
 * the boot/foreground wiring can be tested without a real PDS.
 */

import { AppState, type AppStateStatus } from 'react-native';

import { getReviewPublishRepository, type ReviewPublishRepository } from '@dina/core';

import { getBootedNode } from '../hooks/useNodeBootstrap';

import { runReviewPublishTick, type DrainResult } from './review_publish_worker';

import type { PDSPublisher } from '@dina/brain';

interface BootedNodeView {
  readonly did: string;
  readonly pdsPublisher?: PDSPublisher;
}

export interface ReviewPublishAutodrainSeams {
  getRepo?: () => ReviewPublishRepository | null;
  getNode?: () => BootedNodeView | null;
  runTick?: (repo: ReviewPublishRepository, did: string, publisher: PDSPublisher) => Promise<DrainResult>;
}

let active = false;

/**
 * Start the worker scheduler. Drains once now, then on every foreground. Returns
 * a stop function; a second call while already active is a no-op.
 */
export function startReviewPublishWorker(seams: ReviewPublishAutodrainSeams = {}): () => void {
  if (active) return () => undefined;
  active = true;
  const tick = (): Promise<void> => drainReviewPublishNow(seams);
  void tick();
  const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
    if (s === 'active') void tick();
  });
  return () => {
    sub.remove();
    active = false;
  };
}

/** Run ONE worker pass now — used by "Try again" + the scheduler. No-op without
 *  a booted node / publisher / repo. */
export async function drainReviewPublishNow(seams: ReviewPublishAutodrainSeams = {}): Promise<void> {
  const repo = (seams.getRepo ?? getReviewPublishRepository)();
  const node = (seams.getNode ?? getBootedNode)();
  if (
    repo === null ||
    node === null ||
    node.pdsPublisher === undefined ||
    node.did.length === 0
  ) {
    return; // nothing booted / no publisher / no repo — nothing to drain
  }
  const runTick =
    seams.runTick ??
    ((r: ReviewPublishRepository, did: string, publisher: PDSPublisher) =>
      runReviewPublishTick({ repo: r, did, publisher }));
  await runTick(repo, node.did, node.pdsPublisher);
}
