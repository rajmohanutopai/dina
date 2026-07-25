/**
 * Home Node Lite supervisor for Core's runtime-neutral review publish queue.
 *
 * The durable state machine and retry policy live in @dina/core. This class
 * only supplies scheduling and process lifecycle: one immediate pass, one
 * bounded periodic pass, no overlap, and a clean stop hook.
 */

import {
  runReviewPublishTick,
  type ReviewPublishErrorClassifier,
  type ReviewPublishRepository,
  type ReviewRecordWriter,
} from '@dina/core';

import type { Logger } from '../logger';

export interface ReviewPublishSupervisorOptions {
  ownerDid: string;
  repo: ReviewPublishRepository;
  publish: ReviewRecordWriter;
  classifyError: ReviewPublishErrorClassifier;
  logger: Logger;
  intervalMs?: number;
  now?: () => number;
}

export class ReviewPublishSupervisor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private flight: Promise<void> | null = null;

  constructor(private readonly options: ReviewPublishSupervisorOptions) {}

  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    this.timer = setInterval(
      () => void this.tick(),
      this.options.intervalMs ?? 30_000,
    );
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
        const result = await runReviewPublishTick({
          ownerDid: this.options.ownerDid,
          repo: this.options.repo,
          publish: this.options.publish,
          classifyError: this.options.classifyError,
          ...(this.options.now !== undefined ? { now: this.options.now } : {}),
        });
        if (
          result.reclaimed > 0 ||
          result.published > 0 ||
          result.requeued > 0 ||
          result.failed > 0
        ) {
          this.options.logger.info(result, 'PeerLens publish queue drained');
        }
      } catch (error) {
        this.options.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'PeerLens publish queue tick failed',
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
