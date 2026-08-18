/**
 * The khata fold (§4.4) — golden vectors. Every expected value below is
 * hand-computed from the pinned rules, so a conforming implementation
 * in any language can run the same inputs and must land on the same
 * paisa. Covers: short delivery, split delivery with proportional tax
 * and discount, zero-acceptance refusal, partial payment, overpayment
 * (direction flip), the delivery-charge first-positive-acceptance rule,
 * half-even ties, and the refusals (second currency, unknown line,
 * net-negative charges).
 */

import { computeTradeFold, type FoldOrder, type TradeFoldInput } from '../src/trade_fold';

const INR = (minor: string) => ({ currency: 'INR', minor_units: minor });
const EACH = (value: string) => ({ value, unit_code: 'each' });
const KG = (value: string) => ({ value, unit_code: 'kg' });
const G = (value: string) => ({ value, unit_code: 'g' });

function chairsOrder(overrides: Partial<FoldOrder> = {}): FoldOrder {
  return {
    purchase_order_id: 'po-1',
    lines: [
      {
        line_id: 'line-1',
        unit_price: INR('45000'), // ₹450.00 per chair
        price_basis: EACH('1'),
        ordered_quantity: EACH('10'),
      },
    ],
    charges: [
      { kind: 'delivery', label: 'freight', amount: INR('50000'), operation: 'add' },
      { kind: 'tax', label: 'gst', amount: INR('22500'), operation: 'add' },
      { kind: 'discount', label: 'scheme', amount: INR('10000'), operation: 'subtract' },
    ],
    receipted: [
      { line_id: 'line-1', delivered_quantity: EACH('10'), accepted_quantity: EACH('7') },
    ],
    ...overrides,
  };
}

function fold(input: Partial<TradeFoldInput>): ReturnType<typeof computeTradeFold> {
  return computeTradeFold({ currency: 'INR', orders: [], payments_received: [], ...input });
}

describe('golden vector 1 — short delivery with all three charge kinds', () => {
  // accepted 7/10 × ₹450 = 315000; full = 450000; fraction = 7/10.
  // delivery 50000 in full; tax 22500×0.7 = 15750; discount 10000×0.7 = 7000.
  // goods_owed = 315000 + 50000 + 15750 − 7000 = 373750.
  // disputed = 3 × 45000 = 135000.
  it('computes 373750 owed, 135000 disputed, buyer_owes 173750 after a 200000 payment', () => {
    const result = fold({ orders: [chairsOrder()], payments_received: [INR('200000')] });
    expect(result).toEqual({
      ok: true,
      currency: 'INR',
      goods_owed_minor: '373750',
      payments_minor: '200000',
      balance: { direction: 'buyer_owes', minor_units: '173750' },
      disputed_minor: '135000',
      per_order: [
        {
          purchase_order_id: 'po-1',
          goods_minor: '315000',
          charges_minor: '58750',
          disputed_minor: '135000',
        },
      ],
    });
  });

  it('overpayment flips the direction: supplier_owes 126250 after 500000', () => {
    const result = fold({ orders: [chairsOrder()], payments_received: [INR('500000')] });
    expect(result.ok && result.balance).toEqual({
      direction: 'supplier_owes',
      minor_units: '126250',
    });
  });
});

describe('golden vector 2 — split delivery sums exact rationals across units', () => {
  // 2.5 kg ordered at ₹100.00/kg. Receipts: 250 g + 0.75 kg = exactly 1 kg.
  // goods = 10000; full = 25000; tax 1000 × 10000/25000 = 400; owed 10400.
  const order: FoldOrder = {
    purchase_order_id: 'po-2',
    lines: [
      {
        line_id: 'line-1',
        unit_price: INR('10000'),
        price_basis: KG('1'),
        ordered_quantity: KG('2.5'),
      },
    ],
    charges: [{ kind: 'tax', label: 'gst', amount: INR('1000'), operation: 'add' }],
    receipted: [
      { line_id: 'line-1', delivered_quantity: G('250'), accepted_quantity: G('250') },
      { line_id: 'line-1', delivered_quantity: KG('0.75'), accepted_quantity: KG('0.75') },
    ],
  };

  it('250 g + 0.75 kg bills exactly 1 kg — 10400 owed, nothing disputed', () => {
    const result = fold({ orders: [order] });
    expect(result.ok && result.goods_owed_minor).toBe('10400');
    expect(result.ok && result.disputed_minor).toBe('0');
    expect(result.ok && result.balance).toEqual({ direction: 'buyer_owes', minor_units: '10400' });
  });
});

describe('golden vector 3 — zero acceptance accrues NOTHING', () => {
  it('a fully refused shipment owes 0 (no goods, no delivery charge) and disputes the delivered value', () => {
    const order = chairsOrder({
      receipted: [
        { line_id: 'line-1', delivered_quantity: EACH('10'), accepted_quantity: EACH('0') },
      ],
    });
    const result = fold({ orders: [order] });
    expect(result.ok && result.goods_owed_minor).toBe('0');
    expect(result.ok && result.disputed_minor).toBe('450000');
    expect(result.ok && result.balance).toEqual({ direction: 'settled', minor_units: '0' });
  });

  it('an unreceipted order (cancelled after acceptance, nothing shipped) contributes nothing', () => {
    const result = fold({ orders: [chairsOrder({ receipted: [] })] });
    expect(result.ok && result.goods_owed_minor).toBe('0');
    expect(result.ok && result.disputed_minor).toBe('0');
  });
});

describe('golden vector 4 — half-even ties round to even', () => {
  // accepted 5/10 → fraction 1/2. tax 25 → 12.5 → 12 (even); a second
  // tax 35 → 17.5 → 18 (even). goods = 225000.
  it('12.5 → 12 and 17.5 → 18 under the one permitted rounding', () => {
    const order = chairsOrder({
      charges: [
        { kind: 'tax', label: 'a', amount: INR('25'), operation: 'add' },
        { kind: 'tax', label: 'b', amount: INR('35'), operation: 'add' },
      ],
      receipted: [
        { line_id: 'line-1', delivered_quantity: EACH('5'), accepted_quantity: EACH('5') },
      ],
    });
    const result = fold({ orders: [order] });
    expect(result.ok && result.per_order[0]?.charges_minor).toBe('30'); // 12 + 18
    expect(result.ok && result.goods_owed_minor).toBe('225030');
  });
});

describe('refusals', () => {
  it('a second currency refuses — one currency per ledger, no conversion ever', () => {
    const order = chairsOrder({
      charges: [{ kind: 'tax', label: 'gst', amount: { currency: 'USD', minor_units: '1' }, operation: 'add' }],
    });
    const result = fold({ orders: [order] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('one currency per ledger');

    const payment = fold({ payments_received: [{ currency: 'USD', minor_units: '1' }] });
    expect(!payment.ok && payment.error).toContain('one currency per ledger');
  });

  it('a receipted entry for a line the order does not carry refuses', () => {
    const order = chairsOrder({
      receipted: [
        { line_id: 'line-9', delivered_quantity: EACH('1'), accepted_quantity: EACH('1') },
      ],
    });
    const result = fold({ orders: [order] });
    expect(!result.ok && result.error).toContain('unknown line');
  });

  it('net charges driving the goods total negative refuses (computeTotal parity)', () => {
    const order = chairsOrder({
      charges: [{ kind: 'discount', label: 'scheme', amount: INR('9999999'), operation: 'subtract' }],
      receipted: [
        { line_id: 'line-1', delivered_quantity: EACH('1'), accepted_quantity: EACH('1') },
      ],
    });
    const result = fold({ orders: [order] });
    expect(!result.ok && result.error).toContain('negative');
  });

  it('an incomparable unit against the price basis refuses', () => {
    const order = chairsOrder({
      receipted: [
        { line_id: 'line-1', delivered_quantity: KG('1'), accepted_quantity: KG('1') },
      ],
    });
    const result = fold({ orders: [order] });
    expect(result.ok).toBe(false);
  });
});

describe('determinism', () => {
  it('receipt entry order never changes the fold (exact sums before the one rounding)', () => {
    const base: FoldOrder = {
      purchase_order_id: 'po-3',
      lines: [
        {
          line_id: 'line-1',
          unit_price: INR('333'),
          price_basis: KG('1'),
          ordered_quantity: KG('3'),
        },
      ],
      charges: [],
      receipted: [
        { line_id: 'line-1', delivered_quantity: G('333'), accepted_quantity: G('333') },
        { line_id: 'line-1', delivered_quantity: G('333'), accepted_quantity: G('333') },
        { line_id: 'line-1', delivered_quantity: KG('0.334'), accepted_quantity: KG('0.334') },
      ],
    };
    const forward = fold({ orders: [base] });
    const reversed = fold({
      orders: [{ ...base, receipted: [...base.receipted].reverse() }],
    });
    expect(forward).toEqual(reversed);
    // 333+333+334 g = 1 kg exactly → 333 minor, one rounding.
    expect(forward.ok && forward.goods_owed_minor).toBe('333');
  });
});
