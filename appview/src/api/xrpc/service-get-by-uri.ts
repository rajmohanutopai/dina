import { z } from 'zod'
import { eq, and, isNull } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { services, didRedactions } from '@/db/schema/index.js'

/**
 * xRPC endpoint: com.dinakernel.service.getByUri
 *
 * Resolve a SINGLE service listing by its exact AT-URI
 * (`at://<did>/com.dinakernel.service.profile/<rkey>`) — the "resolve a
 * shared link" path for UNLISTED services.
 *
 * Unlike `service.search` (which gates on `isDiscoverable=true`, so it only
 * ever returns `public` listings), this endpoint does NOT filter on
 * discoverability — it returns the row whether it's `public` or `unlisted`.
 * That's the whole point: an `unlisted` listing is hidden from search but must
 * stay resolvable by whoever holds its exact URI (the link/QR/invite). A
 * `known_only` listing is never stored in the index at all, so it simply isn't
 * found here (returns null), which is correct — those resolve over the direct
 * D2D relationship, not the network.
 *
 * Still fail-safe on takedown: tombstoned (moderator-removed) and GDPR-redacted
 * operators return null — a taken-down service must not be resolvable into a
 * callable listing even by exact URI.
 */

export const ServiceGetByUriParams = z.object({
  uri: z.string().min(1).max(2048),
})

export type ServiceGetByUriParamsType = z.infer<typeof ServiceGetByUriParams>

export interface ServiceGetByUriResponse {
  uri: string
  operatorDid: string
  name: string
  description: string | null
  capabilities: unknown
  capabilitySchemas: unknown
  responsePolicy: unknown
  serviceArea: { lat: number; lng: number; radiusKm: number } | null
  discoverability: string | null
}

export async function serviceGetByUri(
  db: DrizzleDB,
  params: ServiceGetByUriParamsType,
): Promise<ServiceGetByUriResponse | null> {
  const rows = await db
    .select({
      uri: services.uri,
      operatorDid: services.operatorDid,
      name: services.name,
      description: services.description,
      capabilitiesJson: services.capabilitiesJson,
      capabilitySchemasJson: services.capabilitySchemasJson,
      responsePolicyJson: services.responsePolicyJson,
      lat: services.lat,
      lng: services.lng,
      radiusKm: services.radiusKm,
      discoverability: services.discoverability,
    })
    .from(services)
    // GDPR-shaped exclusion (mirrors service-search / isDiscoverable): a DID
    // with a did_redactions row resolves to null. Tombstoned rows likewise —
    // a moderator takedown must not be invocable even via a direct link.
    .leftJoin(didRedactions, eq(services.operatorDid, didRedactions.did))
    .where(
      and(
        eq(services.uri, params.uri),
        isNull(services.tombstonedAt),
        isNull(didRedactions.did),
      ),
    )
    .limit(1)

  const row = rows[0]
  if (row === undefined) return null

  const serviceArea =
    row.lat != null && row.lng != null && row.radiusKm != null
      ? {
          lat: parseFloat(row.lat),
          lng: parseFloat(row.lng),
          radiusKm: parseFloat(row.radiusKm),
        }
      : null

  return {
    uri: row.uri,
    operatorDid: row.operatorDid,
    name: row.name,
    description: row.description,
    capabilities: row.capabilitiesJson,
    capabilitySchemas: row.capabilitySchemasJson,
    responsePolicy: row.responsePolicyJson,
    serviceArea,
    discoverability: row.discoverability,
  }
}
