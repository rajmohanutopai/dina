import {
  MAX_QUANTITY_INTEGER_DIGITS,
  compareQuantities,
  quantityToRational,
  validateQuantity,
} from '../src/quantity';

describe('validateQuantity', () => {
  it('accepts canonical values within the unit scale', () => {
    expect(validateQuantity({ value: '100', unit_code: 'each' })).toBeNull();
    expect(validateQuantity({ value: '0', unit_code: 'g' })).toBeNull();
    expect(validateQuantity({ value: '1.5', unit_code: 'kg' })).toBeNull();
    expect(validateQuantity({ value: '0.001', unit_code: 'l' })).toBeNull();
    expect(
      validateQuantity({ value: '9'.repeat(MAX_QUANTITY_INTEGER_DIGITS), unit_code: 'ml' }),
    ).toBeNull();
  });

  it('rejects a bare number without a unit ("100" without a unit is invalid)', () => {
    expect(validateQuantity({ value: '100' })).toMatch(/unit_code/);
    expect(validateQuantity({ value: '100', unit_code: '' })).toMatch(/unknown unit/);
  });

  it('rejects units outside the closed v1 vocabulary, including custom codes', () => {
    expect(validateQuantity({ value: '1', unit_code: 'lb' })).toMatch(/unknown unit/);
    expect(validateQuantity({ value: '1', unit_code: 'custom:did:plc:abc#sack' })).toMatch(
      /custom units are not valid in v1/,
    );
  });

  it('rejects non-canonical decimal spellings', () => {
    for (const value of ['01', '1.', '.5', '1.50', '+1', '-1', '1e3', '1,5', ' 1', '']) {
      expect(validateQuantity({ value, unit_code: 'kg' })).not.toBeNull();
    }
  });

  it('rejects scale overflow instead of rounding (§9.1)', () => {
    expect(validateQuantity({ value: '1.2345', unit_code: 'kg' })).toMatch(/declared scale of 3/);
    expect(validateQuantity({ value: '1.5', unit_code: 'each' })).toMatch(/declared scale of 0/);
    expect(validateQuantity({ value: '2.25', unit_code: 'case' })).toMatch(/declared scale of 0/);
  });

  it('rejects integer magnitude overflow', () => {
    const over = '1'.repeat(MAX_QUANTITY_INTEGER_DIGITS + 1);
    expect(validateQuantity({ value: over, unit_code: 'each' })).toMatch(/magnitude bound/);
  });

  it('enforces require_positive for line quantities', () => {
    expect(validateQuantity({ value: '0', unit_code: 'each' }, { require_positive: true })).toMatch(
      /must be positive/,
    );
    expect(
      validateQuantity({ value: '1', unit_code: 'each' }, { require_positive: true }),
    ).toBeNull();
  });
});

describe('quantityToRational', () => {
  it('normalizes convertible units to the dimension base exactly', () => {
    // 1.5 kg: scaled 15 at scale 1, factor 1000 -> 15000/10 = 1500 g exact.
    const kg = quantityToRational({ value: '1.5', unit_code: 'kg' });
    expect(kg.numerator).toBe(15000n);
    expect(kg.denominator).toBe(10n);
    expect(kg.numerator / kg.denominator).toBe(1500n);
    expect(kg.numerator % kg.denominator).toBe(0n);

    const l = quantityToRational({ value: '0.001', unit_code: 'l' });
    expect(l.numerator / l.denominator).toBe(1n); // 1 ml exact
  });

  it('keeps pack-evidence units in their own kind', () => {
    const cases = quantityToRational({ value: '12', unit_code: 'case' });
    expect(cases.numerator).toBe(12n);
    expect(cases.denominator).toBe(1n);
    expect(cases.unit.code).toBe('case');
  });
});

describe('compareQuantities', () => {
  it('compares across convertible units exactly', () => {
    expect(
      compareQuantities({ value: '1.5', unit_code: 'kg' }, { value: '1500', unit_code: 'g' }),
    ).toBe(0);
    expect(
      compareQuantities({ value: '1.499', unit_code: 'kg' }, { value: '1500', unit_code: 'g' }),
    ).toBe(-1);
    expect(
      compareQuantities({ value: '2', unit_code: 'l' }, { value: '1999', unit_code: 'ml' }),
    ).toBe(1);
  });

  it('compares same-code pack units', () => {
    expect(
      compareQuantities({ value: '3', unit_code: 'case' }, { value: '3', unit_code: 'case' }),
    ).toBe(0);
  });

  it('refuses pack-evidence conversion with a typed error', () => {
    const result = compareQuantities(
      { value: '1', unit_code: 'case' },
      { value: '12', unit_code: 'each' },
    );
    expect(typeof result).toBe('string');
    expect(result).toMatch(/pack evidence/);
  });

  it('refuses cross-dimension comparison', () => {
    const result = compareQuantities({ value: '1', unit_code: 'kg' }, { value: '1', unit_code: 'l' });
    expect(typeof result).toBe('string');
  });
});
