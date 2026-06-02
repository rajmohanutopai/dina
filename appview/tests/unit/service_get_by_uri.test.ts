/**
 * Unit tests for `appview/src/api/xrpc/service-get-by-uri.ts`.
 *
 * This endpoint is the "resolve a shared link" path for UNLISTED services.
 * The load-bearing invariant: it must NOT filter on `is_discoverable` (so an
 * unlisted listing — stored with isDiscoverable=false — still resolves by exact
 * URI), but it MUST still exclude tombstoned/redacted operators (a taken-down
 * service is not invocable even via a direct link). `known_only` listings are
 * never stored, so they simply aren't found (null) — verified by the "no rows"
 * case.
 */

import { describe, it, expect } from 'vitest'
import { serviceGetByUri } from '@/api/xrpc/service-get-by-uri'
import type { DrizzleDB } from '@/db/connection'

interface Row {
  uri: string
  operatorDid: string
  name: string
  description: string | null
  capabilitiesJson: unknown
  capabilitySchemasJson: unknown
  responsePolicyJson: unknown
  lat: string | null
  lng: string | null
  radiusKm: string | null
  discoverability: string | null
}

/** Stub matching `db.select({...}).from().leftJoin().where(pred).limit(1)`. */
function stubDb(rows: Row[]): { db: DrizzleDB; capturedWhere: () => unknown } {
  let where: unknown
  const limitStep = { limit: async () => rows }
  const whereStep = {
    where: (pred: unknown) => {
      where = pred
      return limitStep
    },
  }
  const db = {
    select: () => ({ from: () => ({ leftJoin: () => whereStep }) }),
  } as unknown as DrizzleDB
  return { db, capturedWhere: () => where }
}

function whereCols(pred: unknown): string {
  return JSON.stringify(pred, (_k, v) => {
    if (
      v !== null &&
      typeof v === 'object' &&
      'name' in (v as Record<string, unknown>) &&
      typeof (v as { name: unknown }).name === 'string'
    ) {
      return `col:${(v as { name: string }).name}`
    }
    return v
  })
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    uri: 'at://did:plc:bus42/com.dinakernel.service.profile/route-42',
    operatorDid: 'did:plc:bus42',
    name: 'Bus 42',
    description: null,
    capabilitiesJson: ['eta_query'],
    capabilitySchemasJson: { eta_query: { schemaHash: 'abc' } },
    responsePolicyJson: { eta_query: 'auto' },
    lat: null,
    lng: null,
    radiusKm: null,
    discoverability: 'public',
    ...overrides,
  }
}

describe('serviceGetByUri (unlisted resolve-by-link)', () => {
  it('WHERE references uri + tombstoned_at but NOT is_discoverable', async () => {
    // The whole point: do NOT gate on is_discoverable, so unlisted resolves;
    // DO gate on tombstoned_at, so a taken-down service does not.
    const { db, capturedWhere } = stubDb([row()])
    await serviceGetByUri(db, { uri: row().uri })
    const cols = whereCols(capturedWhere())
    expect(cols).toContain('col:uri')
    expect(cols).toContain('col:tombstoned_at')
    expect(cols).not.toContain('col:is_discoverable')
  })

  it('resolves a public listing by exact uri', async () => {
    const { db } = stubDb([row()])
    const r = await serviceGetByUri(db, { uri: row().uri })
    expect(r).not.toBeNull()
    expect(r?.operatorDid).toBe('did:plc:bus42')
    expect(r?.capabilities).toEqual(['eta_query'])
    expect(r?.discoverability).toBe('public')
  })

  it('resolves an UNLISTED listing (isDiscoverable=false but stored)', async () => {
    // The handler never inspects isDiscoverable; an unlisted row resolves the
    // same as a public one once found by uri.
    const { db } = stubDb([row({ discoverability: 'unlisted' })])
    const r = await serviceGetByUri(db, { uri: row().uri })
    expect(r).not.toBeNull()
    expect(r?.discoverability).toBe('unlisted')
    expect(r?.capabilitySchemas).toEqual({ eta_query: { schemaHash: 'abc' } })
  })

  it('returns null when nothing matches (not found / known_only / tombstoned / redacted)', async () => {
    const { db } = stubDb([])
    expect(await serviceGetByUri(db, { uri: 'at://did:plc:x/com.dinakernel.service.profile/none' })).toBeNull()
  })

  it('maps lat/lng/radiusKm into serviceArea', async () => {
    const { db } = stubDb([row({ lat: '37.77', lng: '-122.43', radiusKm: '25' })])
    const r = await serviceGetByUri(db, { uri: row().uri })
    expect(r?.serviceArea).toEqual({ lat: 37.77, lng: -122.43, radiusKm: 25 })
  })
})
