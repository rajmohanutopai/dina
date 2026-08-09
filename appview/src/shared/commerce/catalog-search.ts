import { productKey, type CatalogProductRow, type ProductRef } from './catalog-projection.js'

/**
 * Catalog search: what matches, why, and how confidently (§10.5, FR-A4, FR-A5).
 *
 * PURE, and separate from the SQL for the usual reason — the interesting part
 * is the ranking rationale, not the query plan, and a rationale that can only
 * be tested through Postgres does not get tested.
 *
 * WHAT `retrievalScoreBp` IS AND IS NOT. It is RECALL confidence: how sure the
 * index is that this row is what the buyer asked for. It is explicitly not
 * permission, and it is not the buyer's ranking — that happens in the buyer's
 * own node, against signed quotes, weighing price and lead time and trust
 * (`offer_ranking.ts`). Conflating the two would let an index operator move
 * commercial outcomes by tuning recall, which is the failure mode the whole
 * §10.6 "multiple AppViews" design exists to survive.
 *
 * EVERY RESULT NAMES WHY IT MATCHED. A candidate with no matched field is a
 * result nobody can explain, and an unexplainable result is indistinguishable
 * from a paid placement.
 */

export interface CatalogSearchQuery {
  /** Exact identity. The strongest possible signal. */
  identifiers?: ProductRef[]
  categoryIds?: string[]
  /** Free text, matched against name/brand/description. */
  text?: string
  /** `scheme:value`, matched against the item's published regions. */
  region?: string
  /**
   * Products reachable from the queried identifiers along a relationship edge,
   * keyed by product key, with the evidence that got them there.
   *
   * §10.7 permits lower-confidence semantic relationships to improve RECALL —
   * and only recall. A row reached this way scores well below a direct
   * identifier hit and says so in `matchedFields`, so a buyer can see that the
   * index guessed rather than matched.
   */
  relatedKeys?: Map<string, string[]>
  /** Evaluation instant, so an expired row is dropped deterministically. */
  atIso: string
}

export interface CatalogSearchMatch {
  matchedFields: string[]
  retrievalScoreBp: number
  /**
   * Which claims justified reaching this row along an edge (§10.5's
   * `relationshipEvidenceRefs`). Empty when it matched on its own identity —
   * an empty list and a populated one are the difference between "this is the
   * product" and "the index thinks this is close".
   */
  relationshipEvidenceRefs: string[]
}

/**
 * Weights, in basis points, summing to 10000 across the four signals.
 *
 * IDENTIFIER dominates deliberately: a GTIN match IS the product, and no
 * amount of text or category similarity should be able to outrank it. The
 * remaining three exist to make a query with no identifier still useful, not
 * to compete with one that has it.
 */
export const IDENTIFIER_WEIGHT_BP = 6000
export const CATEGORY_WEIGHT_BP = 2000
export const TEXT_WEIGHT_BP = 1500
export const REGION_WEIGHT_BP = 500
/**
 * Reached along a relationship edge rather than by its own identifier.
 *
 * Deliberately below `CATEGORY_WEIGHT_BP + TEXT_WEIGHT_BP`, so a product that
 * genuinely matches the category and the words outranks one the graph merely
 * associates. An edge improves recall; it does not get to win on precision.
 */
export const RELATED_WEIGHT_BP = 1200

/** Nothing below this is worth returning; it is noise wearing a score. */
export const MIN_RETRIEVAL_SCORE_BP = 1

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * The comparison form of a region: `scheme:value`.
 *
 * Derived at match time rather than stored, so the ROW keeps the §9.0 shape
 * the catalog published and only the comparison is flattened. Storing the flat
 * form and splitting it back is what lost `issuer_did` in the first draft.
 */
export function regionKey(region: { scheme: string; value: string }): string {
  return `${region.scheme}:${region.value}`
}

/**
 * Is this row still current at `atIso`?
 *
 * §10.4 / FR-A6 require withdrawn and expired snapshots to be handled
 * PREDICTABLY. Withdrawn catalogs have no rows at all — the handler deletes
 * them — and expired rows are dropped here rather than returned with a flag.
 * The reason is what a buyer does next: a discovery result is the thing they
 * request a quote against, and offering a row the supplier has already said is
 * stale invites exactly the round trip §10.4 is trying to avoid. A row with no
 * `validUntil` never expires, which is the supplier's own claim about it.
 */
export function isFresh(row: Pick<CatalogProductRow, 'validUntil'>, atIso: string): boolean {
  if (row.validUntil === null) return true
  return Date.parse(row.validUntil) > Date.parse(atIso)
}

/**
 * Match one row against a query.
 *
 * Returns null when the row does not match at all — which is different from
 * matching weakly, and the caller must not be able to confuse the two.
 */
export function matchCatalogRow(
  row: CatalogProductRow,
  query: CatalogSearchQuery,
): CatalogSearchMatch | null {
  if (!isFresh(row, query.atIso)) return null

  const matchedFields: string[] = []
  const relationshipEvidenceRefs: string[] = []
  let scoreBp = 0

  if (query.identifiers !== undefined && query.identifiers.length > 0) {
    const wanted = new Set(query.identifiers.map(productKey))
    // EVERY identifier the item claims is checked, not only its primary: a
    // buyer holding the GTIN and a buyer holding the supplier's SKU are asking
    // about the same product and both must find it.
    if (row.identifierKeys.some((key) => wanted.has(key))) {
      matchedFields.push('identifier')
      scoreBp += IDENTIFIER_WEIGHT_BP
    }
  }

  // Only when the row did NOT match by its own identifier: a product that
  // matched directly is not additionally "related to itself", and awarding
  // both would let the graph inflate a hit it did not produce.
  if (!matchedFields.includes('identifier') && query.relatedKeys !== undefined) {
    const refs = query.relatedKeys.get(row.productKey)
    if (refs !== undefined) {
      matchedFields.push('related')
      relationshipEvidenceRefs.push(...refs)
      scoreBp += RELATED_WEIGHT_BP
    }
  }

  if (query.categoryIds !== undefined && query.categoryIds.length > 0) {
    const wanted = new Set(query.categoryIds.map(normalize))
    if (row.categoryIds.some((id) => wanted.has(normalize(id)))) {
      matchedFields.push('category')
      scoreBp += CATEGORY_WEIGHT_BP
    }
  }

  if (query.text !== undefined && query.text.trim() !== '') {
    const needle = normalize(query.text)
    const haystack = [row.name, row.brand ?? '', row.description ?? ''].map(normalize)
    if (haystack.some((field) => field.includes(needle))) {
      matchedFields.push('text')
      scoreBp += TEXT_WEIGHT_BP
    }
  }

  if (query.region !== undefined && query.region !== '') {
    const wanted = normalize(query.region)
    if (row.fulfilmentRegions.some((region) => normalize(regionKey(region)) === wanted)) {
      matchedFields.push('region')
      scoreBp += REGION_WEIGHT_BP
    }
  }

  if (scoreBp < MIN_RETRIEVAL_SCORE_BP) return null
  return { matchedFields, retrievalScoreBp: scoreBp, relationshipEvidenceRefs }
}

/**
 * Rank matches, highest recall first.
 *
 * The tiebreak is the row key, which is deterministic and carries no
 * commercial meaning. Ordering ties by recency or by price would make the
 * index a ranking authority, and §10.5 is explicit that it is not one.
 */
export function rankCatalogMatches<T extends { retrievalScoreBp: number; rowKey: string }>(
  matches: readonly T[],
): T[] {
  return [...matches].sort((a, b) =>
    b.retrievalScoreBp !== a.retrievalScoreBp
      ? b.retrievalScoreBp - a.retrievalScoreBp
      : a.rowKey < b.rowKey
        ? -1
        : a.rowKey > b.rowKey
          ? 1
          : 0,
  )
}
