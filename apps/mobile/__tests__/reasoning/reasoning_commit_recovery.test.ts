import { reconcileReasoningCommitsNow } from '../../src/reasoning/reasoning_commit_recovery';

import type { CoreReasoningBroker, ReasoningCommitReconcileResult } from '@dina/core';

const EMPTY_RESULT: ReasoningCommitReconcileResult = {
  scanned: 0,
  committed: 0,
  pendingApproval: 0,
  failed: 0,
  skipped: 0,
};

describe('mobile reasoning commit recovery', () => {
  test('reconciles before sweeping short-lived context records', async () => {
    const order: string[] = [];
    const broker = {} as CoreReasoningBroker;

    await reconcileReasoningCommitsNow({
      getBroker: () => broker,
      reconcile: async () => {
        order.push('reconcile');
        return EMPTY_RESULT;
      },
      sweep: () => {
        order.push('sweep');
        return 0;
      },
    });

    expect(order).toEqual(['reconcile', 'sweep']);
  });

  test('does not sweep when reconciliation fails', async () => {
    const broker = {} as CoreReasoningBroker;
    const sweep = jest.fn();

    await expect(
      reconcileReasoningCommitsNow({
        getBroker: () => broker,
        reconcile: async () => {
          throw new Error('identity store unavailable');
        },
        sweep,
      }),
    ).rejects.toThrow('identity store unavailable');
    expect(sweep).not.toHaveBeenCalled();
  });
});
