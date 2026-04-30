/**
 * Search-results facet derivation tests (TN-MOB-021).
 *
 * Pins the contract that screens depend on:
 *
 *   - Empty results yield empty primary + overflow (no crashes, no
 *     phantom rows).
 *   - Counts are correct across single-valued and multi-valued fields.
 *   - Sort: count desc, value asc as tiebreaker — stable across calls.
 *   - Whitespace + empty values dropped (no `[' · 12]` rows).
 *   - Within-result duplicates count once per result.
 *   - Overflow kicks in at the configured threshold; default 5.
 *   - `null` / `undefined` from the extractor skip the result, not
 *     count under an empty bucket.
 *   - Frozen output — mutation can't corrupt the next render.
 *
 * Pure function — runs under plain Jest, no RN deps.
 */

import {
  DEFAULT_MAX_PRIMARY,
  deriveFacets,
  type FacetBar,
} from '../../src/trust/facets';

interface SearchHit {
  category?: string;
  city?: string;
  tags?: string[];
}

function toMap(bar: FacetBar): Record<string, number> {
  const all = [...bar.primary, ...bar.overflow];
  return Object.fromEntries(all.map((f) => [f.value, f.count]));
}

// ─── Basics ───────────────────────────────────────────────────────────────

describe('deriveFacets — basics', () => {
  it('empty results → empty primary + overflow', () => {
    const bar = deriveFacets<SearchHit>({ results: [], key: (r) => r.category ?? null });
    expect(bar.primary).toEqual([]);
    expect(bar.overflow).toEqual([]);
  });

  it('counts a single-valued field correctly', () => {
    const results: SearchHit[] = [
      { category: 'Furniture' },
      { category: 'Furniture' },
      { category: 'Phones' },
    ];
    const bar = deriveFacets({ results, key: (r) => r.category ?? null });
    expect(toMap(bar)).toEqual({ Furniture: 2, Phones: 1 });
  });

  it('null / undefined extractor result skips the row (not bucketed under empty string)', () => {
    const results: SearchHit[] = [
      { category: 'Furniture' },
      {}, // no category
      { category: undefined },
    ];
    const bar = deriveFacets({ results, key: (r) => r.category ?? null });
    expect(toMap(bar)).toEqual({ Furniture: 1 });
  });
});

// ─── Multi-valued fields ──────────────────────────────────────────────────

describe('deriveFacets — multi-valued', () => {
  it('a string[] extractor counts each distinct value', () => {
    const results: SearchHit[] = [
      { tags: ['ergonomic', 'office'] },
      { tags: ['office'] },
      { tags: ['outdoor', 'travel'] },
    ];
    const bar = deriveFacets({ results, key: (r) => r.tags ?? null });
    expect(toMap(bar)).toEqual({ office: 2, ergonomic: 1, outdoor: 1, travel: 1 });
  });

  it('within-result duplicates count once (data-quality guard)', () => {
    const results: SearchHit[] = [{ tags: ['office', 'office', 'office'] }];
    const bar = deriveFacets({ results, key: (r) => r.tags ?? null });
    expect(toMap(bar)).toEqual({ office: 1 });
  });
});

// ─── Cleanup ──────────────────────────────────────────────────────────────

describe('deriveFacets — value cleanup', () => {
  it('trims whitespace and collapses ` Furniture ` and `Furniture` into one bucket', () => {
    const results: SearchHit[] = [
      { category: 'Furniture' },
      { category: ' Furniture ' },
      { category: '\tFurniture\n' },
    ];
    const bar = deriveFacets({ results, key: (r) => r.category ?? null });
    expect(toMap(bar)).toEqual({ Furniture: 3 });
  });

  it('drops empty / whitespace-only values', () => {
    const results: SearchHit[] = [
      { category: 'Furniture' },
      { category: '' },
      { category: '   ' },
    ];
    const bar = deriveFacets({ results, key: (r) => r.category ?? null });
    expect(toMap(bar)).toEqual({ Furniture: 1 });
  });

  it('skips non-string entries inside a multi-valued result (defensive)', () => {
    // Forced via cast — real data shouldn't contain non-strings, but
    // the wire format is JSON and a future field could go through here.
    const results = [{ tags: ['office', 42 as unknown as string, null as unknown as string, 'home'] }];
    const bar = deriveFacets({ results, key: (r) => r.tags });
    expect(toMap(bar)).toEqual({ office: 1, home: 1 });
  });
});

// ─── Sort + stability ─────────────────────────────────────────────────────

describe('deriveFacets — sort + stability', () => {
  it('orders by count descending', () => {
    const results: SearchHit[] = [
      { category: 'A' },
      { category: 'B' },
      { category: 'B' },
      { category: 'C' },
      { category: 'C' },
      { category: 'C' },
    ];
    const bar = deriveFacets({ results, key: (r) => r.category ?? null });
    expect(bar.primary.map((f) => f.value)).toEqual(['C', 'B', 'A']);
  });

  it('breaks count ties with value ascending for stable order', () => {
    const results: SearchHit[] = [
      { category: 'Phones' },
      { category: 'Books' },
      { category: 'Furniture' },
    ];
    // All three have count=1; ascending: Books, Furniture, Phones
    const bar = deriveFacets({ results, key: (r) => r.category ?? null });
    expect(bar.primary.map((f) => f.value)).toEqual(['Books', 'Furniture', 'Phones']);
  });

  it('two derivations of the same set produce identical output (no upstream-order leakage)', () => {
    const a = deriveFacets({
      results: [{ category: 'X' }, { category: 'Y' }, { category: 'X' }],
      key: (r) => r.category ?? null,
    });
    const b = deriveFacets({
      // shuffled
      results: [{ category: 'Y' }, { category: 'X' }, { category: 'X' }],
      key: (r) => r.category ?? null,
    });
    expect(a.primary).toEqual(b.primary);
    expect(a.overflow).toEqual(b.overflow);
  });
});

// ─── Overflow ─────────────────────────────────────────────────────────────

describe('deriveFacets — primary/overflow split', () => {
  function makeNCategories(n: number): SearchHit[] {
    // Counts are descending so order is unambiguous: cat-1 has 1
    // result, cat-2 has 2, …, cat-N has N.
    const out: SearchHit[] = [];
    for (let i = 1; i <= n; i++) {
      const cat = `cat-${String(i).padStart(2, '0')}`;
      for (let k = 0; k < i; k++) out.push({ category: cat });
    }
    return out;
  }

  it('default DEFAULT_MAX_PRIMARY is 5 (per plan §8.3.1)', () => {
    expect(DEFAULT_MAX_PRIMARY).toBe(5);
  });

  it('default puts top 5 in primary, rest in overflow', () => {
    const results = makeNCategories(8); // 8 categories with distinct counts
    const bar = deriveFacets({ results, key: (r) => r.category ?? null });
    expect(bar.primary).toHaveLength(5);
    expect(bar.overflow).toHaveLength(3);
    // cat-08 (count 8) is most-frequent → primary.
    expect(bar.primary[0]?.value).toBe('cat-08');
    expect(bar.overflow[bar.overflow.length - 1]?.value).toBe('cat-01');
  });

  it('honours a custom maxPrimary', () => {
    const bar = deriveFacets({
      results: makeNCategories(4),
      key: (r) => r.category ?? null,
      maxPrimary: 2,
    });
    expect(bar.primary).toHaveLength(2);
    expect(bar.overflow).toHaveLength(2);
  });

  it('maxPrimary=0 puts everything in overflow', () => {
    const bar = deriveFacets({
      results: makeNCategories(3),
      key: (r) => r.category ?? null,
      maxPrimary: 0,
    });
    expect(bar.primary).toHaveLength(0);
    expect(bar.overflow).toHaveLength(3);
  });

  it('overflow is empty when count <= maxPrimary', () => {
    const bar = deriveFacets({
      results: makeNCategories(3),
      key: (r) => r.category ?? null,
    });
    expect(bar.overflow).toHaveLength(0);
  });

  it('rejects negative or non-finite maxPrimary', () => {
    expect(() =>
      deriveFacets({ results: [], key: () => null, maxPrimary: -1 }),
    ).toThrow();
    expect(() =>
      deriveFacets({ results: [], key: () => null, maxPrimary: Number.NaN }),
    ).toThrow();
  });
});

// ─── Frozen output ────────────────────────────────────────────────────────

describe('deriveFacets — frozen output', () => {
  it('primary and overflow arrays are frozen', () => {
    const bar = deriveFacets<SearchHit>({
      results: [{ category: 'Furniture' }],
      key: (r) => r.category ?? null,
    });
    expect(Object.isFrozen(bar.primary)).toBe(true);
    expect(Object.isFrozen(bar.overflow)).toBe(true);
  });
});
