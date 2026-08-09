/**
 * WS-6.4 — hierarchical product evidence (§13.6, FR-B13, FR-B14).
 *
 * "This chair has forty good reviews" and "chairs in this family have forty
 * good reviews between them" are different claims. Every test here is a way
 * the second could be presented as the first — or, per FR-B14, the first as
 * the second, which misleads in the other direction.
 */

import {
  composeProductEvidence,
  headlineEvidence,
  type ProductEvidenceItem,
} from '../../src/commerce/product_evidence';

import type { ProductRef } from '@dina/commerce-protocol';

// Real §9.3 schemes. `sku` is not one of the four — `manufacturer_sku` is,
// and it carries the issuing DID because two suppliers may both call
// something CHAIR-1. Writing this test is what exposed the catalog importer
// casting `{scheme: 'sku'}` into a `ProductRef` it does not match.
const ISSUER = 'did:plc:chairmaker99';
const CHAIR_OAK: ProductRef = {
  scheme: 'manufacturer_sku',
  value: 'CHAIR-1-OAK',
  issuer_did: ISSUER,
};
const CHAIR: ProductRef = { scheme: 'manufacturer_sku', value: 'CHAIR-1', issuer_did: ISSUER };
const SEATING: ProductRef = { scheme: 'manufacturer_sku', value: 'SEATING', issuer_did: ISSUER };

function ev(subject: ProductRef, source: string, ratingBp?: number): ProductEvidenceItem {
  return {
    subject,
    source,
    ...(ratingBp === undefined ? {} : { ratingBp }),
    assertedAtMs: 1_000,
  };
}

describe('exact and inherited evidence are never merged', () => {
  it('groups by what the evidence is actually about', () => {
    const composed = composeProductEvidence({
      product: CHAIR_OAK,
      ancestors: [CHAIR, SEATING],
      evidence: [
        ev(CHAIR_OAK, 'peer:a', 9000),
        ev(CHAIR, 'peer:b', 4000),
        ev(CHAIR, 'peer:c', 5000),
        ev(SEATING, 'peer:d', 1000),
      ],
    });
    expect(composed.exact.items).toHaveLength(1);
    expect(composed.inherited).toHaveLength(2);
    expect(composed.inherited[0]?.inheritedFrom).toEqual(CHAIR);
    expect(composed.inherited[1]?.inheritedFrom).toEqual(SEATING);
  });

  /**
   * The conflation that motivates the module. A single summed count would be
   * "4 sources, mean 4750" — a number that describes no product anyone can
   * buy, and from which the buyer cannot recover what they needed to know.
   */
  it('averages WITHIN a scope, never across scopes', () => {
    const composed = composeProductEvidence({
      product: CHAIR_OAK,
      ancestors: [CHAIR],
      evidence: [ev(CHAIR_OAK, 'peer:a', 9000), ev(CHAIR, 'peer:b', 1000)],
    });
    expect(composed.exact.meanRatingBp).toBe(9000);
    expect(composed.inherited[0]?.meanRatingBp).toBe(1000);
    // The tempting cross-scope mean (5000) appears nowhere.
    const everyMean = [
      composed.exact.meanRatingBp,
      ...composed.inherited.map((g) => g.meanRatingBp),
    ];
    expect(everyMean).not.toContain(5000);
  });

  it('counts a source once per scope, never doubled across them', () => {
    // The same reviewer writing about the family and about this variant is
    // one voice, not two.
    const composed = composeProductEvidence({
      product: CHAIR_OAK,
      ancestors: [CHAIR],
      evidence: [ev(CHAIR_OAK, 'peer:a', 9000), ev(CHAIR, 'peer:a', 1000)],
    });
    expect(composed.exact.distinctSources).toBe(1);
    expect(composed.inherited[0]?.distinctSources).toBe(1);
  });

  it('preserves ancestor order, nearest first', () => {
    // Evidence about the immediate parent is worth more than evidence about a
    // grandparent, and flattening the list loses the only signal that says so.
    const composed = composeProductEvidence({
      product: CHAIR_OAK,
      ancestors: [CHAIR, SEATING],
      evidence: [ev(SEATING, 'peer:d', 1000), ev(CHAIR, 'peer:b', 4000)],
    });
    expect(composed.inherited.map((g) => g.inheritedFrom?.value)).toEqual(['CHAIR-1', 'SEATING']);
  });
});

describe('absence is reported, not filled in (FR-B13)', () => {
  it('reports an EMPTY exact group rather than omitting it', () => {
    // "Nothing is known about this exact variant" is a fact a buyer should be
    // told. Omitting the group lets inherited evidence quietly stand in.
    const composed = composeProductEvidence({
      product: CHAIR_OAK,
      ancestors: [CHAIR],
      evidence: [ev(CHAIR, 'peer:b', 4000)],
    });
    expect(composed.exact.items).toEqual([]);
    expect(composed.exact.meanRatingBp).toBeNull();
    expect(composed.exact.distinctSources).toBe(0);
  });

  it('drops an inherited group with no evidence rather than showing an empty one', () => {
    // The mirror judgement: an ancestor nobody has said anything about is
    // noise on the card, not information.
    const composed = composeProductEvidence({
      product: CHAIR_OAK,
      ancestors: [CHAIR, SEATING],
      evidence: [ev(CHAIR, 'peer:b', 4000)],
    });
    expect(composed.inherited).toHaveLength(1);
  });

  it('reports evidence about neither the product nor a declared ancestor', () => {
    // Silently dropping it hides a feed and a variant chain that disagree;
    // silently including it IS the conflation.
    const composed = composeProductEvidence({
      product: CHAIR_OAK,
      ancestors: [CHAIR],
      evidence: [
        ev({ scheme: 'manufacturer_sku', value: 'TABLE-9', issuer_did: ISSUER }, 'peer:x', 9000),
      ],
    });
    expect(composed.unrelated).toHaveLength(1);
    expect(composed.exact.items).toEqual([]);
    expect(composed.inherited).toEqual([]);
  });

  it('counts items with no rating toward sources but not toward the mean', () => {
    const composed = composeProductEvidence({
      product: CHAIR_OAK,
      ancestors: [],
      evidence: [ev(CHAIR_OAK, 'peer:a'), ev(CHAIR_OAK, 'peer:b', 8000)],
    });
    expect(composed.exact.distinctSources).toBe(2);
    expect(composed.exact.meanRatingBp).toBe(8000);
  });
});

/**
 * FR-B14 runs both ways, and the headline is where a card would break it.
 */
describe('the headline carries its own scope', () => {
  it('prefers exact evidence and says so', () => {
    const headline = headlineEvidence(
      composeProductEvidence({
        product: CHAIR_OAK,
        ancestors: [CHAIR],
        evidence: [ev(CHAIR_OAK, 'peer:a', 9000), ev(CHAIR, 'peer:b', 1000)],
      }),
    );
    expect(headline).toEqual({ scope: 'exact', meanRatingBp: 9000, distinctSources: 1 });
    // No `inheritedFrom` on an exact headline — labelling exact evidence as
    // inherited is the FR-B14 failure in the other direction, and it makes a
    // buyer discount evidence they should have trusted.
    expect(headline).not.toHaveProperty('inheritedFrom');
  });

  it('falls back to the NEAREST ancestor with evidence, and names it', () => {
    const headline = headlineEvidence(
      composeProductEvidence({
        product: CHAIR_OAK,
        ancestors: [CHAIR, SEATING],
        evidence: [ev(SEATING, 'peer:d', 1000), ev(CHAIR, 'peer:b', 4000)],
      }),
    );
    expect(headline?.scope).toBe('inherited');
    expect(headline?.meanRatingBp).toBe(4000);
    expect(headline?.inheritedFrom).toEqual(CHAIR);
  });

  it('skips an ancestor whose evidence carries no rating', () => {
    const headline = headlineEvidence(
      composeProductEvidence({
        product: CHAIR_OAK,
        ancestors: [CHAIR, SEATING],
        evidence: [ev(CHAIR, 'peer:b'), ev(SEATING, 'peer:d', 2000)],
      }),
    );
    expect(headline?.inheritedFrom).toEqual(SEATING);
  });

  it('returns NULL when nothing is known, never a zero', () => {
    // A zero rendered beside a product name reads as a bad rating, which is
    // the opposite of "no data" — and a buyer cannot tell the difference.
    expect(
      headlineEvidence(
        composeProductEvidence({ product: CHAIR_OAK, ancestors: [CHAIR], evidence: [] }),
      ),
    ).toBeNull();
  });

  it('never lets unrelated evidence become a headline', () => {
    expect(
      headlineEvidence(
        composeProductEvidence({
          product: CHAIR_OAK,
          ancestors: [CHAIR],
          evidence: [
            ev(
              { scheme: 'manufacturer_sku', value: 'TABLE-9', issuer_did: ISSUER },
              'peer:x',
              10000,
            ),
          ],
        }),
      ),
    ).toBeNull();
  });
});
