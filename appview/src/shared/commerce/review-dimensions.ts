/**
 * §14.4 — review-dimension projection, with provenance and weight.
 *
 * WHAT THE SPEC ACTUALLY CONSTRAINS, and why each rule is here.
 *
 * A signed review is the primary evidence. Anything derived from it — "this
 * mentions packaging", "this is about delivery" — is a PROJECTION, and §14.4
 * gives projections four obligations that are easy to state and easy to lose:
 *
 *   1. They retain extractor, version, confidence, source review, target node
 *      and relationship path. A dimension nobody can trace back is an opinion
 *      the index is publishing in its own name.
 *   2. They do NOT modify the signed review. Nothing here mutates its input.
 *   3. Reviewer-CONFIRMED structured scope outweighs an unconfirmed model
 *      extraction.
 *   4. Opaque AI classification alone must not create a large public standing
 *      penalty.
 *
 * (3) and (4) are the pair that matters. Without them a model that decides a
 * supplier's packaging is bad can move that supplier's public standing as
 * hard as a customer who said so — and the customer can be argued with.
 *
 * AND ONE THING §14.4 FORBIDS OUTRIGHT. Exact commercial terms stay private
 * unless the owner deliberately publishes them. A derived dimension is public
 * by construction, so a dimension carrying a price, a total or a quote
 * reference is REFUSED here rather than trimmed: trimming leaves the shape of
 * the number behind, and "roughly what they paid" is the disclosure the rule
 * exists to prevent.
 *
 * THE MODULE DERIVES; IT DOES NOT SCORE A SUPPLIER. Turning dimensions into
 * standing is PeerLens's job against its own policy. Doing both here would let
 * an extractor's confidence and a trust weight be tuned in one place, which is
 * exactly the coupling §10.6 warns about.
 */

/** Where a review sits relative to the thing being looked at (§14.4 UI list). */
export type DimensionProvenance =
  /** Written about this exact variant. */
  | 'direct'
  /** Inherited from the same formulation or family (§10.7 edge). */
  | 'inherited_family'
  /** About the manufacturer or brand rather than this product. */
  | 'brand_history'
  /** About the seller's fulfilment rather than the goods. */
  | 'seller_history'
  /** Reached through a relationship two parties disagree about. */
  | 'disputed_relationship';

/** The §14.4 dimension vocabulary. CLOSED, so a projection cannot invent one. */
export type ReviewDimension =
  | 'product_quality'
  | 'packaging'
  | 'batch_freshness'
  | 'fulfilment'
  | 'terms_held'
  | 'customer_service';

const DIMENSIONS: ReadonlySet<string> = new Set<ReviewDimension>([
  'product_quality',
  'packaging',
  'batch_freshness',
  'fulfilment',
  'terms_held',
  'customer_service',
]);

/**
 * How a dimension came to exist.
 *
 * `reviewer_confirmed` means the person who wrote the review said so in
 * structured form. `model_extracted` means software decided. §14.4 ranks them
 * and this type is what makes the ranking expressible.
 */
export type DimensionSource = 'reviewer_confirmed' | 'model_extracted';

/** A candidate dimension, before this module has judged it. */
export interface DimensionClaim {
  dimension: string;
  source: DimensionSource;
  /** 0..10000. What the extractor reported, before any cap. */
  confidenceBp: number;
  /** Positive, neutral or negative about the dimension. */
  sentiment: 'positive' | 'neutral' | 'negative';
  /** The signed review this was derived FROM. Never rewritten. */
  sourceReviewUri: string;
  /** The node the dimension is about. */
  targetNode: string;
  /** How the review reaches the target: [] when it is directly about it. */
  relationshipPath: string[];
  provenance: DimensionProvenance;
  /** Extractor identity — required, including for a confirmed scope. */
  extractorId: string;
  extractorVersion: string;
  /**
   * Free text the extractor believes supports the dimension.
   *
   * Checked for commercial terms before it can be published. Absent is fine;
   * a dimension does not need a quote to be legible.
   */
  evidenceText?: string;
}

export type DimensionRefusal =
  /** Not in §14.4's vocabulary. */
  | 'unknown_dimension'
  /** Missing a field §14.4 requires a projection to retain. */
  | 'untraceable'
  /** Confidence outside 0..10000, or not an integer. */
  | 'confidence_out_of_range'
  /** Carries an exact commercial term the owner has not published. */
  | 'commercial_terms_leak';

export interface ProjectedDimension {
  dimension: ReviewDimension;
  source: DimensionSource;
  /** After §14.4's cap. Never above what the extractor reported. */
  confidenceBp: number;
  sentiment: 'positive' | 'neutral' | 'negative';
  sourceReviewUri: string;
  targetNode: string;
  relationshipPath: string[];
  provenance: DimensionProvenance;
  extractorId: string;
  extractorVersion: string;
  /**
   * May this dimension move public standing on its own?
   *
   * False for every unconfirmed extraction — §14.4's "opaque AI classification
   * alone must not create a large public standing penalty". Such a dimension
   * is still SHOWN, because hiding it would lose recall; it simply cannot be
   * the reason a supplier's number moves.
   */
  mayAffectStandingAlone: boolean;
}

export interface DimensionFinding {
  refusal: DimensionRefusal;
  dimension: string;
  detail: string;
}

/**
 * The ceiling on an unconfirmed model extraction (§14.4).
 *
 * A NUMBER RATHER THAN A FLAG, because "cannot create a LARGE penalty" is a
 * matter of degree: a model may contribute, and may not dominate. The cap sits
 * below the reviewer-confirmed floor so no amount of model confidence ever
 * outranks a person who said the same thing.
 */
export const MODEL_EXTRACTION_CAP_BP = 4000;

/** At or above this, a dimension may move standing on its own. */
export const STANDING_FLOOR_BP = 6000;

/**
 * Patterns that mean "this text carries an exact commercial term".
 *
 * DELIBERATELY BROAD on the money side and narrow elsewhere. A false refusal
 * costs one dimension; a false pass publishes what a buyer paid, which §14.4
 * says stays private and which cannot be un-published.
 */
const COMMERCIAL_TERM_PATTERNS: readonly RegExp[] = [
  // A currency symbol or ISO code next to a number.
  /(?:[$€£¥₹]|\b(?:USD|EUR|GBP|INR|JPY|AUD|CAD)\b)\s*[\d,]+(?:\.\d+)?/i,
  /[\d,]+(?:\.\d+)?\s*(?:USD|EUR|GBP|INR|JPY|AUD|CAD)\b/i,
  // Our own identifiers for a priced artefact.
  /\bquote[_-]?id\b/i,
  /\bpurchase[_-]?order[_-]?id\b/i,
  /\bunit[_-]?price\b/i,
  /\bapproved[_-]?total\b/i,
  /\bminor[_-]?units\b/i,
];

function carriesCommercialTerms(text: string): boolean {
  return COMMERCIAL_TERM_PATTERNS.some((re) => re.test(text));
}

/**
 * Project one claim, or say why it cannot be published.
 *
 * A UNION rather than a nullable, because every refusal here is something an
 * operator may need to act on: an unknown dimension is a version skew, an
 * untraceable one is an extractor bug, and a commercial-terms leak is a
 * privacy incident in waiting.
 */
export function projectDimension(
  claim: DimensionClaim,
  options: { ownerPublishedTerms?: boolean } = {},
): { ok: true; dimension: ProjectedDimension } | { ok: false; finding: DimensionFinding } {
  const refuse = (refusal: DimensionRefusal, detail: string) => ({
    ok: false as const,
    finding: { refusal, dimension: claim.dimension, detail },
  });

  if (!DIMENSIONS.has(claim.dimension)) {
    return refuse('unknown_dimension', 'not a §14.4 review dimension');
  }
  // TRACEABILITY IS NOT OPTIONAL, and it applies to a reviewer-confirmed scope
  // too: "the reviewer said so" still has to name which review.
  for (const [field, value] of [
    ['sourceReviewUri', claim.sourceReviewUri],
    ['targetNode', claim.targetNode],
    ['extractorId', claim.extractorId],
    ['extractorVersion', claim.extractorVersion],
  ] as const) {
    if (value === '') return refuse('untraceable', `${field} is required (§14.4)`);
  }
  if (
    !Number.isInteger(claim.confidenceBp) ||
    claim.confidenceBp < 0 ||
    claim.confidenceBp > 10000
  ) {
    return refuse('confidence_out_of_range', 'confidence must be an integer 0..10000');
  }
  if (
    options.ownerPublishedTerms !== true &&
    claim.evidenceText !== undefined &&
    carriesCommercialTerms(claim.evidenceText)
  ) {
    // The FIELD is named, never the value — echoing the price into a finding
    // turns one leak into two, the same rule the catalog leakage gate follows.
    return refuse('commercial_terms_leak', 'evidenceText carries an exact commercial term');
  }

  // §14.4: an unconfirmed extraction is capped, and the cap is arithmetic
  // rather than advisory so a caller cannot opt out of it.
  const confidenceBp =
    claim.source === 'model_extracted'
      ? Math.min(claim.confidenceBp, MODEL_EXTRACTION_CAP_BP)
      : claim.confidenceBp;

  return {
    ok: true,
    dimension: {
      dimension: claim.dimension as ReviewDimension,
      source: claim.source,
      confidenceBp,
      sentiment: claim.sentiment,
      sourceReviewUri: claim.sourceReviewUri,
      targetNode: claim.targetNode,
      relationshipPath: [...claim.relationshipPath],
      provenance: claim.provenance,
      extractorId: claim.extractorId,
      extractorVersion: claim.extractorVersion,
      // Checked against the SOURCE again, not only the number. A future caller
      // constructing a dimension by hand cannot route around the cap by
      // reporting a high confidence on a model extraction.
      mayAffectStandingAlone:
        claim.source === 'reviewer_confirmed' &&
        confidenceBp >= STANDING_FLOOR_BP &&
        claim.provenance !== 'disputed_relationship',
    },
  };
}

/**
 * Project a review's claims, keeping the refusals beside the results.
 *
 * BOTH HALVES TRAVEL. A projection that silently dropped what it could not
 * publish would make an extractor bug indistinguishable from a review that
 * said nothing.
 */
export function projectReviewDimensions(
  claims: readonly DimensionClaim[],
  options: { ownerPublishedTerms?: boolean } = {},
): { dimensions: ProjectedDimension[]; findings: DimensionFinding[] } {
  const dimensions: ProjectedDimension[] = [];
  const findings: DimensionFinding[] = [];
  for (const claim of claims) {
    const out = projectDimension(claim, options);
    if (out.ok) dimensions.push(out.dimension);
    else findings.push(out.finding);
  }
  return { dimensions, findings };
}

/**
 * The strongest claim per dimension, for a display that shows one line each.
 *
 * STRONGEST, NEVER SUMMED — the same rule the relationship projection follows.
 * Three model extractions agreeing is still three model extractions, and
 * adding them would let volume manufacture standing. A reviewer-confirmed
 * dimension always outranks a model one whatever the numbers say, because
 * §14.4 ranks the SOURCES and not just their confidence.
 */
export function strongestPerDimension(
  dimensions: readonly ProjectedDimension[],
): ProjectedDimension[] {
  const best = new Map<ReviewDimension, ProjectedDimension>();
  for (const d of dimensions) {
    const held = best.get(d.dimension);
    if (held === undefined || outranks(d, held)) best.set(d.dimension, d);
  }
  return [...best.values()].sort((a, b) => a.dimension.localeCompare(b.dimension));
}

function outranks(candidate: ProjectedDimension, held: ProjectedDimension): boolean {
  const rank = (d: ProjectedDimension): number => (d.source === 'reviewer_confirmed' ? 1 : 0);
  if (rank(candidate) !== rank(held)) return rank(candidate) > rank(held);
  return candidate.confidenceBp > held.confidenceBp;
}
