import { z } from 'zod'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { services, didRedactions } from '@/db/schema/index.js'
import { allCanonicalCapabilities, isCustomCapability } from '@/shared/capability-registry.js'

/**
 * xRPC endpoint: com.dinakernel.service.searchCapabilities
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
  params: SearchCapabilitiesParamsType,
): Promise<SearchCapabilitiesResponse> {
  // Which index keys currently have ≥1 discoverable, non-tombstoned provider?
  // The index stores canonical names for registry capabilities AND normalized
  // names for namespaced custom capabilities (the handler admits both).
  // Unnest each service's capabilities; carry the service description +
  // per-capability schemas alongside so we can give custom capabilities REAL
  // descriptive text (not just their raw namespaced name) for intent matching.
  const rows = await db
    .select({
      cap: sql<string>`jsonb_array_elements_text(${services.capabilitiesJson}::jsonb)`,
      description: services.description,
      capabilitySchemasJson: services.capabilitySchemasJson,
    })
    .from(services)
    // GDPR-shaped: exclude any operator with a `did_redactions` row, mirroring
    // service-search.ts + service-is-discoverable.ts. Without this a redacted
    // provider still influences capability coverage (the LLM would see a
    // capability as "available" backed only by a taken-down provider).
    .leftJoin(didRedactions, eq(services.operatorDid, didRedactions.did))
    .where(
      and(
        eq(services.isDiscoverable, true),
        isNull(services.tombstonedAt),
        isNull(didRedactions.did),
      ),
    )

  const covered = new Set<string>()
  // Best human-readable description per CUSTOM capability key. Preference:
  // the provider's per-capability schema description → the service-level
  // description → (fall back to the raw name later). First non-empty wins so
  // the result is deterministic regardless of row order.
  const customDescriptions = new Map<string, string>()
  for (const row of rows) {
    const cap = row.cap
    if (typeof cap !== 'string' || cap.length === 0) continue
    covered.add(cap)
    if (customDescriptions.has(cap)) continue
    const schemas = row.capabilitySchemasJson as
      | Record<string, { description?: unknown }>
      | null
      | undefined
    const schemaDesc = schemas?.[cap]?.description
    const desc =
      typeof schemaDesc === 'string' && schemaDesc.trim() !== ''
        ? schemaDesc.trim()
        : typeof row.description === 'string' && row.description.trim() !== ''
          ? row.description.trim()
          : ''
    if (desc !== '') customDescriptions.set(cap, desc)
  }

  // Registry capabilities first, in stable registry order, with curated copy.
  const capabilities: CapabilityCandidate[] = []
  const registryNames = new Set<string>()
  for (const entry of allCanonicalCapabilities()) {
    registryNames.add(entry.canonical)
    if (covered.has(entry.canonical)) {
      capabilities.push({
        canonical: entry.canonical,
        description: entry.description,
        domain: entry.domain,
      })
    }
  }

  // Open vocabulary: a covered key that is NOT a registry capability but IS a
  // well-formed namespaced custom capability is a provider-owned listing —
  // surface it (sorted) so "any customer can create their own service" is
  // discoverable. A FLAT non-registry key is dropped (defensive).
  const customNames = [...covered]
    .filter((c) => !registryNames.has(c) && isCustomCapability(c))
    .sort()
  for (const name of customNames) {
    // Use the provider's published description so the LLM can match this
    // custom capability from natural language — not just when the query
    // happens to share words with the raw namespaced name. Falls back to the
    // name when the provider published no description.
    const description = customDescriptions.get(name) ?? name
    capabilities.push({ canonical: name, description, domain: 'custom' })
  }

  // Intent ranking: rank candidates by lexical token-overlap against each
  // candidate's (name + description + domain). Stable sort preserves the
  // registry/custom order for equal scores. Deterministic, dependency-free —
  // NOT semantic similarity. Embedding-based ranking is deferred (no pipeline
  // yet); see SERVICES_LAUNCH_ARCHITECTURE follow-up.
  const intent = params.intent
  if (typeof intent === 'string' && intent.trim() !== '') {
    const intentTokens = tokenize(intent)
    if (intentTokens.size > 0) {
      const scored = capabilities.map((c, i) => ({ c, i, score: overlapScore(intentTokens, c) }))
      scored.sort((a, b) => b.score - a.score || a.i - b.i)
      return { capabilities: scored.map((s) => s.c) }
    }
  }

  return { capabilities }
}

/** Lowercased alnum word tokens, deduped. Pure. */
function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length > 0) out.add(tok)
  }
  return out
}

/** Count of intent tokens present in a candidate's searchable text. */
function overlapScore(intentTokens: Set<string>, c: CapabilityCandidate): number {
  const hay = tokenize(`${c.canonical} ${c.description} ${c.domain}`)
  let score = 0
  for (const t of intentTokens) if (hay.has(t)) score++
  return score
}
