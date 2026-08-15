/**
 * Money (§9.1).
 *
 * `minor_units` is a canonical non-negative base-10 integer string.
 * Floating point is forbidden for money; negative prices are forbidden
 * — a discount is an explicitly typed adjustment (`operation:
 * 'subtract'` on a charge, arithmetic.ts), never a negative Money.
 *
 * The currency field is validated as an ISO 4217 alpha shape (three
 * uppercase ASCII letters). The full ISO table — and each currency's
 * display exponent — is a presentation concern; the wire contract
 * only needs one currency per document and integer minor units.
 *
 * Magnitude bound: MAX_MONEY_MINOR_UNIT_DIGITS caps every money value
 * AND every computed total; overflow is a validation failure, never
 * wraparound (§9.1).
 */

import { validateCanonicalInteger } from './numeric';

export interface Money {
  /** ISO 4217 uppercase alpha code, e.g. "INR". */
  currency: string;
  /** Canonical base-10 non-negative integer string, no float. */
  minor_units: string;
}

/** Magnitude bound for every Money value and computed total (§9.1). */
export const MAX_MONEY_MINOR_UNIT_DIGITS = 15;

const CURRENCY_SHAPE = /^[A-Z]{3}$/;

/**
 * Is this a currency code `Money` will accept?
 *
 * EXPORTED SO THE RULE HAS ONE DEFINITION. A caller that stores a currency
 * before building any `Money` — supplier settings, for instance — has to apply
 * the same test, and the alternative is a second regex somewhere else that
 * agrees until one of them is edited. Same reasoning as the §10.2 collection
 * names: a rule spelled twice is a rule that can disagree with itself.
 */
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_SHAPE.test(value);
}

/** Validate a Money value. Returns null on success, error string on failure. */
export function validateMoney(money: unknown): string | null {
  if (typeof money !== 'object' || money === null) {
    return 'money: value must be an object';
  }
  const m = money as Record<string, unknown>;
  if (!isCurrencyCode(m.currency)) {
    return 'money: currency must be a three-letter uppercase ISO 4217 code';
  }
  if (typeof m.minor_units !== 'string') {
    return 'money: minor_units must be a string';
  }
  const err = validateCanonicalInteger(m.minor_units, MAX_MONEY_MINOR_UNIT_DIGITS);
  if (err) return `money: ${err}`;
  return null;
}

/** Parse validated minor_units to BigInt. Callers validate first. */
export function moneyMinorUnits(money: Money): bigint {
  return BigInt(money.minor_units);
}

/** Render a BigInt of minor units back to the canonical wire string.
 *  Rejects negatives (Money is non-negative by contract) and values
 *  over the magnitude bound — the caller surfaces both as validation
 *  failures, never as wrapped or clamped output. */
export function minorUnitsToString(value: bigint): { value: string | null; error: string | null } {
  if (value < 0n) {
    return { value: null, error: 'money: computed value is negative' };
  }
  const s = value.toString(10);
  if (s.length > MAX_MONEY_MINOR_UNIT_DIGITS) {
    return {
      value: null,
      error: `money: computed value exceeds the ${MAX_MONEY_MINOR_UNIT_DIGITS}-digit magnitude bound`,
    };
  }
  return { value: s, error: null };
}
