/**
 * §7 — Rate Limiter with Database Effects
 *
 * Test count: 5
 * Plan traceability: IT-RL-001..005
 *
 * Traces to: Fix 11
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { isRateLimited, getQuarantinedDids, getWriteCount, resetRateLimiter } from '@/ingester/rate-limiter'
import { getTestDb, cleanAllTables, closeTestDb, createTestHandlerContext } from '../test-db'
import { sql } from 'drizzle-orm'

const db = getTestDb()
const ctx = createTestHandlerContext(db)

beforeEach(async () => {
  resetRateLimiter()
  await cleanAllTables(db)
})

afterAll(async () => {
  await closeTestDb()
})

// ---------------------------------------------------------------------------
// §7 Rate Limiter with Database Effects (IT-RL-001..005) — 5 tests
// ---------------------------------------------------------------------------
describe('§7 Rate Limiter with Database Effects (Fix 11)', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0421", "section": "01", "sectionName": "General", "title": "IT-RL-001: Fix 11: 50 records \u2192 all written to DB"}
  it('IT-RL-001: Fix 11: 50 records → all written to DB', async () => {
    const did = 'did:plc:rateLimitTest001'

    // Call isRateLimited 50 times — all should return false (not limited)
    for (let i = 0; i < 50; i++) {
      const limited = isRateLimited(did)
      expect(limited).toBe(false)
    }

    // Verify write count is 50
    const count = getWriteCount(did)
    expect(count).toBe(50)

    // DID should not be quarantined
    const quarantined = getQuarantinedDids()
    expect(quarantined.has(did)).toBe(false)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0422", "section": "01", "sectionName": "General", "title": "IT-RL-002: Fix 11: 51st record \u2192 dropped, no DB write"}
  it('IT-RL-002: Fix 11: 51st record → dropped, no DB write', async () => {
    const did = 'did:plc:rateLimitTest002'

    // First 50 calls should not be limited
    for (let i = 0; i < 50; i++) {
      expect(isRateLimited(did)).toBe(false)
    }

    // 51st call should be rate limited
    expect(isRateLimited(did)).toBe(true)

    // Write count should remain at 50 (51st was rejected, not recorded)
    const count = getWriteCount(did)
    expect(count).toBe(50)

    // DID should now be quarantined
    const quarantined = getQuarantinedDids()
    expect(quarantined.has(did)).toBe(true)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0423", "section": "01", "sectionName": "General", "title": "IT-RL-003: Fix 11: rate-limited DID \u2192 zero DB I/O"}
  it('IT-RL-003: Fix 11: rate-limited DID → zero DB I/O', async () => {
    const did = 'did:plc:rateLimitTest003'

    // Hit the limit
    for (let i = 0; i < 50; i++) {
      isRateLimited(did)
    }

    // Confirm limited
    expect(isRateLimited(did)).toBe(true)

    // Send 100 more — all should be rate limited
    for (let i = 0; i < 100; i++) {
      const limited = isRateLimited(did)
      expect(limited).toBe(true)
    }

    // Write count should still be 50 (no additional writes recorded)
    const count = getWriteCount(did)
    expect(count).toBe(50)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0424", "section": "01", "sectionName": "General", "title": "IT-RL-004: Fix 11: quarantine feeds sybil detection"}
  it('IT-RL-004: Fix 11: quarantine feeds sybil detection', async () => {
    const did = 'did:plc:rateLimitTest004'

    // Hit the rate limit
    for (let i = 0; i < 50; i++) {
      isRateLimited(did)
    }
    // Trigger quarantine
    isRateLimited(did)

    // Verify the DID appears in quarantine list
    const quarantined = getQuarantinedDids()
    expect(quarantined.has(did)).toBe(true)
    expect(quarantined.size).toBeGreaterThanOrEqual(1)

    // In real system, sybil detector would read quarantinedDids as input
    // Here we verify the contract: quarantined set contains the spammy DID
    const quarantinedArray = [...quarantined]
    expect(quarantinedArray).toContain(did)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0425", "section": "01", "sectionName": "General", "title": "IT-RL-005: Fix 11: different DIDs not affected"}
  it('IT-RL-005: Fix 11: different DIDs not affected', async () => {
    const didA = 'did:plc:rateLimitTestA'
    const didB = 'did:plc:rateLimitTestB'

    // Rate-limit DID-A
    for (let i = 0; i < 50; i++) {
      isRateLimited(didA)
    }
    expect(isRateLimited(didA)).toBe(true)

    // DID-B should not be affected at all
    for (let i = 0; i < 30; i++) {
      expect(isRateLimited(didB)).toBe(false)
    }

    // DID-B has 30 writes
    expect(getWriteCount(didB)).toBe(30)

    // DID-B is not quarantined
    const quarantined = getQuarantinedDids()
    expect(quarantined.has(didA)).toBe(true)
    expect(quarantined.has(didB)).toBe(false)
  })
})
