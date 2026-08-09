/**
 * Hierarchical product evidence (§13.6, FR-B13, FR-B14) — what is known about
 * a product, and about WHICH product it is known.
 *
 * THE CONFLATION THIS EXISTS TO PREVENT. "This chair has forty good reviews"
 * and "chairs in this family have forty good reviews between them" are
 * different claims. The first is about the exact variant a buyer is about to
 * order; the second may be about a different finish, a different size, or a
 * discontinued predecessor. Presenting the second as the first is not a
 * rounding error — it is telling a buyer that a thing has a track record it
 * does not have.
 *
 * The failure is easy to reach because the convenient data structure is a
 * single count. Sum forty inherited and two exact into "42 reviews" and the
 * information that would have let a buyer discount it is gone, irreversibly,
 * one line into the pipeline.
 *
 * SO: EXACT AND INHERITED ARE NEVER SUMMED, NEVER MERGED, AND ALWAYS LABELLED.
 * They travel as separate groups all the way to the card. A caller that wants
 * one number has to decide, itself, which claim it is making — and the type
 * makes that decision explicit rather than accidental.
 *
 * FR-B14 in particular: inherited evidence must not be presented as exact, AND
 * exact evidence must not be presented as inherited. Both directions mislead.
 * Understating what is known about the exact variant makes a buyer discount
 * evidence they should have trusted.
 */

import type { ProductRef } from '@dina/commerce-protocol';

/** Where a piece of evidence sits relative to the product being considered. */
export type EvidenceScope =
  /** About the exact variant the buyer is looking at. */
  | 'exact'
  /** About an ancestor: the same product family, not the same product. */
  | 'inherited';

export interface ProductEvidenceItem {
  /** The product this evidence is actually about. */
  subject: ProductRef;
  /** Who asserted it (an AppView, a peer, a reviewer). */
  source: string;
  /** Reviewer-confirmed rating 0..10000, when the evidence carries one. */
  ratingBp?: number;
  /** When the evidence was asserted, epoch ms. */
  assertedAtMs: number;
}

export interface EvidenceGroup {
  scope: EvidenceScope;
  items: ProductEvidenceItem[];
  /**
   * Distinct sources in this group. Counted rather than summed across groups:
   * the same reviewer appearing at both scopes is one voice, not two.
   */
  distinctSources: number;
  /**
   * Mean rating across items that carry one, in basis points; null when none
   * do. Averaged WITHIN a scope only — a mean spanning exact and inherited
   * evidence is the conflation this module exists to prevent.
   */
  meanRatingBp: number | null;
  /**
   * For `inherited`, the ancestor the evidence is about. Absent on `exact`,
   * where the subject IS the product.
   */
  inheritedFrom?: ProductRef;
}

export interface ComposedEvidence {
  product: ProductRef;
  /** Always present, possibly empty. Absence of exact evidence is a FACT. */
  exact: EvidenceGroup;
  /** One group per ancestor. Never flattened together. */
  inherited: EvidenceGroup[];
  /**
   * Evidence that is about neither the product nor a declared ancestor.
   * Reported rather than discarded: silently dropping it would hide a
   * mislabelled feed, and silently including it would be the conflation.
   */
  unrelated: ProductEvidenceItem[];
}

function sameProduct(a: ProductRef, b: ProductRef): boolean {
  return a.scheme === b.scheme && a.value === b.value;
}

function summarise(
  scope: EvidenceScope,
  items: ProductEvidenceItem[],
  inheritedFrom?: ProductRef,
): EvidenceGroup {
  const rated = items.filter((i) => i.ratingBp !== undefined);
  const meanRatingBp =
    rated.length === 0
      ? null
      : Math.round(rated.reduce((sum, i) => sum + (i.ratingBp ?? 0), 0) / rated.length);
  return {
    scope,
    items,
    distinctSources: new Set(items.map((i) => i.source)).size,
    meanRatingBp,
    ...(inheritedFrom === undefined ? {} : { inheritedFrom }),
  };
}

/**
 * Group evidence by what it is actually about.
 *
 * `ancestors` is the declared variant chain, nearest first. Order is preserved
 * in the output because nearness matters to a reader: evidence about the
 * immediate parent is worth more than evidence about a grandparent, and a
 * caller that flattened the list would lose the only signal that distinguishes
 * them.
 */
export function composeProductEvidence(args: {
  product: ProductRef;
  ancestors: readonly ProductRef[];
  evidence: readonly ProductEvidenceItem[];
}): ComposedEvidence {
  const exactItems: ProductEvidenceItem[] = [];
  const byAncestor = new Map<string, ProductEvidenceItem[]>();
  const unrelated: ProductEvidenceItem[] = [];

  for (const item of args.evidence) {
    if (sameProduct(item.subject, args.product)) {
      exactItems.push(item);
      continue;
    }
    const ancestor = args.ancestors.find((a) => sameProduct(a, item.subject));
    if (ancestor === undefined) {
      // NOT silently dropped. Evidence about neither the product nor a
      // declared ancestor means the feed and the variant chain disagree, and
      // that is worth someone noticing.
      unrelated.push(item);
      continue;
    }
    const key = `${ancestor.scheme}:${ancestor.value}`;
    const bucket = byAncestor.get(key);
    if (bucket === undefined) byAncestor.set(key, [item]);
    else bucket.push(item);
  }

  return {
    product: args.product,
    // Always present even when empty: "nothing is known about this exact
    // variant" is a fact a buyer should be told, not an absence that lets
    // inherited evidence quietly stand in for it.
    exact: summarise('exact', exactItems),
    // Ancestor ORDER preserved — nearest first, as declared.
    inherited: args.ancestors
      .map((ancestor) =>
        summarise(
          'inherited',
          byAncestor.get(`${ancestor.scheme}:${ancestor.value}`) ?? [],
          ancestor,
        ),
      )
      .filter((group) => group.items.length > 0),
    unrelated,
  };
}

/**
 * The one number a card may show, and what it is a number ABOUT.
 *
 * A caller wanting a headline figure must go through this, because the return
 * type forces it to carry the scope it chose. There is deliberately no
 * function that returns a bare number: that function would be called, its
 * result would be rendered next to the product name, and the distinction this
 * whole module protects would be gone at the last step.
 */
export interface HeadlineEvidence {
  scope: EvidenceScope;
  meanRatingBp: number;
  distinctSources: number;
  /** Present when `scope` is `inherited`: which ancestor it came from. */
  inheritedFrom?: ProductRef;
}

/**
 * Prefer exact evidence; fall back to the NEAREST ancestor that has any.
 *
 * Returns null when nothing is known at all rather than a zero — a zero
 * rendered next to a product reads as a bad rating, which is the opposite of
 * "no data".
 */
export function headlineEvidence(composed: ComposedEvidence): HeadlineEvidence | null {
  if (composed.exact.meanRatingBp !== null) {
    return {
      scope: 'exact',
      meanRatingBp: composed.exact.meanRatingBp,
      distinctSources: composed.exact.distinctSources,
    };
  }
  for (const group of composed.inherited) {
    if (group.meanRatingBp === null) continue;
    return {
      scope: 'inherited',
      meanRatingBp: group.meanRatingBp,
      distinctSources: group.distinctSources,
      ...(group.inheritedFrom === undefined ? {} : { inheritedFrom: group.inheritedFrom }),
    };
  }
  return null;
}
