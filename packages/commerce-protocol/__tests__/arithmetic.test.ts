import {
  computeLineSubtotal,
  computeTotal,
  roundRationalHalfEven,
  validateCharge,
  type Charge,
} from '../src/arithmetic';
import { MAX_MONEY_MINOR_UNIT_DIGITS, type Money } from '../src/money';

const inr = (minor_units: string): Money => ({ currency: 'INR', minor_units });
const q = (value: string, unit_code: string) => ({ value, unit_code });

describe('roundRationalHalfEven', () => {
  it('rounds down below the midpoint and up above it', () => {
    expect(roundRationalHalfEven(74n, 10n)).toBe(7n); // 7.4
    expect(roundRationalHalfEven(76n, 10n)).toBe(8n); // 7.6
  });

  it('resolves exact ties to the even neighbour', () => {
    expect(roundRationalHalfEven(75n, 10n)).toBe(8n); // 7.5 -> 8 (even)
    expect(roundRationalHalfEven(85n, 10n)).toBe(8n); // 8.5 -> 8 (even)
    expect(roundRationalHalfEven(5n, 10n)).toBe(0n); // 0.5 -> 0 (even)
    expect(roundRationalHalfEven(15n, 10n)).toBe(2n); // 1.5 -> 2 (even)
  });

  it('is exact for integers', () => {
    expect(roundRationalHalfEven(21n, 3n)).toBe(7n);
    expect(roundRationalHalfEven(0n, 7n)).toBe(0n);
  });

  it('rejects nonsense inputs', () => {
    expect(() => roundRationalHalfEven(1n, 0n)).toThrow(/positive/);
    expect(() => roundRationalHalfEven(-1n, 2n)).toThrow(/negative/);
  });
});

describe('computeLineSubtotal', () => {
  it('computes per-unit pricing exactly', () => {
    // INR 5.00 per each × 100 each = INR 500.00
    expect(computeLineSubtotal(inr('500'), q('100', 'each'), q('1', 'each'))).toEqual({
      value: inr('50000'),
      error: null,
    });
  });

  it('handles fractional ratios with one half-even rounding', () => {
    // 15 minor units per each × 0.5 ratio -> 7.5 -> 8 (half-even).
    expect(computeLineSubtotal(inr('15'), q('1', 'each'), q('2', 'each'))).toEqual({
      value: inr('8'),
      error: null,
    });
    // 17 × 0.5 -> 8.5 -> 8 (half-even to even).
    expect(computeLineSubtotal(inr('17'), q('1', 'each'), q('2', 'each'))).toEqual({
      value: inr('8'),
      error: null,
    });
  });

  it('converts across declared unit factors exactly (kg/g, l/ml)', () => {
    // INR 500.00 per kg × 1500 g = INR 750.00
    expect(computeLineSubtotal(inr('50000'), q('1500', 'g'), q('1', 'kg'))).toEqual({
      value: inr('75000'),
      error: null,
    });
    // INR 90.00 per l × 250 ml = INR 22.50
    expect(computeLineSubtotal(inr('9000'), q('250', 'ml'), q('1', 'l'))).toEqual({
      value: inr('2250'),
      error: null,
    });
    // Fractional vocabulary scale: 1.5 kg at per-kg pricing is legal.
    expect(computeLineSubtotal(inr('50000'), q('1.5', 'kg'), q('1', 'kg'))).toEqual({
      value: inr('75000'),
      error: null,
    });
  });

  it('prices per case against case quantities (same-code pack units)', () => {
    expect(computeLineSubtotal(inr('120000'), q('12', 'case'), q('1', 'case'))).toEqual({
      value: inr('1440000'),
      error: null,
    });
  });

  it('refuses conversions that need pack evidence — the line is invalid, not rounded', () => {
    const { value, error } = computeLineSubtotal(inr('100'), q('24', 'each'), q('1', 'case'));
    expect(value).toBeNull();
    expect(error).toMatch(/no exact declared conversion/);
  });

  it('refuses cross-dimension pricing', () => {
    const { error } = computeLineSubtotal(inr('100'), q('1', 'kg'), q('1', 'l'));
    expect(error).toMatch(/no exact declared conversion/);
  });

  it('refuses a zero price basis', () => {
    const { error } = computeLineSubtotal(inr('100'), q('1', 'each'), q('0', 'each'));
    expect(error).toMatch(/must be positive/);
  });

  it('revalidates its inputs (arithmetic never trusts upstream validation)', () => {
    expect(computeLineSubtotal(inr('1.5'), q('1', 'each'), q('1', 'each')).error).toMatch(/money/);
    expect(computeLineSubtotal(inr('100'), q('1.50', 'kg'), q('1', 'kg')).error).toMatch(
      /canonical/,
    );
  });

  it('fails on overflow instead of wrapping', () => {
    const nearMax = '9'.repeat(MAX_MONEY_MINOR_UNIT_DIGITS);
    const { value, error } = computeLineSubtotal(inr(nearMax), q('1000', 'each'), q('1', 'each'));
    expect(value).toBeNull();
    expect(error).toMatch(/magnitude bound/);
  });
});

describe('validateCharge', () => {
  it('accepts a typed adjustment', () => {
    const charge: Charge = { kind: 'tax', label: 'GST 5%', amount: inr('2500'), operation: 'add' };
    expect(validateCharge(charge)).toBeNull();
  });

  it('rejects unknown kinds, operations, and empty labels', () => {
    expect(
      validateCharge({ kind: 'surge', label: 'x', amount: inr('1'), operation: 'add' }),
    ).toMatch(/kind/);
    expect(
      validateCharge({ kind: 'tax', label: 'x', amount: inr('1'), operation: 'negate' }),
    ).toMatch(/operation/);
    expect(validateCharge({ kind: 'tax', label: '', amount: inr('1'), operation: 'add' })).toMatch(
      /label/,
    );
  });

  it('rejects negative-money smuggling (discounts are typed subtracts)', () => {
    expect(
      validateCharge({
        kind: 'discount',
        label: 'promo',
        amount: inr('-500'),
        operation: 'subtract',
      }),
    ).toMatch(/money/);
  });
});

describe('computeTotal', () => {
  it('sums lines and charges as plain integers', () => {
    const total = computeTotal(
      'INR',
      [inr('50000'), inr('2250')],
      [
        { kind: 'delivery', label: 'delivery', amount: inr('1500'), operation: 'add' },
        { kind: 'discount', label: 'first order', amount: inr('750'), operation: 'subtract' },
      ],
    );
    expect(total).toEqual({ value: inr('53000'), error: null });
  });

  it('requires at least one line', () => {
    expect(computeTotal('INR', [], []).error).toMatch(/at least one line/);
  });

  it('rejects mixed currencies in one document', () => {
    expect(
      computeTotal('INR', [inr('100'), { currency: 'USD', minor_units: '5' }], []).error,
    ).toMatch(/mixed currencies/);
    expect(
      computeTotal(
        'INR',
        [inr('100')],
        [
          {
            kind: 'tax',
            label: 't',
            amount: { currency: 'USD', minor_units: '5' },
            operation: 'add',
          },
        ],
      ).error,
    ).toMatch(/mixed currencies/);
  });

  it('rejects a subtraction that drives the FINAL total negative', () => {
    // Non-negativity did not go away when order-independence landed; it
    // moved from every intermediate value to the result, and is owned by
    // minorUnitsToString rather than duplicated in computeTotal.
    const { value, error } = computeTotal(
      'INR',
      [inr('100')],
      [{ kind: 'discount', label: 'too big', amount: inr('200'), operation: 'subtract' }],
    );
    expect(value).toBeNull();
    // Pin the OWNER's message, so a future duplicate check in computeTotal
    // cannot satisfy this test while the real guard is deleted.
    expect(error).toMatch(/money: computed value is negative/);
  });

  it('the total is INDEPENDENT of charge order (§9.1 plain integer sum)', () => {
    // This replaces a test that asserted the opposite. Rejecting an
    // intermediate negative made validity depend on iteration order:
    // subtotal 100, subtract 200, add 500 was refused, while the same three
    // charges reordered summed to 400 and passed. §9.1 specifies a plain
    // integer sum, so two conforming implementations iterating a charge set
    // differently must agree — otherwise byte-identical totals are false for
    // any invoice where a discount precedes a surcharge, which is ordinary.
    const discountFirst = computeTotal(
      'INR',
      [inr('100')],
      [
        { kind: 'discount', label: 'big', amount: inr('200'), operation: 'subtract' },
        { kind: 'delivery', label: 'later add', amount: inr('500'), operation: 'add' },
      ],
    );
    const addFirst = computeTotal(
      'INR',
      [inr('100')],
      [
        { kind: 'delivery', label: 'later add', amount: inr('500'), operation: 'add' },
        { kind: 'discount', label: 'big', amount: inr('200'), operation: 'subtract' },
      ],
    );
    expect(discountFirst.error).toBeNull();
    expect(discountFirst.value).toEqual(addFirst.value);
    expect(discountFirst.value?.minor_units).toBe('400');
  });

  it('fails on overflow instead of wrapping', () => {
    const nearMax = '9'.repeat(MAX_MONEY_MINOR_UNIT_DIGITS);
    const { error } = computeTotal('INR', [inr(nearMax), inr('1')], []);
    expect(error).toMatch(/magnitude bound/);
  });
});
