/**
 * WS-6.1 + 6.2 — hard filters before scoring, and a deterministic score
 * (§13.2, §13.3, §13.4, FR-B6, FR-B7).
 *
 * Sancho has quotes from several manufacturers and has to pick one. The two
 * properties that matter are that a requirement can never be outweighed, and
 * that the same evidence always produces the same answer with the same
 * explanation.
 */

import { applyHardFilters, rankOffers, type Offer } from '../../src/commerce/offer_ranking';

const NOW = '2026-08-08T10:00:00.000Z';

const REQUIREMENTS = {
  quantity: { value: '100', unit_code: 'each' },
  currency: 'INR',
};

function offer(overrides: Partial<Offer> & Pick<Offer, 'quoteId'>): Offer {
  return {
    supplierDid: `did:plc:${overrides.quoteId}`,
    totalMinorUnits: '100000',
    currency: 'INR',
    availableQuantity: { value: '100', unit_code: 'each' },
    expiresAt: '2026-08-09T10:00:00.000Z',
    ...overrides,
  };
}

describe('hard filters run BEFORE scoring (§13.2)', () => {
  /**
   * The property the ordering exists for. A weighted score can always be
   * dragged across a hard requirement by making one factor extreme enough, so
   * a requirement that participates in a score is not a requirement.
   */
  it('a free offer that cannot meet the requirement never outranks one that can', () => {
    const result = rankOffers(
      [
        offer({
          quoteId: 'q-free',
          totalMinorUnits: '0',
          availableQuantity: { value: '1', unit_code: 'each' },
        }),
        offer({ quoteId: 'q-real', totalMinorUnits: '900000' }),
      ],
      REQUIREMENTS,
      NOW,
    );
    expect(result.ranked.map((r) => r.offer.quoteId)).toEqual(['q-real']);
    expect(result.filtered[0]).toMatchObject({ reason: 'insufficient_quantity' });
  });

  it.each([
    ['quote_expired', { expiresAt: '2026-08-07T10:00:00.000Z' }],
    ['quote_expired', { expiresAt: 'not-a-date' }],
    ['currency_mismatch', { currency: 'USD' }],
    ['insufficient_quantity', { availableQuantity: { value: '99', unit_code: 'each' } }],
    ['incomparable_unit', { availableQuantity: { value: '100', unit_code: 'furlong' } }],
  ])('removes an offer for %s', (reason, override) => {
    const result = rankOffers([offer({ quoteId: 'q-1', ...override })], REQUIREMENTS, NOW);
    expect(result.ranked).toHaveLength(0);
    expect(result.filtered[0]?.reason).toBe(reason);
  });

  it('treats an unreadable expiry as expired, not as no expiry', () => {
    // A quote this buyer cannot date is one it cannot rely on. Reading a
    // malformed date as "never expires" is the generous reading and the wrong
    // one.
    const result = applyHardFilters([offer({ quoteId: 'q-1', expiresAt: '' })], REQUIREMENTS, NOW);
    expect(result.passed).toHaveLength(0);
  });

  it('never converts currency to make an offer comparable', () => {
    // A rate applied here would be this node inventing a commercial term.
    const result = rankOffers([offer({ quoteId: 'q-1', currency: 'USD' })], REQUIREMENTS, NOW);
    expect(result.filtered[0]?.reason).toBe('currency_mismatch');
  });

  it('removes an offer whose lead time misses the deadline', () => {
    const result = rankOffers(
      [offer({ quoteId: 'q-slow', leadTimeDays: 30 })],
      { ...REQUIREMENTS, neededBy: '2026-08-20T10:00:00.000Z' },
      NOW,
    );
    expect(result.filtered[0]?.reason).toBe('too_late');
  });

  it('removes an offer outside the regions the buyer can receive into', () => {
    const result = rankOffers(
      [offer({ quoteId: 'q-far', region: 'US-CA' }), offer({ quoteId: 'q-near', region: 'IN-KL' })],
      { ...REQUIREMENTS, regions: ['IN-KL'] },
      NOW,
    );
    expect(result.ranked.map((r) => r.offer.quoteId)).toEqual(['q-near']);
    expect(result.filtered[0]?.reason).toBe('region_not_served');
  });

  it('removes an offer over the stated ceiling', () => {
    const result = rankOffers(
      [offer({ quoteId: 'q-dear', totalMinorUnits: '500001' })],
      { ...REQUIREMENTS, maxTotalMinorUnits: '500000' },
      NOW,
    );
    expect(result.filtered[0]?.reason).toBe('over_budget');
  });

  it('REPORTS every removal rather than silently shortening the list', () => {
    // "Why isn't ChairMaker here" is the first question anyone asks of a
    // shortlist, and a comparison that cannot answer it is one the buyer
    // cannot trust.
    const result = rankOffers(
      [
        offer({ quoteId: 'q-ok' }),
        offer({ quoteId: 'q-usd', currency: 'USD' }),
        offer({ quoteId: 'q-old', expiresAt: '2026-01-01T00:00:00.000Z' }),
      ],
      REQUIREMENTS,
      NOW,
    );
    expect(result.ranked).toHaveLength(1);
    expect(result.filtered.map((f) => f.offer.quoteId).sort()).toEqual(['q-old', 'q-usd']);
    for (const removed of result.filtered) expect(removed.detail).not.toBe('');
  });
});

describe('deterministic scoring (§13.3, FR-B6)', () => {
  it('ranks a cheaper, faster, better-trusted offer first', () => {
    const result = rankOffers(
      [
        offer({ quoteId: 'q-dear', totalMinorUnits: '200000', leadTimeDays: 20, trustBp: 4000 }),
        offer({ quoteId: 'q-good', totalMinorUnits: '100000', leadTimeDays: 5, trustBp: 9000 }),
      ],
      REQUIREMENTS,
      NOW,
    );
    expect(result.ranked.map((r) => r.offer.quoteId)).toEqual(['q-good', 'q-dear']);
    // NOT 10000 and NOT 0, and the reason is a real design decision — see the
    // relative/absolute test below. q-good is best on price and lead time
    // (10000 each) but its trust is 9000 out of a possible 10000:
    //   0.60*10000 + 0.25*10000 + 0.15*9000 = 9850.
    // q-dear is worst on both relative factors but still holds a 4000 rating:
    //   0.60*0 + 0.25*0 + 0.15*4000 = 600.
    expect(result.ranked[0]?.scoreBp).toBe(9850);
    expect(result.ranked[1]?.scoreBp).toBe(600);
  });

  /**
   * PRICE AND LEAD TIME ARE RELATIVE; TRUST IS ABSOLUTE.
   *
   * "Cheapest of these three" is only meaningful against the others, so price
   * and lead time normalise across the shortlist. A trust rating is not like
   * that: 4000 means the same thing whoever else happened to quote, and
   * stretching it to 10000 just because it is the best on offer would tell
   * the buyer that the least-bad supplier is excellent.
   *
   * I got this wrong first: my own test expected the top offer to score
   * 10000, which would only hold if trust were normalised too.
   */
  it('normalises price and lead time across offers but never the trust rating', () => {
    const result = rankOffers(
      [
        offer({ quoteId: 'q-a', totalMinorUnits: '100000', leadTimeDays: 5, trustBp: 3000 }),
        offer({ quoteId: 'q-b', totalMinorUnits: '200000', leadTimeDays: 10, trustBp: 2000 }),
      ],
      REQUIREMENTS,
      NOW,
    );
    const top = result.ranked[0];
    // Best on both relative factors: full marks on each.
    expect(top?.components.find((c) => c.factor === 'price')?.valueBp).toBe(10000);
    expect(top?.components.find((c) => c.factor === 'lead_time')?.valueBp).toBe(10000);
    // Best on trust too — and still 3000, because that is what the rating IS.
    expect(top?.components.find((c) => c.factor === 'trust')?.valueBp).toBe(3000);
  });

  it('produces the same ranking whatever order the offers arrived in', () => {
    // A ranking that depended on response arrival order would give two buyers
    // different answers from the same evidence.
    const offers = [
      offer({ quoteId: 'q-a', totalMinorUnits: '100000', leadTimeDays: 5, trustBp: 5000 }),
      offer({ quoteId: 'q-b', totalMinorUnits: '150000', leadTimeDays: 3, trustBp: 8000 }),
      offer({ quoteId: 'q-c', totalMinorUnits: '120000', leadTimeDays: 9, trustBp: 6000 }),
    ];
    const forward = rankOffers(offers, REQUIREMENTS, NOW).ranked.map((r) => r.offer.quoteId);
    const reversed = rankOffers([...offers].reverse(), REQUIREMENTS, NOW).ranked.map(
      (r) => r.offer.quoteId,
    );
    expect(reversed).toEqual(forward);
  });

  it('breaks an exact tie on quote id, not on input order', () => {
    const a = offer({
      quoteId: 'q-aaa',
      totalMinorUnits: '100000',
      leadTimeDays: 5,
      trustBp: 5000,
    });
    const b = offer({
      quoteId: 'q-bbb',
      totalMinorUnits: '100000',
      leadTimeDays: 5,
      trustBp: 5000,
    });
    expect(rankOffers([b, a], REQUIREMENTS, NOW).ranked.map((r) => r.offer.quoteId)).toEqual([
      'q-aaa',
      'q-bbb',
    ]);
  });

  it('gives a lone survivor full marks rather than zero', () => {
    // Arithmetically, one offer is both the best and the worst. Scoring it
    // zero would tell the buyer their only viable supplier is bad, which it
    // does not.
    const result = rankOffers(
      [offer({ quoteId: 'q-only', leadTimeDays: 7, trustBp: 5000 })],
      REQUIREMENTS,
      NOW,
    );
    expect(result.ranked[0]?.components.find((c) => c.factor === 'price')?.valueBp).toBe(10000);
  });

  it('explains every component it used', () => {
    const result = rankOffers(
      [
        offer({ quoteId: 'q-a', totalMinorUnits: '100000', leadTimeDays: 5, trustBp: 9000 }),
        offer({ quoteId: 'q-b', totalMinorUnits: '200000', leadTimeDays: 10, trustBp: 3000 }),
      ],
      REQUIREMENTS,
      NOW,
    );
    const top = result.ranked[0];
    expect(top?.components.map((c) => c.factor).sort()).toEqual(['lead_time', 'price', 'trust']);
    expect(top?.weightAppliedBp).toBe(10000);
    // The score is recomputable from the parts a buyer was shown — which is
    // the whole point of keeping an LLM out of this path.
    const recomputed = top?.components.reduce((sum, c) => sum + c.contributionBp, 0);
    expect(recomputed).toBe(top?.scoreBp);
  });
});

describe('missing data is explained, never substituted (§13.4, FR-B7)', () => {
  /**
   * The case this rule exists for. A new supplier has no PeerLens history.
   * Scoring absence as zero makes the trust system a barrier to entry;
   * scoring it as full marks rewards having no history at all.
   */
  it('does not punish a supplier for having no trust history', () => {
    const withHistory = offer({
      quoteId: 'q-known',
      totalMinorUnits: '100000',
      leadTimeDays: 5,
      trustBp: 200,
    });
    const newcomer = offer({ quoteId: 'q-new', totalMinorUnits: '100000', leadTimeDays: 5 });
    const result = rankOffers([withHistory, newcomer], REQUIREMENTS, NOW);

    const scored = result.ranked.find((r) => r.offer.quoteId === 'q-new');
    expect(scored?.missing).toEqual([
      { factor: 'trust', reason: 'no PeerLens history for this supplier yet' },
    ]);
    // Scored on the factors it HAS, not on a value invented for the one it
    // lacks — so identical price and lead time put the newcomer ahead of a
    // badly-rated incumbent rather than behind it.
    expect(result.ranked[0]?.offer.quoteId).toBe('q-new');
  });

  it('does not reward absence either', () => {
    // The mirror failure. If missing trust scored as 10000, the newcomer
    // would beat a supplier with an excellent record.
    const excellent = offer({
      quoteId: 'q-excellent',
      totalMinorUnits: '100000',
      leadTimeDays: 5,
      trustBp: 10000,
    });
    const newcomer = offer({ quoteId: 'q-new', totalMinorUnits: '100000', leadTimeDays: 5 });
    const result = rankOffers([excellent, newcomer], REQUIREMENTS, NOW);
    // Both score 10000 on the factors they share; the tie breaks on id. What
    // matters is that neither is ahead BECAUSE of the missing field.
    expect(result.ranked.map((r) => r.scoreBp)).toEqual([10000, 10000]);
  });

  it('reports the weight actually applied, so scores are read honestly', () => {
    // A score built from two factors is on the same 0..10000 scale as one
    // built from three. The scale being shared is not the same as the evidence
    // being equal, which is exactly why this number travels with the score.
    const result = rankOffers(
      [offer({ quoteId: 'q-thin', totalMinorUnits: '100000' })],
      REQUIREMENTS,
      NOW,
    );
    const only = result.ranked[0];
    expect(only?.weightAppliedBp).toBe(6000);
    expect(only?.missing.map((m) => m.factor).sort()).toEqual(['lead_time', 'trust']);
  });

  it('clamps an out-of-range trust value rather than trusting it', () => {
    // The rating comes from an AppView, which is not this node.
    const result = rankOffers(
      [
        offer({ quoteId: 'q-a', totalMinorUnits: '100000', trustBp: 99999 }),
        offer({ quoteId: 'q-b', totalMinorUnits: '100000', trustBp: -5 }),
      ],
      REQUIREMENTS,
      NOW,
    );
    const values = result.ranked.map(
      (r) => r.components.find((c) => c.factor === 'trust')?.valueBp,
    );
    expect(values.sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([0, 10000]);
  });
});

describe('an empty or fully-filtered shortlist', () => {
  it('ranks nothing and says why, rather than returning an empty list', () => {
    const result = rankOffers([offer({ quoteId: 'q-usd', currency: 'USD' })], REQUIREMENTS, NOW);
    expect(result.ranked).toEqual([]);
    expect(result.filtered).toHaveLength(1);
  });

  it('handles no offers at all without inventing one', () => {
    expect(rankOffers([], REQUIREMENTS, NOW)).toEqual({ ranked: [], filtered: [] });
  });
});
