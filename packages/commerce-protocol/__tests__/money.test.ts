import {
  MAX_MONEY_MINOR_UNIT_DIGITS,
  minorUnitsToString,
  moneyMinorUnits,
  validateMoney,
} from '../src/money';

describe('validateMoney', () => {
  it('accepts canonical money', () => {
    expect(validateMoney({ currency: 'INR', minor_units: '0' })).toBeNull();
    expect(validateMoney({ currency: 'USD', minor_units: '1' })).toBeNull();
    expect(validateMoney({ currency: 'JPY', minor_units: '505000' })).toBeNull();
    expect(
      validateMoney({ currency: 'EUR', minor_units: '9'.repeat(MAX_MONEY_MINOR_UNIT_DIGITS) }),
    ).toBeNull();
  });

  it('rejects non-objects', () => {
    expect(validateMoney(null)).toMatch(/must be an object/);
    expect(validateMoney('INR 5')).toMatch(/must be an object/);
  });

  it('rejects malformed currency codes', () => {
    for (const currency of ['inr', 'IN', 'INRR', 'IN1', '₹', '']) {
      expect(validateMoney({ currency, minor_units: '1' })).toMatch(/ISO 4217/);
    }
  });

  it('rejects non-canonical minor units', () => {
    for (const minor_units of ['01', '-1', '+1', '1.5', '1e3', '', ' 1', '1 ']) {
      expect(validateMoney({ currency: 'INR', minor_units })).not.toBeNull();
    }
    expect(validateMoney({ currency: 'INR', minor_units: 5 as unknown as string })).toMatch(
      /must be a string/,
    );
  });

  it('rejects values over the magnitude bound', () => {
    const over = '1'.repeat(MAX_MONEY_MINOR_UNIT_DIGITS + 1);
    expect(validateMoney({ currency: 'INR', minor_units: over })).toMatch(/magnitude bound/);
  });
});

describe('moneyMinorUnits / minorUnitsToString', () => {
  it('round-trips values exactly', () => {
    for (const s of ['0', '1', '505000', '9'.repeat(MAX_MONEY_MINOR_UNIT_DIGITS)]) {
      expect(minorUnitsToString(moneyMinorUnits({ currency: 'INR', minor_units: s }))).toEqual({
        value: s,
        error: null,
      });
    }
  });

  it('refuses negative computed values', () => {
    const { value, error } = minorUnitsToString(-1n);
    expect(value).toBeNull();
    expect(error).toMatch(/negative/);
  });

  it('refuses overflow instead of wrapping', () => {
    const { value, error } = minorUnitsToString(10n ** BigInt(MAX_MONEY_MINOR_UNIT_DIGITS));
    expect(value).toBeNull();
    expect(error).toMatch(/magnitude bound/);
  });
});
