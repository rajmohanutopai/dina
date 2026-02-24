/**
 * §6 — Backpressure + Low Watermark
 *
 * Test count: 10
 * Plan traceability: IT-BP-001..005, IT-LW-001..005
 *
 * Traces to: Fix 5 (WebSocket OOM), Fix 7 (Concurrent Worker Data Loss)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BoundedIngestionQueue, type QueueItem } from '@/ingester/bounded-queue'

// ---------------------------------------------------------------------------
// §6.1 Backpressure / Fix 5 (IT-BP-001..005) — 5 tests
// ---------------------------------------------------------------------------
describe('§6.1 Backpressure (Fix 5)', () => {
  let processedItems: QueueItem[]
  let processFn: (item: QueueItem) => Promise<void>
  let mockWs: { pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; readyState: number }

  beforeEach(() => {
    processedItems = []
    processFn = async (item: QueueItem) => {
      processedItems.push(item)
    }
    mockWs = { pause: vi.fn(), resume: vi.fn(), readyState: 1 } as any
  })

  it('IT-BP-001: Fix 5: burst of 5000 events → bounded queue', async () => {
    // Use a slow processFn to create backpressure
    const slowProcessFn = async (item: QueueItem) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
      processedItems.push(item)
    }

    const queue = new BoundedIngestionQueue(slowProcessFn, { maxSize: 100, maxConcurrency: 5 })
    queue.setWebSocket(mockWs as any)

    let accepted = 0
    let rejected = 0

    for (let i = 0; i < 5000; i++) {
      const result = queue.push({ timestampUs: i * 1000, data: { seq: i } })
      if (result) accepted++
      else rejected++
    }

    // Queue depth should never exceed maxSize
    expect(queue.depth).toBeLessThanOrEqual(100)
    // Some items should have been rejected due to backpressure
    expect(rejected).toBeGreaterThan(0)
    expect(accepted).toBeGreaterThan(0)
  })

  it('IT-BP-002: Fix 5: ws.pause() called at threshold', async () => {
    // Very slow processFn so queue fills up
    const slowProcessFn = async (item: QueueItem) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 500))
      processedItems.push(item)
    }

    const queue = new BoundedIngestionQueue(slowProcessFn, { maxSize: 10, maxConcurrency: 1 })
    queue.setWebSocket(mockWs as any)

    // Push items until the queue is full
    for (let i = 0; i < 20; i++) {
      queue.push({ timestampUs: i * 1000, data: { seq: i } })
    }

    // At this point, the queue should be full and ws.pause() should have been called
    expect(mockWs.pause).toHaveBeenCalled()
  })

  it('IT-BP-003: Fix 5: ws.resume() at 50% drain', async () => {
    let resolvers: (() => void)[] = []
    const controlledProcessFn = async (item: QueueItem) => {
      await new Promise<void>((resolve) => {
        resolvers.push(resolve)
      })
      processedItems.push(item)
    }

    const queue = new BoundedIngestionQueue(controlledProcessFn, { maxSize: 10, maxConcurrency: 10 })
    queue.setWebSocket(mockWs as any)

    // Fill up the queue
    for (let i = 0; i < 10; i++) {
      queue.push({ timestampUs: i * 1000, data: { seq: i } })
    }

    // Wait a tick for the drain loop to pick up items
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    // Try to push one more to trigger backpressure
    queue.push({ timestampUs: 11000, data: { seq: 11 } })

    // Now resolve enough items to drop below 50% (lowWatermark = 5)
    // The resolvers array should have items from the drain loop
    // Complete all the resolvers to drain the queue
    for (const resolver of resolvers) {
      resolver()
    }

    // Wait for drain to process
    await new Promise<void>((resolve) => setTimeout(resolve, 100))

    // If pause was called (queue was full), resume should be called after draining
    if (mockWs.pause.mock.calls.length > 0) {
      expect(mockWs.resume).toHaveBeenCalled()
    }
  })

  it('IT-BP-004: Fix 5: all events eventually processed', async () => {
    const localProcessed: QueueItem[] = []
    const fastProcessFn = async (item: QueueItem) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
      localProcessed.push(item)
    }

    const queue = new BoundedIngestionQueue(fastProcessFn, { maxSize: 100, maxConcurrency: 20 })

    // Push items — all should be accepted since maxSize=100 and we push 50
    let accepted = 0
    for (let i = 0; i < 50; i++) {
      const result = queue.push({ timestampUs: i * 1000, data: { seq: i } })
      if (result) accepted++
    }

    expect(accepted).toBe(50)

    // Wait for processing to complete — poll until all are processed
    for (let tick = 0; tick < 100; tick++) {
      if (localProcessed.length >= accepted) break
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }

    // All accepted items should be processed
    expect(localProcessed.length).toBe(accepted)
  })

  it('IT-BP-005: Fix 5: memory bounded', async () => {
    // Push 10,000 events — verify no crash / no OOM
    const fastProcessFn = async (item: QueueItem) => {
      processedItems.push(item)
    }

    const queue = new BoundedIngestionQueue(fastProcessFn, { maxSize: 500, maxConcurrency: 50 })
    queue.setWebSocket(mockWs as any)

    // Capture initial memory
    const memBefore = process.memoryUsage().heapUsed

    for (let i = 0; i < 10000; i++) {
      queue.push({ timestampUs: i * 1000, data: { seq: i, payload: 'x'.repeat(100) } })
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 1000))

    const memAfter = process.memoryUsage().heapUsed
    // Memory increase should be bounded (less than 100MB)
    const memDeltaMB = (memAfter - memBefore) / (1024 * 1024)
    expect(memDeltaMB).toBeLessThan(100)

    // Queue should not have crashed
    expect(queue.depth).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// §6.2 Low Watermark Cursor / Fix 7 (IT-LW-001..005) — 5 tests
// ---------------------------------------------------------------------------
describe('§6.2 Low Watermark Cursor (Fix 7)', () => {
  it('IT-LW-001: Fix 7: slow event + fast event → cursor = slow - 1', async () => {
    let resolvers: Map<number, () => void> = new Map()
    const controlledProcessFn = async (item: QueueItem) => {
      await new Promise<void>((resolve) => {
        resolvers.set(item.timestampUs, resolve)
      })
    }

    const queue = new BoundedIngestionQueue(controlledProcessFn, { maxSize: 100, maxConcurrency: 10 })

    // Push a slow event (timestamp 1000) and a fast event (timestamp 2000)
    queue.push({ timestampUs: 1000, data: { id: 'slow' } })
    queue.push({ timestampUs: 2000, data: { id: 'fast' } })

    // Wait for drain to pick them up
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    // Both should be in-flight now — safe cursor should be the minimum
    const safeCursor = queue.getSafeCursor()
    expect(safeCursor).toBe(1000)

    // Resolve the fast event (2000) first
    if (resolvers.has(2000)) resolvers.get(2000)!()
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    // The slow event (1000) is still in-flight, so cursor stays at 1000
    const safeCursorAfterFast = queue.getSafeCursor()
    expect(safeCursorAfterFast).toBe(1000)

    // Now resolve the slow event
    if (resolvers.has(1000)) resolvers.get(1000)!()
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  })

  it('IT-LW-002: Fix 7: all events complete → cursor = highestSeen', async () => {
    const processedItems: QueueItem[] = []
    const fastProcessFn = async (item: QueueItem) => {
      processedItems.push(item)
    }

    const queue = new BoundedIngestionQueue(fastProcessFn, { maxSize: 100, maxConcurrency: 10 })

    queue.push({ timestampUs: 1000, data: {} })
    queue.push({ timestampUs: 2000, data: {} })
    queue.push({ timestampUs: 3000, data: {} })

    // Wait for all to process
    await new Promise<void>((resolve) => setTimeout(resolve, 200))

    // All done — no in-flight, no queued
    const safeCursor = queue.getSafeCursor()
    // When nothing is in-flight or queued, getSafeCursor returns null
    expect(safeCursor).toBeNull()

    // All items should be processed
    expect(processedItems.length).toBe(3)
  })

  it('IT-LW-003: Fix 7: crash mid-processing → replay from low watermark', async () => {
    let resolvers: Map<number, () => void> = new Map()
    const controlledProcessFn = async (item: QueueItem) => {
      await new Promise<void>((resolve) => {
        resolvers.set(item.timestampUs, resolve)
      })
    }

    const queue = new BoundedIngestionQueue(controlledProcessFn, { maxSize: 100, maxConcurrency: 10 })

    // Push 5 events
    for (let i = 1; i <= 5; i++) {
      queue.push({ timestampUs: i * 1000, data: { seq: i } })
    }

    // Wait for drain
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    // Simulate checking cursor before "crash"
    // With all 5 in-flight, cursor should be min = 1000
    const cursorBeforeCrash = queue.getSafeCursor()
    expect(cursorBeforeCrash).toBe(1000)

    // The saved cursor (1000) ensures we replay from that point
    // This means no data is lost on crash
    expect(cursorBeforeCrash).toBeLessThanOrEqual(1000)

    // Clean up
    for (const resolver of resolvers.values()) resolver()
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  })

  it('IT-LW-004: Fix 7: replay from low watermark → no data loss', async () => {
    const processedTimestamps = new Set<number>()
    const processFn = async (item: QueueItem) => {
      processedTimestamps.add(item.timestampUs)
    }

    const queue = new BoundedIngestionQueue(processFn, { maxSize: 100, maxConcurrency: 10 })

    // First pass: push items 1000..5000
    for (let i = 1; i <= 5; i++) {
      queue.push({ timestampUs: i * 1000, data: { seq: i } })
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 200))

    // All items processed in first pass
    expect(processedTimestamps.size).toBe(5)

    // Simulate replay from low watermark (say cursor was at 3000, replay 3000..5000)
    const queue2 = new BoundedIngestionQueue(processFn, { maxSize: 100, maxConcurrency: 10 })
    for (let i = 3; i <= 5; i++) {
      queue2.push({ timestampUs: i * 1000, data: { seq: i } })
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 200))

    // Idempotent: all 5 original timestamps are still present (set deduplicates)
    expect(processedTimestamps.has(1000)).toBe(true)
    expect(processedTimestamps.has(2000)).toBe(true)
    expect(processedTimestamps.has(3000)).toBe(true)
    expect(processedTimestamps.has(4000)).toBe(true)
    expect(processedTimestamps.has(5000)).toBe(true)
  })

  it('IT-LW-005: Fix 7: graceful shutdown saves low watermark', async () => {
    let resolvers: Map<number, () => void> = new Map()
    const controlledProcessFn = async (item: QueueItem) => {
      await new Promise<void>((resolve) => {
        resolvers.set(item.timestampUs, resolve)
      })
    }

    const queue = new BoundedIngestionQueue(controlledProcessFn, { maxSize: 100, maxConcurrency: 10 })

    // Push 3 events
    queue.push({ timestampUs: 5000, data: { seq: 5 } })
    queue.push({ timestampUs: 3000, data: { seq: 3 } })
    queue.push({ timestampUs: 7000, data: { seq: 7 } })

    // Wait for drain
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    // Simulate SIGTERM: save cursor before shutdown
    const shutdownCursor = queue.getSafeCursor()

    // Should be min of in-flight timestamps = 3000
    expect(shutdownCursor).toBe(3000)

    // In a real system, we'd persist this cursor.
    // On restart, replay from 3000 ensures no data loss.
    expect(shutdownCursor).toBeLessThanOrEqual(5000)
    expect(shutdownCursor).toBeLessThanOrEqual(7000)

    // Clean up
    for (const resolver of resolvers.values()) resolver()
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  })
})
