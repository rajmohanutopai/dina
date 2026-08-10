import { and, eq, gte, inArray, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'

import type { DrizzleDB } from '@/db/connection.js'
import { commerceCatalogProducts, commerceProductRelationships } from '@/db/schema/index.js'
import { productKey, type CatalogProductRow } from '@/shared/commerce/catalog-projection.js'
import {
  matchCatalogRow,
  rankCatalogMatches,
  type CatalogSearchQuery,
} from '@/shared/commerce/catalog-search.js'
import {
  SHOW_AS_RELATED_BP,
  type RelationshipEvidence,
} from '@/shared/commerce/relationship-projection.js'

/**
 * xRPC endpoint: com.dinakernel.commerce.searchCatalog (§10.5, FR-A4, FR-A5).
 *
 * Returns bounded CANDIDATE REFERENCES. Nothing here is a commitment: the
 * price is indicative (§10.4), the snapshot reference is what the supplier
 * published rather than what they will honour today, and `retrieval_score_bp`
 * is recall confidence rather than the buyer's ranking — that happens in the
 * buyer's own node against signed quotes.
 *
 * TWO-STAGE ON PURPOSE. SQL narrows (identifier, category, region, text) and
 * the pure matcher scores. The narrowing is an optimisation and the scoring is
 * the contract, so every row SQL returns is re-checked by
 * `matchCatalogRow` — a WHERE clause that drifted from the matcher would
 * otherwise silently change what is returned and nothing would fail. The cost
 * is one extra pass over a bounded page.
 *
 * The SQL narrowing is deliberately a superset: it may let through rows the
 * matcher then drops (an expired row, a text hit the matcher scores as no
 * match). It must never be narrower, or a candidate would be lost before the
 * contract ever sees it.
 */

/**
 * A query-string LIST: `?category=a&category=b`, or a single `?category=a`.
 *
 * A bare `z.array(...)` cannot be satisfied over HTTP. One value in a query
 * string is a string, not a one-element array, and a caller has no way to say
 * otherwise — so a field declared as a plain array rejects every request that
 * uses it. Arity belongs here, in the schema, rather than in a transport that
 * would have to know which fields are lists.
 */
function queryList(max: number, itemMax: number) {
  return z.preprocess(
    (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]),
    z.array(z.string().min(1).max(itemMax)).max(max).optional(),
  )
}

export const CommerceCatalogSearchParams = z.object({
  /** Product identifiers, as `scheme:value[:issuer_did]`. */
  identifier: queryList(20, 400),
  category: queryList(20, 64),
  q: z.string().max(256).optional(),
  region: z.string().max(64).optional(),
  supplier: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export type CommerceCatalogSearchParamsType = z.infer<typeof CommerceCatalogSearchParams>

/**
 * A ceiling on graph expansion per query.
 *
 * Without it a heavily-related product turns one lookup into a graph walk, and
 * an index whose cost depends on how many claims strangers filed about a
 * product is an index anyone can make slow.
 */
export const MAX_RELATED_EXPANSION = 100

export interface CommerceSearchCandidateDto {
  supplier_did: string
  service_uri: string
  service_rkey: string
  product: { scheme: string; value: string; issuer_did?: string; variant_digest?: string }
  catalog_snapshot_ref: string
  /** Present only when the row was reached along a relationship edge (§10.5). */
  relationship_evidence_refs?: string[]
  matched_fields: string[]
  indicative_price?: { currency: string; minor_units: string }
  fulfilment_regions: { scheme: string; value: string; issuer_did?: string }[]
  generated_at: string
  valid_until?: string
  retrieval_score_bp: number
}

export interface CommerceCatalogSearchResponse {
  candidates: CommerceSearchCandidateDto[]
  /**
   * How many rows SQL narrowed to before scoring. Reported so an operator can
   * see the matcher dropping things, which is otherwise invisible — a query
   * returning nothing looks identical whether the index is empty or the
   * narrowing and the matcher disagree.
   */
  examined: number
}

/**
 * Parse `scheme:value[:issuer_did]` into a product reference.
 *
 * Split on the FIRST two separators only: an `issuer_did` is itself full of
 * colons (`did:plc:…`), so a greedy split would shred it. Returns null on a
 * shape this cannot read rather than guessing — a misparsed identifier
 * silently searches for a different product.
 */
export function parseIdentifierParam(
  raw: string,
): { scheme: string; value: string; issuer_did?: string } | null {
  const firstColon = raw.indexOf(':')
  if (firstColon <= 0) return null
  const scheme = raw.slice(0, firstColon)
  const rest = raw.slice(firstColon + 1)
  if (rest === '') return null

  const SCOPED = scheme === 'manufacturer_sku' || scheme === 'custom'
  if (!SCOPED) return { scheme, value: rest }

  const secondColon = rest.indexOf(':')
  if (secondColon <= 0) {
    // A scoped scheme with no issuer is ambiguous across suppliers (§9.3).
    // Searching for it anyway would return another supplier's product under
    // this one's SKU.
    return null
  }
  const value = rest.slice(0, secondColon)
  const issuer = rest.slice(secondColon + 1)
  if (issuer === '') return null
  return { scheme, value, issuer_did: issuer }
}

/** Escape ILIKE metacharacters so a query cannot become a wildcard. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export async function searchCommerceCatalog(
  db: DrizzleDB,
  params: CommerceCatalogSearchParamsType,
  nowIso: string,
): Promise<CommerceCatalogSearchResponse> {
  const identifiers = (params.identifier ?? [])
    .map(parseIdentifierParam)
    .filter((ref): ref is NonNullable<typeof ref> => ref !== null)

  const conditions: SQL[] = []
  if (params.supplier !== undefined && params.supplier !== '') {
    conditions.push(eq(commerceCatalogProducts.supplierDid, params.supplier))
  }

  // The narrowing is an OR across the signals the caller supplied, matching
  // the matcher's own additive scoring: a row that hits ANY signal is a
  // candidate, and how strongly is the matcher's decision, not SQL's.
  const anyOf: SQL[] = []
  if (identifiers.length > 0) {
    const keys = identifiers.map((ref) => productKey(ref as never))
    anyOf.push(
      or(
        inArray(commerceCatalogProducts.productKey, keys),
        // PARAMETERISED, not interpolated. The previous form built the array
        // literal with `sql.raw` and hand-rolled quote doubling — a product key
        // carries a `custom` value, which is an arbitrary bounded string from a
        // stranger's published catalog, and hand-escaping is the wrong side of
        // that boundary to be standing on. The cast is required because `?|`
        // takes text[] and a bare placeholder list is untyped.
        sql`${commerceCatalogProducts.identifierKeys} ?| ARRAY[${sql.join(
          keys.map((k) => sql`${k}`),
          sql`, `,
        )}]::text[]`,
      ) as SQL,
    )
  }
  if (params.category !== undefined && params.category.length > 0) {
    anyOf.push(
      // `IN (...)` with one placeholder per value, NOT `= ANY(<array>)`.
      // Drizzle spreads a JS array into separate placeholders, so `ANY($1)`
      // received a bare string and Postgres tried to parse `furniture.seating`
      // as an array literal — `malformed array literal`, every category search
      // failing at the database. The handler's stub test could not see it: it
      // records that a select happened, not whether the SQL runs.
      sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${commerceCatalogProducts.categoryIds}) c WHERE lower(c) IN (${sql.join(
        params.category.map((v) => sql`${v.toLowerCase()}`),
        sql`, `,
      )}))`,
    )
  }
  if (params.q !== undefined && params.q.trim() !== '') {
    const pattern = `%${escapeLike(params.q.trim())}%`
    anyOf.push(
      or(
        sql`${commerceCatalogProducts.name} ILIKE ${pattern}`,
        sql`${commerceCatalogProducts.brand} ILIKE ${pattern}`,
        sql`${commerceCatalogProducts.description} ILIKE ${pattern}`,
      ) as SQL,
    )
  }
  if (params.region !== undefined && params.region !== '') {
    anyOf.push(
      // PARENTHESISED, and it has to be. `->>` and `||` sit in the same
      // precedence class in Postgres and associate LEFT, so
      // `r->>'scheme' || ':' || r->>'value'` parses as
      // `(((r->>'scheme') || ':') || r) ->> 'value'` — a text on the left of
      // `->>`, which is `operator does not exist: text ->> unknown`. Every
      // region-filtered search failed at the database, and a stub that records
      // "a select happened" reports it as working.
      sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${commerceCatalogProducts.fulfilmentRegions}) r WHERE lower((r->>'scheme') || ':' || (r->>'value')) = ${params.region.toLowerCase()})`,
    )
  }
  if (anyOf.length === 0) {
    // No signal at all. Returning the whole index would make discovery a
    // firehose and would rank suppliers by nothing, which §10.5 forbids more
    // clearly than it forbids a bad ranking.
    return { candidates: [], examined: 0 }
  }
  conditions.push(or(...anyOf) as SQL)

  // §10.7 RECALL EXPANSION. Products reachable from the queried identifiers
  // along an edge the index is at least willing to SHOW. Deliberately not
  // gated on the standing or substitution thresholds: this widens what a buyer
  // is offered to look at, and nothing more — the row still has to survive the
  // matcher, and it scores below anything that matched on its own identity.
  const relatedKeys = new Map<string, string[]>()
  if (identifiers.length > 0) {
    const subjectKeys = identifiers.map((ref) => productKey(ref as never))
    const edges = await db
      .select()
      .from(commerceProductRelationships)
      .where(
        and(
          inArray(commerceProductRelationships.subjectKey, subjectKeys),
          gte(commerceProductRelationships.confidenceBp, SHOW_AS_RELATED_BP),
        ),
      )
      .limit(MAX_RELATED_EXPANSION)
    for (const edge of edges) {
      // An operator DID is not a product and cannot be searched for as one.
      if (edge.objectKey.startsWith('did:')) continue
      const refs = (edge.evidenceJson as RelationshipEvidence[]).map((e) => e.claimId)
      relatedKeys.set(edge.objectKey, refs)
    }
  }

  // Over-fetch, because the matcher drops rows SQL let through (expired, or a
  // text hit that does not survive normalization). Bounded so a broad query
  // cannot turn into a scan.
  const rows = await db
    .select()
    .from(commerceCatalogProducts)
    .where(and(...conditions))
    .limit(params.limit * 4)

  const query: CatalogSearchQuery = {
    atIso: nowIso,
    ...(identifiers.length > 0 ? { identifiers: identifiers as never } : {}),
    ...(relatedKeys.size > 0 ? { relatedKeys } : {}),
    ...(params.category !== undefined ? { categoryIds: params.category } : {}),
    ...(params.q !== undefined ? { text: params.q } : {}),
    ...(params.region !== undefined ? { region: params.region } : {}),
  }

  const scored = rows.flatMap((row) => {
    const projected: CatalogProductRow = {
      rowKey: row.rowKey,
      productKey: row.productKey,
      supplierDid: row.supplierDid,
      catalogId: row.catalogId,
      snapshotSequence: row.snapshotSequence,
      snapshotDigest: row.snapshotDigest,
      serviceRkey: row.serviceRkey,
      itemRevision: row.itemRevision,
      name: row.name,
      brand: row.brand,
      description: row.description,
      categoryIds: row.categoryIds as string[],
      identifierKeys: row.identifierKeys as string[],
      fulfilmentRegions: row.fulfilmentRegions as CatalogProductRow['fulfilmentRegions'],
      indicativePrice: row.indicativePrice as CatalogProductRow['indicativePrice'],
      generatedAt: row.generatedAt,
      validUntil: row.validUntil,
    }
    const match = matchCatalogRow(projected, query)
    return match === null ? [] : [{ row: projected, ...match }]
  })

  const ranked = rankCatalogMatches(
    scored.map((entry) => ({ ...entry, rowKey: entry.row.rowKey })),
  ).slice(0, params.limit)

  return {
    examined: rows.length,
    candidates: ranked.map((entry) =>
      toCandidate(
        entry.row,
        entry.matchedFields,
        entry.retrievalScoreBp,
        entry.relationshipEvidenceRefs,
      ),
    ),
  }
}

/**
 * Project a row into the §10.5 wire shape.
 *
 * Exported so the mapping is testable without a database, and because this is
 * the one place FR-A7 is enforced by construction: the candidate type has no
 * field for live stock or buyer authorization, so there is nothing to
 * accidentally populate.
 */
export function toCandidate(
  row: CatalogProductRow,
  matchedFields: string[],
  retrievalScoreBp: number,
  relationshipEvidenceRefs: string[] = [],
): CommerceSearchCandidateDto {
  const [scheme, value, issuer, variant] = decodeProductKey(row.productKey)
  // §10.5 (DR-5) — WHERE TO SEND THE QUOTE REQUEST, from the supplier's own
  // pointer. This was hardcoded to `self` for every candidate, which is right
  // for a supplier with one listing and points every buyer at the wrong one
  // for a supplier with several — and §10's model is rkey-keyed listings. The
  // pointer now carries `service_rkey`; `self` remains the documented
  // convention for a node's PRIMARY listing and is used only where the
  // supplier has not said otherwise, rather than asserted as if known.
  const listingRkey = row.serviceRkey ?? 'self'
  return {
    supplier_did: row.supplierDid,
    service_uri: `at://${row.supplierDid}/com.dinakernel.service.profile/${listingRkey}`,
    service_rkey: listingRkey,
    product: {
      scheme,
      value,
      ...(issuer === '' ? {} : { issuer_did: issuer }),
      ...(variant === '' ? {} : { variant_digest: variant }),
    },
    catalog_snapshot_ref: row.snapshotDigest,
    // Omitted when the row matched on its own identity. An empty array and an
    // absent field would both render as "no evidence", but only one of them is
    // true — this row needed none.
    ...(relationshipEvidenceRefs.length === 0
      ? {}
      : { relationship_evidence_refs: relationshipEvidenceRefs }),
    matched_fields: matchedFields,
    ...(row.indicativePrice === null ? {} : { indicative_price: row.indicativePrice }),
    // Verbatim. The row already holds the §9.0 shape the catalog published;
    // re-deriving it from a flattened string is what dropped `issuer_did`.
    fulfilment_regions: row.fulfilmentRegions.map((region) => ({ ...region })),
    generated_at: row.generatedAt,
    ...(row.validUntil === null ? {} : { valid_until: row.validUntil }),
    retrieval_score_bp: retrievalScoreBp,
  }
}

/**
 * Reverse the length-prefixed product key.
 *
 * The key is stored rather than the parts because it is the row's identity;
 * decoding it back is exact BECAUSE the encoding is length-prefixed, which is
 * the second reason that encoding was chosen. A separator-joined key could not
 * be decoded at all once a value contained the separator.
 */
export function decodeProductKey(key: string): [string, string, string, string] {
  const parts: string[] = []
  let cursor = 0
  while (cursor < key.length && parts.length < 4) {
    const colon = key.indexOf(':', cursor)
    if (colon < 0) break
    const length = Number(key.slice(cursor, colon))
    if (!Number.isSafeInteger(length) || length < 0) break
    parts.push(key.slice(colon + 1, colon + 1 + length))
    cursor = colon + 1 + length
  }
  return [parts[0] ?? '', parts[1] ?? '', parts[2] ?? '', parts[3] ?? '']
}
