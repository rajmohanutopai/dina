/**
 * A located search keeps listings that name no place (TODO "Bangalore Salon
 * issue"). "bangalore salon" geocoded the city and searched with lat/lng; the
 * salon had published no service area, and the location filter required one,
 * so the search found nothing while "salon" alone found it.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { cleanAllTables, closeTestDb, createTestHandlerContext, getTestDb } from '../test-db'
import { clearFlagCache } from '@/ingester/feature-flag-cache.js'
import { serviceProfileHandler } from '@/ingester/handlers/service-profile.js'
import { serviceSearch, ServiceSearchParams } from '@/api/xrpc/service-search.js'

const db = getTestDb()
const ctx = () => createTestHandlerContext(db)
const NOW = Date.now() * 1000
const CID = (n: number) => `bafyrei${'a'.repeat(50)}${String.fromCharCode(97 + n)}`
const HERE = { lat: 12.9716, lng: 77.5946 }
const near = { latE7: 129_720_000, lngE7: 775_950_000, radiusKm: 10 }
const far = { latE7: 289_000_000, lngE7: 772_000_000, radiusKm: 10 }

async function publish(did: string, name: string, serviceArea: Record<string, number> | undefined, n: number) {
  await serviceProfileHandler.handleCreate(ctx(), {
    uri: `at://${did}/com.dinakernel.service.profile/self`,
    did,
    collection: 'com.dinakernel.service.profile',
    rkey: 'self',
    cid: CID(n),
    record: {
      name,
      capabilities: ['appointment_availability'],
      responsePolicy: { appointment_availability: 'auto' },
      isDiscoverable: true,
      discoverability: 'public',
      ...(serviceArea !== undefined ? { serviceArea } : {}),
      updatedAt: new Date().toISOString(),
    } as never,
    observedUs: NOW,
  })
}

beforeEach(async () => {
  await cleanAllTables(db)
  clearFlagCache()
})

afterAll(async () => {
  await closeTestDb()
})

describe('located service search', () => {
  it('keeps a listing with no location, ranked below a nearby one; drops one out of range', async () => {
    await publish('did:plc:nearsalon', 'Near salon', near, 0)
    await publish('did:plc:nowhere', 'Salon with no area', undefined, 1)
    await publish('did:plc:farsalon', 'Delhi salon', far, 2)

    const r = await serviceSearch(
      db as never,
      ServiceSearchParams.parse({ capability: 'appointment_availability', ...HERE, radiusKm: 25 }),
    )
    const dids = r.services.map((s) => s.operatorDid)
    expect(dids).toEqual(['did:plc:nearsalon', 'did:plc:nowhere'])
    const nowhere = r.services.find((s) => s.operatorDid === 'did:plc:nowhere')
    expect(nowhere?.distanceKm).toBeNull()
  })
})
