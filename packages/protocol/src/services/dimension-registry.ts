/**
 * Canonical PeerLens review-dimension registry + resolver, keyed by
 * product/subject category.
 *
 * SOURCE OF TRUTH for the closed launch dimension vocabulary. See
 * docs/SERVICES_LAUNCH_ARCHITECTURE.md Part 2.
 *
 * The problem: a review's `dimension` field is free-form, and reviews are
 * immutable signed records. The aggregator groups per-dimension consensus
 * by the raw string, so `lumbar_support` vs `back_support` vs `lumbar`
 * silently split into three piles — each a fraction of the data, all
 * wrong. This module converges synonyms to ONE canonical dimension per
 * category so the aggregate stays merged.
 *
 * Failure mode vs. Services capabilities: dimension fragmentation is
 * SILENT (a wrong number, not a missing result) and PERMANENT (immutable
 * records). So we defend at BOTH write (chips/LLM emit canonical only)
 * and read (this resolver runs in the aggregator before group-by).
 *
 * ─────────────────────────────────────────────────────────────────────
 * SHARED MODULE — DRIFT GATE. Source of truth; copied verbatim to
 * packages/protocol/src/services/dimension-registry.ts so the mobile
 * write form + brain draft tool import the SAME resolver. A unit test
 * asserts the two are byte-identical. Edit one → edit both. Keep this
 * dependency-free (pure TS, no imports).
 * ─────────────────────────────────────────────────────────────────────
 *
 * Keyed by the FIRST slash-segment of the category (`furniture/chair` →
 * `furniture`), mirroring the existing `USE_CASE_BY_CATEGORY` shape. A
 * category with no specific entry falls back to a small GENERIC set.
 *
 * Launch vocabulary is intentionally SMALL (4–5 per category). Adding a
 * canonical dimension later is additive + zero-pollution (new reviews use
 * it, old reviews stay valid). NEVER rename a canonical (that fragments
 * the aggregate forever); add an alias instead.
 */

export interface CanonicalDimension {
  /** The one true dimension name the aggregate is keyed on. */
  readonly canonical: string
  /** Synonyms that resolve to `canonical`. Excludes `canonical` itself. */
  readonly aliases: readonly string[]
  /** Human / LLM-readable label — chip text + query-side description. */
  readonly description: string
}

/** Generic dimensions for categories without a specific entry. */
export const GENERIC_DIMENSIONS: readonly CanonicalDimension[] = Object.freeze([
  Object.freeze({ canonical: 'quality', aliases: Object.freeze(['overall_quality', 'build']), description: 'Overall quality' }),
  Object.freeze({ canonical: 'value', aliases: Object.freeze(['value_for_money', 'price_value']), description: 'Value for money' }),
  Object.freeze({ canonical: 'reliability', aliases: Object.freeze(['dependability']), description: 'Reliability' }),
])

/**
 * Per-category canonical dimension lists. Keyed by first slash-segment of
 * the category (lowercased + trimmed).
 */
export const DIMENSION_BY_CATEGORY: Readonly<Record<string, readonly CanonicalDimension[]>> =
  Object.freeze({
    furniture: Object.freeze([
      Object.freeze({
        canonical: 'lumbar_support',
        aliases: Object.freeze(['back_support', 'lumbar', 'lower_back_comfort']),
        description: 'Lower-back / lumbar support',
      }),
      Object.freeze({
        canonical: 'comfort',
        aliases: Object.freeze(['comfortable', 'seat_comfort']),
        description: 'Comfort',
      }),
      Object.freeze({
        canonical: 'build_quality',
        aliases: Object.freeze(['build', 'construction', 'sturdiness']),
        description: 'Build quality',
      }),
      Object.freeze({
        canonical: 'value',
        aliases: Object.freeze(['value_for_money', 'price_value']),
        description: 'Value for money',
      }),
      Object.freeze({
        canonical: 'durability',
        aliases: Object.freeze(['longevity', 'wear']),
        description: 'Durability',
      }),
    ]),
    dining: Object.freeze([
      Object.freeze({
        canonical: 'food_quality',
        aliases: Object.freeze(['food', 'taste', 'flavour', 'flavor']),
        description: 'Food quality',
      }),
      Object.freeze({
        canonical: 'service',
        aliases: Object.freeze(['service_quality', 'staff']),
        description: 'Service',
      }),
      Object.freeze({
        canonical: 'value',
        aliases: Object.freeze(['value_for_money', 'price_value']),
        description: 'Value for money',
      }),
      Object.freeze({
        canonical: 'ambiance',
        aliases: Object.freeze(['ambience', 'atmosphere', 'vibe']),
        description: 'Ambiance',
      }),
      Object.freeze({
        canonical: 'accessibility',
        aliases: Object.freeze(['access', 'wheelchair_access']),
        description: 'Accessibility',
      }),
    ]),
  })

/**
 * Category aliases → canonical category KEY. String normalization alone
 * (lowercase + first-slash-segment) does NOT map `home_furniture →
 * furniture`, so category needs the same alias treatment as dimensions.
 */
export const CATEGORY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  home_furniture: 'furniture',
  furnishings: 'furniture',
  restaurants: 'dining',
  restaurant: 'dining',
  food: 'dining',
})

/**
 * Resolve a raw category string to its canonical category KEY: lowercase
 * + first-slash-segment, then map through `CATEGORY_ALIASES`. Always
 * returns a string (the normalized key) — unknown categories pass through
 * normalized so they fall back to GENERIC dimensions.
 */
export function resolveCategoryKey(rawCategory: string): string {
  const trimmed = rawCategory.trim().toLowerCase()
  // `split('/')[0]` is `string | undefined` under noUncheckedIndexedAccess;
  // it can only be undefined for an empty split, which can't happen here —
  // coalesce to `trimmed` to keep the return type a plain `string`.
  const firstSegment = trimmed.includes('/') ? (trimmed.split('/')[0] ?? trimmed) : trimmed
  return CATEGORY_ALIASES[firstSegment] ?? firstSegment
}

/** The canonical dimension list for a category (specific or GENERIC). */
export function dimensionsForCategory(rawCategory: string): readonly CanonicalDimension[] {
  const key = resolveCategoryKey(rawCategory)
  return DIMENSION_BY_CATEGORY[key] ?? GENERIC_DIMENSIONS
}

/**
 * Build the alias → canonical lookup for a category's dimension list.
 * Throws on a duplicate alias within the category (an authoring bug).
 * Exported so the fail-loud invariant is unit-testable.
 */
export function buildDimensionAliasMap(
  dims: readonly CanonicalDimension[],
): ReadonlyMap<string, string> {
  const m = new Map<string, string>()
  for (const dim of dims) {
    registerDim(m, dim.canonical, dim.canonical)
    for (const alias of dim.aliases) {
      registerDim(m, alias, dim.canonical)
    }
  }
  return m
}

function registerDim(m: Map<string, string>, token: string, canonical: string): void {
  const existing = m.get(token)
  if (existing !== undefined && existing !== canonical) {
    throw new Error(
      `dimension-registry: token "${token}" maps to both "${existing}" and ` +
        `"${canonical}" within one category — dimension tokens must be unique.`,
    )
  }
  m.set(token, canonical)
}

/** Per-category alias maps, built once. */
const ALIAS_MAP_BY_CATEGORY: ReadonlyMap<string, ReadonlyMap<string, string>> = (() => {
  const outer = new Map<string, ReadonlyMap<string, string>>()
  for (const [cat, dims] of Object.entries(DIMENSION_BY_CATEGORY)) {
    outer.set(cat, buildDimensionAliasMap(dims))
  }
  outer.set('__generic__', buildDimensionAliasMap(GENERIC_DIMENSIONS))
  return outer
})()

/**
 * Resolve a raw dimension string to its canonical name WITHIN a category,
 * or `null` if it is not in that category's vocabulary (including the
 * GENERIC fallback when the category has no specific list).
 *
 * `null` means UNKNOWN: per spec the caller DROPS it (never aggregates
 * under the raw string). Returning `null` (not the raw string) forces
 * that decision to be explicit at every call site.
 */
export function resolveCanonicalDimension(rawCategory: string, rawDimension: string): string | null {
  const normalizedDim = rawDimension.trim().toLowerCase()
  if (normalizedDim.length === 0) return null
  const key = resolveCategoryKey(rawCategory)
  const map = ALIAS_MAP_BY_CATEGORY.get(key) ?? ALIAS_MAP_BY_CATEGORY.get('__generic__')!
  return map.get(normalizedDim) ?? null
}
