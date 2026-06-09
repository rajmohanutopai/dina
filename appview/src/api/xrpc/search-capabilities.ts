import { z } from 'zod'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { services, didRedactions } from '@/db/schema/index.js'
import { allCanonicalCapabilities } from '@/shared/capability-registry.js'

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
 * Output = canonical capabilities that are ALL of:
 *   (a) in the closed registry, AND
 *   (b) flagged `intentRoutable` (PUBLIC_SERVICES_TAXONOMY §3 — official-but-
 *       subject-scoped capabilities never enter generic routing), AND
 *   (c) currently advertised by ≥1 discoverable, non-tombstoned provider
 *       (the coverage filter — an unsupported intent ends at the honest
 *       empty-state immediately, no wasted provider search).
 *
 * Custom (provider-owned, namespaced) capabilities are DELIBERATELY EXCLUDED
 * from this generic intent pool (V1 rule). They remain reachable by exact NSID
 * (service.search), by exact service_uri (service.getByUri), and later by
 * provider/place browse — but never by generic "what service answers this?"
 * routing, so a provider can't hijack the shared AI vocabulary by publishing
 * `com.foo.best_doctor`.
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
  // Unnest each service's capabilities just to compute COVERAGE — which index
  // keys currently have ≥1 live provider. We only need the capability name:
  // custom capabilities are intentionally excluded from this result (below),
  // so the per-capability descriptions the old custom branch needed are gone.
  const rows = await db
    .select({
      cap: sql<string>`jsonb_array_elements_text(${services.capabilitiesJson}::jsonb)`,
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
  for (const row of rows) {
    const cap = row.cap
    if (typeof cap === 'string' && cap.length > 0) covered.add(cap)
  }

  // V1 rule: generic intent discovery returns ONLY official catalog
  // (canonical) capabilities — the stable, shared AI vocabulary. Custom
  // (provider-owned, namespaced) capabilities are DELIBERATELY excluded from
  // this pool: a provider must not be able to publish `com.foo.best_doctor`
  // and have it compete in generic "what service answers this?" routing
  // (namespace hijacking → unpredictable, untrustworthy AI selection). Custom
  // capabilities stay fully reachable — by EXACT NSID via service.search, by
  // exact service_uri via service.getByUri, and (later) via provider/place
  // browse — just never via generic intent. (Restored to the original spec
  // §Layer-4 contract: "in the closed registry".)
  //
  // SECOND gate (PUBLIC_SERVICES_TAXONOMY §3): only canonical capabilities
  // flagged `intentRoutable` enter the generic pool. An official capability
  // can be a shared contract yet stay out of generic routing forever —
  // subject-scoped reads (`school_homework_status`, `order_status`) route via
  // the already-known provider, never via "what service answers this?". The
  // gate holds even if such a capability is somehow published publicly:
  // discoverability and routability are enforced independently.
  const capabilities: CapabilityCandidate[] = []
  for (const entry of allCanonicalCapabilities()) {
    if (entry.intentRoutable && covered.has(entry.canonical)) {
      capabilities.push({
        canonical: entry.canonical,
        description: entry.description,
        domain: entry.domain,
      })
    }
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
