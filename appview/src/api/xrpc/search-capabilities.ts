import { z } from 'zod'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { services } from '@/db/schema/index.js'
import { allCanonicalCapabilities } from '@/shared/capability-registry.js'

/**
 * xRPC endpoint: com.dina.service.searchCapabilities
 *
 * Consumer-side capability DISCOVERY (SERVICES_LAUNCH_ARCHITECTURE.md
 * Part 1, Layer 4). The contract is INTENT-BASED, not "dump the
 * catalogue": the caller passes a free-text `intent` (the user's
 * question — "when's the bus") and gets back the real canonical
 * capabilities that can serve it. This is what removes the consumer's
 * blind capability guess (Bug 1) AND the empty-flagship failure
 * (coverage): the LLM can only pick a capability that actually has a
 * provider behind it.
 *
 * Output = canonical capabilities that are BOTH:
 *   (a) in the closed registry, AND
 *   (b) currently advertised by ≥1 discoverable, non-tombstoned provider
 *       (the coverage filter — an unsupported intent ends at the honest
 *       empty-state immediately, no wasted provider search).
 *
 * Launch implementation: the with-provider set is tiny (2 domains), so we
 * return ALL covered registry capabilities and let the LLM select by
 * description. The `intent` is accepted now (the scale-ready contract)
 * but not yet used for ranking — at scale the same endpoint embeds the
 * intent and cosine-ranks → top-N, a server-side swap behind this same
 * contract with no client change.
 */

export const SearchCapabilitiesParams = z.object({
  /** Free-text user intent. Accepted now; embedding-ranked at scale. */
  intent: z.string().min(1).max(500),
  // Geo is part of the scale-ready contract (proximity-aware ranking)
  // but unused at launch — the coverage set is tiny. Optional so callers
  // can pass it without a behavior change today.
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
})

export type SearchCapabilitiesParamsType = z.infer<typeof SearchCapabilitiesParams>

export interface CapabilityCandidate {
  canonical: string
  description: string
  domain: string
}

export interface SearchCapabilitiesResponse {
  capabilities: CapabilityCandidate[]
}

export async function searchCapabilities(
  db: DrizzleDB,
  // `intent` (+ geo) are part of the contract but unused at launch — the
  // coverage set is tiny so we return all covered capabilities. Prefixed
  // with `_` to document "accepted, not yet consumed" without an unused-
  // var lint error.
  _params: SearchCapabilitiesParamsType,
): Promise<SearchCapabilitiesResponse> {
  // Which canonical capabilities currently have ≥1 discoverable,
  // non-tombstoned provider? One grouped query over the index. The index
  // stores CANONICAL names (the handler canonicalizes on ingest), so a
  // capability appearing here is already canonical.
  const rows = await db
    .select({
      // jsonb_array_elements_text unnests the capabilities array so we can
      // DISTINCT the individual canonical capability strings.
      cap: sql<string>`jsonb_array_elements_text(${services.capabilitiesJson}::jsonb)`,
    })
    .from(services)
    .where(and(eq(services.isDiscoverable, true), isNull(services.tombstonedAt)))

  const covered = new Set<string>()
  for (const row of rows) {
    if (typeof row.cap === 'string' && row.cap.length > 0) covered.add(row.cap)
  }

  // Intersect registry × coverage. Registry order is stable + intentional
  // (domain grouping), so the response order is deterministic.
  const capabilities: CapabilityCandidate[] = []
  for (const entry of allCanonicalCapabilities()) {
    if (covered.has(entry.canonical)) {
      capabilities.push({
        canonical: entry.canonical,
        description: entry.description,
        domain: entry.domain,
      })
    }
  }

  return { capabilities }
}
