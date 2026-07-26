/**
 * Runtime-neutral cadence for a reasoning backend worker.
 *
 * The supervisor is intentionally policy-free: Core's broker decides what the
 * backend may claim. It only coalesces ticks, drains a bounded batch, and makes
 * shutdown await the active pass. Mobile and split Home Node Brain use this
 * exact implementation.
 */

import { ReasoningBackendWorker, type ReasoningWorkerResult } from './backend_worker';

const DEFAULT_INTERVAL_MS = 2_500;
const DEFAULT_MAX_JOBS_PER_TICK = 4;

export interface ReasoningBackendSupervisorOptions {
  worker: ReasoningBackendWorker;
  intervalMs?: number;
  maxJobsPerTick?: number;
  onResult?: (result: ReasoningWorkerResult) => void;
  onError?: (error: unknown) => void;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class ReasoningBackendSupervisor {
  private handle: unknown | null = null;
  private flight: Promise<ReasoningWorkerResult[]> | null = null;

  constructor(private readonly options: ReasoningBackendSupervisorOptions) {
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const maxJobs = options.maxJobsPerTick ?? DEFAULT_MAX_JOBS_PER_TICK;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 250) {
      throw new Error('reasoning supervisor interval must be at least 250ms');
    }
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 100) {
      throw new Error('reasoning supervisor batch size must be between 1 and 100');
    }
  }

  start(): void {
    if (this.handle !== null) return;
    void this.tick();
    const setTimer =
      this.options.setInterval ??
      ((callback: () => void, ms: number): unknown => setInterval(callback, ms));
    this.handle = setTimer(() => void this.tick(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    (this.handle as { unref?: () => void }).unref?.();
  }

  async stop(): Promise<void> {
    if (this.handle !== null) {
      const clearTimer =
        this.options.clearInterval ??
        ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>));
      clearTimer(this.handle);
      this.handle = null;
    }
    await this.flight;
  }

  async tick(): Promise<ReasoningWorkerResult[]> {
    if (this.flight !== null) return this.flight;
    const run = this.drain();
    this.flight = run;
    try {
      return await run;
    } finally {
      if (this.flight === run) this.flight = null;
    }
  }

  private async drain(): Promise<ReasoningWorkerResult[]> {
    const results: ReasoningWorkerResult[] = [];
    try {
      const limit = this.options.maxJobsPerTick ?? DEFAULT_MAX_JOBS_PER_TICK;
      for (let index = 0; index < limit; index += 1) {
        const result = await this.options.worker.runOne();
        results.push(result);
        try {
          this.options.onResult?.(result);
        } catch {
          // Observer failures never stop durable processing.
        }
        if (result.state === 'idle' || result.state === 'busy') break;
      }
    } catch (error) {
      try {
        this.options.onError?.(error);
      } catch {
        // Error observers are diagnostics only.
      }
    }
    return results;
  }
}
