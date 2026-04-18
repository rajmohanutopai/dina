import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { services } from '@/db/schema/index.js'

/**
 * xRPC endpoint: com.dina.service.isDiscoverable
 *
 * Simple boolean check: does this DID have any provider service profiles?
 * Used by Core's ProviderServiceResolver to decide whether to bypass
 * D2D authentication for service discovery queries.
 */

export const ServiceIsDiscoverableParams = z.object({
  did: z.string().min(8).max(2048).regex(/^did:[a-z]+:/),
})

export type ServiceIsDiscoverableParamsType = z.infer<typeof ServiceIsDiscoverableParams>

export interface ServiceIsDiscoverableResponse {
  isDiscoverable: boolean
  capabilities?: string[]
}

export async function serviceIsDiscoverable(
  db: DrizzleDB,
  params: ServiceIsDiscoverableParamsType,
): Promise<ServiceIsDiscoverableResponse> {
  const rows = await db.select({
    capabilitiesJson: services.capabilitiesJson,
  })
    .from(services)
    .where(and(
      eq(services.operatorDid, params.did),
      eq(services.isDiscoverable, true),
    ))

  if (rows.length === 0) {
    return { isDiscoverable: false }
  }

  // Merge capabilities from all provider service profiles for this DID
  const allCapabilities = new Set<string>()
  for (const row of rows) {
    const caps = row.capabilitiesJson as string[]
    if (Array.isArray(caps)) {
      for (const cap of caps) {
        allCapabilities.add(cap)
      }
    }
  }

  return {
    isDiscoverable: true,
    capabilities: Array.from(allCapabilities),
  }
}
