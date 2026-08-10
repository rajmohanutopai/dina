/**
 * xRPC: com.dinakernel.commerce.getSupplierDimensions (§14.4, WS-10.1/10.2).
 *
 * WHAT THIS CLOSES. `review-dimensions.ts` held the whole §14.4 projection —
 * the closed vocabulary, the model-extraction cap, the reviewer-confirmed
 * floor, the commercial-terms scan — and had NO consumer anywhere in AppView.
 * A derivation nothing calls is the defect class this codebase keeps
 * producing: correct, tested, and unreachable. WBS 10.1 stated it plainly
 * ("nothing consumes it yet") and 10.2 carried the same silence.
 *
 * WHAT A BUYER ASKS. Not "is this supplier good" — a number a buyer cannot
 * interrogate is the thing PeerLens exists to replace. They ask what reviewers
 * said, along which dimension, and how much of it a person actually confirmed.
 * So the answer is per-dimension, each carrying its own provenance and its own
 * `mayAffectStandingAlone`, and the caller does the weighing.
 *
 * WHERE THE WEIGHTING IS NOT. This endpoint deliberately computes no score.
 * §10.6's argument is that an extractor's confidence and a trust weight
 * tunable in one place is the coupling to avoid, so the projection reports and
 * the ranking lives elsewhere. An endpoint that returned one blended number
 * would put both dials in one hand.
 *
 * REFUSALS TRAVEL. A dimension outside §14.4's vocabulary, one missing a field
 * the projection must retain, or one carrying an exact commercial term the
 * owner never published, is dropped AND reported. An index that silently
 * discarded them would look identical to one with nothing to say.
 */

import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'

import { attestations } from '@/db/schema/attestations.js'
import { subjects } from '@/db/schema/subjects.js'
import {
  projectReviewDimensions,
  strongestPerDimension,
  type DimensionClaim,
  type DimensionFinding,
  type ProjectedDimension,
} from '@/shared/commerce/review-dimensions.js'

import type { DrizzleDB } from '@/db/connection.js'

export const CommerceSupplierDimensionsParams = z.object({
  /** The supplier being asked about. */
  supplier: z.string().min(1),
  /**
   * Cap on reviews READ, not on dimensions returned.
   *
   * Bounded because a supplier with ten thousand reviews must not turn one
   * question into a scan; named as a read cap because a caller who sees three
   * dimensions from a limit of ten has not been told about the rest.
   */
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export type CommerceSupplierDimensionsParamsType = z.infer<
  typeof CommerceSupplierDimensionsParams
>

export interface CommerceSupplierDimensionsResponse {
  supplier_did: string
  /** The strongest claim per dimension, each with its own provenance. */
  dimensions: ProjectedDimension[]
  /** Every projected claim, so a caller can see the spread behind the winner. */
  all: ProjectedDimension[]
  /** Claims §14.4 refused, named so an operator can see an index degrade. */
  findings: DimensionFinding[]
  /** Reviews read. Beside the answer, so a truncated read is legible. */
  reviews_examined: number
}

/**
 * One attestation row, as a §14.4 claim.
 *
 * PROVENANCE IS DERIVED FROM THE ROW, never asserted by the caller. An
 * attestation this AppView indexed from a signed record is
 * `reviewer_confirmed` only where the reviewer themselves stated the
 * dimension; anything this index inferred is `model_extracted` and carries the
 * cap. Today AppView performs no extraction of its own, so every claim here is
 * the reviewer's own category — which is why `extractorId` names this index
 * and the version is pinned: a later extraction pass must be distinguishable
 * from what a person wrote.
 */
const EXTRACTOR_ID = 'com.dinakernel.appview.attestation-category'
const EXTRACTOR_VERSION = '1'

function toClaim(row: {
  uri: string
  subjectDid: string | null
  category: string
  sentiment: string
  searchContent: string | null
}): DimensionClaim {
  return {
    dimension: row.category,
    // The reviewer chose this category when they published. It is their word,
    // not this index's inference, so it is confirmed and uncapped.
    source: 'reviewer_confirmed',
    confidenceBp: 10000,
    sentiment:
      row.sentiment === 'positive' || row.sentiment === 'negative' ? row.sentiment : 'neutral',
    sourceReviewUri: row.uri,
    targetNode: row.subjectDid ?? '',
    // Directly about the supplier. A path arrives only through the §10.3
    // relationship resolver, which is a different question than this one.
    relationshipPath: [],
    // 'direct' — written about this exact subject. The inherited and
    // brand/seller provenances arrive only through the §10.3 relationship
    // resolver, which answers a different question than this endpoint.
    provenance: 'direct',
    extractorId: EXTRACTOR_ID,
    extractorVersion: EXTRACTOR_VERSION,
    ...(row.searchContent === null ? {} : { evidenceText: row.searchContent }),
  }
}

export async function getSupplierDimensions(
  db: DrizzleDB,
  params: CommerceSupplierDimensionsParamsType,
): Promise<CommerceSupplierDimensionsResponse> {
  // JOINED THROUGH `subjects`, because an attestation names a subject ROW and
  // the DID lives on that row. Reading `attestations.subject_id` as though it
  // were a DID would answer about whatever subject happened to share the
  // string — the §9.4 identity mistake, one table over.
  const rows = await db
    .select({
      uri: attestations.uri,
      subjectDid: subjects.did,
      category: attestations.category,
      sentiment: attestations.sentiment,
      searchContent: attestations.searchContent,
    })
    .from(attestations)
    .innerJoin(subjects, eq(attestations.subjectId, subjects.id))
    .where(and(eq(subjects.did, params.supplier)))
    .orderBy(desc(attestations.uri))
    .limit(params.limit)

  const projected = projectReviewDimensions(rows.map(toClaim))

  return {
    supplier_did: params.supplier,
    dimensions: strongestPerDimension(projected.dimensions),
    all: projected.dimensions,
    findings: projected.findings,
    reviews_examined: rows.length,
  }
}
