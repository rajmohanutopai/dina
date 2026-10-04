/**
 * The A2A directory's wiring and settings (design §8.3, notes M5 step 3):
 * which collections the consumer asks Jetstream for, the flag's default,
 * the retention the gap rule assumes, and the two xRPC rate tiers. Each is
 * read from the real module, never a copy.
 */

import { describe, expect, it } from 'vitest'

import { A2A_CARD_COLLECTION, A2A_FENCE_COLLECTION } from '@dina/a2a'

import { checkPerMethodRateLimit, createRateLimitCache } from '@/api/middleware/rate-limit'
import { envSchema } from '@/config/env'
import { COLLECTION_NSID_MAP, JETSTREAM_COLLECTIONS, TRUST_COLLECTIONS } from '@/config/lexicons'
import { FLAG_DEFAULTS } from '@/db/queries/appview-config'
import { isA2ACommit } from '@/ingester/a2a-directory'
import { routeHandler } from '@/ingester/handlers/index'

describe('the Jetstream subscription', () => {
  // Plan F15
  it('asks for the card collection, outside the trust collections, with no trust handler', () => {
    expect(JETSTREAM_COLLECTIONS).toContain(A2A_CARD_COLLECTION)
    expect(TRUST_COLLECTIONS as readonly string[]).not.toContain(A2A_CARD_COLLECTION)
    expect(Object.values(COLLECTION_NSID_MAP)).not.toContain(A2A_CARD_COLLECTION)
    expect(routeHandler(A2A_CARD_COLLECTION)).toBeNull()
    expect(isA2ACommit({ kind: 'commit', commit: { collection: A2A_CARD_COLLECTION } })).toBe(true)
  })

  // Plan F15
  it('never asks for the fence: AppView does not index fence records', () => {
    expect(JETSTREAM_COLLECTIONS).not.toContain(A2A_FENCE_COLLECTION)
    expect(isA2ACommit({ kind: 'commit', commit: { collection: A2A_FENCE_COLLECTION } })).toBe(false)
    expect(routeHandler(A2A_FENCE_COLLECTION)).toBeNull()
  })
})

describe('settings', () => {
  // Plan F115
  it('the directory flag is off by default, and the trust flag stays on', () => {
    expect(FLAG_DEFAULTS.a2a_directory_enabled).toBe(false)
    expect(FLAG_DEFAULTS.trust_v1_enabled).toBe(true)
  })

  // Plan F108
  it('the gap rule assumes Jetstream keeps 24 hours unless told otherwise, and never zero or less', () => {
    expect(envSchema.parse({}).A2A_JETSTREAM_RETENTION_HOURS).toBe(24)
    expect(envSchema.parse({ A2A_JETSTREAM_RETENTION_HOURS: '72' }).A2A_JETSTREAM_RETENTION_HOURS).toBe(72)
    for (const bad of ['0', '-1', 'a day']) {
      expect(() => envSchema.parse({ A2A_JETSTREAM_RETENTION_HOURS: bad })).toThrow()
    }
  })

  // Plan F108
  it('publishers’ DID documents come from plc.directory over HTTPS unless told otherwise', () => {
    expect(envSchema.parse({}).A2A_PLC_URL).toBe('https://plc.directory')
  })
})

describe('rate tiers', () => {
  const NOW = Date.parse('2026-10-03T12:00:00Z')
  const burst = (method: string, n: number, ip = '203.0.113.7') => {
    const cache = createRateLimitCache()
    const out: boolean[] = []
    for (let i = 0; i < n; i++) out.push(checkPerMethodRateLimit(cache, ip, method, NOW).ok)
    return out
  }

  // Plan F147
  it('searchAgents takes 60 a minute from one address; the 61st is refused', () => {
    const answers = burst('com.dinakernel.a2a.searchAgents', 61)
    expect(answers.slice(0, 60).every(Boolean)).toBe(true)
    expect(answers[60]).toBe(false)
  })

  // Plan F147
  it('getCard takes 120 a minute; the 121st is refused, and a search budget is apart from it', () => {
    const cache = createRateLimitCache()
    const ip = '203.0.113.8'
    for (let i = 0; i < 120; i++) expect(checkPerMethodRateLimit(cache, ip, 'com.dinakernel.a2a.getCard', NOW).ok).toBe(true)
    expect(checkPerMethodRateLimit(cache, ip, 'com.dinakernel.a2a.getCard', NOW).ok).toBe(false)
    expect(checkPerMethodRateLimit(cache, ip, 'com.dinakernel.a2a.searchAgents', NOW).ok).toBe(true)
    // A minute on, the card budget is back.
    expect(checkPerMethodRateLimit(cache, ip, 'com.dinakernel.a2a.getCard', NOW + 60_001).ok).toBe(true)
  })
})
