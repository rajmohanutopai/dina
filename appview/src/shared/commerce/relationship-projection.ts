import { productKey, type ProductRef } from './catalog-projection.js'

/**
 * The product relationship graph — a SECOND projection, never a merge
 * (§10.7, FR-A8, FR-A10).
 *
 * THE ONE SENTENCE THIS MODULE EXISTS TO ENFORCE: the relationship graph is a
 * projection OVER the exact-variant index, not a destructive deduplication
 * pass across it. Exact variants stay separate documents forever. An edge says
 * "these two are related, here is who said so and how strongly"; it never says
 * "these two are the same".
 *
 * WHY THAT MATTERS MORE THAN IT SOUNDS. A merge is irreversible in practice:
 * once two identities are one row, the reviews, the order history and the
 * lineage of both are indistinguishable, and no later evidence can separate
 * them again. §10.7 lists what a similarity score alone may NOT do — merge
 * identities, authorize substitution, move or delete a review, erase lineage,
 * or make one node's standing count as exact-variant standing on another — and
 * every one of those is a consequence of merging rather than projecting.
 *
 * THREE THRESHOLDS, DELIBERATELY ORDERED. Showing "possibly related" is
 * cheaper than inheriting standing, which is cheaper than authorizing a
 * substitution in an order. The ordering is asserted in code because a single
 * confidence number with three call sites would eventually be compared against
 * whichever constant was nearest.
 *
 * DISAGREEMENT IS DATA. §10.7: plural AppViews may disagree, and Dina exposes
 * material grouping disagreement rather than silently choosing whichever merge
 * scores highest. So conflicting claims are KEPT, both of them, and the edge
 * is marked — an edge in dispute is not an edge with the loser deleted.
 */

/** Relationships whose object is an operator DID rather than a product. */
const DID_OBJECT_RELATIONSHIPS: ReadonlySet<string> = new Set([
  'manufactured_by',
  'marketed_under',
  'sold_by',
])

export type ProductRelationship =
  | 'manufactured_by'
  | 'marketed_under'
  | 'variant_of'
  | 'packaging_variant_of'
  | 'same_formulation_as'
  | 'replaces'
  | 'sold_by'

export interface RelationshipClaimShape {
  claim_id: string
  subject: ProductRef
  relationship: ProductRelationship
  object: ProductRef | { did: string }
  issuer_did: string
  effective_from?: string
  effective_until?: string
  evidence_refs?: string[]
}

/**
 * How an edge came to be believed. §10.7 requires AI suggestions to stay
 * LABELLED and VERSIONED inferences until stronger evidence supports them, so
 * the source is part of the edge rather than a property of the pipeline that
 * produced it.
 */
export type EdgeSource =
  /** Asserted by the party whose identity the claim is about. */
  | 'first_party_claim'
  /** Asserted by someone else — a distributor, a marketplace, a buyer. */
  | 'third_party_claim'
  /** Suggested by a model. Never sufficient on its own for anything. */
  | 'inferred'

export interface RelationshipEvidence {
  claimId: string
  issuerDid: string
  source: EdgeSource
  /** Confidence in basis points, 0–10000. Integer, like every other score. */
  confidenceBp: number
  /** The model + version that produced an `inferred` edge; null otherwise. */
  inferenceVersion: string | null
  assertedAt: string
  effectiveFrom: string | null
  effectiveUntil: string | null
  evidenceRefs: string[]
}

export interface RelationshipEdge {
  /**
   * Subject + relationship, plus the object only when the relationship is
   * many-to-many. Returned rather than recomputed by callers: it is the row
   * key a store uses, and two spellings of it would eventually disagree about
   * which claims belong to which edge.
   */
  edgeKey: string
  subjectKey: string
  relationship: ProductRelationship
  /** Product key, or `did:…` when the object is an operator. */
  objectKey: string
  /** Every claim behind this edge, kept whole (FR-A8). */
  evidence: RelationshipEvidence[]
  /** The strongest confidence any single claim carries. */
  confidenceBp: number
  /**
   * True when claims about the SAME subject and relationship name different
   * objects for a relationship that can only have one. Not a failure — a fact
   * to expose (§10.7).
   */
  disputed: boolean
}

/**
 * The three thresholds, in the order §10.7 states them.
 *
 * They are separate constants rather than one number with three comparisons
 * because they answer three different questions, and a single "confidence"
 * would drift toward whichever call site was edited last.
 */
export const SHOW_AS_RELATED_BP = 3000
export const INHERIT_STANDING_BP = 6000
export const AUTHORIZE_SUBSTITUTION_BP = 9000

/**
 * Relationships that name at most ONE object per subject.
 *
 * `variant_of` and `packaging_variant_of` describe a parent, and a product has
 * one parent; two claims naming different parents is a genuine disagreement
 * about lineage. `same_formulation_as` and `replaces` are many-to-many — a
 * product can replace several — so two of those are not in conflict.
 */
const SINGLE_OBJECT_RELATIONSHIPS: ReadonlySet<ProductRelationship> = new Set([
  'variant_of',
  'packaging_variant_of',
  'manufactured_by',
])

function objectKey(object: ProductRef | { did: string }): string {
  return 'did' in object ? `did:${object.did}` : productKey(object)
}

/** Confidence a claim carries before any threshold is applied. */
export function claimConfidenceBp(source: EdgeSource, declaredBp?: number): number {
  if (source === 'inferred') {
    // An inference is CAPPED below the standing threshold whatever the model
    // reports. §10.7: a similarity score alone cannot make one node's standing
    // count as exact-variant standing on another, and the cheapest way to
    // guarantee that is to make the arithmetic incapable of it.
    return Math.min(declaredBp ?? SHOW_AS_RELATED_BP, INHERIT_STANDING_BP - 1)
  }
  if (source === 'first_party_claim') return declaredBp ?? 9500
  return declaredBp ?? 6500
}

export interface ProjectedRelationships {
  edges: RelationshipEdge[]
  /**
   * Claims that were read and NOT projected, with the reason. Reported rather
   * than dropped: a claim silently ignored looks the same as one nobody made.
   */
  rejected: { claimId: string; reason: string }[]
}

/**
 * Project claims into edges.
 *
 * Claims are assumed to have passed the wire validator already — the
 * discriminant between DID-object and product-object relationships is checked
 * again here because this projection composes standing along those edges, and
 * a `manufactured_by` pointing at a PRODUCT would compose manufacturer
 * reputation along an edge that means nothing.
 */
export function projectRelationships(
  claims: readonly { claim: RelationshipClaimShape; source: EdgeSource; confidenceBp?: number; inferenceVersion?: string; assertedAt: string }[],
): ProjectedRelationships {
  const byEdge = new Map<string, RelationshipEdge>()
  const rejected: { claimId: string; reason: string }[] = []

  for (const entry of claims) {
    const { claim } = entry
    const objectIsDid = 'did' in claim.object
    if (objectIsDid !== DID_OBJECT_RELATIONSHIPS.has(claim.relationship)) {
      rejected.push({
        claimId: claim.claim_id,
        reason: objectIsDid
          ? `"${claim.relationship}" relates products — object must be a product`
          : `"${claim.relationship}" relates a product to an operator — object must carry a did`,
      })
      continue
    }
    if (entry.source === 'inferred' && (entry.inferenceVersion ?? '') === '') {
      // §10.7 requires inferences to stay LABELLED and VERSIONED. An
      // unversioned one cannot be re-evaluated when the model changes, so it
      // is not an inference anybody can reason about later.
      rejected.push({ claimId: claim.claim_id, reason: 'an inferred edge must name its model version' })
      continue
    }

    const subjectKey = productKey(claim.subject)
    const objKey = objectKey(claim.object)
    // The edge is keyed WITHOUT the object for single-object relationships, so
    // two claims naming different parents land on the same edge and become a
    // visible dispute rather than two confident, contradictory edges.
    const single = SINGLE_OBJECT_RELATIONSHIPS.has(claim.relationship)
    const key = single
      ? `${subjectKey} ${claim.relationship}`
      : `${subjectKey} ${claim.relationship} ${objKey}`

    const evidence: RelationshipEvidence = {
      claimId: claim.claim_id,
      issuerDid: claim.issuer_did,
      source: entry.source,
      confidenceBp: claimConfidenceBp(entry.source, entry.confidenceBp),
      inferenceVersion: entry.inferenceVersion ?? null,
      assertedAt: entry.assertedAt,
      effectiveFrom: claim.effective_from ?? null,
      effectiveUntil: claim.effective_until ?? null,
      evidenceRefs: [...(claim.evidence_refs ?? [])],
    }

    const existing = byEdge.get(key)
    if (existing === undefined) {
      byEdge.set(key, {
        edgeKey: key,
        subjectKey,
        relationship: claim.relationship,
        objectKey: objKey,
        evidence: [evidence],
        confidenceBp: evidence.confidenceBp,
        disputed: false,
      })
      continue
    }

    existing.evidence.push(evidence)
    // The edge's confidence is the STRONGEST single claim, not a sum: three
    // weak inferences agreeing is still three weak inferences, and adding them
    // would let a model vote its way past a threshold it must never reach.
    existing.confidenceBp = Math.max(existing.confidenceBp, evidence.confidenceBp)
    if (single && existing.objectKey !== objKey) {
      existing.disputed = true
      // The edge keeps the FIRST object it saw as its nominal one, and both
      // claims stay in the evidence. Choosing the higher-confidence object
      // here would be exactly the silent merge §10.7 forbids.
    }
  }

  return { edges: [...byEdge.values()], rejected }
}

/**
 * May this edge be shown to a buyer as "possibly related"?
 *
 * The lowest bar, and still a bar: an edge below it is noise that would make
 * every product look adjacent to every other.
 */
export function mayShowAsRelated(edge: RelationshipEdge): boolean {
  return edge.confidenceBp >= SHOW_AS_RELATED_BP
}

/**
 * May standing inherit along this edge?
 *
 * A DISPUTED edge never qualifies, whatever its confidence. Inheriting
 * standing along a lineage two parties disagree about is how one product's
 * reputation lands on another's page, and the disagreement is precisely the
 * signal that it should not.
 */
export function mayInheritStanding(edge: RelationshipEdge): boolean {
  if (edge.disputed) return false
  if (edge.confidenceBp < INHERIT_STANDING_BP) return false
  // An inference alone can never carry standing, even at a reported 10000bp:
  // `claimConfidenceBp` caps it below this threshold, and this second check
  // means a future caller constructing an edge by hand cannot route around it.
  return edge.evidence.some((e) => e.source !== 'inferred' && e.confidenceBp >= INHERIT_STANDING_BP)
}

/**
 * May a supplier substitute the object for the subject in an ORDER?
 *
 * The highest bar, and the only one whose answer moves money. A dispute or an
 * inference disqualifies outright.
 */
export function mayAuthorizeSubstitution(edge: RelationshipEdge): boolean {
  if (edge.disputed) return false
  if (edge.relationship !== 'same_formulation_as' && edge.relationship !== 'replaces') {
    // Being a VARIANT of something is not permission to send it instead. A
    // packaging variant is a different quantity; a formulation variant is a
    // different product to whoever has to use it.
    return false
  }
  return edge.evidence.some(
    (e) => e.source === 'first_party_claim' && e.confidenceBp >= AUTHORIZE_SUBSTITUTION_BP,
  )
}
