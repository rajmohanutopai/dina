import { z } from 'zod'
import { eq, and, isNull, sql } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { services, didRedactions, serviceAccountStatus, serviceOperatorPresence } from '@/db/schema/index.js'
import { livenessSql, readLivenessSettings, servableSql, type Liveness } from '@/shared/service-liveness.js'

/**
 * xRPC endpoint: com.dinakernel.service.isDiscoverable
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
  /** Live listings (§14): the operator's liveness, when discoverable. */
  liveness?: Liveness
}

export async function serviceIsDiscoverable(
  db: DrizzleDB,
  params: ServiceIsDiscoverableParamsType,
): Promise<ServiceIsDiscoverableResponse> {
  const live = await readLivenessSettings(db)
  const P = 'service_operator_presence'
  const rows = await db.select({
    capabilitiesJson: services.capabilitiesJson,
    liveness: sql<string>`${livenessSql(P, live)}`.as('liveness_label'),
  })
    .from(services)
    // GDPR-shaped: a DID with a `did_redactions` row is excluded entirely.
    // Mirrors service-search.ts so a redacted provider can NEITHER surface in
    // search NOR authorise the D2D egress bypass via this endpoint. The LEFT
    // JOIN keeps non-redacted operators eligible; the IS NULL check drops the
    // redacted ones.
    .leftJoin(didRedactions, eq(services.operatorDid, didRedactions.did))
    .leftJoin(serviceOperatorPresence, eq(services.operatorDid, serviceOperatorPresence.did))
    .leftJoin(serviceAccountStatus, eq(services.operatorDid, serviceAccountStatus.did))
    .where(and(
      eq(services.operatorDid, params.did),
      // Live listings (§14): the same gate as search.
      servableSql('services', P, 'service_account_status'),
      eq(services.isDiscoverable, true),
      // Exclude moderator-tombstoned rows. A tombstoned service must NOT
      // pass the public-service egress bypass even though its row still
      // carries isDiscoverable=true. Mirrors service-search.ts's filter —
      // without it a taken-down service could still authorise D2D egress.
      isNull(services.tombstonedAt),
      isNull(didRedactions.did),
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
    liveness: (rows[0]?.liveness ?? 'unknown') as Liveness,
  }
}
