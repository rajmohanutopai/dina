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

import {
  currentDataScope,
  getReviewPublishRepository,
  isGuidedDemoScope,
  type ReviewPublishRepository,
} from '@dina/core';

import { getBootedNode } from '../hooks/useNodeBootstrap';

import { INJECT_SENTINEL_PUBLISHER, injectPublish, isTestPublishConfigured } from './inject_publish';
import {
  runReviewPublishTick,
  type DrainResult,
  type ReviewPublishWorkerDeps,
} from './review_publish_worker';

import type { PDSPublisher } from '@dina/brain';

interface BootedNodeView {
  readonly did: string;
  readonly pdsPublisher?: PDSPublisher;
}

export interface ReviewPublishAutodrainSeams {
  getRepo?: () => ReviewPublishRepository | null;
  getNode?: () => BootedNodeView | null;
  runTick?: (repo: ReviewPublishRepository, did: string, publisher: PDSPublisher) => Promise<DrainResult>;
  /** Injectable clock for the lease reaper; defaults to `Date.now`. */
  now?: () => number;
}

/** How this build can publish right now (or null if it can't). */
interface PublishStrategy {
  readonly publisher: PDSPublisher;
  /** Override `publishToPDS`; undefined ⇒ the real sovereign PDS publish. */
  readonly publishToPDS?: ReviewPublishWorkerDeps['publishToPDS'];
}

/**
 * Resolve how the worker should publish. Inject takes PRECEDENCE over the real
 * publisher — exactly matching `submitReviewFromUI`'s inline attempt: when the
 * test-inject token is set, BOTH the inline submit AND the worker publish via
 * `injectPublish`. Otherwise a transient inject failure could leave a job
 * `queued`, and the foreground worker would drain that dev/E2E review to the
 * user's REAL PDS just because a `pdsPublisher` also exists. Falls back to the
 * real publisher when inject is off; `null` ⇒ no way to publish.
 */
function resolvePublishStrategy(node: BootedNodeView): PublishStrategy | null {
  if (isTestPublishConfigured()) {
    return { publisher: INJECT_SENTINEL_PUBLISHER, publishToPDS: injectPublish };
  }
  if (node.pdsPublisher !== undefined) return { publisher: node.pdsPublisher };
  return null;
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

/**
 * Whether a worker pass could actually publish right now: a wired repo, a booted
 * identity with SOME way to publish (a real PDS publisher OR the dev/E2E inject
 * path), and NOT under a guided-demo scope. Callers use this to avoid moving a
 * job to `queued` when the worker would only no-op (which would strand it as an
 * undrainable row). Mirrors `runReviewPublishTick`'s demo guard so the decision
 * is identical to what the tick would do.
 */
export function canDrainReviewPublish(seams: ReviewPublishAutodrainSeams = {}): boolean {
  const repo = (seams.getRepo ?? getReviewPublishRepository)();
  const node = (seams.getNode ?? getBootedNode)();
  if (repo === null || node === null || node.did.length === 0) return false;
  if (isGuidedDemoScope(currentDataScope())) return false;
  return resolvePublishStrategy(node) !== null;
}

/** Run ONE worker pass now — used by "Try again" + the scheduler.
 *
 *  Two stages, deliberately decoupled:
 *   1. REAPER — reclaim crashed leases (`publishing → queued`). Runs whenever
 *      there's a repo + identity + we're not in a demo, EVEN WITH NO WAY TO
 *      PUBLISH. Otherwise a row left `publishing` by a crash, on a boot that then
 *      has no publish strategy (e.g. credentials removed), would stay `publishing`
 *      forever with no Cancel/Dismiss path until credentials returned.
 *   2. PUBLISH — only if a publish strategy exists.
 */
export async function drainReviewPublishNow(seams: ReviewPublishAutodrainSeams = {}): Promise<void> {
  const repo = (seams.getRepo ?? getReviewPublishRepository)();
  const node = (seams.getNode ?? getBootedNode)();
  if (repo === null || node === null || node.did.length === 0) return;
  if (isGuidedDemoScope(currentDataScope())) return; // never touch real jobs in a demo

  // 1. Reaper — independent of whether we can publish.
  repo.reclaimExpiredLeases(node.did, (seams.now ?? Date.now)());

  // 2. Publish, only if there's a way to.
  const strategy = resolvePublishStrategy(node);
  if (strategy === null) return;
  const runTick =
    seams.runTick ??
    ((r: ReviewPublishRepository, did: string, publisher: PDSPublisher) =>
      runReviewPublishTick({ repo: r, did, publisher, publishToPDS: strategy.publishToPDS }));
  await runTick(repo, node.did, strategy.publisher);
}
