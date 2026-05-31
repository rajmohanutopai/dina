/**
 * Unit tests for com.dina.service.searchCapabilities (Layer 4 discovery).
 * Spec: docs/SERVICES_LAUNCH_ARCHITECTURE.md Part 1, Layer 4.
 */

import { describe, expect, it } from 'vitest'
import type { DrizzleDB } from '@/db/connection.js'
import {
  searchCapabilities,
  SearchCapabilitiesParams,
} from '../../src/api/xrpc/search-capabilities.js'

/**
 * Stub the simple `select().from().where()` chain the handler uses,
 * returning the given unnested-capability rows (each `{ cap }`).
 */
function stubDb(rows: Array<{ cap: string }>): DrizzleDB {
  return {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  } as unknown as DrizzleDB
}

describe('searchCapabilities — params', () => {
  it('requires a non-empty intent', () => {
    expect(SearchCapabilitiesParams.safeParse({ intent: '' }).success).toBe(false)
    expect(SearchCapabilitiesParams.safeParse({ intent: 'when is the bus' }).success).toBe(true)
  })

  it('accepts optional geo (scale-ready contract)', () => {
    const r = SearchCapabilitiesParams.safeParse({ intent: 'bus', lat: 37, lng: -122 })
    expect(r.success).toBe(true)
  })
})

describe('searchCapabilities — registry ∩ coverage', () => {
  it('returns only registry capabilities that have a provider', async () => {
    // Coverage: only eta_query has a provider.
    const db = stubDb([{ cap: 'eta_query' }])
    const r = await searchCapabilities(db, { intent: 'when does the bus arrive' })
    expect(r.capabilities.map((c) => c.canonical)).toEqual(['eta_query'])
    expect(r.capabilities[0].domain).toBe('transit')
    expect(r.capabilities[0].description).toMatch(/arrival/i)
  })

  it('returns multiple when multiple domains have providers', async () => {
    const db = stubDb([{ cap: 'eta_query' }, { cap: 'appointment_status' }])
    const r = await searchCapabilities(db, { intent: 'anything' })
    const names = r.capabilities.map((c) => c.canonical).sort()
    expect(names).toEqual(['appointment_status', 'eta_query'])
  })

  it('returns empty when NO provider exists (honest empty-state / coverage)', async () => {
    const db = stubDb([])
    const r = await searchCapabilities(db, { intent: 'when does the bus arrive' })
    expect(r.capabilities).toEqual([])
  })

  it('ignores a covered capability that is NOT in the registry (stale/unknown index row)', async () => {
    // Defensive: the index should only hold canonical names, but if a
    // non-registry string somehow appears it must NOT be surfaced as a
    // discovery candidate.
    const db = stubDb([{ cap: 'eta_query' }, { cap: 'mystery_capability' }])
    const r = await searchCapabilities(db, { intent: 'x' })
    expect(r.capabilities.map((c) => c.canonical)).toEqual(['eta_query'])
  })

  it('dedupes a capability provided by multiple providers', async () => {
    const db = stubDb([{ cap: 'eta_query' }, { cap: 'eta_query' }])
    const r = await searchCapabilities(db, { intent: 'x' })
    expect(r.capabilities.map((c) => c.canonical)).toEqual(['eta_query'])
  })

  it('surfaces a provider-owned namespaced custom capability (open vocabulary)', async () => {
    const db = stubDb([{ cap: 'eta_query' }, { cap: 'com.acme.widget_price' }])
    const r = await searchCapabilities(db, { intent: 'zzz' })
    const byName = new Map(r.capabilities.map((c) => [c.canonical, c]))
    // registry one keeps its curated copy; the custom one is surfaced as `custom`.
    expect(byName.get('eta_query')?.domain).toBe('transit')
    expect(byName.get('com.acme.widget_price')).toEqual({
      canonical: 'com.acme.widget_price',
      description: 'com.acme.widget_price',
      domain: 'custom',
    })
  })

  it('still drops a FLAT non-registry capability (only namespaced customs are open)', async () => {
    // `mystery_capability` has no dot → not a well-formed custom capability →
    // never surfaced, even under the open vocabulary.
    const db = stubDb([{ cap: 'eta_query' }, { cap: 'mystery_capability' }])
    const r = await searchCapabilities(db, { intent: 'zzz' })
    expect(r.capabilities.map((c) => c.canonical)).toEqual(['eta_query'])
  })

  it('ranks candidates by lexical overlap with intent', async () => {
    const db = stubDb([{ cap: 'eta_query' }, { cap: 'appointment_status' }])
    // "appointment" overlaps the appointment_status name/description, so it
    // ranks ahead of the transit capability.
    const r = await searchCapabilities(db, { intent: 'check my appointment booking' })
    expect(r.capabilities[0].canonical).toBe('appointment_status')
  })

  it('intent with no overlap preserves the default (registry-first) order', async () => {
    const db = stubDb([{ cap: 'eta_query' }, { cap: 'com.acme.widget_price' }])
    const r = await searchCapabilities(db, { intent: 'zzz nomatch qqq' })
    // stable: registry capability stays before the custom one.
    expect(r.capabilities.map((c) => c.canonical)).toEqual(['eta_query', 'com.acme.widget_price'])
  })
})
