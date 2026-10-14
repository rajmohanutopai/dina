/**
 * SHELF_SPACE_NEGOTIATION on the phone — the store's terms form ↔ Core's
 * policy (rupees and percentages in, minor units and basis points out), the
 * brand's request form, labels, and the deep-link guard.
 */

import { DEFAULT_TERM_POLICY, validateTermPolicy } from '@dina/core';

import {
  bpsText,
  emptyHolding,
  emptySlot,
  formToPolicy,
  policyToForm,
  readListingUri,
  requestToNegotiation,
  termsText,
  type HoldingForm,
  type RequestForm,
  type TermsForm,
} from '../../src/services/shelf_space';

function filledForm(over: Partial<TermsForm['slots'][number]> = {}): TermsForm {
  return {
    enabled: true,
    maxRounds: '3',
    rules: [{ tag: 'beverages.juice', premiumPercent: '15', maxBrands: '4' }],
    holdings: [],
    slots: [
      {
        ...emptySlot('INR'),
        resourceRef: 'slot-3',
        askingRent: '2500',
        askingSharePercent: '10',
        floorRent: '1500',
        autoRent: '1800',
        floorSharePercent: '5',
        availableFrom: '2027-01-01',
        availableTo: '2028-12-31',
        trialDays: '14',
        trialRent: '500',
        ...over,
      },
    ],
  };
}

describe('the store’s terms form', () => {
  it('turns rupees and percentages into minor units and basis points, and back', () => {
    const built = formToPolicy(filledForm(), DEFAULT_TERM_POLICY);
    if (!built.ok) throw new Error(built.problem);
    const [slot] = built.policy.resources;
    expect(slot).toEqual({
      resource_ref: 'slot-3',
      currency: 'INR',
      asking: { fee: '250000', share_bps: '1000' },
      floors: { fee: { hard: '150000', auto: '180000' }, share_bps: { hard: '500' } },
      available: { from: '2027-01-01T00:00:00Z', to: '2028-12-31T00:00:00Z' },
      conditions: {
        period: 'monthly',
        cash_handler: 'vendor',
        exit_notice_days: 30,
        trial: { days: 14, fee_minor: '50000' },
      },
    });
    expect(built.policy.holding_rules).toEqual([
      { tag: 'beverages.juice', premium_bps_per_count: 1500, max_count: 4 },
    ]);
    // Who may ask is set per listing (§6.2); the policy carries no such field.
    expect('access' in built.policy).toBe(false);
    expect(validateTermPolicy(built.policy)).toBeNull();
    // Everything the form does not edit comes from the stored policy.
    expect(DEFAULT_TERM_POLICY).toBeDefined();
    expect(built.policy.windowSeconds).toBe(DEFAULT_TERM_POLICY.windowSeconds);
    expect(built.policy.manual_holdings).toEqual([]);
    const back = policyToForm(built.policy);
    expect(back.slots[0]).toMatchObject({
      askingRent: '2500.00',
      askingSharePercent: '10',
      autoRent: '1800.00',
      trialDays: '14',
    });
    expect(back.rules[0]).toEqual({ tag: 'beverages.juice', premiumPercent: '15', maxBrands: '4' });
  });

  it('saving an unrelated change keeps what the form does not show: the automatic share limit and stock duties', () => {
    const built = formToPolicy(filledForm(), DEFAULT_TERM_POLICY);
    if (!built.ok) throw new Error(built.problem);
    const stored = {
      ...built.policy,
      resources: built.policy.resources.map((r) => ({
        ...r,
        floors: { ...r.floors, share_bps: { hard: '500', auto: '800' } },
        conditions: { ...r.conditions, stock_duties: { min_skus: 4, restock_days: 7 } },
      })),
    };
    expect(validateTermPolicy(stored)).toBeNull();
    // The owner opens the form and changes only the notice period.
    const form = policyToForm(stored);
    const edited = { ...form, slots: form.slots.map((slot) => ({ ...slot, exitNoticeDays: '45' })) };
    const saved = formToPolicy(edited, stored);
    if (!saved.ok) throw new Error(saved.problem);
    const [slot] = saved.policy.resources;
    expect(slot?.floors.share_bps).toEqual({ hard: '500', auto: '800' });
    expect(slot?.conditions.stock_duties).toEqual({ min_skus: 4, restock_days: 7 });
    expect(slot?.conditions.exit_notice_days).toBe(45);
    // Raising the lowest share past the old automatic limit leaves no limit below it.
    const raised = formToPolicy(
      { ...form, slots: form.slots.map((s2) => ({ ...s2, floorSharePercent: '9' })) },
      stored,
    );
    if (!raised.ok) throw new Error(raised.problem);
    expect(raised.policy.resources[0]?.floors.share_bps).toEqual({ hard: '900' });
  });

  it.each<[Partial<TermsForm['slots'][number]>, RegExp]>([
    [{ resourceRef: 'slot 3!' }, /short name/],
    [{ currency: 'rupees' }, /three-letter/],
    [{ askingRent: 'a lot' }, /amounts/],
    [{ askingSharePercent: '150' }, /percentages/],
    [{ askingRent: '0', askingSharePercent: '0' }, /rent, a share of sales, or both/],
    [{ askingSharePercent: '0', cashHandler: 'host' }, /keeps its own takings/],
    [{ autoRent: '1000' }, /cannot be below your lowest rent/],
    [{ availableTo: '2026-01-01' }, /end after the start/],
    [{ exitNoticeDays: '400' }, /notice/],
    [{ trialDays: '0' }, /trial/],
  ])('catches a typo beside the field: %o', (over, problem) => {
    const built = formToPolicy(filledForm(over), DEFAULT_TERM_POLICY);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.problem).toMatch(problem);
  });

  it('two slots with one name are refused', () => {
    const form = filledForm();
    const [first] = form.slots;
    if (first === undefined) throw new Error('fixture has a slot');
    form.slots.push({ ...first });
    const built = formToPolicy(form, DEFAULT_TERM_POLICY);
    expect(built.ok).toBe(false);
  });
});

describe('brands placed outside Dina (§5.4 manual holdings)', () => {
  const holding = (over: Partial<HoldingForm> = {}): HoldingForm => ({
    ...emptyHolding('beverages.juice'),
    startDay: '2027-01-01',
    endDay: '2027-12-01',
    ...over,
  });

  it('a new holding is named on save without clashing; a kept one keeps its id and its slot', () => {
    const form = filledForm();
    form.holdings = [
      holding({ holdingId: 'holding-1', resourceRef: 'slot-3' }),
      holding(),
      holding({ tag: 'snacks' }),
    ];
    const built = formToPolicy(form, DEFAULT_TERM_POLICY);
    if (!built.ok) throw new Error(built.problem);
    expect(built.policy.manual_holdings).toEqual([
      {
        holding_id: 'holding-1',
        tag: 'beverages.juice',
        resource_ref: 'slot-3',
        start: '2027-01-01T00:00:00Z',
        end: '2027-12-01T00:00:00Z',
      },
      {
        holding_id: 'holding-2',
        tag: 'beverages.juice',
        start: '2027-01-01T00:00:00Z',
        end: '2027-12-01T00:00:00Z',
      },
      {
        holding_id: 'holding-3',
        tag: 'snacks',
        start: '2027-01-01T00:00:00Z',
        end: '2027-12-01T00:00:00Z',
      },
    ]);
    // Core's own validator takes what the form builds.
    expect(validateTermPolicy(built.policy)).toBeNull();
    // And the stored policy reads back as the same form.
    expect(policyToForm(built.policy).holdings[1]).toEqual(holding({ holdingId: 'holding-2' }));
  });

  it.each<[Partial<HoldingForm>, RegExp]>([
    [{ tag: '' }, /pick its category/],
    [{ resourceRef: 'slot-9' }, /not one of your slots/],
    [{ startDay: '1 Jan' }, /YYYY-MM-DD/],
    [{ endDay: '2026-12-01' }, /end must come after the start/],
  ])('catches %o', (over, problem) => {
    const form = filledForm();
    form.holdings = [holding(over)];
    const built = formToPolicy(form, DEFAULT_TERM_POLICY);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.problem).toMatch(problem);
  });
});

describe('the brand’s request form', () => {
  const form: RequestForm = {
    tag: 'beverages.juice',
    products: 'cold-pressed juice',
    skus: '4',
    startDay: '2027-02-01',
    endDay: '2027-08-01',
    currency: 'INR',
    targetRent: '1700',
    targetSharePercent: '6',
    maxRent: '2200',
    maxSharePercent: '9',
    expectedSales: '20000',
    period: 'monthly',
    rounds: '3',
    days: '3',
  };

  it('becomes the negotiation’s limits', () => {
    const built = requestToNegotiation(form);
    if (!built.ok) throw new Error(built.problem);
    expect(built.policy).toEqual({
      currency: 'INR',
      targets: { fee: '170000', share_bps: '600' },
      ceilings: { fee: '220000', share_bps: '900' },
      expected_sales_minor: '2000000',
      period: 'monthly',
      max_rounds: 3,
      deadline_seconds: 3 * 24 * 60 * 60,
    });
    expect(built.attributes).toEqual({ products: 'cold-pressed juice', skus: 4 });
    expect(built.start).toBe('2027-02-01T00:00:00Z');
  });

  it.each<[Partial<RequestForm>, RegExp]>([
    [{ endDay: '2027-01-01' }, /end after the start/],
    [{ targetRent: '3000' }, /within the most you will pay/],
    [{ days: '9' }, /1 to 7 days/],
    [{ skus: '0' }, /whole number/],
  ])('refuses %o', (over, problem) => {
    const built = requestToNegotiation({ ...form, ...over });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.problem).toMatch(problem);
  });
});

describe('labels and the deep-link guard', () => {
  it('reads terms the way an owner says them', () => {
    const general = { currency: 'INR', period: 'monthly' as const };
    expect(
      termsText(
        [
          { name: 'fee', value: '195000' },
          { name: 'share_bps', value: '800' },
        ],
        general,
      ),
    ).toBe('INR 1950.00 a month + 8% of sales');
    expect(
      termsText(
        [
          { name: 'fee', value: '195000' },
          { name: 'share_bps', value: '0' },
        ],
        general,
      ),
    ).toBe('INR 1950.00 a month');
    expect(bpsText(1250)).toBe('12.5%');
  });

  it('a deep link may carry a listing address and nothing else', () => {
    const ok = 'at://did:plc:cornerstore000000000000000/com.dinakernel.commerce.termListing/slot-3';
    expect(readListingUri(ok)).toBe(ok);
    expect(readListingUri('at://did:plc:x/com.dinakernel.commerce.catalog/abc')).toBeNull();
    expect(readListingUri('https://evil.example/slot')).toBeNull();
    expect(readListingUri(undefined)).toBeNull();
  });
});
