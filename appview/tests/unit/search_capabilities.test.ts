/**
 * Unit tests for com.dinakernel.service.searchCapabilities (Layer 4 discovery).
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
function stubDb(
  rows: Array<{
    cap: string
    description?: string | null
    capabilitySchemasJson?: Record<string, unknown> | null
  }>,
): DrizzleDB {
  // The handler chains `.leftJoin(didRedactions).where(...)` (GDPR redaction
  // exclusion); resolve both the joined + unjoined shapes to `rows`.
  const whereStep = { where: async () => rows }
  return {
    select: () => ({
      from: () => ({
        leftJoin: () => whereStep,
        where: whereStep.where,
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

  it('EXCLUDES a provider-owned namespaced custom capability from generic intent discovery (V1)', async () => {
    // V1 rule: custom (namespaced) capabilities must not enter the generic AI
    // routing pool — only official catalog capabilities do. The custom cap is
    // still reachable by exact NSID via service.search; it just never surfaces
    // here. Prevents namespace hijacking of the shared AI vocabulary.
    const db = stubDb([{ cap: 'eta_query' }, { cap: 'com.acme.widget_price' }])
    const r = await searchCapabilities(db, { intent: 'zzz' })
    expect(r.capabilities.map((c) => c.canonical)).toEqual(['eta_query'])
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

  it('intent with no overlap returns only registry capabilities (custom excluded)', async () => {
    const db = stubDb([{ cap: 'eta_query' }, { cap: 'com.acme.widget_price' }])
    const r = await searchCapabilities(db, { intent: 'zzz nomatch qqq' })
    // Only the registry capability — the custom one is never in the generic pool.
    expect(r.capabilities.map((c) => c.canonical)).toEqual(['eta_query'])
  })

  it('EXCLUDES a custom capability even when it ships a rich schema description (#5)', async () => {
    // A published description does NOT buy a custom capability into generic
    // intent discovery — exclusion is by capability CLASS, not by metadata.
    const db = stubDb([
      { cap: 'eta_query' },
      {
        cap: 'com.acme.widget_price',
        description: 'Acme storefront',
        capabilitySchemasJson: {
          'com.acme.widget_price': { description: 'Check the price of a widget at Acme' },
        },
      },
    ])
    const r = await searchCapabilities(db, { intent: 'anything' })
    expect(r.capabilities.map((c) => c.canonical)).toEqual(['eta_query'])
    expect(r.capabilities.find((c) => c.canonical === 'com.acme.widget_price')).toBeUndefined()
  })

  it('a lone custom capability (no registry coverage) yields an empty generic pool', async () => {
    // Even when the ONLY covered capability is a custom one, generic intent
    // discovery returns nothing — the AI is steered to the honest empty-state
    // (and the custom service is reached by exact NSID / URI / profile browse).
    const db = stubDb([
      {
        cap: 'com.acme.widget_price',
        description: 'Acme storefront — widgets and gadgets',
        capabilitySchemasJson: null,
      },
    ])
    const r = await searchCapabilities(db, { intent: 'widget' })
    expect(r.capabilities).toEqual([])
  })

  it('WHERE excludes GDPR-redacted operators (references the did_redactions join column)', async () => {
    // P2: a redacted provider must not influence capability coverage. The
    // `isNull(didRedactions.did)` term references the redactions table's `did`
    // column — distinct from services' `operator_did`.
    let captured: unknown
    const whereStep = {
      where: async (pred: unknown) => {
        captured = pred
        return [] as Array<{ cap: string }>
      },
    }
    const db = {
      select: () => ({
        from: () => ({
          leftJoin: () => whereStep,
          where: whereStep.where,
        }),
      }),
    } as unknown as DrizzleDB
    await searchCapabilities(db, { intent: 'anything' })
    const cols = JSON.stringify(captured, (_k, v) =>
      v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string'
        ? `col:${(v as { name: string }).name}`
        : v,
    )
    expect(cols).toContain('col:did')
  })
})
