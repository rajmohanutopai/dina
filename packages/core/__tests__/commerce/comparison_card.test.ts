/**
 * WS-7.4 — the comparison card (§18.4).
 *
 * §18.4's requirement is the unusual one and the tests take it literally: the
 * result must remain useful on the GENERIC CardSpec fallback. So the assertions
 * are about what a renderer with no special knowledge would show — ordered
 * label/value lines, one action, and no field whose absence leaves a blank
 * where a number should be.
 */

import { buildComparisonCard } from '../../src/commerce/comparison_card';
import { rankOffers, type Offer } from '../../src/commerce/offer_ranking';

const AT = '2026-08-08T09:00:00.000Z';
const REQUEST = {
  label: 'Oak dining chairs',
  quantity: { value: '100', unit_code: 'each' },
};
const REQUIREMENTS = { currency: 'INR', quantity: { value: '100', unit_code: 'each' } };

function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    supplierDid: 'did:plc:chairmaker99',
    quoteId: 'q-1',
    totalMinorUnits: '50000',
    currency: 'INR',
    availableQuantity: { value: '100', unit_code: 'each' },
    expiresAt: '2026-08-09T09:00:00.000Z',
    leadTimeDays: 14,
    trustBp: 7000,
    ...overrides,
  };
}

function card(offers: Offer[], evidence?: Parameters<typeof buildComparisonCard>[0]['evidence']) {
  return buildComparisonCard({
    request: REQUEST,
    ranking: rankOffers(offers, REQUIREMENTS, AT),
    ...(evidence === undefined ? {} : { evidence }),
  });
}

function valueOf(fields: { label: string; value: string }[], label: string): string | undefined {
  return fields.find((f) => f.label === label)?.value;
}

describe('what a generic renderer sees', () => {
  it('renders every §18.4 baseline field as an ordered label/value line', () => {
    const built = card([
      offer(),
      offer({
        supplierDid: 'did:plc:rivalchairs01',
        quoteId: 'q-2',
        totalMinorUnits: '60000',
        leadTimeDays: 30,
        trustBp: 5000,
      }),
    ]);
    for (const label of [
      'Requested',
      'Valid candidates',
      'Recommended',
      'Total landed cost',
      'Delivery estimate',
      'Quote valid until',
      'Confidence',
      'Evidence',
    ]) {
      expect(valueOf(built.fields, label)).toBeDefined();
    }
    // Every value is a printable string — a renderer that knows nothing about
    // commerce still produces a readable card.
    expect(built.fields.every((f) => typeof f.value === 'string' && f.value.length > 0)).toBe(true);
  });

  it('offers "Review order" and never a buy action', () => {
    // §18.4 is explicit, and the reason is Cart Handover: Dina advises on
    // purchases and never completes one without the human seeing the order.
    expect(card([offer()]).primaryAction).toBe('review_order');
  });

  it('says "not stated" rather than leaving a blank where a number should be', () => {
    const built = card([offer({ leadTimeDays: undefined })]);
    expect(valueOf(built.fields, 'Delivery estimate')).toBe('not stated');
  });
});

describe('explaining the ranking rather than re-deciding it', () => {
  it('names each factor and how much it moved the total', () => {
    // An owner asking "why did this win" is asking what CONTRIBUTED, not how
    // the offer scored on a factor in isolation.
    const built = card([
      offer(),
      offer({ supplierDid: 'did:plc:rivalchairs01', quoteId: 'q-2', totalMinorUnits: '90000' }),
    ]);
    const why = built.fields.filter((f) => f.label === 'Why').map((f) => f.value);
    expect(why.some((v) => v.startsWith('price:'))).toBe(true);
    expect(why.some((v) => v.startsWith('trust:'))).toBe(true);
  });

  it('reports the factors the RANKING could not score, not its own guess', () => {
    // Read off `missing`. A card that worked this out independently would
    // eventually contradict the score it is explaining.
    const built = card([
      offer({ trustBp: undefined }),
      offer({ supplierDid: 'did:plc:rivalchairs01', quoteId: 'q-2' }),
    ]);
    expect(built.incomparable.some((line) => line.startsWith('trust:'))).toBe(true);
  });

  it('says when a winner was scored on less than the full weight', () => {
    // A score over fewer factors is not comparable to one over all of them,
    // and the number alone does not say so.
    const built = card([offer({ trustBp: undefined })]);
    expect(valueOf(built.fields, 'Scored on')).toContain('of 10000 of the ranking weight');
  });

  it('names every excluded offer with its reason, never a count', () => {
    // "2 offers excluded" is the sentence that hides the one an owner would
    // have wanted to see.
    const built = card([
      offer(),
      offer({
        supplierDid: 'did:plc:rivalchairs01',
        quoteId: 'q-2',
        availableQuantity: { value: '5', unit_code: 'each' },
      }),
    ]);
    const excluded = built.fields.filter((f) => f.label === 'Excluded');
    expect(excluded).toHaveLength(1);
    expect(excluded[0]?.value).toContain('did:plc:rivalchairs01');
    expect(excluded[0]?.value).toContain('insufficient_quantity');
  });

  it('keeps the alternatives in the ranking order', () => {
    // A renderer that showed more than the winner must not have to re-sort and
    // risk disagreeing with the recommendation above it.
    const built = card([
      offer({ totalMinorUnits: '90000' }),
      offer({ supplierDid: 'did:plc:b', quoteId: 'q-b', totalMinorUnits: '50000' }),
      offer({ supplierDid: 'did:plc:c', quoteId: 'q-c', totalMinorUnits: '70000' }),
    ]);
    expect(valueOf(built.fields, 'Recommended')).toBe('did:plc:b');
    expect(built.alternatives.map((a) => a.supplierDid)).toEqual([
      'did:plc:c',
      'did:plc:chairmaker99',
    ]);
  });
});

describe('the honest empty case', () => {
  it('is a card with reasons, not an error and not a blank', () => {
    // Every offer failing the hard filters is a RESULT: §13.2's filters exist
    // to remove what a buyer cannot accept, and the reasons are the useful part.
    const built = card([offer({ expiresAt: '2026-08-01T00:00:00.000Z' })]);
    expect(valueOf(built.fields, 'Recommended')).toContain('no offer met the requirements');
    expect(built.fields.some((f) => f.label === 'Excluded')).toBe(true);
    expect(built.alternatives).toEqual([]);
    // Still "review order", never a dead end with no verb.
    expect(built.primaryAction).toBe('review_order');
  });

  it('says evidence is absent rather than showing a zero', () => {
    // An unrated supplier and a mediocre one are different, and a zero makes
    // them look the same.
    expect(valueOf(card([offer()]).fields, 'Evidence')).toBe('none recorded for this supplier');
  });

  it('shows evidence with its scope when there is some', () => {
    // `meanRatingBp: null` is what "nothing known" means here, NOT an empty
    // item list — a first version of this fixture used `0`, which reads as a
    // real rating of zero and made the headline claim exact evidence nobody
    // had. That is the same confusion the module refuses to make downstream.
    const built = card([offer()], {
      exact: { items: [], meanRatingBp: null, distinctSources: 0 },
      inherited: [
        {
          inheritedFrom: {
            scheme: 'manufacturer_sku',
            value: 'SEATING',
            issuer_did: 'did:plc:chairmaker99',
          },
          items: [{ source: 'peer:someone', ratingBp: 8000, assertedAtMs: 1 }],
          meanRatingBp: 8000,
          distinctSources: 1,
        },
      ],
    } as never);
    expect(valueOf(built.fields, 'Evidence')).toContain('inherited');
    expect(valueOf(built.fields, 'Evidence')).toContain('8000');
  });
});
