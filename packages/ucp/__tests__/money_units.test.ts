import {
  addExact,
  checkTotals,
  MAX_AMOUNT,
  parseAmount,
  parsePrice,
  parseSignedAmount,
  parseTotals,
} from '../src/money';
import {
  decimalFromSteps,
  EACH,
  fitsIncrement,
  formatQuantity,
  fromDinaQuantity,
  parseQuantityUnit,
  parseSteps,
  sameUnitIdentity,
  toDinaQuantity,
} from '../src/units';

import { must } from './helpers';

describe('money', () => {
  it('reads safe non-negative integers only', () => {
    expect(parseAmount(2500)).toBe(2500n);
    expect(parseAmount(0)).toBe(0n);
    expect(parseAmount(Number(MAX_AMOUNT))).toBe(MAX_AMOUNT);
    for (const bad of [-1, 1.5, '25', 2 ** 53, Number.NaN, null])
      expect(parseAmount(bad)).toBeNull();
    expect(parseSignedAmount(-250)).toBe(-250n);
  });
  it('reads a price and refuses a bad currency', () => {
    expect(parsePrice({ amount: 79, currency: 'USD' })).toEqual({ amount: 79n, currency: 'USD' });
    expect(parsePrice({ amount: 79, currency: 'usd' })).toBeNull();
    expect(parsePrice({ amount: 79 })).toBeNull();
  });
  it('adds exactly and refuses to leave the 2^53-1 bound', () => {
    expect(addExact(MAX_AMOUNT - 1n, 1n)).toBe(MAX_AMOUNT);
    expect(addExact(MAX_AMOUNT, 1n)).toBeNull();
  });
});

describe('totals', () => {
  const discountExample = [
    { type: 'subtotal', display_text: 'Subtotal', amount: 5000 },
    { type: 'items_discount', display_text: 'Discounts', amount: -250 },
    { type: 'total', display_text: 'Total', amount: 4750 },
  ];
  it('parses the spec example (discount.md) and finds it consistent', () => {
    const parsed = parseTotals(discountExample);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(checkTotals(parsed.totals)).toBe('consistent');
  });
  it('counts an unknown type by its own sign', () => {
    const parsed = parseTotals([
      { type: 'subtotal', amount: 1000 },
      { type: 'eco_fee', display_text: 'Eco fee', amount: 50 },
      { type: 'total', amount: 1050 },
    ]);
    expect(parsed.ok && checkTotals(parsed.totals)).toBe('consistent');
  });
  it('finds a mismatch, and a sub-line mismatch', () => {
    const a = parseTotals([
      { type: 'subtotal', amount: 1000 },
      { type: 'tax', amount: 80 },
      { type: 'total', amount: 1000 },
    ]);
    expect(a.ok && checkTotals(a.totals)).toBe('inconsistent');
    const b = parseTotals([
      { type: 'subtotal', amount: 1000 },
      {
        type: 'tax',
        amount: 80,
        lines: [
          { display_text: 'State', amount: 50 },
          { display_text: 'City', amount: 20 },
        ],
      },
      { type: 'total', amount: 1080 },
    ]);
    expect(b.ok && checkTotals(b.totals)).toBe('inconsistent');
  });
  it.each([
    [
      'two subtotals',
      [
        { type: 'subtotal', amount: 1 },
        { type: 'subtotal', amount: 1 },
        { type: 'total', amount: 2 },
      ],
      'subtotal_count',
    ],
    ['no total', [{ type: 'subtotal', amount: 1 }], 'total_count'],
    [
      'positive discount',
      [
        { type: 'subtotal', amount: 1 },
        { type: 'discount', amount: 1 },
        { type: 'total', amount: 2 },
      ],
      'total_sign_discount',
    ],
    [
      'negative tax',
      [
        { type: 'subtotal', amount: 1 },
        { type: 'tax', amount: -1 },
        { type: 'total', amount: 0 },
      ],
      'total_sign_tax',
    ],
    [
      'unknown type without display_text',
      [
        { type: 'subtotal', amount: 1 },
        { type: 'x', amount: 1 },
        { type: 'total', amount: 2 },
      ],
      'unknown_total_without_display_text',
    ],
    [
      'float amount',
      [
        { type: 'subtotal', amount: 1.5 },
        { type: 'total', amount: 1.5 },
      ],
      'total_amount',
    ],
  ])('refuses %s', (_n, totals, reason) => {
    expect(parseTotals(totals)).toEqual({ ok: false, reason });
  });
});

describe('units', () => {
  const bananas = { unit: 'LBR', scale: 2, display_text: 'lb', increment: 25 };
  it('parses the spec bananas descriptor and defaults scale and increment', () => {
    expect(parseQuantityUnit(bananas)).toEqual({
      unit: 'LBR',
      scale: 2,
      displayText: 'lb',
      increment: 25,
    });
    expect(parseQuantityUnit({ unit: 'KGM', display_text: 'kg' })).toEqual({
      unit: 'KGM',
      scale: 0,
      displayText: 'kg',
      increment: 1,
    });
  });
  it.each([
    ['C62 with a scale', { unit: 'C62', scale: 1, display_text: 'each' }],
    ['scale 16', { unit: 'KGM', scale: 16, display_text: 'kg' }],
    ['no display_text', { unit: 'KGM' }],
    ['increment 0', { unit: 'KGM', display_text: 'kg', increment: 0 }],
  ])('refuses %s', (_n, value) => {
    expect(parseQuantityUnit(value)).toBeNull();
  });
  it('compares identity on unit and scale only', () => {
    expect(sameUnitIdentity({ unit: 'KGM', scale: 3 }, { unit: 'KGM', scale: 3 })).toBe(true);
    expect(sameUnitIdentity({ unit: 'KGM', scale: 3 }, { unit: 'KGM', scale: 2 })).toBe(false);
  });
  it('checks increments', () => {
    const u = must(parseQuantityUnit(bananas));
    expect(fitsIncrement(150n, u)).toBe(true);
    expect(fitsIncrement(160n, u)).toBe(false);
  });
  it('reads step counts', () => {
    expect(parseSteps(3)).toBe(3n);
    expect(parseSteps(0)).toBeNull();
    expect(parseSteps(0, { allowZero: true })).toBe(0n);
    expect(parseSteps(1.5)).toBeNull();
  });
  it('formats steps (150 lb@2 → "1.5 lb"), and canonical decimals drop trailing zeros', () => {
    expect(formatQuantity(150n, must(parseQuantityUnit(bananas)))).toBe('1.5 lb');
    expect(decimalFromSteps(5n, 3)).toBe('0.005');
    expect(decimalFromSteps(1000n, 3)).toBe('1');
    expect(formatQuantity(2n)).toBe('2 each');
  });
  it('converts to Dina quantities exactly, or not at all', () => {
    expect(toDinaQuantity(2n)).toEqual({ value: '2', unit_code: 'each' });
    expect(
      toDinaQuantity(1500n, must(parseQuantityUnit({ unit: 'KGM', scale: 3, display_text: 'kg' }))),
    ).toEqual({
      value: '1.5',
      unit_code: 'kg',
    });
    // kg holds three fraction digits; 1.0005 kg would need four.
    expect(
      toDinaQuantity(
        10005n,
        must(parseQuantityUnit({ unit: 'KGM', scale: 4, display_text: 'kg' })),
      ),
    ).toBeNull();
    // grams are whole in Dina.
    expect(
      toDinaQuantity(15n, must(parseQuantityUnit({ unit: 'GRM', scale: 1, display_text: 'g' }))),
    ).toBeNull();
    // an opaque unit is never converted.
    expect(toDinaQuantity(150n, must(parseQuantityUnit(bananas)))).toBeNull();
  });
  it.each([
    ['C62', 0, 3n, { value: '3', unit_code: 'each' }],
    ['GRM', 0, 250n, { value: '250', unit_code: 'g' }],
    ['KGM', 3, 1250n, { value: '1.25', unit_code: 'kg' }],
    ['MLT', 0, 330n, { value: '330', unit_code: 'ml' }],
    ['LTR', 3, 1500n, { value: '1.5', unit_code: 'l' }],
  ] as const)('maps Rec 20 %s exactly, both ways', (unit, scale, steps, dina) => {
    const basis = must(parseQuantityUnit({ unit, scale, display_text: unit }));
    expect(toDinaQuantity(steps, basis)).toEqual(dina);
    expect(fromDinaQuantity(dina, basis)).toBe(steps);
  });
  it.each(['XPX', 'CS', 'H87'])('refuses %s (pallet, case, piece): no exact Dina unit', (unit) => {
    expect(toDinaQuantity(1n, must(parseQuantityUnit({ unit, display_text: unit })))).toBeNull();
  });
  it('converts from Dina quantities into a sale basis', () => {
    const kg3 = must(parseQuantityUnit({ unit: 'KGM', scale: 3, display_text: 'kg' }));
    expect(fromDinaQuantity({ value: '1.5', unit_code: 'kg' }, kg3)).toBe(1500n);
    expect(fromDinaQuantity({ value: '1.5', unit_code: 'kg' }, { ...kg3, scale: 0 })).toBeNull();
    expect(fromDinaQuantity({ value: '2', unit_code: 'case' }, EACH)).toBeNull();
    expect(fromDinaQuantity({ value: '2', unit_code: 'g' }, kg3)).toBeNull();
    expect(fromDinaQuantity({ value: '01', unit_code: 'each' }, EACH)).toBeNull();
  });
});
