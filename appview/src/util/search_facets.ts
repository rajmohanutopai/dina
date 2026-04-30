/**
 * Search-results facet derivation, server-side (TN-TEST-022).
 *
 * The mobile client already has `apps/mobile/src/trust/facets.ts`
 * with the canonical algorithm — count rows by a key, drop empty /
 * whitespace values, sort by count desc + value asc, partition into
 * primary + overflow. That implementation runs against the visible
 * page of results.
 *
 * Server-side facets matter because:
 *
 *   1. The visible page is small (default 25). A category that's
 *      large in the corpus but only has 1 row on the current page
 *      would show as `[Category · 1]` even though there are
 *      thousands. Counting across the FULL match set surfaces the
 *      true distribution.
 *
 *   2. `getFacets` can be a separate xRPC that runs faceted COUNT
 *      aggregations (cheaper than fetching every row + counting in
 *      JS). This module is the in-memory fallback for the
 *      smaller-set case (after a query has already streamed every
 *      row, e.g. for a small or filtered match set).
 *
 *   3. AppView is NOT an npm workspace member, so it cannot import
 *      `apps/mobile/src/trust/facets.ts` even though the algorithms
 *      are byte-identical. Mirroring the surface here keeps the two
 *      implementations consistent — pinned by a "same input → same
 *      output" parity test against fixtures.
 *
 * Pure function, zero state, runs under plain vitest.
 */

// ─── Public types ──────────────────────────────────────────────────

/**
 * One facet entry — a value the user can tap to refine, plus how many
 * results carry that value.
 */
export interface FacetItem {
  readonly value: string
  readonly count: number
}

/**
 * Paged facet output. `primary` are the top-N by count; `overflow` is
 * the rest. Concatenating them yields the full ranked list. Both
 * arrays follow the same sort order: count descending, value
 * ascending as the tiebreaker. Stable across re-renders when two
 * facets share a count.
 */
export interface FacetBar {
  readonly primary: readonly FacetItem[]
  readonly overflow: readonly FacetItem[]
}

/**
 * Plan §8.3.1: "Long-tail facets collapse under 'More' once 5+ are
 * visible." Five is the inline cap before overflow.
 */
export const DEFAULT_MAX_PRIMARY = 5

/**
 * Extractor return shape. A single string for a scalar field
 * (`category: 'Furniture'`), an array for multi-valued fields
 * (`tags: ['ergonomic', 'office']`), or null/undefined to skip the
 * row for this facet axis (the row had no value to count).
 */
export type FacetKeyResult = string | readonly string[] | null | undefined

export interface DeriveFacetsInput<T> {
  readonly results: readonly T[]
  readonly key: (result: T) => FacetKeyResult
  /** Inline-cap before overflow. Default `DEFAULT_MAX_PRIMARY` (5). */
  readonly maxPrimary?: number
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Derive a facet bar from a result set.
 *
 * Empty / whitespace-only values are dropped — `[' · 12]` is noise,
 * not signal. Values are trimmed before counting so `'Furniture'`
 * and `' Furniture '` collapse into one bucket.
 *
 * Sort order: count descending, then value ascending. The value-
 * ascending tiebreak prevents two equal-count facets from swapping
 * order between renders just because the upstream JSON order
 * changed. Predictable order matters for tap-target stability.
 *
 * Multi-valued fields (a result returning `['a', 'b']`) count once
 * per distinct value within that result. Duplicates within a single
 * result's array still only count once — counting a tag twice
 * because the row listed it twice would be a data-quality bug, not
 * a facet signal.
 *
 * Output is `Object.freeze`d to defend against accidental mutation
 * by a caller that wants to "post-process" the result list and
 * corrupts it for the next render.
 */
export function deriveFacets<T>(input: DeriveFacetsInput<T>): FacetBar {
  const maxPrimary = input.maxPrimary ?? DEFAULT_MAX_PRIMARY
  if (maxPrimary < 0 || !Number.isFinite(maxPrimary)) {
    throw new Error('deriveFacets: maxPrimary must be a non-negative finite number')
  }

  const counts = new Map<string, number>()
  for (const result of input.results) {
    const seen = new Set<string>() // dedupe within a single result
    const raw = input.key(result)
    if (raw === null || raw === undefined) continue

    const values = typeof raw === 'string' ? [raw] : raw
    for (const v of values) {
      if (typeof v !== 'string') continue
      const trimmed = v.trim()
      if (trimmed.length === 0) continue
      if (seen.has(trimmed)) continue
      seen.add(trimmed)
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1)
    }
  }

  const ranked: FacetItem[] = []
  for (const [value, count] of counts) {
    ranked.push({ value, count })
  }
  ranked.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0
  })

  return Object.freeze({
    primary: Object.freeze(ranked.slice(0, maxPrimary)) as readonly FacetItem[],
    overflow: Object.freeze(ranked.slice(maxPrimary)) as readonly FacetItem[],
  })
}
