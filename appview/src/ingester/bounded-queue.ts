import type WebSocket from 'ws'
import { CONSTANTS } from '@/config/constants.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

/**
 * Bounded ingestion queue with backpressure (Fix 5, Fix 7).
 *
 * When the queue fills up, it pauses the WebSocket (TCP-level backpressure)
 * so the upstream Jetstream relay stops sending events. When the queue
 * drains below the low watermark, the WebSocket is resumed.
 *
 * The queue also tracks in-flight timestamps so we can compute a safe
 * cursor position: the lowest timestamp among all queued + in-flight items.
 * This ensures we never advance the cursor past events that haven't been
 * fully processed.
 */

export interface QueueItem {
  /** Microsecond timestamp from Jetstream */
  timestampUs: number
  /** The raw event data to process */
  data: unknown
}

type ProcessFn = (item: QueueItem) => Promise<void>

/**
 * Called when a failed item cannot be requeued because the queue is full.
 * The consumer should spool the item to disk so it can be recovered via
 * replaySpool() on the next startup.
 */
type OnRetryDroppedFn = (item: QueueItem) => void

export class BoundedIngestionQueue {
  private queue: QueueItem[] = []
  private ws: WebSocket | null = null
  private paused = false
  private processing = false
  private activeCount = 0
  private inFlightTimestamps = new Set<number>()
  private failedTimestamps = new Set<number>()
  private failedAttempts = new Map<number, number>()
  private static readonly MAX_RETRY = 3
  private processFn: ProcessFn
  private onRetryDropped: OnRetryDroppedFn | null = null
  private dropCount = 0

  private readonly maxSize: number
  private readonly maxConcurrency: number
  private readonly lowWatermark: number

  constructor(processFn: ProcessFn, options?: {
    maxSize?: number
    maxConcurrency?: number
    onRetryDropped?: OnRetryDroppedFn
  }) {
    this.processFn = processFn
    this.onRetryDropped = options?.onRetryDropped ?? null
    this.maxSize = options?.maxSize ?? CONSTANTS.MAX_QUEUE_SIZE
    this.maxConcurrency = options?.maxConcurrency ?? CONSTANTS.MAX_CONCURRENCY
    // Resume when queue drops below 50% capacity
    this.lowWatermark = Math.floor(this.maxSize * 0.5)

    // HIGH-02: Periodic cleanup of old failed timestamps (older than 1 hour)
    setInterval(() => {
      const cutoff = Date.now() * 1000 - 3_600_000_000 // 1 hour in microseconds
      for (const ts of this.failedTimestamps) {
        if (ts < cutoff) {
          this.failedTimestamps.delete(ts)
          this.failedAttempts.delete(ts)
        }
      }
    }, 300_000) // every 5 minutes
  }

  /** Attach a WebSocket for backpressure signaling */
  setWebSocket(ws: WebSocket): void {
    this.ws = ws
  }

  /**
   * Push an item onto the queue.
   * Returns false if the queue is full (item was dropped).
   */
  push(item: QueueItem): boolean {
    if (this.queue.length >= this.maxSize) {
      // Apply backpressure: pause the WebSocket
      if (!this.paused && this.ws) {
        this.paused = true
        this.ws.pause()
        logger.warn({ depth: this.queue.length }, '[Queue] Backpressure: WebSocket paused')
        metrics.incr('ingester.queue.backpressure')
      }
      this.dropCount++
      return false
    }

    this.queue.push(item)
    metrics.gauge('ingester.queue.depth', this.queue.length)

    // Start processing if not already running
    if (!this.processing) {
      this.drain()
    }

    return true
  }

  /**
   * Get the safe cursor position: the lowest timestamp among all
   * queued and in-flight items. Returns null if nothing is pending.
   *
   * The ingester should never persist a cursor higher than this value,
   * because items at or below this timestamp might still fail and need retry.
   */
  getSafeCursor(): number | null {
    let min: number | null = null

    // Check in-flight items
    for (const ts of this.inFlightTimestamps) {
      if (min === null || ts < min) min = ts
    }

    // Check all queued items (not just head — queue may be unordered)
    for (const item of this.queue) {
      if (min === null || item.timestampUs < min) min = item.timestampUs
    }

    // Include failed timestamps to prevent cursor advancement past failures
    for (const ts of this.failedTimestamps) {
      if (min === null || ts < min) min = ts
    }

    return min
  }

  /** Current queue depth */
  get depth(): number {
    return this.queue.length
  }

  /** Number of items currently being processed */
  get active(): number {
    return this.activeCount
  }

  /** Number of in-flight timestamps being tracked */
  get inFlight(): number {
    return this.inFlightTimestamps.size
  }

  /** Whether the WebSocket is currently paused */
  get isPaused(): boolean {
    return this.paused
  }

  /** Number of items dropped since last reset */
  getDropCount(): number {
    return this.dropCount
  }

  /** Reset the drop counter (for periodic health checks) */
  resetDropCount(): void {
    this.dropCount = 0
  }

  /**
   * Drain the queue, processing up to maxConcurrency items at a time.
   */
  private async drain(): Promise<void> {
    if (this.processing) return
    this.processing = true

    try {
      while (this.queue.length > 0) {
        // Wait if we're at max concurrency
        if (this.activeCount >= this.maxConcurrency) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10))
          continue
        }

        const item = this.queue.shift()!
        this.inFlightTimestamps.add(item.timestampUs)
        this.activeCount++

        // Process without awaiting — allows concurrent processing
        this.processItem(item).finally(() => {
          this.activeCount--
          this.inFlightTimestamps.delete(item.timestampUs)
          metrics.gauge('ingester.queue.depth', this.queue.length)
          metrics.gauge('ingester.queue.active', this.activeCount)

          // Resume WebSocket if queue has drained below low watermark
          if (this.paused && this.queue.length <= this.lowWatermark && this.ws) {
            this.paused = false
            this.ws.resume()
            logger.info({ depth: this.queue.length }, '[Queue] Backpressure released: WebSocket resumed')
          }
        })
      }
    } finally {
      this.processing = false
    }
  }

  private async processItem(item: QueueItem): Promise<void> {
    try {
      await this.processFn(item)
      // On success: clear any prior failure tracking so cursor is unpinned
      if (this.failedTimestamps.has(item.timestampUs)) {
        this.failedTimestamps.delete(item.timestampUs)
        this.failedAttempts.delete(item.timestampUs)
      }
    } catch (err) {
      // HIGH-02: Bounded retry with dead-lettering and actual requeue
      const attempts = (this.failedAttempts.get(item.timestampUs) ?? 0) + 1
      if (attempts >= BoundedIngestionQueue.MAX_RETRY) {
        // Dead-letter: stop blocking cursor advancement
        this.failedTimestamps.delete(item.timestampUs)
        this.failedAttempts.delete(item.timestampUs)
        logger.error(
          { err, timestampUs: item.timestampUs, attempts },
          '[Queue] Event dead-lettered after max retries',
        )
        metrics.incr('ingester.queue.dead_lettered')
      } else {
        this.failedAttempts.set(item.timestampUs, attempts)
        this.failedTimestamps.add(item.timestampUs)
        // Re-push for retry. If queue is full, spool the item to disk
        // via the onRetryDropped callback so it can be recovered on restart.
        if (this.queue.length < this.maxSize) {
          this.queue.push(item)
          if (!this.processing) this.drain()
          logger.warn(
            { err, timestampUs: item.timestampUs, attempt: attempts },
            '[Queue] Failed to process item — requeued for retry',
          )
        } else if (this.onRetryDropped) {
          // Queue full — hand off to spool so the item is not lost.
          // Clear failure tracking since the item is now on disk and will
          // be retried via replaySpool() on next startup.
          this.failedTimestamps.delete(item.timestampUs)
          this.failedAttempts.delete(item.timestampUs)
          this.onRetryDropped(item)
          logger.warn(
            { err, timestampUs: item.timestampUs, attempt: attempts },
            '[Queue] Failed to process item — queue full, spooled to disk',
          )
          metrics.incr('ingester.queue.retry_spooled')
        } else {
          // No spool callback — dead-letter immediately to avoid
          // pinning cursor indefinitely with no recovery path
          this.failedTimestamps.delete(item.timestampUs)
          this.failedAttempts.delete(item.timestampUs)
          logger.error(
            { err, timestampUs: item.timestampUs, attempt: attempts },
            '[Queue] Failed to process item — queue full, no spool, dead-lettered',
          )
          metrics.incr('ingester.queue.dead_lettered')
        }
        metrics.incr('ingester.queue.process_error')
      }
    }
  }
}
