/**
 * §14.4 review-dimension projection (WS-10.1, WS-10.2).
 *
 * The rules under test are the ones that decide whether software can move a
 * supplier's public standing. Everything else in this file is scaffolding
 * around three claims:
 *
 *   - a projection retains what it was derived FROM, or it is not published;
 *   - a reviewer who said so outranks a model that inferred it;
 *   - exact commercial terms do not become public because an extractor quoted
 *     a sentence containing them.
 */

import { describe, expect, it } from 'vitest'

import {
  MODEL_EXTRACTION_CAP_BP,
  STANDING_FLOOR_BP,
  projectDimension,
  projectReviewDimensions,
  strongestPerDimension,
  type DimensionClaim,
} from '@/shared/commerce/review-dimensions.js'

const REVIEW = 'at://did:plc:buyer1/com.dinakernel.peerlens.attestation/r1'
const TARGET = 'did:plc:chairmaker99'

function claim(over: Partial<DimensionClaim> = {}): DimensionClaim {
  return {
    dimension: 'fulfilment',
    source: 'reviewer_confirmed',
    confidenceBp: 9000,
    sentiment: 'positive',
    sourceReviewUri: REVIEW,
    targetNode: TARGET,
    relationshipPath: [],
    provenance: 'direct',
    extractorId: 'dina.review.dimensions',
    extractorVersion: '1',
    ...over,
  }
}

describe('a projection is traceable or it is not published', () => {
  it('keeps every field §14.4 requires it to retain', () => {
    const out = projectDimension(claim({ relationshipPath: ['same_formulation_as'] }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.dimension.sourceReviewUri).toBe(REVIEW)
    expect(out.dimension.targetNode).toBe(TARGET)
    expect(out.dimension.extractorId).toBe('dina.review.dimensions')
    expect(out.dimension.extractorVersion).toBe('1')
    expect(out.dimension.relationshipPath).toEqual(['same_formulation_as'])
  })

  it.each(['sourceReviewUri', 'targetNode', 'extractorId', 'extractorVersion'] as const)(
    'refuses a claim missing %s',
    (field) => {
      // A dimension nobody can trace back is an opinion the index publishes in
      // its own name.
      const out = projectDimension(claim({ [field]: '' }))
      expect(out.ok).toBe(false)
      expect(!out.ok && out.finding.refusal).toBe('untraceable')
    },
  )

  it('requires traceability of a REVIEWER-CONFIRMED scope too', () => {
    // "The reviewer said so" still has to name which review said it.
    const out = projectDimension(claim({ source: 'reviewer_confirmed', sourceReviewUri: '' }))
    expect(out.ok).toBe(false)
  })

  it('refuses a dimension outside §14.4’s vocabulary', () => {
    const out = projectDimension(claim({ dimension: 'vibes' }))
    expect(out.ok).toBe(false)
    expect(!out.ok && out.finding.refusal).toBe('unknown_dimension')
  })

  it.each([-1, 10001, 1.5, Number.NaN])('refuses confidence %s', (confidenceBp) => {
    const out = projectDimension(claim({ confidenceBp }))
    expect(out.ok).toBe(false)
    expect(!out.ok && out.finding.refusal).toBe('confidence_out_of_range')
  })

  it('does NOT modify its input', () => {
    const original = claim({ relationshipPath: ['variant_of'] })
    const snapshot = JSON.stringify(original)
    projectDimension(original)
    expect(JSON.stringify(original)).toBe(snapshot)
  })

  it('copies the relationship path, so a caller cannot rewrite it afterwards', () => {
    const path = ['variant_of']
    const out = projectDimension(claim({ relationshipPath: path }))
    path.push('mutated')
    expect(out.ok && out.dimension.relationshipPath).toEqual(['variant_of'])
  })
})

describe('a reviewer outranks a model (§14.4)', () => {
  it('caps an unconfirmed model extraction however confident it reports', () => {
    // "Opaque AI classification alone must not create a large public standing
    // penalty." The cap is arithmetic, so a caller cannot opt out of it.
    const out = projectDimension(claim({ source: 'model_extracted', confidenceBp: 10000 }))
    expect(out.ok && out.dimension.confidenceBp).toBe(MODEL_EXTRACTION_CAP_BP)
  })

  it('never RAISES a model extraction that reported less than the cap', () => {
    const out = projectDimension(claim({ source: 'model_extracted', confidenceBp: 1200 }))
    expect(out.ok && out.dimension.confidenceBp).toBe(1200)
  })

  it('a model extraction can never move standing on its own', () => {
    const out = projectDimension(claim({ source: 'model_extracted', confidenceBp: 10000 }))
    expect(out.ok && out.dimension.mayAffectStandingAlone).toBe(false)
  })

  it('a confident reviewer-confirmed dimension may', () => {
    const out = projectDimension(claim({ confidenceBp: STANDING_FLOOR_BP }))
    expect(out.ok && out.dimension.mayAffectStandingAlone).toBe(true)
  })

  it('a reviewer-confirmed dimension BELOW the floor may not', () => {
    const out = projectDimension(claim({ confidenceBp: STANDING_FLOOR_BP - 1 }))
    expect(out.ok && out.dimension.mayAffectStandingAlone).toBe(false)
  })

  it('a dimension reached through a DISPUTED relationship may not, at any confidence', () => {
    // Same rule as §10.7's disputed edge: inheriting standing along a lineage
    // two parties disagree about is how one product acquires another's history.
    const out = projectDimension(
      claim({ confidenceBp: 10000, provenance: 'disputed_relationship' }),
    )
    expect(out.ok && out.dimension.mayAffectStandingAlone).toBe(false)
  })

  it('a reviewer beats a model on the same dimension whatever the numbers say', () => {
    // The SOURCES are ranked, not just their confidence — otherwise a model
    // reporting 4000 would outrank a person who said so at 3000.
    const { dimensions } = projectReviewDimensions([
      claim({ source: 'model_extracted', confidenceBp: 10000 }),
      claim({ source: 'reviewer_confirmed', confidenceBp: 3000 }),
    ])
    const best = strongestPerDimension(dimensions)
    expect(best).toHaveLength(1)
    expect(best[0]?.source).toBe('reviewer_confirmed')
  })

  it('takes the STRONGEST claim, never a sum', () => {
    // Three model extractions agreeing is still three model extractions.
    const { dimensions } = projectReviewDimensions([
      claim({ source: 'model_extracted', confidenceBp: 1500 }),
      claim({ source: 'model_extracted', confidenceBp: 2000 }),
      claim({ source: 'model_extracted', confidenceBp: 1000 }),
    ])
    const best = strongestPerDimension(dimensions)
    expect(best[0]?.confidenceBp).toBe(2000)
  })
})

describe('exact commercial terms stay private (§14.4)', () => {
  it.each([
    'they charged ₹50,000 for the lot',
    'quoted 1200 USD and held it',
    'the approved_total was wrong',
    'see quote_id q-4471',
    'the unit_price field was wrong',
  ])('refuses evidence text carrying a commercial term: %s', (evidenceText) => {
    const out = projectDimension(claim({ dimension: 'terms_held', evidenceText }))
    expect(out.ok).toBe(false)
    expect(!out.ok && out.finding.refusal).toBe('commercial_terms_leak')
  })

  it('names the FIELD and never echoes the value', () => {
    // Echoing a price into a finding turns one leak into two — the same rule
    // the catalog leakage gate follows.
    const out = projectDimension(claim({ evidenceText: 'they charged ₹50,000' }))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.finding.detail).toContain('evidenceText')
    expect(JSON.stringify(out.finding)).not.toContain('50,000')
  })

  it('allows it when the owner DELIBERATELY published the terms', () => {
    const out = projectDimension(claim({ evidenceText: 'quoted 1200 USD and held it' }), {
      ownerPublishedTerms: true,
    })
    expect(out.ok).toBe(true)
  })

  it('PERMITS commentary on whether terms held, with no exact term in it', () => {
    // §14.4 names "price and whether quoted terms held" as a publishable
    // DIMENSION. What stays private is the exact number, not the fact that a
    // buyer was happy with it — refusing this would delete the dimension the
    // spec asks for. The first version of this suite had it the other way
    // round and the code was right.
    const out = projectDimension(
      claim({ dimension: 'terms_held', evidenceText: 'the unit price was fine and it held' }),
    )
    expect(out.ok).toBe(true)
  })

  it('leaves ordinary evidence text alone', () => {
    const out = projectDimension(
      claim({ evidenceText: 'arrived two days early and nothing was damaged' }),
    )
    expect(out.ok).toBe(true)
  })

  it('refuses a bare number with a currency code after it', () => {
    const out = projectDimension(claim({ evidenceText: 'paid 50000 INR' }))
    expect(out.ok).toBe(false)
  })
})

describe('refusals travel beside results', () => {
  it('a batch reports what it could not publish rather than dropping it', () => {
    // A projection that silently dropped a refusal would make an extractor bug
    // indistinguishable from a review that said nothing.
    const { dimensions, findings } = projectReviewDimensions([
      claim({ dimension: 'packaging' }),
      claim({ dimension: 'vibes' }),
      claim({ dimension: 'terms_held', evidenceText: 'they charged £900' }),
    ])
    expect(dimensions).toHaveLength(1)
    expect(findings.map((f) => f.refusal).sort()).toEqual([
      'commercial_terms_leak',
      'unknown_dimension',
    ])
  })

  it('keeps every §14.4 provenance class distinguishable', () => {
    // The UI has to tell a review about THIS variant from one inherited across
    // a family, and both from a complaint about the seller.
    const { dimensions } = projectReviewDimensions([
      claim({ dimension: 'product_quality', provenance: 'direct' }),
      claim({ dimension: 'packaging', provenance: 'inherited_family' }),
      claim({ dimension: 'batch_freshness', provenance: 'brand_history' }),
      claim({ dimension: 'fulfilment', provenance: 'seller_history' }),
      claim({ dimension: 'customer_service', provenance: 'disputed_relationship' }),
    ])
    expect(new Set(dimensions.map((d) => d.provenance)).size).toBe(5)
  })
})
