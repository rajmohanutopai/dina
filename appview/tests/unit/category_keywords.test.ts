/**
 * Category-keywords lookup tests (TN-ENRICH-002).
 *
 * Pins:
 *   - Plan §3.6.3 documented examples (`furniture`, `book`, `phone`,
 *     `restaurant`, `cafe`, `hotel`) all match.
 *   - Word-boundary matching: "chair" matches "Aeron chair" but
 *     NOT "chairman" (regression-pinned).
 *   - Multi-word keywords match first (longest-first sort): "dining
 *     table" beats "table" on a name containing both.
 *   - Case-insensitive + whitespace-normalised input.
 *   - Caller composes full category by prefixing SubjectRef.type
 *     (the lookup returns just the segment).
 *   - Returns `null` for null / undefined / empty / no-match.
 *   - Curation hygiene: no duplicate keywords, monotonic length-sort,
 *     seed-list size in plan range.
 *   - Frozen entries.
 *
 * Pure data — runs under vitest.
 */

import { describe, it, expect } from 'vitest'
import {
  categoryKeywordsStats,
  lookupCategorySegment,
} from '@/util/category_keywords'

// ─── Plan §3.6.3 documented examples ──────────────────────────────────────

describe('lookupCategorySegment — plan §3.6.3 documented examples', () => {
  it('furniture (chair → furniture)', () => {
    expect(lookupCategorySegment('Aeron chair')).toBe('furniture')
  })

  it('book → book', () => {
    expect(lookupCategorySegment('My favourite book')).toBe('book')
  })

  it('phone → electronics', () => {
    expect(lookupCategorySegment('iPhone 15')).toBeNull() // no `phone` word boundary in iPhone
    expect(lookupCategorySegment('My phone')).toBe('electronics')
  })

  it('restaurant → restaurant', () => {
    expect(lookupCategorySegment('La Pergola Restaurant')).toBe('restaurant')
  })

  it('cafe → cafe', () => {
    expect(lookupCategorySegment('Mona Cafe')).toBe('cafe')
  })

  it('hotel → hotel', () => {
    expect(lookupCategorySegment('Marriott Hotel')).toBe('hotel')
  })
})

// ─── Word-boundary matching ──────────────────────────────────────────────

describe('lookupCategorySegment — word-boundary matching', () => {
  it('matches whole-word "chair" in "Aeron chair"', () => {
    expect(lookupCategorySegment('Aeron chair')).toBe('furniture')
  })

  it('does NOT match "chair" inside "chairman" (regression guard)', () => {
    expect(lookupCategorySegment('chairman of the board')).toBeNull()
  })

  it('does NOT match "bar" inside "barbarian"', () => {
    expect(lookupCategorySegment('barbarian movie')).toBeNull()
  })

  it('matches "bar" as a whole word', () => {
    expect(lookupCategorySegment('Sky Bar')).toBe('bar')
  })

  it('matches at start of name', () => {
    expect(lookupCategorySegment('chair model XYZ')).toBe('furniture')
  })

  it('matches at end of name', () => {
    expect(lookupCategorySegment('Herman Miller chair')).toBe('furniture')
  })
})

// ─── Multi-word keyword priority ─────────────────────────────────────────

describe('lookupCategorySegment — multi-word keyword priority', () => {
  it('"dining table" wins over plain "table"', () => {
    // Both `dining table` (segment=furniture) and `table` (segment=furniture)
    // are in the map. The multi-word should match first.
    // Both happen to map to 'furniture', so the regression guard is on
    // matching ORDER (not result) — confirmed by the sort invariant
    // test below. Here we just verify a multi-word match returns
    // furniture for a known-multi-word input.
    expect(lookupCategorySegment('Modern dining table for 6')).toBe('furniture')
  })

  it('"office chair" matches even when "chair" alone would also', () => {
    expect(lookupCategorySegment('Aeron office chair')).toBe('furniture')
  })

  it('"coffee shop" → cafe (NOT just "coffee" → cafe; same segment but multi-word semantics)', () => {
    expect(lookupCategorySegment('Brooklyn Coffee Shop')).toBe('cafe')
  })

  it('"wine bar" → bar (multi-word matches before single-word "bar")', () => {
    // Both `wine bar` and `bar` map to segment 'bar'. The regression
    // is on the SORT ORDER — multi-word first. Verified via stats test.
    expect(lookupCategorySegment('Carmela Wine Bar')).toBe('bar')
  })

  it('"power drill" matches before "drill"', () => {
    expect(lookupCategorySegment('DeWalt power drill 20V')).toBe('tools')
  })
})

// ─── Case + whitespace normalisation ─────────────────────────────────────

describe('lookupCategorySegment — case + whitespace normalisation', () => {
  it('case-insensitive', () => {
    expect(lookupCategorySegment('CHAIR')).toBe('furniture')
    expect(lookupCategorySegment('Chair')).toBe('furniture')
    expect(lookupCategorySegment('cHaIr')).toBe('furniture')
  })

  it('trims surrounding whitespace', () => {
    expect(lookupCategorySegment('   chair   ')).toBe('furniture')
  })

  it('collapses internal multi-spaces', () => {
    expect(lookupCategorySegment('Aeron     chair')).toBe('furniture')
    expect(lookupCategorySegment('dining    table')).toBe('furniture')
  })

  it('handles tabs / newlines as whitespace', () => {
    expect(lookupCategorySegment('Aeron\tchair')).toBe('furniture')
    expect(lookupCategorySegment('Aeron\nchair')).toBe('furniture')
  })
})

// ─── Café (accented form) ────────────────────────────────────────────────

describe('lookupCategorySegment — accented forms', () => {
  it('matches "café" (with accent) → cafe', () => {
    expect(lookupCategorySegment('La Petite Café')).toBe('cafe')
  })

  it('matches plain "cafe" (no accent) → cafe', () => {
    expect(lookupCategorySegment('Mona Cafe')).toBe('cafe')
  })
})

// ─── Place keywords ──────────────────────────────────────────────────────

describe('lookupCategorySegment — place keywords', () => {
  const cases: ReadonlyArray<[string, string]> = [
    ['Wonderbox Restaurant', 'restaurant'],
    ['Sunny Cafe', 'cafe'],
    ['Pizza Pub', 'bar'],
    ['Marriott Hotel', 'hotel'],
    ['Best Western Motel', 'hotel'],
    ['HI Boston Hostel', 'hostel'],
    ['Equinox Gym', 'gym'],
    ['Style Salon', 'salon'],
    ['Public Library', 'library'],
    ['Mt Sinai Hospital', 'hospital'],
    ['Dr. Smith Dental Clinic', 'dentist'],
    ['CVS Pharmacy', 'pharmacy'],
    ['Trader Joes Grocery Store', 'grocery'],
    ['Powell’s Bookstore', 'bookstore'],
    ['Westfield Mall', 'mall'],
    ['Central Park', 'park'],
    ['MoMA Museum', 'museum'],
    ['Apollo Theater', 'theater'],
    ['IMAX Cinema', 'cinema'],
  ]
  for (const [name, segment] of cases) {
    it(`"${name}" → ${segment}`, () => {
      expect(lookupCategorySegment(name)).toBe(segment)
    })
  }
})

// ─── Product keywords ────────────────────────────────────────────────────

describe('lookupCategorySegment — product keywords', () => {
  const cases: ReadonlyArray<[string, string]> = [
    ['Aeron chair', 'furniture'],
    ['IKEA Bookshelf', 'furniture'],
    ['Casper Mattress', 'furniture'],
    ['MacBook Pro laptop', 'electronics'],
    ['Sony headphones', 'electronics'],
    ['Canon camera', 'electronics'],
    ['Apple Watch', 'electronics'],
    ['novel by Tolkien', 'book'],
    ['Calculus textbook', 'book'],
    ['Levis Jeans', 'apparel'],
    ['Nike sneakers', 'apparel'],
    ['Gucci dress', 'apparel'],
    ['Chanel perfume', 'beauty'],
    ['L\'Oreal shampoo', 'beauty'],
    ['DeWalt drill', 'tools'],
    ['Coleman tent', 'outdoors'],
    ['Specialized bicycle', 'outdoors'],
  ]
  for (const [name, segment] of cases) {
    it(`"${name}" → ${segment}`, () => {
      expect(lookupCategorySegment(name)).toBe(segment)
    })
  }
})

// ─── No match / null input ───────────────────────────────────────────────

describe('lookupCategorySegment — no match / null input', () => {
  it('returns null for unrecognised name', () => {
    expect(lookupCategorySegment('Quantum entanglement experiment')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(lookupCategorySegment('')).toBeNull()
  })

  it('returns null for whitespace-only input', () => {
    expect(lookupCategorySegment('   ')).toBeNull()
  })

  it('returns null for null / undefined', () => {
    expect(lookupCategorySegment(null)).toBeNull()
    expect(lookupCategorySegment(undefined)).toBeNull()
  })

  it('returns null for non-string input', () => {
    // @ts-expect-error — runtime guard
    expect(lookupCategorySegment(42)).toBeNull()
    // @ts-expect-error — runtime guard
    expect(lookupCategorySegment({ name: 'chair' })).toBeNull()
  })
})

// ─── Curation hygiene ────────────────────────────────────────────────────

describe('seed list — curation hygiene', () => {
  it('zero duplicate keywords', () => {
    const { hasDuplicates } = categoryKeywordsStats()
    expect(hasDuplicates).toBe(false)
  })

  it('keywords sorted by length descending (multi-word match priority)', () => {
    const { sortedDescByLength } = categoryKeywordsStats()
    expect(sortedDescByLength).toBe(true)
  })

  it('seed list size in plan §3.6.3 range (~200 entries; V1 launch baseline ≥ 50)', () => {
    const { count } = categoryKeywordsStats()
    expect(count).toBeGreaterThanOrEqual(50)
    expect(count).toBeLessThanOrEqual(300)
  })

  it('covers a broad range of segments (≥ 15 distinct segments)', () => {
    const { segments } = categoryKeywordsStats()
    expect(segments).toBeGreaterThanOrEqual(15)
  })
})
