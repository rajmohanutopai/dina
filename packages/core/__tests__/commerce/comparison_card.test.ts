/**
 * WS-7.4 — the comparison card (§18.4).
 *
 * §18.4's requirement is the unusual one and the tests take it literally: the
 * result must remain useful on the GENERIC CardSpec fallback. So the assertions
 * are about what a renderer with no special knowledge would show — ordered
 * label/value lines, one action, and no field whose absence leaves a blank
 * where a number should be.
 */

import { CATALOG_NEVER_EXPIRES } from '../../src/commerce/catalog_offers';
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

  it('shows money in major units, never the wire minor units (₹500.00, not "INR 50000")', () => {
    const built = card([
      offer(),
      offer({ supplierDid: 'did:plc:rivalchairs01', quoteId: 'q-2', totalMinorUnits: '60000' }),
    ]);
    expect(valueOf(built.fields, 'Total landed cost')).toBe('INR 500.00');
    expect(built.alternatives.map((a) => a.total)).toEqual(['INR 600.00']);
    // A zero-exponent currency gains no phantom decimals.
    const yen = buildComparisonCard({
      request: REQUEST,
      ranking: rankOffers(
        [offer({ currency: 'JPY', totalMinorUnits: '48000' })],
        { ...REQUIREMENTS, currency: 'JPY' },
        AT,
      ),
    });
    expect(valueOf(yen.fields, 'Total landed cost')).toBe('JPY 48000');
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

  it('echoes the ranking\'s recorded reason VERBATIM (a recompute could not produce it)', () => {
    // Inject a sentinel reason the card has no way to derive itself, then assert
    // it appears verbatim — so a regression that recomputes the incomparable
    // notes instead of reading `ranking.missing` is caught.
    const built = buildComparisonCard({
      request: REQUEST,
      ranking: {
        ranked: [
          {
            offer: offer(),
            scoreBp: 5000,
            weightAppliedBp: 8500,
            components: [],
            missing: [{ factor: 'trust', reason: 'SENTINEL-carried-verbatim-9f3a' }],
          },
        ],
        filtered: [],
      },
    });
    expect(built.incomparable).toContain('trust: SENTINEL-carried-verbatim-9f3a');
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

describe('hand-off mode (§5.A5) — the money-free where-to-buy card', () => {
  function handoffCard(
    offers: Offer[],
    handoff: NonNullable<Parameters<typeof buildComparisonCard>[0]['handoff']>,
  ) {
    return buildComparisonCard({
      request: REQUEST,
      ranking: rankOffers(offers, REQUIREMENTS, AT),
      mode: 'handoff',
      handoff,
    });
  }

  it('offers "where to buy" and the hand-off links, never a buy or an order verb', () => {
    // Cart Handover for a consumer: Dina credits the source and lets the human
    // complete the purchase there. No money moves through Dina.
    const built = handoffCard(
      [offer()],
      [{ supplierDid: 'did:plc:chairmaker99', serviceUri: 'at://x/svc' }],
    );
    expect(built.primaryAction).toBe('where_to_buy');
    expect(built.handoff).toEqual([{ supplierDid: 'did:plc:chairmaker99', serviceUri: 'at://x/svc' }]);
  });

  it('labels the price as indicative and the window as a listing, not a quote', () => {
    const built = handoffCard([offer()], []);
    expect(valueOf(built.fields, 'Indicative price')).toBeDefined();
    expect(valueOf(built.fields, 'Total landed cost')).toBeUndefined();
    expect(valueOf(built.fields, 'Listing valid until')).toBeDefined();
    expect(valueOf(built.fields, 'Quote valid until')).toBeUndefined();
  });

  it('renders a never-expired listing as "no stated expiry", not a nonsense date', () => {
    const built = handoffCard([offer({ expiresAt: CATALOG_NEVER_EXPIRES })], []);
    expect(valueOf(built.fields, 'Listing valid until')).toBe('no stated expiry');
  });

  it('passes a REAL validity date through unchanged (both modes)', () => {
    // The other half of renderValidity: only the far-future sentinel is
    // rewritten; a real date must survive byte-for-byte, or the order card is
    // no longer byte-identical to before hand-off mode existed.
    const handoff = handoffCard([offer({ expiresAt: '2026-08-09T09:00:00.000Z' })], []);
    expect(valueOf(handoff.fields, 'Listing valid until')).toBe('2026-08-09T09:00:00.000Z');
    const ordered = buildComparisonCard({
      request: REQUEST,
      ranking: rankOffers([offer({ expiresAt: '2026-08-09T09:00:00.000Z' })], REQUIREMENTS, AT),
    });
    expect(valueOf(ordered.fields, 'Quote valid until')).toBe('2026-08-09T09:00:00.000Z');
  });

  it('order mode omits hand-off entirely and keeps the review-order verb (byte-unchanged)', () => {
    const ordered = buildComparisonCard({
      request: REQUEST,
      ranking: rankOffers([offer()], REQUIREMENTS, AT),
    });
    expect(ordered.primaryAction).toBe('review_order');
    expect('handoff' in ordered).toBe(false);
    expect(valueOf(ordered.fields, 'Total landed cost')).toBeDefined();
    expect(valueOf(ordered.fields, 'Quote valid until')).toBeDefined();
  });
});

describe('the owner’s choice over the ranking (§5.A6)', () => {
  const CHEAP = offer({ supplierDid: 'did:plc:cheap', quoteId: 'q-cheap', totalMinorUnits: '40000', trustBp: 2800 });
  const STEADY = offer({ supplierDid: 'did:plc:steady', quoteId: 'q-steady', totalMinorUnits: '50000', trustBp: 9400 });
  const SWORN = offer({ supplierDid: 'did:plc:sworn', quoteId: 'q-sworn', totalMinorUnits: '45000', trustBp: 8300 });
  const LINKS = [
    { supplierDid: 'did:plc:cheap', serviceUri: 'at://cheap' },
    { supplierDid: 'did:plc:steady', serviceUri: 'at://steady', sellerName: 'Steady Seats' },
    { supplierDid: 'did:plc:sworn', serviceUri: 'at://sworn', sellerName: 'ChairMaker' },
  ];
  const NAMES = { 'did:plc:steady': 'Steady Seats', 'did:plc:sworn': 'ChairMaker' };

  function chosen(choice: Parameters<typeof buildComparisonCard>[0]['choice']) {
    return buildComparisonCard({
      request: REQUEST,
      ranking: rankOffers([CHEAP, STEADY, SWORN], REQUIREMENTS, AT),
      mode: 'handoff',
      handoff: LINKS,
      sellerNames: NAMES,
      ...(choice === undefined ? {} : { choice }),
    });
  }

  it('without a choice the ranking’s #1 stands, and the card is the plain card plus seller labels', () => {
    const built = chosen(undefined);
    expect(valueOf(built.fields, 'Recommended')).toBe('did:plc:cheap');
    expect(valueOf(built.fields, 'Chosen for')).toBeUndefined();
    expect(valueOf(built.fields, 'Set aside')).toBeUndefined();
    expect(built.alternatives.map((a) => a.seller)).toEqual(['ChairMaker (did:plc:sworn)', 'Steady Seats (did:plc:steady)']);
    // Against the same card built with NO names and NO choice: every field
    // the old card had, in the old order, the same alternatives and links —
    // only the display labels differ, and only where a name is known.
    const plain = buildComparisonCard({
      request: REQUEST,
      ranking: rankOffers([CHEAP, STEADY, SWORN], REQUIREMENTS, AT),
      mode: 'handoff',
      handoff: LINKS,
    });
    expect(built.fields).toEqual(plain.fields);
    expect(built.primaryAction).toBe(plain.primaryAction);
    expect(built.handoff).toEqual(plain.handoff);
    expect(built.incomparable).toEqual(plain.incomparable);
    expect(built.alternatives.map(({ seller: _s, ...rest }) => rest)).toEqual(plain.alternatives.map(({ seller: _s, ...rest }) => rest));
    expect(plain.alternatives.map((a) => a.seller)).toEqual(['did:plc:sworn', 'did:plc:steady']);
  });

  it('names a seller the owner knows on the Excluded lines too', () => {
    const built = buildComparisonCard({
      request: REQUEST,
      ranking: rankOffers([CHEAP, offer({ supplierDid: 'did:plc:sworn', quoteId: 'q-x', currency: 'USD' })], REQUIREMENTS, AT),
      sellerNames: NAMES,
    });
    expect(valueOf(built.fields, 'Excluded')).toMatch(/^ChairMaker \(did:plc:sworn\): currency_mismatch/);
  });

  it('a supplier with two ranked offers cannot be chosen by DID — refused, never a coin toss', () => {
    const twice = rankOffers([CHEAP, STEADY, offer({ supplierDid: 'did:plc:steady', quoteId: 'q-steady-2', totalMinorUnits: '52000' })], REQUIREMENTS, AT);
    expect(() =>
      buildComparisonCard({ request: REQUEST, ranking: twice, choice: { supplierDid: 'did:plc:steady', reason: 'x' } }),
    ).toThrow(/has 2 ranked offers/);
    // Without a choice the order path still lists BOTH of that supplier's offers.
    const plain = buildComparisonCard({ request: REQUEST, ranking: twice });
    expect(plain.alternatives.map((a) => a.supplierDid)).toEqual(['did:plc:steady', 'did:plc:steady']);
  });

  it('renders the chosen offer as the recommendation, says whose decision it was, and keeps the ranking’s #1 as an alternative', () => {
    const built = chosen({
      supplierDid: 'did:plc:steady',
      reason: 'your rule — a proven seller over the cheapest',
      setAside: [{ supplierDid: 'did:plc:sworn', reason: 'you swore off ChairMaker after a cracked base' }],
    });
    const labels = built.fields.map((f) => f.label);
    expect(valueOf(built.fields, 'Recommended')).toBe('Steady Seats (did:plc:steady)');
    expect(valueOf(built.fields, 'Chosen for')).toBe('your rule — a proven seller over the cheapest');
    expect(valueOf(built.fields, 'Set aside')).toBe('ChairMaker (did:plc:sworn): you swore off ChairMaker after a cracked base');
    // The decision reads before the price; the ranking's own "Why" lines stay beneath.
    expect(labels.indexOf('Chosen for')).toBeLessThan(labels.indexOf('Indicative price'));
    expect(labels.indexOf('Set aside')).toBeLessThan(labels.indexOf('Why'));
    // The chosen offer's OWN ranking facts, not the #1's: its price, its
    // score, its factor lines.
    expect(valueOf(built.fields, 'Indicative price')).toBe('INR 500.00');
    const ranking = rankOffers([CHEAP, STEADY, SWORN], REQUIREMENTS, AT);
    const steady = ranking.ranked.find((r) => r.offer.supplierDid === 'did:plc:steady');
    expect(valueOf(built.fields, 'Confidence')).toBe(`${String(steady?.scoreBp)} of 10000`);
    expect(built.fields.filter((f) => f.label === 'Why').map((f) => f.value)).toEqual(
      steady?.components.map((c) => `${c.factor}: ${String(c.contributionBp)} of ${String(c.weightBp)}`),
    );
    // The passed-over #1 is still on the table; the set-aside seller is not.
    expect(built.alternatives.map((a) => a.supplierDid)).toEqual(['did:plc:cheap']);
    expect(built.handoff?.map((h) => h.supplierDid)).toEqual(['did:plc:cheap', 'did:plc:steady']);
    expect(built.primaryAction).toBe('where_to_buy');
  });

  it('a choice of NOTHING (every offer ruled out) is a card in the owner’s terms, with the offers still listed', () => {
    const built = chosen({
      reason: 'nothing on the network fits your ₹4,000 cap',
      setAside: [{ supplierDid: 'did:plc:sworn', reason: 'sworn off' }],
    });
    expect(valueOf(built.fields, 'Recommended')).toBe('none — nothing on the network fits your ₹4,000 cap');
    expect(valueOf(built.fields, 'Set aside')).toBe('ChairMaker (did:plc:sworn): sworn off');
    expect(built.alternatives.map((a) => a.supplierDid)).toEqual(['did:plc:cheap', 'did:plc:steady']);
    expect(built.handoff?.some((h) => h.supplierDid === 'did:plc:sworn')).toBe(false);
  });

  it('refuses a choice that names an offer the ranking does not hold — never a silent fallback to #1', () => {
    expect(() => chosen({ supplierDid: 'did:plc:nobody', reason: 'x' })).toThrow(/not among the ranked offers/);
  });
});
