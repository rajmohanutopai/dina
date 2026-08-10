/**
 * §10.6 — combining catalog AppViews, with the source kept attached.
 *
 * THE SECTION IS THREE SENTENCES and each one is a rule. The protocol permits
 * multiple catalog AppViews. A buyer may choose OR COMBINE indexes. Every
 * result carries enough source and snapshot evidence to identify where it came
 * from and to verify the supplier live before commitment.
 *
 * That last clause is the one with consequences. A combined result set is the
 * only place in discovery where two parties can be describing the same product
 * and disagreeing, and the disagreement is exactly the information a buyer
 * needs BEFORE they commit. So this module never picks a winner between two
 * indexes: it merges by product identity, keeps every index's sighting with
 * its own snapshot reference, and marks the merged candidate DIVERGENT when
 * those snapshots differ.
 *
 * WHY NOT PICK THE NEWEST SNAPSHOT. Because "newest" is a claim by an index,
 * and an index that wanted to win could always make one. The whole reason
 * §10.6 asks for source evidence is that a buyer verifies against the SUPPLIER
 * before committing — the combiner's job is to make the disagreement visible,
 * not to resolve it on the buyer's behalf.
 *
 * SCORES ARE NEVER SUMMED, the same rule the relationship projection and the
 * review dimensions follow. One index reporting a product twice, or two
 * indexes mirroring each other, would otherwise manufacture rank. The merged
 * score is the strongest single sighting.
 *
 * WHERE THIS LIVES, and why not in Core. A combiner is a pure function over
 * the §10.5 candidate — a shape this package already defines and freezes as a
 * vector. Putting it here makes it usable by a buyer's node AND by a
 * third-party pack, and keeps discovery logic out of the kernel.
 */

import { validateCommerceSearchCandidate, type CommerceSearchCandidate } from './search';

/**
 * One index's answer to one query.
 *
 * `indexId` is how the buyer names the AppView — a DID or a URL. It is carried
 * through to every candidate, because "which index said this" is half of
 * §10.6's source evidence and a result set that lost it cannot be audited.
 */
export interface IndexAnswer {
  indexId: string;
  candidates: readonly CommerceSearchCandidate[];
}

/** One index's sighting of one product. */
export interface Sighting {
  indexId: string;
  /** The snapshot the index projected from. §10.6's other half of evidence. */
  catalogSnapshotRef: string;
  retrievalScoreBp: number;
  matchedFields: string[];
}

export interface CombinedCandidate {
  supplierDid: string;
  serviceUri: string;
  product: CommerceSearchCandidate['product'];
  /** Every index that returned it, in the order the buyer listed them. */
  sightings: Sighting[];
  /**
   * The STRONGEST single sighting's score. Never a sum, never an average — an
   * average would let a weak second opinion drag a strong match down, and a
   * sum would reward mirroring.
   */
  retrievalScoreBp: number;
  /**
   * True when two indexes projected this product from DIFFERENT snapshots.
   *
   * Not an error and not resolved here: it is the signal §10.6 exists to
   * preserve, and the buyer's answer to it is to verify with the supplier
   * before committing.
   */
  divergentSnapshots: boolean;
  /** The full candidate from the strongest sighting, for display. */
  representative: CommerceSearchCandidate;
}

export interface IndexFinding {
  indexId: string;
  /** Zero-based position in that index's answer. */
  position: number;
  reason: string;
}

export interface CombinedResults {
  candidates: CombinedCandidate[];
  /** Indexes that were asked and returned nothing. Distinct from not asked. */
  emptyIndexes: string[];
  /**
   * Candidates a source index returned that this buyer refused.
   *
   * KEPT, not dropped. An index quietly returning malformed candidates is a
   * thing a buyer should be able to notice about it, and a combiner that
   * silently discarded them would present a degraded index as a quiet one.
   */
  findings: IndexFinding[];
}

/** Identity for merging: supplier plus the product ref, length-prefixed. */
function mergeKey(candidate: CommerceSearchCandidate): string {
  const parts = [
    candidate.supplier_did,
    candidate.product.scheme,
    candidate.product.value,
    candidate.product.issuer_did ?? '',
    candidate.product.variant_digest ?? '',
  ];
  // LENGTH-PREFIXED, for the reason the product key is: a `custom` value is an
  // arbitrary bounded string, so any separator can appear inside a field and
  // splice two different products into one merged row.
  return parts.map((p) => `${String(p.length)}:${p}`).join('');
}

/**
 * Combine several indexes' answers into one attributed result set.
 *
 * VALIDATES EVERY CANDIDATE, because these arrive from independent operators
 * this buyer does not control. An index is a stranger with an opinion; the
 * shape of its answer is not something to take on trust.
 */
export function combineIndexAnswers(answers: readonly IndexAnswer[]): CombinedResults {
  const merged = new Map<string, CombinedCandidate>();
  const emptyIndexes: string[] = [];
  const findings: IndexFinding[] = [];

  for (const answer of answers) {
    let accepted = 0;
    answer.candidates.forEach((candidate, position) => {
      const invalid = validateCommerceSearchCandidate(candidate);
      if (invalid !== null) {
        findings.push({ indexId: answer.indexId, position, reason: invalid });
        return;
      }
      accepted += 1;

      const sighting: Sighting = {
        indexId: answer.indexId,
        catalogSnapshotRef: candidate.catalog_snapshot_ref,
        retrievalScoreBp: candidate.retrieval_score_bp,
        matchedFields: [...candidate.matched_fields],
      };

      const key = mergeKey(candidate);
      const held = merged.get(key);
      if (held === undefined) {
        merged.set(key, {
          supplierDid: candidate.supplier_did,
          serviceUri: candidate.service_uri,
          product: candidate.product,
          sightings: [sighting],
          retrievalScoreBp: candidate.retrieval_score_bp,
          divergentSnapshots: false,
          representative: candidate,
        });
        return;
      }

      held.sightings.push(sighting);
      // DIVERGENCE IS ABOUT THE SNAPSHOT, not the score. Two indexes may
      // legitimately rank a product differently; they may not legitimately
      // both be current about a supplier who published once.
      if (held.sightings.some((s) => s.catalogSnapshotRef !== sighting.catalogSnapshotRef)) {
        held.divergentSnapshots = true;
      }
      if (candidate.retrieval_score_bp > held.retrievalScoreBp) {
        held.retrievalScoreBp = candidate.retrieval_score_bp;
        held.representative = candidate;
      }
    });
    if (accepted === 0) emptyIndexes.push(answer.indexId);
  }

  const candidates = [...merged.values()].sort((a, b) => {
    if (a.retrievalScoreBp !== b.retrievalScoreBp) return b.retrievalScoreBp - a.retrievalScoreBp;
    // Deterministic, and on something with no commercial meaning: a tie broken
    // by index order would let whoever the buyer listed first win ties.
    return mergeKey(a.representative).localeCompare(mergeKey(b.representative));
  });

  return { candidates, emptyIndexes, findings };
}

/**
 * Does this candidate need a live check before the buyer commits (§10.6)?
 *
 * TRUE ON DIVERGENCE, and true on a SINGLE sighting too. One index agreeing
 * with itself is not corroboration — it is one opinion — and §10.6 asks for
 * enough evidence "to verify the supplier live before commitment" rather than
 * enough to skip verifying. This returns false only where several independent
 * indexes agree on the same snapshot, which is the one case where the extra
 * round trip buys nothing.
 */
export function needsLiveVerification(candidate: CombinedCandidate): boolean {
  if (candidate.divergentSnapshots) return true;
  const distinctIndexes = new Set(candidate.sightings.map((s) => s.indexId));
  return distinctIndexes.size < 2;
}
