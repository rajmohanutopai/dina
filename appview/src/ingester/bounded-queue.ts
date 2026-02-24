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

export class BoundedIngestionQueue {
  private queue: QueueItem[] = []
  private ws: WebSocket | null = null
  private paused = false
  private processing = false
  private activeCount = 0
  private inFlightTimestamps = new Set<number>()
  private processFn: ProcessFn

  private readonly maxSize: number
  private readonly maxConcurrency: number
  private readonly lowWatermark: number

  constructor(processFn: ProcessFn, options?: {
    maxSize?: number
    maxConcurrency?: number
  }) {
    this.processFn = processFn
    this.maxSize = options?.maxSize ?? CONSTANTS.MAX_QUEUE_SIZE
    this.maxConcurrency = options?.maxConcurrency ?? CONSTANTS.MAX_CONCURRENCY
    // Resume when queue drops below 50% capacity
    this.lowWatermark = Math.floor(this.maxSize * 0.5)
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

    // Check queued items
    if (this.queue.length > 0) {
      const queueMin = this.queue[0].timestampUs
      if (min === null || queueMin < min) min = queueMin
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
    } catch (err) {
      logger.error({ err, timestampUs: item.timestampUs }, '[Queue] Failed to process item')
      metrics.incr('ingester.queue.process_error')
    }
  }
}
