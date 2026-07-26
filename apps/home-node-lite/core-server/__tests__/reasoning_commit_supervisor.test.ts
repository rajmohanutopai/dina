import { ReasoningCommitSupervisor } from '../src/reasoning/reasoning_commit_supervisor';

import type { CoreReasoningBroker, ReasoningCommitReconcileResult } from '@dina/core';

const EMPTY_RESULT: ReasoningCommitReconcileResult = {
  scanned: 0,
  committed: 0,
  pendingApproval: 0,
  failed: 0,
  skipped: 0,
};

describe('ReasoningCommitSupervisor', () => {
  test('reconciles before sweeping context records', async () => {
    const order: string[] = [];
    const broker = {
      reconcilePendingCommits: async () => {
        order.push('reconcile');
        return EMPTY_RESULT;
      },
      sweepContextRecords: () => {
        order.push('sweep');
        return 0;
      },
    } as unknown as CoreReasoningBroker;
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
    };

    const supervisor = new ReasoningCommitSupervisor({
      broker,
      logger: logger as never,
    });
    await supervisor.tick();

    expect(order).toEqual(['reconcile', 'sweep']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('does not sweep when reconciliation fails', async () => {
    const sweepContextRecords = jest.fn();
    const broker = {
      reconcilePendingCommits: async () => {
        throw new Error('identity store unavailable');
      },
      sweepContextRecords,
    } as unknown as CoreReasoningBroker;
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
    };

    const supervisor = new ReasoningCommitSupervisor({
      broker,
      logger: logger as never,
    });
    await supervisor.tick();

    expect(sweepContextRecords).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { reason: 'reasoning_commit_recovery_unavailable' },
      'reasoning commit recovery failed',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('identity store unavailable');
  });
});
