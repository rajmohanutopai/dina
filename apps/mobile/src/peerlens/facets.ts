/**
 * Search-results facet bar derivation (TN-MOB-021).
 *
 * Per plan §8.3.1, the search screen renders a horizontal facet bar
 * above its results — labels + counts derived from the result set's
 * `category` / `metadata` distribution:
 *
 *     [All]  [Furniture · 12]  [Phones · 8]  [Books · 4]  [Software · 2]   …
 *
 * Tapping a facet adds it to the search params and re-runs the query.
 * This module owns the *derivation* — pure data → ranked list of
 * `{value, count}` items partitioned into primary (visible inline)
 * and overflow (collapsed under "More"). The screen layer wraps it
 * with theme tokens, tap handlers, and animation.
 *
 * Why a generic `key` callback instead of hard-coding "category"?
 * The same algorithm applies to any string-valued field: category,
 * city (places), media_type (content), cuisine (restaurants).
 * One implementation, one test surface, called once per facet kind
 * the screen wants to render. The plan's §8.3.1 lists four type-
 * specific facet axes; passing them as separate `deriveFacets` calls
 * is cleaner than embedding the field-name in this file.
 *
 * Pure function, zero state, runs under plain Jest. No dependency on
 * `@dina/protocol` types — the input is structurally typed via the
 * extractor, so the same derivation works for AppView search hits,
 * locally-cached subjects, or any other shape the screen has.
 */

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * One facet entry — a value the user can tap to refine, plus how many
 * results in the current set carry that value.
 */
export interface FacetItem {
  readonly value: string;
  readonly count: number;
}

/**
 * Result of a single facet derivation. `primary` are the top-N by
 * count; `overflow` is the rest. Concatenating them yields the full
 * ranked list. Both arrays follow the same sort order (count desc,
 * value asc as tiebreaker — keeps display stable across re-renders
 * when two facets share a count).
 */
export interface FacetBar {
  readonly primary: readonly FacetItem[];
  readonly overflow: readonly FacetItem[];
}

/**
 * Per plan §8.3.1: "Long-tail facets collapse under 'More' once 5+
 * are visible." Five is the inline cap before the chevron appears.
 */
export const DEFAULT_MAX_PRIMARY = 5;

/**
 * `key` extractor return shape. A single string for a scalar field
 * (`category: 'Furniture'`), an array for a multi-valued field
 * (`tags: ['ergonomic', 'office']`), or null/undefined to skip the
 * result for this facet axis (the row had no value to count).
 */
export type FacetKeyResult = string | readonly string[] | null | undefined;

export interface DeriveFacetsInput<T> {
  readonly results: readonly T[];
  readonly key: (result: T) => FacetKeyResult;
  /** Inline-cap before overflow. Default `DEFAULT_MAX_PRIMARY` (5). */
  readonly maxPrimary?: number;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Derive a facet bar from a result set.
 *
 * Empty / whitespace-only values are dropped — facets like
 * `[" · 12]` are noise, not signal. Trimmed values are counted under
 * their trimmed form so `'Furniture'` and `' Furniture '` collapse
 * into one bucket.
 *
 * Sort order: count descending, then value ascending. The value-
 * ascending tiebreak is what stops two equal-count facets from
 * swapping order between renders just because the upstream JSON
 * order changed. Predictable order matters for tap-target stability.
 *
 * Multi-valued fields (a result returning `['a', 'b']`) count once
 * per distinct value within that result. Duplicates within the same
 * result's array still only count once — counting a tag twice
 * because the row listed it twice would be a data-quality bug, not
 * a facet signal.
 */
export function deriveFacets<T>(input: DeriveFacetsInput<T>): FacetBar {
  const maxPrimary = input.maxPrimary ?? DEFAULT_MAX_PRIMARY;
  if (maxPrimary < 0 || !Number.isFinite(maxPrimary)) {
    throw new Error(`deriveFacets: maxPrimary must be a non-negative finite number`);
  }

  const counts = new Map<string, number>();
  for (const result of input.results) {
    const seen = new Set<string>(); // dedupe within a single result
    const raw = input.key(result);
    if (raw === null || raw === undefined) continue;

    const values = typeof raw === 'string' ? [raw] : raw;
    for (const v of values) {
      if (typeof v !== 'string') continue;
      const trimmed = v.trim();
      if (trimmed.length === 0) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    }
  }

  const ranked: FacetItem[] = [];
  for (const [value, count] of counts) {
    ranked.push({ value, count });
  }
  ranked.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  });

  return {
    primary: Object.freeze(ranked.slice(0, maxPrimary)) as readonly FacetItem[],
    overflow: Object.freeze(ranked.slice(maxPrimary)) as readonly FacetItem[],
  };
}
