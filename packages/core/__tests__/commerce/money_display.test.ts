/**
 * Money for people to read: the wire's integer minor units become the decimal
 * amount at the currency's exponent, BigInt-exact, with fixed decimals so a
 * column of prices lines up. One rule for the card, the research loop and the
 * Tally export.
 */

import { CURRENCY_EXPONENTS, currencyExponent, formatMoney, formatMoneyAmount } from '../../src/commerce/money_display';

describe('money display', () => {
  it.each([
    ['INR', '449900', '4499.00'],
    ['INR', '5', '0.05'],
    ['INR', '0', '0.00'],
    ['USD', '100', '1.00'],
    ['JPY', '48000', '48000'],
    ['KRW', '1', '1'],
    // 15 digits — the §9.1 magnitude bound — stays exact.
    ['INR', '999999999999999', '9999999999999.99'],
  ])('%s %s → %s', (currency, minor_units, amount) => {
    expect(formatMoneyAmount({ currency, minor_units })).toBe(amount);
    expect(formatMoney({ currency, minor_units })).toBe(`${currency} ${amount}`);
  });

  it('an unlisted currency uses the ISO-4217 default of two decimals', () => {
    expect(currencyExponent('XYZ')).toBe(2);
    expect(CURRENCY_EXPONENTS.has('XYZ')).toBe(false);
    expect(formatMoneyAmount({ currency: 'XYZ', minor_units: '1234' })).toBe('12.34');
  });

  it.each(['BHD', 'KWD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD'])('%s has three minor-unit digits', (currency) => {
    expect(formatMoneyAmount({ currency, minor_units: '12345' })).toBe('12.345');
    expect(formatMoneyAmount({ currency, minor_units: '5' })).toBe('0.005');
  });

  it('a currency string that names an Object.prototype key is an unknown currency, not a function', () => {
    for (const currency of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(currencyExponent(currency)).toBe(2);
    }
  });

  it.each([
    ['', 'empty'],
    ['-4050', 'negative'],
    ['12.50', 'decimal'],
    ['abc', 'letters'],
    [' 42 ', 'whitespace'],
    ['0x10', 'hex'],
    ['1e3', 'exponent'],
    ['007', 'leading zero'],
  ])('refuses minor_units that are not Money (%s — %s) instead of rendering garbage', (minor_units) => {
    expect(() => formatMoneyAmount({ currency: 'INR', minor_units })).toThrow(/money_display: money:/);
  });

  it('refuses a currency that is not an ISO-4217 code shape', () => {
    expect(() => formatMoneyAmount({ currency: 'constructor', minor_units: '100' })).toThrow(/currency/);
    expect(() => formatMoneyAmount({ currency: 'inr', minor_units: '100' })).toThrow(/currency/);
  });
});
