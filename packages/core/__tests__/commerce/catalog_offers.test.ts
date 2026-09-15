/**
 * The catalog → Offer bridge (§5.A2). It synthesizes the quote-shaped fields
 * `Offer` demands from a catalog row HONESTLY: a stable id, a never-expires
 * window unless the catalog set one, the requested quantity as available (a
 * listing is an offer to supply), and the indicative price as a comparable
 * figure — and it reports, never drops, a row with no price.
 */

import {
  CATALOG_NEVER_EXPIRES,
  catalogCandidatesToOffers,
  catalogOfferId,
  type CatalogOfferInput,
} from '../../src/commerce/catalog_offers';
import { rankOffers } from '../../src/commerce/offer_ranking';

const QTY = { value: '100', unit_code: 'each' };
const NOW = '2026-08-08T10:00:00.000Z';

function candidate(
  overrides: Partial<CatalogOfferInput> & Pick<CatalogOfferInput, 'supplierDid'>,
): CatalogOfferInput {
  return {
    serviceUri: `at://${overrides.supplierDid}/svc`,
    productScheme: 'gtin',
    productValue: '08901234567890',
    catalogSnapshotRef: 'snap1',
    indicativePrice: { currency: 'INR', minorUnits: '100000' },
    fulfilmentRegions: [{ scheme: 'iso-3166-2', value: 'IN-KA' }],
    ...overrides,
  };
}

describe('catalog → Offer bridge (§5.A2)', () => {
  it('a priced row becomes a rankable Offer with a deterministic, row-derived id', () => {
    const c = candidate({ supplierDid: 'did:plc:a' });
    const { offers, unpriced } = catalogCandidatesToOffers([c], QTY);
    expect(unpriced).toEqual([]);
    expect(offers).toHaveLength(1);
    const [o] = offers;
    expect(o.quoteId).toBe(catalogOfferId(c));
    expect(o.quoteId).toBe('catalog:did:plc:a:gtin:08901234567890:snap1');
    expect(o.supplierDid).toBe('did:plc:a');
    expect(o.totalMinorUnits).toBe('100000');
    expect(o.currency).toBe('INR');
    expect(o.availableQuantity).toEqual(QTY);
    expect(o.region).toBe('iso-3166-2:IN-KA');
    // The catalog states no lead time or trust; the ranking reports those missing.
    expect(o.leadTimeDays).toBeUndefined();
    expect(o.trustBp).toBeUndefined();
  });

  it('the id depends only on the row, so two runs match (the ranking tiebreak relies on it)', () => {
    const c = candidate({ supplierDid: 'did:plc:b' });
    const first = catalogCandidatesToOffers([c], QTY).offers[0].quoteId;
    const second = catalogCandidatesToOffers([c], QTY).offers[0].quoteId;
    expect(first).toBe(second);
  });

  it('a row with no indicative price is reported in unpriced, never scored as free', () => {
    const priced = candidate({ supplierDid: 'did:plc:priced' });
    const bare = candidate({ supplierDid: 'did:plc:bare', indicativePrice: undefined });
    const { offers, unpriced } = catalogCandidatesToOffers([priced, bare], QTY);
    expect(offers.map((o) => o.supplierDid)).toEqual(['did:plc:priced']);
    expect(unpriced).toEqual([{ supplierDid: 'did:plc:bare', serviceUri: bare.serviceUri }]);
  });

  it('a listing the catalog never expired survives the §13.2 expiry filter', () => {
    const c = candidate({ supplierDid: 'did:plc:c' });
    expect(c.validUntil).toBeUndefined();
    const { offers } = catalogCandidatesToOffers([c], QTY);
    expect(offers[0].expiresAt).toBe(CATALOG_NEVER_EXPIRES);
    const ranked = rankOffers(offers, { quantity: QTY, currency: 'INR' }, NOW);
    expect(ranked.ranked.map((r) => r.offer.supplierDid)).toEqual(['did:plc:c']);
    expect(ranked.filtered).toEqual([]);
  });

  it('a real validUntil in the past still drops the listing', () => {
    const c = candidate({ supplierDid: 'did:plc:stale', validUntil: '2026-08-07T10:00:00.000Z' });
    const { offers } = catalogCandidatesToOffers([c], QTY);
    const ranked = rankOffers(offers, { quantity: QTY, currency: 'INR' }, NOW);
    expect(ranked.ranked).toEqual([]);
    expect(ranked.filtered[0]).toMatchObject({ reason: 'quote_expired' });
  });

  it('availableQuantity is the request, so the stock filter is neutral (a listing offers to supply)', () => {
    const big = { value: '999999', unit_code: 'each' };
    const c = candidate({ supplierDid: 'did:plc:d' });
    const { offers } = catalogCandidatesToOffers([c], big);
    expect(offers[0].availableQuantity).toEqual(big);
    const ranked = rankOffers(offers, { quantity: big, currency: 'INR' }, NOW);
    expect(ranked.filtered).toEqual([]);
    expect(ranked.ranked).toHaveLength(1);
  });

  it('a listing priced in another currency is filtered by the ranker, not by the bridge', () => {
    const c = candidate({
      supplierDid: 'did:plc:usd',
      indicativePrice: { currency: 'USD', minorUnits: '5000' },
    });
    const { offers } = catalogCandidatesToOffers([c], QTY);
    expect(offers[0].currency).toBe('USD');
    const ranked = rankOffers(offers, { quantity: QTY, currency: 'INR' }, NOW);
    expect(ranked.filtered[0]).toMatchObject({ reason: 'currency_mismatch' });
  });

  it('a row with no fulfilment region leaves the offer region undefined', () => {
    const c = candidate({ supplierDid: 'did:plc:noreg', fulfilmentRegions: [] });
    const { offers } = catalogCandidatesToOffers([c], QTY);
    expect(offers[0].region).toBeUndefined();
  });

  it('feeds the ranker correctly: across suppliers the cheaper indicative price wins', () => {
    const { offers } = catalogCandidatesToOffers(
      [
        candidate({
          supplierDid: 'did:plc:dear',
          catalogSnapshotRef: 's1',
          indicativePrice: { currency: 'INR', minorUnits: '90000' },
        }),
        candidate({
          supplierDid: 'did:plc:cheap',
          catalogSnapshotRef: 's2',
          indicativePrice: { currency: 'INR', minorUnits: '50000' },
        }),
      ],
      QTY,
    );
    const ranked = rankOffers(offers, { quantity: QTY, currency: 'INR' }, NOW);
    expect(ranked.ranked.map((r) => r.offer.supplierDid)).toEqual(['did:plc:cheap', 'did:plc:dear']);
  });

  describe('a stated price that is not Money is never an offer (the buyer re-validates, §10.5 / X3)', () => {
    it.each([
      ['', 'an empty string would rank as free'],
      ['-4050', 'a negative would render as garbage'],
      ['12.50', 'a decimal would throw inside the ranker'],
      ['abc', 'letters would throw inside the ranker'],
      [' 42 ', 'whitespace parses as a different number'],
      ['0x10', 'hex parses as a different number'],
      ['1e3', 'an exponent would throw inside the ranker'],
      ['007', 'a leading zero is not the canonical form'],
    ])('minor_units %j → unpriced with the validator’s reason, and the ranker never sees it (%s)', (minorUnits) => {
      const { offers, unpriced } = catalogCandidatesToOffers(
        [
          candidate({ supplierDid: 'did:plc:bad', indicativePrice: { currency: 'INR', minorUnits } }),
          candidate({ supplierDid: 'did:plc:good', catalogSnapshotRef: 's2' }),
        ],
        QTY,
      );
      expect(offers.map((o) => o.supplierDid)).toEqual(['did:plc:good']);
      expect(unpriced).toEqual([
        { supplierDid: 'did:plc:bad', serviceUri: 'at://did:plc:bad/svc', malformedPrice: expect.stringMatching(/^money:/) },
      ]);
      // The good row still ranks; nothing threw.
      const ranked = rankOffers(offers, { quantity: QTY, currency: 'INR' }, NOW);
      expect(ranked.ranked.map((r) => r.offer.supplierDid)).toEqual(['did:plc:good']);
    });

    it('a currency that is not a code shape is refused the same way', () => {
      const { offers, unpriced } = catalogCandidatesToOffers(
        [candidate({ supplierDid: 'did:plc:bad', indicativePrice: { currency: 'constructor', minorUnits: '100' } })],
        QTY,
      );
      expect(offers).toEqual([]);
      expect(unpriced[0]?.malformedPrice).toMatch(/currency/);
    });

    it('a row that states no price carries no reason — absence and malformation are different facts', () => {
      const { unpriced } = catalogCandidatesToOffers([candidate({ supplierDid: 'did:plc:bare', indicativePrice: undefined })], QTY);
      expect(unpriced).toEqual([{ supplierDid: 'did:plc:bare', serviceUri: 'at://did:plc:bare/svc' }]);
    });
  });
});
