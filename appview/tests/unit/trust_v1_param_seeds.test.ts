/**
 * Unit tests for `appview/src/db/seeds/trust-v1-params.ts` (TN-DB-004).
 *
 * The seed list is the single source of truth for the trust_v1_params
 * table's bootstrap values. Pinning shape + invariants here means the
 * consolidated TN-DB-010 migration, the `dina-admin trust seed-params`
 * CLI, and any test fixture all consume a verified frozen list.
 */

import { describe, it, expect } from 'vitest'
import { TRUST_V1_PARAM_SEEDS } from '@/db/seeds/trust-v1-params'

describe('TRUST_V1_PARAM_SEEDS — TN-DB-004 canonical seed list', () => {
  it('exports every Plan §4.1 numeric parameter (FTS_WEIGHT_* deferred to TN-DB-009)', () => {
    const expectedKeys = new Set([
      'WEIGHT_VOLUME',
      'WEIGHT_AGE',
      'WEIGHT_COSIG',
      'WEIGHT_CONSISTENCY',
      'N_VOLUME_TARGET',
      'N_COSIG_TARGET',
      'N_CONSISTENCY_MIN',
      'VAR_MAX',
      'HOT_SUBJECT_THRESHOLD',
      'FRIEND_BOOST',
    ])
    const seeded = new Set(TRUST_V1_PARAM_SEEDS.map((s) => s.key))
    expect(seeded).toEqual(expectedKeys)
  })

  it('reviewer-trust WEIGHT_* coefficients sum to 1.0 (Plan §7 ranking formula contract)', () => {
    // Reviewer trust = WEIGHT_VOLUME × volume_signal + WEIGHT_AGE × age_signal
    //                + WEIGHT_COSIG × cosig_signal + WEIGHT_CONSISTENCY × consistency_signal
    // The sum must be 1.0 so the trust score's range stays [0, 1] regardless of signal values.
    // If a future PR rebalances the weights, this test forces the rebalancing to keep summing to 1.
    const weightKeys = ['WEIGHT_VOLUME', 'WEIGHT_AGE', 'WEIGHT_COSIG', 'WEIGHT_CONSISTENCY']
    const sum = TRUST_V1_PARAM_SEEDS
      .filter((s) => weightKeys.includes(s.key))
      .reduce((acc, s) => acc + s.value, 0)
    expect(sum).toBeCloseTo(1.0, 10)
  })

  it('every entry has a non-empty description (operator-facing docstring per `dina-admin trust list-params`)', () => {
    for (const seed of TRUST_V1_PARAM_SEEDS) {
      expect(seed.description.length).toBeGreaterThan(0)
    }
  })

  it('every entry has a finite numeric value (no NaN / Infinity from a typo)', () => {
    for (const seed of TRUST_V1_PARAM_SEEDS) {
      expect(Number.isFinite(seed.value)).toBe(true)
    }
  })

  it('saturation thresholds are positive integers (review counts, not fractions)', () => {
    const integerKeys = ['N_VOLUME_TARGET', 'N_COSIG_TARGET', 'N_CONSISTENCY_MIN', 'HOT_SUBJECT_THRESHOLD']
    for (const seed of TRUST_V1_PARAM_SEEDS) {
      if (integerKeys.includes(seed.key)) {
        expect(Number.isInteger(seed.value)).toBe(true)
        expect(seed.value).toBeGreaterThan(0)
      }
    }
  })

  it('zero key collisions (regression guard against duplicate seed rows)', () => {
    const keys = TRUST_V1_PARAM_SEEDS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('top-level array is frozen (caller cannot mutate the seed list)', () => {
    expect(Object.isFrozen(TRUST_V1_PARAM_SEEDS)).toBe(true)
    expect(() => {
      // @ts-expect-error — runtime mutation guard
      TRUST_V1_PARAM_SEEDS.push({ key: 'X', value: 1, description: 'x' })
    }).toThrow()
  })

  it('individual entries are frozen (caller cannot mutate a row)', () => {
    for (const seed of TRUST_V1_PARAM_SEEDS) {
      expect(Object.isFrozen(seed)).toBe(true)
    }
  })
})
