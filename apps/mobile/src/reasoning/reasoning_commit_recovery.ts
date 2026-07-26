/**
 * Mobile lifecycle adapter for Core's durable reasoning commit reconciler.
 *
 * The state machine and replay rules live in @dina/core. Mobile only schedules
 * one pass after boot and one on each foreground transition.
 */

import { AppState, type AppStateStatus } from 'react-native';

import {
  currentDataScope,
  getReasoningBroker,
  isGuidedDemoScope,
  type CoreReasoningBroker,
  type ReasoningCommitReconcileResult,
} from '@dina/core';

export interface ReasoningCommitRecoverySeams {
  getBroker?: () => CoreReasoningBroker | null;
  reconcile?: (broker: CoreReasoningBroker) => Promise<ReasoningCommitReconcileResult>;
  sweep?: (broker: CoreReasoningBroker) => number;
}

let active = false;

export async function reconcileReasoningCommitsNow(
  seams: ReasoningCommitRecoverySeams = {},
): Promise<void> {
  if (isGuidedDemoScope(currentDataScope())) return;
  const broker = (seams.getBroker ?? getReasoningBroker)();
  if (broker === null) return;
  const reconcile =
    seams.reconcile ?? ((value: CoreReasoningBroker) => value.reconcilePendingCommits());
  await reconcile(broker);
  const sweep = seams.sweep ?? ((value: CoreReasoningBroker) => value.sweepContextRecords());
  sweep(broker);
}

export function startReasoningCommitRecovery(seams: ReasoningCommitRecoverySeams = {}): () => void {
  if (active) return () => undefined;
  active = true;
  const tick = (): void => {
    void reconcileReasoningCommitsNow(seams).catch(() => {
      // Commit errors can contain provider or vault text. Operational logs
      // carry only a coarse diagnostic; owner-safe state remains in the
      // durable reasoning job projection.
      console.warn('[reasoning] commit recovery unavailable');
    });
  };
  tick();
  const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') tick();
  });
  return () => {
    subscription.remove();
    active = false;
  };
}
