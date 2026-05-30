/**
 * Read-side dimension canonicalization (Part 2, Layer 3 — the safety net).
 * The aggregator must canonicalize each dimension WITHIN its category
 * before group-by, so alias-keyed records merge into the canonical pile
 * instead of silently splitting the consensus; unknown dimensions are
 * dropped (never aggregated raw) and counted.
 *
 * Spec: docs/SERVICES_LAUNCH_ARCHITECTURE.md Part 2.
 */

import { describe, expect, it } from 'vitest'
import {
  aggregateSubjectSentiment,
  type AttestationForAggregation,
} from '../../src/scorer/algorithms/sentiment-aggregation.js'

function att(overrides: Partial<AttestationForAggregation>): AttestationForAggregation {
  return {
    sentiment: 'positive',
    recordCreatedAt: new Date('2026-01-01T00:00:00Z'),
    evidenceJson: null,
    hasCosignature: false,
    isVerified: false,
    category: 'furniture',
    dimensionsJson: null,
    ...overrides,
  } as AttestationForAggregation
}

describe('aggregateSubjectSentiment — dimension read-net', () => {
  it('merges aliases into ONE canonical pile (no silent split)', () => {
    const r = aggregateSubjectSentiment([
      att({ category: 'furniture', dimensionsJson: [{ dimension: 'lumbar_support', value: 'exceeded' }] }),
      att({ category: 'furniture', dimensionsJson: [{ dimension: 'back_support', value: 'met' }] }),
      att({ category: 'furniture', dimensionsJson: [{ dimension: 'lumbar', value: 'exceeded' }] }),
    ])
    // All three rate the SAME canonical dimension — one merged pile.
    expect(Object.keys(r.dimensionSummary)).toEqual(['lumbar_support'])
    expect(r.dimensionSummary.lumbar_support).toEqual({
      exceeded: 2,
      met: 1,
      below: 0,
      failed: 0,
    })
    expect(r.droppedUnknownDimensions).toBe(0)
  })

  it('canonicalizes through a category alias (home_furniture → furniture)', () => {
    const r = aggregateSubjectSentiment([
      att({ category: 'home_furniture', dimensionsJson: [{ dimension: 'back_support', value: 'exceeded' }] }),
    ])
    expect(r.dimensionSummary.lumbar_support).toEqual({
      exceeded: 1,
      met: 0,
      below: 0,
      failed: 0,
    })
  })

  it('DROPS an unknown dimension (never aggregated raw) and counts it', () => {
    const r = aggregateSubjectSentiment([
      att({ category: 'furniture', dimensionsJson: [{ dimension: 'rgb_lighting', value: 'exceeded' }] }),
      att({ category: 'furniture', dimensionsJson: [{ dimension: 'comfort', value: 'met' }] }),
    ])
    expect(Object.keys(r.dimensionSummary)).toEqual(['comfort'])
    expect(r.dimensionSummary.rgb_lighting).toBeUndefined()
    expect(r.droppedUnknownDimensions).toBe(1)
  })

  it('does not bleed dimensions across categories (food_quality is dining, not furniture)', () => {
    const r = aggregateSubjectSentiment([
      att({ category: 'furniture', dimensionsJson: [{ dimension: 'food_quality', value: 'exceeded' }] }),
    ])
    expect(r.dimensionSummary.food_quality).toBeUndefined()
    expect(r.droppedUnknownDimensions).toBe(1)
  })

  it('uses GENERIC vocabulary for a category with no specific list', () => {
    const r = aggregateSubjectSentiment([
      att({ category: 'spaceships', dimensionsJson: [{ dimension: 'value_for_money', value: 'met' }] }),
    ])
    expect(r.dimensionSummary.value).toEqual({ exceeded: 0, met: 1, below: 0, failed: 0 })
  })
})
