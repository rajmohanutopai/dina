import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { services } from '@/db/schema/index.js'

/**
 * xRPC endpoint: com.dina.service.isPublic
 *
 * Simple boolean check: does this DID have any public service profiles?
 * Used by Core's PublicServiceResolver to decide whether to bypass
 * D2D authentication for service discovery queries.
 */

export const ServiceIsPublicParams = z.object({
  did: z.string().min(8).max(2048).regex(/^did:[a-z]+:/),
})

export type ServiceIsPublicParamsType = z.infer<typeof ServiceIsPublicParams>

export interface ServiceIsPublicResponse {
  isPublic: boolean
  capabilities?: string[]
}

export async function serviceIsPublic(
  db: DrizzleDB,
  params: ServiceIsPublicParamsType,
): Promise<ServiceIsPublicResponse> {
  const rows = await db.select({
    capabilitiesJson: services.capabilitiesJson,
  })
    .from(services)
    .where(and(
      eq(services.operatorDid, params.did),
      eq(services.isPublic, true),
    ))

  if (rows.length === 0) {
    return { isPublic: false }
  }

  // Merge capabilities from all public service profiles for this DID
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
    isPublic: true,
    capabilities: Array.from(allCapabilities),
  }
}
