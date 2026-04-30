/**
 * Server-side facet derivation tests (TN-TEST-022).
 *
 * `appview/src/util/search_facets.ts` is byte-mirror of
 * `apps/mobile/src/trust/facets.ts` because AppView isn't an npm
 * workspace member and can't import from `apps/mobile`. This test
 * file pins the SAME contract the mobile test pins — if the two
 * implementations drift, one of them is wrong.
 *
 * Coverage:
 *
 *   - Empty results yield empty primary + overflow (no crashes).
 *   - Counts correct for single + multi-valued fields.
 *   - Sort: count desc, value asc as tiebreaker — stable.
 *   - Whitespace + empty values dropped (no `[' · 12]` rows).
 *   - Within-result duplicates count once.
 *   - Overflow kicks in at the threshold; default 5.
 *   - `null` / `undefined` from extractor skips, not buckets.
 *   - Frozen output — mutation can't corrupt next render.
 *   - `maxPrimary` validation.
 *
 * Pure-function tests — zero I/O, no fixtures, runs in <50ms.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MAX_PRIMARY,
  deriveFacets,
  type FacetBar,
} from '@/util/search_facets'

interface SearchHit {
  category?: string
  city?: string
  tags?: string[]
  language?: string | null
}

describe('deriveFacets — empty + nullish input', () => {
  it('empty result set → empty primary + empty overflow', () => {
    const out = deriveFacets({ results: [], key: () => null })
    expect(out.primary).toEqual([])
    expect(out.overflow).toEqual([])
  })

  it('all-null extractor → empty primary + overflow (skipped, not bucketed)', () => {
    const out = deriveFacets({
      results: [{}, {}, {}] as SearchHit[],
      key: (r) => r.category,
    })
    expect(out.primary).toEqual([])
    expect(out.overflow).toEqual([])
  })

  it('extractor returning explicit null is treated identically to undefined', () => {
    const out = deriveFacets({
      results: [{ category: null }, { category: undefined }] as SearchHit[],
      key: (r) => r.category as string | null | undefined,
    })
    expect(out.primary).toEqual([])
  })

  it('whitespace-only values dropped (not bucketed under empty key)', () => {
    const out = deriveFacets({
      results: [{ category: '   ' }, { category: '\t\n' }, { category: '' }] as SearchHit[],
      key: (r) => r.category,
    })
    expect(out.primary).toEqual([])
  })
})

describe('deriveFacets — counts + sort order', () => {
  it('counts scalar field correctly', () => {
    const results: SearchHit[] = [
      { category: 'Furniture' },
      { category: 'Furniture' },
      { category: 'Phones' },
    ]
    const out = deriveFacets({ results, key: (r) => r.category })
    expect(out.primary).toEqual([
      { value: 'Furniture', count: 2 },
      { value: 'Phones', count: 1 },
    ])
  })

  it('multi-valued field: counts once per distinct value per result', () => {
    const results: SearchHit[] = [
      { tags: ['ergonomic', 'office'] },
      { tags: ['ergonomic'] },
      { tags: ['office', 'desk'] },
    ]
    const out = deriveFacets({ results, key: (r) => r.tags })
    expect(out.primary).toEqual([
      { value: 'ergonomic', count: 2 },
      { value: 'office', count: 2 },
      { value: 'desk', count: 1 },
    ])
  })

  it('within-result duplicates count once', () => {
    // A row tagging itself twice doesn't double-count — counting it
    // twice would be a data-quality artefact bleeding into UI.
    const results: SearchHit[] = [{ tags: ['ergonomic', 'ergonomic', 'ergonomic'] }]
    const out = deriveFacets({ results, key: (r) => r.tags })
    expect(out.primary).toEqual([{ value: 'ergonomic', count: 1 }])
  })

  it('values trimmed before counting (collapses whitespace variants)', () => {
    const results: SearchHit[] = [
      { category: 'Furniture' },
      { category: ' Furniture' },
      { category: 'Furniture ' },
      { category: '  Furniture  ' },
    ]
    const out = deriveFacets({ results, key: (r) => r.category })
    expect(out.primary).toEqual([{ value: 'Furniture', count: 4 }])
  })

  it('sort: count desc, value asc as tiebreaker', () => {
    const results: SearchHit[] = [
      { category: 'Beta' },
      { category: 'Alpha' },
      { category: 'Beta' },
      { category: 'Alpha' },
      { category: 'Gamma' },
    ]
    const out = deriveFacets({ results, key: (r) => r.category })
    // Alpha & Beta tied at 2 → Alpha wins by ascending value;
    // Gamma at 1 last.
    expect(out.primary).toEqual([
      { value: 'Alpha', count: 2 },
      { value: 'Beta', count: 2 },
      { value: 'Gamma', count: 1 },
    ])
  })

  it('sort is stable across re-runs (deterministic)', () => {
    const results: SearchHit[] = [
      { category: 'C' },
      { category: 'A' },
      { category: 'B' },
      { category: 'C' },
    ]
    const a = deriveFacets({ results, key: (r) => r.category })
    const b = deriveFacets({ results, key: (r) => r.category })
    expect(b).toEqual(a)
  })
})

describe('deriveFacets — overflow partition', () => {
  it('default DEFAULT_MAX_PRIMARY is 5', () => {
    expect(DEFAULT_MAX_PRIMARY).toBe(5)
  })

  it('≤ 5 unique values → all primary, empty overflow', () => {
    const results: SearchHit[] = [
      { category: 'A' },
      { category: 'B' },
      { category: 'C' },
      { category: 'D' },
      { category: 'E' },
    ]
    const out = deriveFacets({ results, key: (r) => r.category })
    expect(out.primary).toHaveLength(5)
    expect(out.overflow).toEqual([])
  })

  it('> 5 unique values → first 5 primary, rest overflow', () => {
    const results: SearchHit[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(
      (c) => ({ category: c }) as SearchHit,
    )
    const out = deriveFacets({ results, key: (r) => r.category })
    expect(out.primary).toHaveLength(5)
    expect(out.overflow.map((f) => f.value)).toEqual(['F', 'G'])
  })

  it('caller-supplied maxPrimary respected', () => {
    const results: SearchHit[] = ['A', 'B', 'C', 'D'].map(
      (c) => ({ category: c }) as SearchHit,
    )
    const out = deriveFacets({ results, key: (r) => r.category, maxPrimary: 2 })
    expect(out.primary).toHaveLength(2)
    expect(out.overflow).toHaveLength(2)
  })

  it('maxPrimary = 0 → all overflow, no primary', () => {
    const results: SearchHit[] = [{ category: 'A' }, { category: 'B' }]
    const out = deriveFacets({ results, key: (r) => r.category, maxPrimary: 0 })
    expect(out.primary).toEqual([])
    expect(out.overflow).toHaveLength(2)
  })

  it('maxPrimary = Infinity rejected (must be finite)', () => {
    expect(() =>
      deriveFacets({ results: [], key: () => null, maxPrimary: Infinity }),
    ).toThrow(/non-negative finite/)
  })

  it('maxPrimary = NaN rejected', () => {
    expect(() =>
      deriveFacets({ results: [], key: () => null, maxPrimary: NaN }),
    ).toThrow(/non-negative finite/)
  })

  it('maxPrimary = -1 rejected (negative)', () => {
    expect(() =>
      deriveFacets({ results: [], key: () => null, maxPrimary: -1 }),
    ).toThrow(/non-negative finite/)
  })
})

describe('deriveFacets — frozen output', () => {
  it('returned bar is frozen at the top level', () => {
    const out = deriveFacets({ results: [{ category: 'A' }], key: (r) => r.category })
    expect(Object.isFrozen(out)).toBe(true)
  })

  it('primary array is frozen', () => {
    const out = deriveFacets({ results: [{ category: 'A' }], key: (r) => r.category })
    expect(Object.isFrozen(out.primary)).toBe(true)
  })

  it('overflow array is frozen', () => {
    const results = ['A', 'B', 'C', 'D', 'E', 'F'].map(
      (c) => ({ category: c }) as SearchHit,
    )
    const out = deriveFacets({ results, key: (r) => r.category })
    expect(Object.isFrozen(out.overflow)).toBe(true)
  })

  it('primary mutation throws (defensive against caller bugs)', () => {
    const out = deriveFacets({ results: [{ category: 'A' }], key: (r) => r.category })
    expect(() => {
      // @ts-expect-error - intentional defensive runtime mutation test
      out.primary.push({ value: 'X', count: 999 })
    }).toThrow(TypeError)
  })
})

describe('deriveFacets — non-string in extractor output', () => {
  it('non-string array elements skipped', () => {
    // Defensive: a buggy extractor might return `[123, 'real']`. The
    // string survives; the number is silently dropped (count is a
    // facet-derivation problem, not a data-validation problem).
    const results = [{}] as unknown[]
    const out = deriveFacets({
      results,
      key: () => [123 as unknown as string, 'real', null as unknown as string],
    })
    expect(out.primary).toEqual([{ value: 'real', count: 1 }])
  })
})

describe('deriveFacets — parity with mobile facets surface', () => {
  // The two implementations are byte-mirror by design (TN-MOB-021 +
  // TN-TEST-022). If a refactor changes one without the other, this
  // surface drifts. Pinning the public type shape + algorithm
  // signature here defends against silent divergence.
  it('FacetBar shape: { primary, overflow } both readonly arrays', () => {
    const out: FacetBar = deriveFacets({
      results: [{ category: 'A' }],
      key: (r) => (r as SearchHit).category,
    })
    expect(out).toHaveProperty('primary')
    expect(out).toHaveProperty('overflow')
    expect(Array.isArray(out.primary)).toBe(true)
    expect(Array.isArray(out.overflow)).toBe(true)
  })

  it('FacetItem shape: { value: string, count: number }', () => {
    const out = deriveFacets({
      results: [{ category: 'A' }, { category: 'A' }],
      key: (r) => (r as SearchHit).category,
    })
    expect(out.primary[0]).toEqual({ value: 'A', count: 2 })
  })
})
