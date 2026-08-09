/**
 * The relationship graph as a PROJECTION, never a merge (§10.7, FR-A8, FR-A10).
 *
 * Most of these are one property restated: an edge says "these two are
 * related, here is who said so and how strongly"; it never says "these two are
 * the same". A merge is irreversible in practice — once two identities are one
 * row, the reviews, the order history and the lineage of both are
 * indistinguishable, and no later evidence separates them again.
 */

import { describe, expect, it } from 'vitest'

import { productKey } from '@/shared/commerce/catalog-projection.js'
import {
  AUTHORIZE_SUBSTITUTION_BP,
  INHERIT_STANDING_BP,
  SHOW_AS_RELATED_BP,
  claimConfidenceBp,
  mayAuthorizeSubstitution,
  mayInheritStanding,
  mayShowAsRelated,
  projectRelationships,
  type EdgeSource,
  type ProductRelationship,
  type RelationshipClaimShape,
} from '@/shared/commerce/relationship-projection.js'

const MAKER = 'did:plc:chairmaker99'
const RIVAL = 'did:plc:rivalchairs01'
const AT = '2026-08-08T09:00:00.000Z'

const CHAIR_1 = { scheme: 'gtin' as const, value: '05012345678900' }
const CHAIR_2 = { scheme: 'gtin' as const, value: '05012345678917' }
const CHAIR_3 = { scheme: 'gtin' as const, value: '05012345678924' }

function claim(
  overrides: Partial<RelationshipClaimShape> & { relationship: ProductRelationship },
): RelationshipClaimShape {
  return {
    claim_id: `claim-${overrides.claim_id ?? overrides.relationship}`,
    subject: CHAIR_1,
    object: CHAIR_2,
    issuer_did: MAKER,
    ...overrides,
  }
}

function entry(
  c: RelationshipClaimShape,
  source: EdgeSource,
  confidenceBp?: number,
  inferenceVersion?: string,
) {
  return {
    claim: c,
    source,
    assertedAt: AT,
    ...(confidenceBp === undefined ? {} : { confidenceBp }),
    ...(inferenceVersion === undefined ? {} : { inferenceVersion }),
  }
}

describe('the thresholds', () => {
  it('are ordered: show < inherit < substitute', () => {
    // Asserted in code because a single confidence number with three call
    // sites would eventually be compared against whichever constant was
    // nearest to hand.
    expect(SHOW_AS_RELATED_BP).toBeLessThan(INHERIT_STANDING_BP)
    expect(INHERIT_STANDING_BP).toBeLessThan(AUTHORIZE_SUBSTITUTION_BP)
  })

  it('caps an inference below the standing threshold however confident it claims to be', () => {
    // §10.7: a similarity score alone cannot make one node's standing count as
    // exact-variant standing on another. The cheapest way to guarantee that is
    // to make the arithmetic incapable of it.
    expect(claimConfidenceBp('inferred', 10000)).toBeLessThan(INHERIT_STANDING_BP)
    expect(claimConfidenceBp('inferred')).toBeLessThan(INHERIT_STANDING_BP)
  })
})

describe('projecting claims into edges', () => {
  it('keeps every claim behind an edge, with its provenance (FR-A8)', () => {
    const result = projectRelationships([
      entry(claim({ relationship: 'same_formulation_as', claim_id: 'a' }), 'first_party_claim'),
      entry(
        claim({ relationship: 'same_formulation_as', claim_id: 'b', issuer_did: RIVAL }),
        'third_party_claim',
      ),
    ])
    expect(result.edges).toHaveLength(1)
    const edge = result.edges[0]!
    expect(edge.evidence).toHaveLength(2)
    // Source, issuer, time, confidence — the whole of FR-A8's list.
    expect(edge.evidence.map((e) => e.issuerDid)).toEqual([MAKER, RIVAL])
    expect(edge.evidence.map((e) => e.source)).toEqual(['first_party_claim', 'third_party_claim'])
    expect(edge.evidence.every((e) => e.assertedAt === AT)).toBe(true)
  })

  it('takes the STRONGEST claim, never the sum', () => {
    // Three weak inferences agreeing is still three weak inferences. Adding
    // them would let a model vote its way past a threshold it must not reach.
    const result = projectRelationships([
      entry(claim({ relationship: 'same_formulation_as', claim_id: 'i1' }), 'inferred', 3000, 'sim-v1'),
      entry(claim({ relationship: 'same_formulation_as', claim_id: 'i2' }), 'inferred', 3000, 'sim-v1'),
      entry(claim({ relationship: 'same_formulation_as', claim_id: 'i3' }), 'inferred', 3000, 'sim-v1'),
    ])
    expect(result.edges[0]?.confidenceBp).toBe(3000)
  })

  it('refuses an inference with no model version', () => {
    // §10.7 requires inferences to stay LABELLED and VERSIONED. An unversioned
    // one cannot be re-evaluated when the model changes.
    const result = projectRelationships([
      entry(claim({ relationship: 'same_formulation_as' }), 'inferred', 3000),
    ])
    expect(result.edges).toHaveLength(0)
    expect(result.rejected[0]?.reason).toContain('model version')
  })

  it('refuses an operator relationship pointing at a product, and the inverse', () => {
    // A product "manufactured by" ANOTHER PRODUCT would compose manufacturer
    // standing along an edge that means nothing.
    const backwards = projectRelationships([
      entry(claim({ relationship: 'manufactured_by', object: CHAIR_2 }), 'first_party_claim'),
    ])
    expect(backwards.edges).toHaveLength(0)
    expect(backwards.rejected[0]?.reason).toContain('must carry a did')

    const inverse = projectRelationships([
      entry(claim({ relationship: 'variant_of', object: { did: MAKER } }), 'first_party_claim'),
    ])
    expect(inverse.edges).toHaveLength(0)
    expect(inverse.rejected[0]?.reason).toContain('must be a product')
  })

  it('reports what it refused rather than dropping it', () => {
    // A claim silently ignored looks the same as one nobody made.
    const result = projectRelationships([
      entry(claim({ relationship: 'variant_of', claim_id: 'good' }), 'first_party_claim'),
      entry(
        claim({ relationship: 'manufactured_by', claim_id: 'bad', object: CHAIR_2 }),
        'first_party_claim',
      ),
    ])
    expect(result.edges).toHaveLength(1)
    expect(result.rejected).toEqual([
      {
        claimId: 'bad',
        reason: '"manufactured_by" relates a product to an operator — object must carry a did',
      },
    ])
  })
})

describe('disagreement is data, not a tiebreak (§10.7)', () => {
  it('marks a lineage two parties disagree about, and keeps both claims', () => {
    const result = projectRelationships([
      entry(claim({ relationship: 'variant_of', claim_id: 'p1', object: CHAIR_2 }), 'first_party_claim'),
      entry(
        claim({ relationship: 'variant_of', claim_id: 'p2', object: CHAIR_3, issuer_did: RIVAL }),
        'third_party_claim',
      ),
    ])
    expect(result.edges).toHaveLength(1)
    const edge = result.edges[0]!
    expect(edge.disputed).toBe(true)
    // BOTH survive. An edge in dispute is not an edge with the loser deleted,
    // and choosing the higher-confidence parent here is the silent merge
    // §10.7 forbids.
    expect(edge.evidence).toHaveLength(2)
    expect(edge.objectKey).toBe(productKey(CHAIR_2))
  })

  it('does not treat many-to-many relationships as conflicting', () => {
    // A product can replace several others; two `replaces` claims are two
    // facts, not a disagreement.
    const result = projectRelationships([
      entry(claim({ relationship: 'replaces', claim_id: 'r1', object: CHAIR_2 }), 'first_party_claim'),
      entry(claim({ relationship: 'replaces', claim_id: 'r2', object: CHAIR_3 }), 'first_party_claim'),
    ])
    expect(result.edges).toHaveLength(2)
    expect(result.edges.every((e) => !e.disputed)).toBe(true)
  })
})

describe('what an edge permits', () => {
  function edgeFrom(entries: Parameters<typeof projectRelationships>[0]) {
    const { edges } = projectRelationships(entries)
    const edge = edges[0]
    if (edge === undefined) throw new Error('expected an edge')
    return edge
  }

  it('shows a low-confidence inference as related, and nothing more', () => {
    // Lower-confidence semantic relationships may improve RECALL. They may not
    // move standing or authorize a substitution.
    const edge = edgeFrom([
      entry(claim({ relationship: 'same_formulation_as' }), 'inferred', 4000, 'sim-v1'),
    ])
    expect(mayShowAsRelated(edge)).toBe(true)
    expect(mayInheritStanding(edge)).toBe(false)
    expect(mayAuthorizeSubstitution(edge)).toBe(false)
  })

  it('refuses to inherit standing along a disputed edge at any confidence', () => {
    // The disagreement is precisely the signal that one product's reputation
    // should not land on another's page.
    const edge = edgeFrom([
      entry(claim({ relationship: 'variant_of', claim_id: 'p1', object: CHAIR_2 }), 'first_party_claim', 9900),
      entry(claim({ relationship: 'variant_of', claim_id: 'p2', object: CHAIR_3 }), 'first_party_claim', 9900),
    ])
    expect(edge.disputed).toBe(true)
    expect(mayInheritStanding(edge)).toBe(false)
  })

  it('inherits standing along an undisputed first-party edge', () => {
    const edge = edgeFrom([entry(claim({ relationship: 'variant_of' }), 'first_party_claim')])
    expect(mayInheritStanding(edge)).toBe(true)
  })

  it('never inherits standing from inference alone, even on a hand-built edge', () => {
    // The cap in `claimConfidenceBp` is the first guard; this is the second,
    // so a future caller constructing an edge directly cannot route around it.
    const edge = {
      ...edgeFrom([entry(claim({ relationship: 'variant_of' }), 'inferred', 3000, 'sim-v1')]),
      confidenceBp: 9999,
    }
    expect(mayInheritStanding(edge)).toBe(false)
  })

  it('authorizes substitution only on a first-party formulation or replacement claim', () => {
    const substitutable = edgeFrom([
      entry(claim({ relationship: 'same_formulation_as' }), 'first_party_claim', 9500),
    ])
    expect(mayAuthorizeSubstitution(substitutable)).toBe(true)

    // Being a VARIANT of something is not permission to send it instead: a
    // packaging variant is a different quantity, and a formulation variant is
    // a different product to whoever has to use it.
    const variant = edgeFrom([entry(claim({ relationship: 'variant_of' }), 'first_party_claim', 10000)])
    expect(mayAuthorizeSubstitution(variant)).toBe(false)

    // A third party cannot authorize a substitution on someone else's order.
    const thirdParty = edgeFrom([
      entry(claim({ relationship: 'replaces' }), 'third_party_claim', 10000),
    ])
    expect(mayAuthorizeSubstitution(thirdParty)).toBe(false)
  })
})
