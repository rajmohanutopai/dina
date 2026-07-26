/**
 * Home Node lifecycle adapter for durable reasoning commit recovery.
 *
 * Core owns validation, replay, idempotency, and backoff. This class only
 * schedules bounded passes and makes shutdown wait for the active pass.
 */

import { type CoreReasoningBroker } from '@dina/core';

import type { Logger } from '../logger';

export interface ReasoningCommitSupervisorOptions {
  broker: CoreReasoningBroker;
  logger: Logger;
  intervalMs?: number;
}

export class ReasoningCommitSupervisor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private flight: Promise<void> | null = null;

  constructor(private readonly options: ReasoningCommitSupervisorOptions) {}

  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 30_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flight;
  }

  async tick(): Promise<void> {
    if (this.flight !== null) return this.flight;
    const run = (async () => {
      try {
        const result = await this.options.broker.reconcilePendingCommits();
        this.options.broker.sweepContextRecords();
        if (result.committed > 0 || result.pendingApproval > 0 || result.failed > 0) {
          this.options.logger.info(result, 'reasoning commits reconciled');
        }
      } catch {
        // Commit exceptions may contain provider or vault text. Durable
        // owner-safe job state carries lifecycle detail; operational logs use
        // only a fixed diagnostic.
        this.options.logger.warn(
          { reason: 'reasoning_commit_recovery_unavailable' },
          'reasoning commit recovery failed',
        );
      }
    })();
    this.flight = run;
    try {
      await run;
    } finally {
      if (this.flight === run) this.flight = null;
    }
  }
}
