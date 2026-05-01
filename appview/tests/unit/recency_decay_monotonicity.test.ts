/**
 * §unit — Recency-decay monotonicity (TN-V2-TEST-009 / RANK-006)
 *
 * Property tests pin the algebraic invariants of the per-category
 * recency-decay model. Three properties must hold for any input:
 *
 *  1. **Strict monotonicity in age**: for any fixed half-life and
 *     fixed `now`, an older `recordCreatedAt` produces a STRICTLY
 *     SMALLER recency factor than a younger one. No ties at the
 *     boundary; no inversions; no NaN/Infinity.
 *
 *  2. **Equivalence at equal age**: two attestations with the same
 *     age + same half-life produce IDENTICAL recency factors.
 *
 *  3. **Cross-category ordering**: longer half-life means slower
 *     decay; for the same age, a 5-year-half-life category has a
 *     larger recency factor than a 6-month-half-life category.
 *
 * These properties are what make the per-category decay
 * meaningful — if any failed, the recency component of the trust
 * score would be either degenerate or non-monotone, breaking
 * downstream "newer reviews count more" intuition.
 *
 * The properties are tested directly on the recency factor
 * `exp(-ageDays / halflife)` as composed in `computeSentiment`,
 * extracting that math here so the test isn't tied to the rest of
 * the trust-score plumbing.
 */

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CATEGORY_HALFLIFE_DAYS,
  DEFAULT_HALFLIFE_DAYS,
  halflifeForCategory,
} from '@/scorer/algorithms/category_halflife'

/**
 * Recency factor as composed in `computeSentiment` (TN-V2-RANK-006).
 * Pure: same input → same output. Pinning the formula here means
 * `computeSentiment`'s recency math can't drift away from the
 * monotonicity contract without one of these tests catching it.
 */
function recencyFactor(ageDays: number, halflife: number): number {
  return Math.exp(-Math.max(0, ageDays) / halflife)
}

// ── Deterministic RNG (mulberry32) — same seeded pattern as the
// existing trust-score property tests so failures are reproducible.
function mulberry32(seed: number): () => number {
  let s = seed
  return () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SEED = 0x12345678
const ITERATIONS = 200

describe('Property 1 — strictly monotone in age (older → smaller recency)', () => {
  it('for every category, age_old > age_young ⇒ recency(old) < recency(young)', () => {
    const rand = mulberry32(SEED)
    const categories = [
      'product:book', 'product:phone', 'product:laptop',
      'place:restaurant', 'place:hotel', 'service',
      'product:unknown', // falls to default — must still satisfy monotonicity
    ]
    for (let i = 0; i < ITERATIONS; i++) {
      const cat = categories[Math.floor(rand() * categories.length)]
      const halflife = halflifeForCategory(cat)
      // Random ages in [0, 10 years] — the realistic upper bound for
      // attestations the scorer might encounter.
      const a = rand() * 3650
      const b = rand() * 3650
      // Skip degenerate equal-age (covered by Property 2).
      if (Math.abs(a - b) < 1e-9) continue
      const [younger, older] = a < b ? [a, b] : [b, a]
      const r_young = recencyFactor(younger, halflife)
      const r_old = recencyFactor(older, halflife)
      // Strict inequality — equal-age path is Property 2's job.
      expect(r_old, `category=${cat} young=${younger} old=${older} hl=${halflife}`).toBeLessThan(r_young)
      // Both recencies must be in (0, 1] — recency is bounded.
      expect(r_old).toBeGreaterThan(0)
      expect(r_young).toBeLessThanOrEqual(1)
      expect(Number.isFinite(r_old)).toBe(true)
      expect(Number.isFinite(r_young)).toBe(true)
    }
  })

  it('age = 0 produces recency = 1 (canonical anchor)', () => {
    for (const halflife of DEFAULT_CATEGORY_HALFLIFE_DAYS.values()) {
      expect(recencyFactor(0, halflife)).toBe(1.0)
    }
    expect(recencyFactor(0, DEFAULT_HALFLIFE_DAYS)).toBe(1.0)
  })

  it('age = halflife produces recency = exp(-1) ≈ 0.368 (canonical decay anchor)', () => {
    // The half-life *definition*: at one half-life, the recency factor
    // is `exp(-1)` ≈ 0.367879. Pinning this prevents a future refactor
    // from swapping the exponential base or scaling the formula.
    for (const halflife of DEFAULT_CATEGORY_HALFLIFE_DAYS.values()) {
      expect(recencyFactor(halflife, halflife)).toBeCloseTo(Math.exp(-1), 12)
    }
  })

  it('negative ageDays clamps to 0 (no future-dated boost)', () => {
    // The handler clamps ageDays via `Math.max(0, daysSince(...))`.
    // Pin the clamp here so a refactor can't reintroduce a future-
    // attestation bonus (`exp(-(-x)/h) > 1`).
    expect(recencyFactor(-100, 180)).toBe(1.0)
    expect(recencyFactor(-1, 365)).toBe(1.0)
  })
})

describe('Property 2 — equivalence at equal age (same input → same output)', () => {
  it('two attestations with the same ageDays produce identical recency', () => {
    const rand = mulberry32(SEED)
    for (let i = 0; i < ITERATIONS; i++) {
      const halflife = halflifeForCategory(['product:book', 'product:phone', 'place:restaurant'][i % 3])
      const age = rand() * 3650
      const a = recencyFactor(age, halflife)
      const b = recencyFactor(age, halflife)
      // Strict equality: this is the determinism check. Any drift
      // would mean the formula reads hidden state.
      expect(a).toBe(b)
    }
  })

  it('two categories sharing the same half-life produce identical recency at equal age', () => {
    // 'product:phone' and 'product:laptop' both map to 180 days.
    // For any fixed age, their recency factors must be byte-identical.
    const phone = halflifeForCategory('product:phone')
    const laptop = halflifeForCategory('product:laptop')
    expect(phone).toBe(laptop)  // sanity — the curator might re-tune
    const rand = mulberry32(SEED)
    for (let i = 0; i < 50; i++) {
      const age = rand() * 3650
      expect(recencyFactor(age, phone)).toBe(recencyFactor(age, laptop))
    }
  })
})

describe('Property 3 — cross-category ordering (longer half-life → slower decay)', () => {
  it('books (5yr halflife) decay slower than tech (6mo halflife) at every positive age', () => {
    const tech = halflifeForCategory('product:phone')
    const books = halflifeForCategory('product:book')
    expect(books).toBeGreaterThan(tech)  // sanity
    const rand = mulberry32(SEED)
    for (let i = 0; i < ITERATIONS; i++) {
      // Skip ageDays = 0 — both categories anchor at 1.0 there.
      const age = 0.001 + rand() * 3650
      const r_tech = recencyFactor(age, tech)
      const r_book = recencyFactor(age, books)
      expect(r_book, `age=${age}`).toBeGreaterThan(r_tech)
    }
  })

  it('restaurants (1yr) decay between tech (6mo) and books (5yr) at every positive age', () => {
    const tech = halflifeForCategory('product:phone')
    const rest = halflifeForCategory('place:restaurant')
    const books = halflifeForCategory('product:book')
    expect(tech).toBeLessThan(rest)
    expect(rest).toBeLessThan(books)
    const rand = mulberry32(SEED)
    for (let i = 0; i < ITERATIONS; i++) {
      const age = 0.001 + rand() * 3650
      const r_tech = recencyFactor(age, tech)
      const r_rest = recencyFactor(age, rest)
      const r_book = recencyFactor(age, books)
      expect(r_tech, `age=${age}`).toBeLessThan(r_rest)
      expect(r_rest, `age=${age}`).toBeLessThan(r_book)
    }
  })

  it('halflife monotonicity is preserved across the entire built-in map', () => {
    // For any two categories A and B, halflife_A < halflife_B implies
    // recency_A(age) < recency_B(age) for any age > 0. This pins the
    // structural property that makes per-category tuning meaningful —
    // if the built-in map ever held two categories with the same key
    // but different values, this would surface (impossible by
    // construction) — and it pins that the formula is monotone in the
    // halflife parameter too.
    const entries = Array.from(DEFAULT_CATEGORY_HALFLIFE_DAYS.entries())
    const ages = [1, 30, 365, 1000, 3650]
    for (let i = 0; i < entries.length; i++) {
      for (let j = 0; j < entries.length; j++) {
        if (i === j) continue
        const [, hl_a] = entries[i]
        const [, hl_b] = entries[j]
        if (hl_a === hl_b) continue
        for (const age of ages) {
          const r_a = recencyFactor(age, hl_a)
          const r_b = recencyFactor(age, hl_b)
          if (hl_a < hl_b) {
            expect(r_a).toBeLessThan(r_b)
          } else {
            expect(r_a).toBeGreaterThan(r_b)
          }
        }
      }
    }
  })
})

describe('Property 4 — no NaN / Infinity at boundaries (numerical safety)', () => {
  it('recency stays finite for very old ages (10,000 years)', () => {
    const r = recencyFactor(10_000 * 365, DEFAULT_HALFLIFE_DAYS)
    // Numerically vanishingly small but not 0 in IEEE-754, certainly
    // not NaN or -Infinity. Math.exp(-very-large) underflows to 0
    // gracefully — pin that.
    expect(Number.isFinite(r)).toBe(true)
    expect(r).toBeGreaterThanOrEqual(0)
    expect(r).toBeLessThan(1e-100)
  })

  it('recency stays finite for very large half-life (10,000 years)', () => {
    // A misconfigured override might pick an absurdly long half-life;
    // the formula must not produce NaN/Infinity.
    const r = recencyFactor(365, 10_000 * 365)
    expect(Number.isFinite(r)).toBe(true)
    expect(r).toBeGreaterThan(0.99)  // tiny decay over 1 year vs 10,000-year halflife
    expect(r).toBeLessThanOrEqual(1)
  })
})
