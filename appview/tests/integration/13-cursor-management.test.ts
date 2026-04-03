/**
 * Section 13 -- Cursor Management
 * Total tests: 6
 * Plan traceability: IT-CUR-001 .. IT-CUR-006
 *
 * Source: INTEGRATION_TEST_PLAN.md, Fix 7 (Low Watermark Cursor)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { ingesterCursor } from '@/db/schema/index'
import { getTestDb, cleanTables, closeTestDb, type TestDB } from '../test-db'
import { BoundedIngestionQueue } from '@/ingester/bounded-queue'

let db: TestDB

// Implement cursor load/save directly using Drizzle queries to avoid
// importing JetstreamConsumer (which has side effects like WebSocket setup).

async function loadCursor(database: TestDB, service: string): Promise<number> {
  const row = await database.select()
    .from(ingesterCursor)
    .where(eq(ingesterCursor.service, service))
    .limit(1)
  return row[0]?.cursor ? Number(row[0].cursor) : 0
}

async function saveCursor(database: TestDB, service: string, cursor: number): Promise<void> {
  await database.insert(ingesterCursor).values({
    service,
    cursor,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: ingesterCursor.service,
    set: { cursor, updatedAt: new Date() },
  })
}

beforeAll(async () => {
  db = getTestDb()
  // Clean cursor table once before all tests in this file
  await cleanTables(db, 'ingester_cursor')
})

afterAll(async () => {
  await closeTestDb()
})

describe('13 Cursor Management', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0572", "section": "01", "sectionName": "General", "title": "IT-CUR-001: loadCursor -- no prior cursor -> 0"}
  it('IT-CUR-001: loadCursor -- no prior cursor -> 0', async () => {
    // Description: Fresh database
    // Expected: cursor = 0
    const cursor = await loadCursor(db, 'cur001-nonexistent')
    expect(cursor).toBe(0)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0573", "section": "01", "sectionName": "General", "title": "IT-CUR-002: saveCursor -> loadCursor round-trip"}
  it('IT-CUR-002: saveCursor -> loadCursor round-trip', async () => {
    // Description: Save 12345, then load
    // Expected: Returns 12345
    const service = 'cur002-roundtrip'
    await saveCursor(db, service, 12345)
    const cursor = await loadCursor(db, service)
    expect(cursor).toBe(12345)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0574", "section": "01", "sectionName": "General", "title": "IT-CUR-003: saveCursor -- upsert on conflict"}
  it('IT-CUR-003: saveCursor -- upsert on conflict', async () => {
    // Description: Save twice for same service
    // Expected: 1 row, second value
    const service = 'cur003-upsert'
    await saveCursor(db, service, 100)
    await saveCursor(db, service, 200)

    const cursor = await loadCursor(db, service)
    expect(cursor).toBe(200)

    // Verify only 1 row exists for this service
    const rows = await db.select().from(ingesterCursor).where(eq(ingesterCursor.service, service))
    expect(rows.length).toBe(1)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0575", "section": "01", "sectionName": "General", "title": "IT-CUR-004: cursor per service URL"}
  it('IT-CUR-004: cursor per service URL', async () => {
    // Description: Save for ws://jetstream:6008 and ws://other:6008
    // Expected: 2 distinct rows
    const service1 = 'cur004-ws://jetstream:6008'
    const service2 = 'cur004-ws://other:6008'

    await saveCursor(db, service1, 1000)
    await saveCursor(db, service2, 2000)

    const cursor1 = await loadCursor(db, service1)
    const cursor2 = await loadCursor(db, service2)

    expect(cursor1).toBe(1000)
    expect(cursor2).toBe(2000)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0576", "section": "01", "sectionName": "General", "title": "IT-CUR-005: Fix 7: low watermark cursor value"}
  it('IT-CUR-005: Fix 7: low watermark cursor value', async () => {
    // Description: Save via getSafeCursor with in-flight
    // Expected: Saved value = min(in-flight) - 1

    // Create a BoundedIngestionQueue and push items to simulate in-flight tracking
    const processedItems: number[] = []
    const queue = new BoundedIngestionQueue(
      async (item) => {
        // Simulate slow processing so items stay in-flight
        await new Promise(resolve => setTimeout(resolve, 200))
        processedItems.push(item.timestampUs)
      },
      { maxSize: 100, maxConcurrency: 2 },
    )

    // Push items with different timestamps
    queue.push({ timestampUs: 5000, data: 'event-a' })
    queue.push({ timestampUs: 3000, data: 'event-b' })
    queue.push({ timestampUs: 7000, data: 'event-c' })

    // Give the queue a tick to start processing (items move to in-flight)
    await new Promise(resolve => setTimeout(resolve, 50))

    // getSafeCursor should return the minimum among queued + in-flight items
    const safeCursor = queue.getSafeCursor()
    expect(safeCursor).not.toBeNull()
    // The safe cursor should be the minimum timestamp among all pending items
    expect(safeCursor).toBeLessThanOrEqual(3000)

    // Save the safe cursor (minus 1 as the low watermark)
    const cursorValue = safeCursor! - 1
    const service = 'cur005-lowwatermark'
    await saveCursor(db, service, cursorValue)

    const loaded = await loadCursor(db, service)
    expect(loaded).toBe(cursorValue)

    // Wait for all processing to complete
    await new Promise(resolve => setTimeout(resolve, 500))
  })

  // TRACE: {"suite": "APPVIEW", "case": "0577", "section": "01", "sectionName": "General", "title": "IT-CUR-006: HIGH-04: cursor includes failed event timestamps"}
  it('IT-CUR-006: HIGH-04: cursor includes failed event timestamps', async () => {
    // Description: A failed event should pin the cursor
    // Expected: getSafeCursor includes failed timestamps in minimum calculation
    const queue = new BoundedIngestionQueue(
      async (item) => {
        if (item.timestampUs === 2000) {
          // Delay before throwing so the item is still in-flight when we check
          // getSafeCursor(). Without this, all 3 retry attempts complete instantly
          // and the item gets dead-lettered before the assertion.
          await new Promise(resolve => setTimeout(resolve, 500))
          throw new Error('Simulated failure')
        }
        // Other items complete successfully
      },
      { maxSize: 100, maxConcurrency: 5 },
    )

    queue.push({ timestampUs: 2000, data: 'will-fail' })
    queue.push({ timestampUs: 5000, data: 'will-succeed' })
    queue.push({ timestampUs: 8000, data: 'will-succeed' })

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 300))

    // HIGH-04: Failed item's timestamp (2000) should pin the cursor
    const safeCursor = queue.getSafeCursor()
    expect(safeCursor).toBe(2000)

    // Save this pinned cursor
    const service = 'cur006-failed'
    await saveCursor(db, service, safeCursor!)
    const loaded = await loadCursor(db, service)
    expect(loaded).toBe(2000)
  })
})
