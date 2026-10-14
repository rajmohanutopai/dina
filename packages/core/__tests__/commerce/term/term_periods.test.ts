/**
 * SHELF_SPACE_NEGOTIATION §8 — a brand's limits are per month or per week;
 * a store may rent by the other. The brand's Dina restates its limits in the
 * offer's period before comparing (a year is 12 months or 52 weeks, rounded
 * down: the brand never accepts more than its owner said), counters in the
 * offer's period, and ranks every offer in the brand's own period.
 */

import { TERM_PROPOSAL_CARD } from '../../../src/commerce/term/term_buyer';
import {
  buyerLimitsIn,
  buyerMoneyIn,
  type TermBuyerPolicy,
  type TermResourcePolicy,
} from '../../../src/commerce/term/term_policy';

import { publishListing } from './term_harness';
import { BRAND2_DID, BRAND_DID, Fleet, juicePolicy, STORE_DID, type Node } from './term_harness';

import type { TermCounter, TermListing, TermOffer } from '@dina/commerce-protocol';

const MONTHLY_BRAND: TermBuyerPolicy = {
  currency: 'INR',
  targets: { fee: '170000', share_bps: '600' },
  ceilings: { fee: '300000', share_bps: '1000' },
  expected_sales_minor: '2000000',
  max_rounds: 1,
  deadline_seconds: 3 * 24 * 60 * 60,
};

/** slot-3 rented by the WEEK: asking ₹600, floors ₹350 hard and ₹400 automatic. */
function weeklyStore(
  fleet: Fleet,
  did = STORE_DID,
): { store: Node; listing: TermListing; uri: string } {
  const base = juicePolicy().resources[0] as TermResourcePolicy;
  const store = fleet.add(did);
  const set = store.engine.setPolicy(
    juicePolicy({
      holding_rules: [],
      resources: [
        {
          ...base,
          asking: { fee: '60000', share_bps: '1000' },
          floors: { fee: { hard: '35000', auto: '40000' }, share_bps: { hard: '500' } },
          conditions: { period: 'weekly', cash_handler: 'vendor', exit_notice_days: 30 },
        },
      ],
    }),
  );
  if (!set.ok) throw new Error(set.refusal);
  const published = publishListing(store, {
    listingId: 'slot-3',
    resourceRef: 'slot-3',
    kind: 'shelf',
    region: { scheme: 'postal_area', value: 'IN-560034' },
    tags: ['beverages.juice'],
  });
  if (!published.ok) throw new Error(published.refusal);
  return { store, listing: published.listing, uri: published.uri };
}

function ask(
  brand: Node,
  at: { listing: TermListing; uri: string },
  policy: TermBuyerPolicy,
): string {
  const started = brand.engine.startNegotiation({
    listing: at.listing,
    listingUri: at.uri,
    tag: 'beverages.juice',
    attributes: { skus: 4 },
    start: '2027-02-01T00:00:00Z',
    end: '2027-08-01T00:00:00Z',
    policy,
  });
  if (!started.ok) throw new Error(started.refusal);
  return started.request.request_id;
}

describe('the brand’s period (§8)', () => {
  it('converts by the year, rounding down', () => {
    // ₹1700 a month is ₹392.30… a week; a week of ₹600 is ₹2600 a month.
    expect(buyerMoneyIn(170000n, 'monthly', 'weekly')).toBe(39230n);
    expect(buyerMoneyIn(60000n, 'weekly', 'monthly')).toBe(260000n);
    expect(buyerMoneyIn(170000n, 'monthly', 'monthly')).toBe(170000n);
    // A share is a percentage of sales: never converted.
    expect(buyerLimitsIn(MONTHLY_BRAND, 'ceilings', 'weekly')).toEqual({
      fee: 69230n,
      share_bps: 1000n,
    });
    // Absent, the period is monthly.
    expect(buyerLimitsIn({ ...MONTHLY_BRAND, period: 'weekly' }, 'targets', 'monthly')).toEqual({
      fee: 736666n,
      share_bps: 600n,
    });
  });

  describe('on two engines', () => {
    let fleet: Fleet;
    beforeEach(() => {
      fleet = new Fleet();
    });
    afterEach(() => fleet.closeAll());

    it('a monthly brand counters a weekly store in weeks, and stays inside its monthly ceiling', () => {
      const at = weeklyStore(fleet);
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, at, MONTHLY_BRAND);
      fleet.pump();
      const counter = brand.store
        .listByRequest(requestId, 'term_counter')
        .map((r) => JSON.parse(r.recordJson) as TermCounter)[0];
      // ₹600 a week is under the ₹692.30 weekly form of the ₹3000 monthly
      // ceiling, so the brand bargains; it asks for its ₹1700 monthly target
      // in weeks — ₹392.30 — not for ₹1700 a week, which it would already hold.
      expect(counter?.targets).toEqual({ fee: '39230', share_bps: '600' });
      const offers = brand.store
        .listByRequest(requestId, 'term_offer')
        .map((r) => JSON.parse(r.recordJson) as TermOffer)
        .sort((a, b) => a.revision - b.revision);
      // Halfway from 60000 toward 39230 is 49615, above the ₹400 automatic limit.
      expect(offers.map((o) => o.terms.find((t) => t.name === 'fee')?.value)).toEqual([
        '60000',
        '49615',
      ]);
      expect(brand.store.getNegotiation(requestId)?.state).toBe('ready');
    });

    it('a store asking above the brand’s ceiling once converted is never put to the owner', () => {
      const at = weeklyStore(fleet);
      const brand = fleet.add(BRAND_DID);
      // ₹1500 a month is ₹346.15 a week: under every weekly offer this store can make.
      const requestId = ask(brand, at, {
        ...MONTHLY_BRAND,
        targets: { fee: '150000', share_bps: '600' },
        ceilings: { fee: '150000', share_bps: '1000' },
      });
      fleet.pump();
      expect(brand.store.getNegotiation(requestId)).toMatchObject({
        state: 'closed',
        closeReason: 'above_ceiling',
      });
      expect(brand.cards.filter((c) => c.type === TERM_PROPOSAL_CARD)).toEqual([]);
    });

    it('offers in different periods are ranked on one scale, the brand’s own', () => {
      const weekly = weeklyStore(fleet);
      const monthlyStore = fleet.add(BRAND2_DID.replace('secondjuice', 'otherstore0'));
      const set = monthlyStore.engine.setPolicy(juicePolicy({ holding_rules: [] }));
      if (!set.ok) throw new Error(set.refusal);
      const published = publishListing(monthlyStore, {
        listingId: 'slot-3',
        resourceRef: 'slot-3',
        kind: 'shelf',
        region: { scheme: 'postal_area', value: 'IN-560034' },
        tags: ['beverages.juice'],
      });
      if (!published.ok) throw new Error(published.refusal);
      const brand = fleet.add(BRAND_DID);
      ask(brand, weekly, MONTHLY_BRAND);
      ask(brand, { listing: published.listing, uri: published.uri }, MONTHLY_BRAND);
      fleet.pump();
      const ranked = brand.engine.ranked();
      // Both ranked, both in months, whatever period each store rents by.
      expect(
        ranked.map((r) => [r.period, r.costPeriod, r.costPerPeriodMinor !== undefined]),
      ).toEqual(
        expect.arrayContaining([
          ['weekly', 'monthly', true],
          ['monthly', 'monthly', true],
        ]),
      );
      const costs = ranked.map((r) => BigInt(r.costPerPeriodMinor ?? '0'));
      expect([...costs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(costs);
    });
  });
});
