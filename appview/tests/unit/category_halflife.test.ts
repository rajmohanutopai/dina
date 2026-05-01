/**
 * §unit — Per-category recency half-life lookup (TN-V2-RANK-006)
 *
 * Pin the lookup contract: exact-match-first, prefix-fallback,
 * default-floor. The downstream property test (TEST-009) verifies
 * the monotonicity property *over the lookup* — these tests pin
 * specific category → half-life pairs the curators committed to.
 */

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CATEGORY_HALFLIFE_DAYS,
  DEFAULT_HALFLIFE_DAYS,
  halflifeForCategory,
} from '@/scorer/algorithms/category_halflife'

describe('halflifeForCategory — built-in category map', () => {
  it('tech categories get 180-day half-life (current default — fast-moving)', () => {
    expect(halflifeForCategory('product:phone')).toBe(180)
    expect(halflifeForCategory('product:laptop')).toBe(180)
    expect(halflifeForCategory('product:tech')).toBe(180)
    expect(halflifeForCategory('product:software')).toBe(180)
    expect(halflifeForCategory('product:ide')).toBe(180)
  })

  it('books get 5-year half-life (slow-moving — book itself is immutable)', () => {
    expect(halflifeForCategory('product:book')).toBe(1825)
  })

  it('restaurants / cafes / bars get 1-year half-life (medium decay)', () => {
    expect(halflifeForCategory('place:restaurant')).toBe(365)
    expect(halflifeForCategory('place:cafe')).toBe(365)
    expect(halflifeForCategory('place:bar')).toBe(365)
  })

  it('hotels get 2-year half-life (chains drift slower than indie spots)', () => {
    expect(halflifeForCategory('place:hotel')).toBe(730)
  })

  it('services get 1.5-year half-life', () => {
    expect(halflifeForCategory('service')).toBe(540)
  })
})

describe('halflifeForCategory — fallback semantics', () => {
  it('returns default for unmatched category', () => {
    expect(halflifeForCategory('product:unknown')).toBe(DEFAULT_HALFLIFE_DAYS)
    expect(halflifeForCategory('place:unrecognised')).toBe(DEFAULT_HALFLIFE_DAYS)
    expect(halflifeForCategory('totally:novel:taxonomy')).toBe(DEFAULT_HALFLIFE_DAYS)
  })

  it('returns default for empty / null / undefined category', () => {
    expect(halflifeForCategory('')).toBe(DEFAULT_HALFLIFE_DAYS)
    expect(halflifeForCategory(null)).toBe(DEFAULT_HALFLIFE_DAYS)
    expect(halflifeForCategory(undefined)).toBe(DEFAULT_HALFLIFE_DAYS)
  })

  it('lookup is case-insensitive', () => {
    expect(halflifeForCategory('PRODUCT:BOOK')).toBe(1825)
    expect(halflifeForCategory('Place:Restaurant')).toBe(365)
  })

  it('always returns a positive integer (no NaN, no zero, no negative)', () => {
    for (const cat of ['product:book', 'service', 'totally:unknown', '', null, undefined]) {
      const r = halflifeForCategory(cat)
      expect(r).toBeGreaterThan(0)
      expect(Number.isInteger(r)).toBe(true)
    }
  })
})

describe('halflifeForCategory — prefix matching', () => {
  it('product:phone:samsung falls back to product:phone (more-specific-wins prefix walk)', () => {
    // No 'product:phone:samsung' override defined; the walk down from
    // 3 segments → 2 segments hits 'product:phone' (180 days).
    expect(halflifeForCategory('product:phone:samsung')).toBe(180)
  })

  it('product:book:fiction falls back to product:book', () => {
    expect(halflifeForCategory('product:book:fiction')).toBe(1825)
  })

  it('place:restaurant:italian falls back to place:restaurant', () => {
    expect(halflifeForCategory('place:restaurant:italian')).toBe(365)
  })

  it('product:furniture (1-segment-deep, unmatched) falls to default — does NOT match "product"', () => {
    // 'product' isn't an entry; only 2-segment specific keys are. So
    // 'product:furniture' walks `product:furniture` (no), `product`
    // (no), default. Pinning so a future curator who adds
    // 'product' as a catch-all sees this test break + decides
    // explicitly.
    expect(halflifeForCategory('product:furniture')).toBe(DEFAULT_HALFLIFE_DAYS)
  })
})

describe('halflifeForCategory — operator override', () => {
  it('override map beats built-in for the same key (operator tuning)', () => {
    const override = new Map([['product:book', 365]])
    expect(halflifeForCategory('product:book', override)).toBe(365)
  })

  it('override applies via prefix walk', () => {
    const override = new Map([['product', 90]])
    // 'product:phone' has a 2-segment built-in (180). The walk
    // checks 'product:phone' first — both override and default
    // missing — then 'product' where override hits (90). Override
    // wins because the 2-segment override path didn't match; both
    // fall to the 1-segment level where override has 'product'=90.
    expect(halflifeForCategory('product:phone', override)).toBe(180)  // built-in 2-seg wins
    expect(halflifeForCategory('product:furniture', override)).toBe(90) // override 1-seg wins for unmapped 2-seg
  })

  it('override map with non-positive value is ignored (defensive)', () => {
    // A misconfigured override value like `0` or `-1` would otherwise
    // produce `exp(-x/0) = NaN` or `exp(-x/-1) = Infinity` — neither
    // valid. The function skips such entries and falls through to
    // built-ins / default.
    const broken = new Map([
      ['product:book', 0],
      ['product:phone', -10],
    ])
    expect(halflifeForCategory('product:book', broken)).toBe(1825)
    expect(halflifeForCategory('product:phone', broken)).toBe(180)
  })

  it('empty override map behaves identically to no override', () => {
    expect(halflifeForCategory('product:book', new Map())).toBe(1825)
    expect(halflifeForCategory('product:furniture', new Map())).toBe(DEFAULT_HALFLIFE_DAYS)
  })
})

describe('halflifeForCategory — invariants over the built-in map', () => {
  it('every entry has a positive integer value (no zero/negative/NaN)', () => {
    for (const [key, value] of DEFAULT_CATEGORY_HALFLIFE_DAYS.entries()) {
      expect(Number.isInteger(value), `${key} value not int: ${value}`).toBe(true)
      expect(value, `${key} value not positive: ${value}`).toBeGreaterThan(0)
    }
  })

  it('every entry key is lowercase (lookup normalises before walk; mismatched casing in map = unreachable)', () => {
    for (const key of DEFAULT_CATEGORY_HALFLIFE_DAYS.keys()) {
      expect(key, `${key} not lowercase`).toBe(key.toLowerCase())
    }
  })
})
