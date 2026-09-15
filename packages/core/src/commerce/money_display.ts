/**
 * Money for people to read.
 *
 * The wire carries `Money` as integer MINOR units (`{currency:'INR',
 * minor_units:'449900'}`, §9.1) and the protocol calls the display exponent a
 * presentation concern. This is that concern, in one place: a ₹4,499 chair
 * shown as "INR 449900" on a card, or read by the research loop as a total of
 * 449900, is a hundredfold lie. Every surface that renders a `Money` for the
 * owner or the model goes through here.
 *
 * Money-free: formatting only. No arithmetic beyond splitting an integer at
 * the exponent, and BigInt so a 15-digit amount never rounds.
 */

import { moneyMinorUnits, validateMoney, type Money } from '@dina/commerce-protocol';

/**
 * ISO-4217 minor-unit exponents that differ from the default of 2, plus the
 * currencies the trade runs in today. Zero-exponent currencies are listed so a
 * yen amount never gains phantom decimals; three-exponent currencies so a dinar
 * is not shown ten times too large. A `Map`, not an object literal: a currency
 * string is untrusted text, and `{}['constructor']` is a function, not a row.
 * An unknown code uses 2.
 */
export const CURRENCY_EXPONENTS: ReadonlyMap<string, number> = new Map<string, number>([
  ['INR', 2],
  ['USD', 2],
  ['EUR', 2],
  ['GBP', 2],
  ['AED', 2],
  // Zero minor-unit digits.
  ['JPY', 0],
  ['KRW', 0],
  ['VND', 0],
  ['CLP', 0],
  ['ISK', 0],
  ['UGX', 0],
  ['XAF', 0],
  ['XOF', 0],
  ['XPF', 0],
  ['PYG', 0],
  ['RWF', 0],
  ['GNF', 0],
  ['KMF', 0],
  ['DJF', 0],
  ['BIF', 0],
  ['VUV', 0],
  // Three minor-unit digits.
  ['BHD', 3],
  ['KWD', 3],
  ['OMR', 3],
  ['JOD', 3],
  ['IQD', 3],
  ['TND', 3],
  ['LYD', 3],
]);

const DEFAULT_EXPONENT = 2;

/** The display exponent for a currency code (2 when the table has no row). */
export function currencyExponent(currency: string): number {
  return CURRENCY_EXPONENTS.get(currency) ?? DEFAULT_EXPONENT;
}

/**
 * Minor units → the decimal amount, no currency: `449900` INR → `"4499.00"`,
 * `1200` JPY → `"1200"`, `12345` BHD → `"12.345"`. Fixed decimals so a column
 * of prices lines up. Throws on a value that is not Money — the seams that
 * admit prices (`catalogCandidatesToOffers`, the signed documents) validate
 * first, so a throw here is a caller bug, never an owner-facing state.
 */
export function formatMoneyAmount(money: Money): string {
  const invalid = validateMoney(money);
  if (invalid !== null) throw new Error(`money_display: ${invalid}`);
  const exponent = currencyExponent(money.currency);
  const minor = moneyMinorUnits(money);
  if (exponent === 0) return minor.toString();
  const divisor = 10n ** BigInt(exponent);
  const whole = minor / divisor;
  const fraction = (minor % divisor).toString().padStart(exponent, '0');
  return `${whole.toString()}.${fraction}`;
}

/** Currency and amount as one label: `"INR 4499.00"`. */
export function formatMoney(money: Money): string {
  return `${money.currency} ${formatMoneyAmount(money)}`;
}
