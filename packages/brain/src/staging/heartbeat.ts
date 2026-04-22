/**
 * Staging lease heartbeat — extends item leases during slow processing.
 *
 * When the Brain is enriching an item with LLM (which can take minutes
 * for large documents or slow providers), the 15-minute staging lease
 * risks expiring. The heartbeat extends the lease every interval while
 * processing is active.
 *
 * Usage:
 *   const hb = new LeaseHeartbeat(client, itemId, 300);
 *   hb.start();
 *   await slowEnrichment();
 *   hb.stop();
 *
 * The heartbeat is self-healing: if an extend call fails, it logs the
 * error and retries on the next tick. Only stop() or the item completing
 * stops the heartbeat.
 *
 * Source: ARCHITECTURE.md Task 3.17
 */

/** Injectable client interface — subset of BrainCoreClient. */
export interface LeaseExtender {
  extendStagingLease(itemId: string, seconds: number): Promise<void>;
}

export interface HeartbeatOptions {
  /** Interval between heartbeat ticks in milliseconds. Default: 5 minutes. */
  intervalMs?: number;
  /** Seconds to extend the lease per tick. Default: 600 (10 minutes). */
  extensionSeconds?: number;
  /** Error callback for monitoring. */
  onError?: (itemId: string, error: Error) => void;
}

import { STAGING_LEASE_DURATION_S, MS_MINUTE } from '../../../core/src/constants';

const DEFAULT_INTERVAL_MS = 5 * MS_MINUTE; // 5 minutes
const DEFAULT_EXTENSION_SECONDS = (STAGING_LEASE_DURATION_S * 2) / 3; // 10 minutes (2/3 of lease renewal)

export class LeaseHeartbeat {
  private readonly client: LeaseExtender;
  private readonly itemId: string;
  private readonly intervalMs: number;
  private readonly extensionSeconds: number;
  private readonly onError?: (itemId: string, error: Error) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  private _tickCount = 0;
  private _failCount = 0;
  private _running = false;

  constructor(client: LeaseExtender, itemId: string, options?: HeartbeatOptions) {
    this.client = client;
    this.itemId = itemId;
    this.intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.extensionSeconds = options?.extensionSeconds ?? DEFAULT_EXTENSION_SECONDS;
    this.onError = options?.onError;
  }

  /** Start the heartbeat. Idempotent — calling start() twice is safe. */
  start(): void {
    if (this._running) return;
    this._running = true;

    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }

  /** Stop the heartbeat. Idempotent. */
  stop(): void {
    if (!this._running) return;
    this._running = false;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Whether the heartbeat is currently running. */
  get running(): boolean {
    return this._running;
  }

  /** Number of successful extend calls. */
  get tickCount(): number {
    return this._tickCount;
  }

  /** Number of failed extend calls. */
  get failCount(): number {
    return this._failCount;
  }

  /** The item ID being kept alive. */
  get id(): string {
    return this.itemId;
  }

  /**
   * Execute a single heartbeat tick.
   * Public for testing — normally called by the interval timer.
   */
  async tick(): Promise<void> {
    if (!this._running) return;

    try {
      await this.client.extendStagingLease(this.itemId, this.extensionSeconds);
      this._tickCount++;
    } catch (err) {
      this._failCount++;
      if (this.onError) {
        this.onError(this.itemId, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}

/**
 * Run an async operation with a lease heartbeat.
 *
 * Starts the heartbeat, runs the operation, stops the heartbeat.
 * The heartbeat is stopped whether the operation succeeds or fails.
 */
export async function withHeartbeat<T>(
  client: LeaseExtender,
  itemId: string,
  operation: () => Promise<T>,
  options?: HeartbeatOptions,
): Promise<T> {
  const heartbeat = new LeaseHeartbeat(client, itemId, options);
  heartbeat.start();
  try {
    return await operation();
  } finally {
    heartbeat.stop();
  }
}
