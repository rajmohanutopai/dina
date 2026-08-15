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
const EXTRACTOR_ID = 'com.dinakernel.appview.attestation-dimensions'
const EXTRACTOR_VERSION = '2'

/**
 * A reviewer's per-dimension verdict, as the lexicon carries it.
 *
 * `dimensionRatingSchema` in `record-validator.ts`: `{dimension, value, note?}`
 * with `value` one of `exceeded | met | below | failed`.
 */
interface DimensionRating {
  dimension?: unknown
  value?: unknown
}

/**
 * §14.4 sentiment from a §14.4 verdict.
 *
 * `met` reads POSITIVE, not neutral: the reviewer is affirming the supplier
 * did what they promised on that dimension, which is a judgement rather than
 * an absence of one. Neutral is reserved for a verdict this index cannot
 * interpret — and a rating carrying no recognisable verdict produces no claim
 * at all rather than a neutral one, because inventing a neutral opinion the
 * reviewer never expressed is the same fabrication as inventing a positive one.
 */
function sentimentOf(value: unknown): 'positive' | 'neutral' | 'negative' | null {
  switch (value) {
    case 'exceeded':
    case 'met':
      return 'positive'
    case 'below':
    case 'failed':
      return 'negative'
    default:
      return null
  }
}

/**
 * The reviewer's OWN per-dimension ratings, turned into §14.4 claims.
 *
 * WHAT THIS REPLACES, because the previous version was wrong in a way that
 * passed its tests. It read `dimension: row.category` — the attestation's
 * SUBJECT CATEGORY (`z.string().min(1).max(200)`, holding values like
 * `commerce/product`) — and offered it as a §14.4 review dimension, which is a
 * CLOSED set of six. On real published reviews every claim fell out as
 * `unknown_dimension`, so the endpoint returned an empty `dimensions` list and
 * a refusal per review. The integration tests seeded `category: 'fulfilment'`,
 * so the suite was green while the endpoint was dead.
 *
 * The reviewer's actual per-dimension verdicts were in `dimensions_json` the
 * whole time — written by the ingester, and already read correctly by the
 * scorer's sentiment aggregation one directory away. This reads the same
 * column. `category` returns to being context, not an answer.
 *
 * One review yields one claim PER RATING, so a reviewer who rated packaging
 * and fulfilment separately is not collapsed into a single verdict.
 */
function toClaims(row: {
  uri: string
  subjectDid: string | null
  sentiment: string
  dimensionsJson: unknown
}): DimensionClaim[] {
  if (!Array.isArray(row.dimensionsJson)) return []

  const claims: DimensionClaim[] = []
  for (const raw of row.dimensionsJson as DimensionRating[]) {
    if (raw === null || typeof raw !== 'object') continue
    const name = typeof raw.dimension === 'string' ? raw.dimension.trim().toLowerCase() : ''
    if (name === '') continue

    // Per-dimension verdict first; the record-level sentiment is the fallback
    // for a rating that names a dimension without scoring it.
    const perDimension = sentimentOf(raw.value)
    const sentiment =
      perDimension ??
      (row.sentiment === 'positive' || row.sentiment === 'negative' ? row.sentiment : 'neutral')

    claims.push({
      // NOT normalised into the §14.4 set here. `projectReviewDimensions`
      // owns that vocabulary and refuses `unknown_dimension` with a finding an
      // operator can see; silently mapping a near-miss would hide a publisher
      // using a dimension name this index does not honour.
      dimension: name,
      // The reviewer scored this dimension themselves when they published. It
      // is their word, not this index's inference, so it is confirmed.
      source: 'reviewer_confirmed',
      confidenceBp: 10000,
      sentiment,
      sourceReviewUri: row.uri,
      targetNode: row.subjectDid ?? '',
      // Directly about the supplier. A path arrives only through the §10.3
      // relationship resolver, which answers a different question.
      relationshipPath: [],
      provenance: 'direct',
      extractorId: EXTRACTOR_ID,
      extractorVersion: EXTRACTOR_VERSION,
      // NO `evidenceText`. `ProjectedDimension` has no field to carry it, so
      // nothing was ever published from it — while supplying it ran the
      // commercial-terms scan, which REFUSES THE WHOLE CLAIM when the review
      // text mentions a price. That dropped legitimate dimensions from the
      // projection and filed a privacy-shaped finding, for a disclosure that
      // could not occur.
    })
  }
  return claims
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
      sentiment: attestations.sentiment,
      // The reviewer's per-dimension verdicts. `category` is deliberately NOT
      // selected any more: it is the subject's category, never a §14.4
      // dimension, and reading it as one is what made this endpoint answer
      // nothing on real data.
      dimensionsJson: attestations.dimensionsJson,
    })
    .from(attestations)
    .innerJoin(subjects, eq(attestations.subjectId, subjects.id))
    .where(and(eq(subjects.did, params.supplier)))
    .orderBy(desc(attestations.uri))
    .limit(params.limit)

  // flatMap, because one review carries as many verdicts as the reviewer chose
  // to give. The previous shape was one-claim-per-review, which could not have
  // represented a reviewer who rated packaging and fulfilment differently even
  // if it had been reading the right column.
  const projected = projectReviewDimensions(rows.flatMap(toClaims))

  return {
    supplier_did: params.supplier,
    dimensions: strongestPerDimension(projected.dimensions),
    all: projected.dimensions,
    findings: projected.findings,
    reviews_examined: rows.length,
  }
}
