/**
 * The §9.1 v1 arithmetic contract — fixed so two conforming
 * implementations cannot compute different totals from the same quote:
 *
 * - line subtotal = unit_price × (quantity / price_basis), computed in
 *   EXACT rational arithmetic, then rounded ONCE to minor units using
 *   round-half-even;
 * - "quantity / price_basis must be exact under the declared unit
 *   conversion" means the CONVERSION must be exact: both quantities
 *   comparable through declared vocabulary factors (kg/g, l/ml,
 *   same-code). A division that would need pack evidence (case vs
 *   each) or cross-dimension guessing is INVALID — there is no
 *   alternate rounding rule in v1. The ratio itself may be fractional
 *   ("per-unit pricing always does" divide exactly — 1.5 kg at a
 *   per-kg basis is a legal 1.5 ratio); the single half-even rounding
 *   is what makes the fractional product deterministic;
 * - the total is the PLAIN INTEGER SUM of line subtotals and charges
 *   in minor units — no re-rounding, no floating point at any step;
 * - one currency per document;
 * - magnitude bounds are validation failures, never wraparound, and a
 *   subtraction that would drive the total negative is invalid
 *   (discounts are typed adjustments, not negative money).
 */

import { minorUnitsToString, moneyMinorUnits, validateMoney, type Money } from './money';
import { quantityToRational, validateQuantity, type Quantity } from './quantity';
import { unitsComparable } from './units';

/** Typed adjustment on a quote/order total (§9.8 `charges`). */
export interface Charge {
  kind: 'tax' | 'delivery' | 'discount' | 'other';
  label: string;
  amount: Money;
  operation: 'add' | 'subtract';
}

export const MAX_CHARGE_LABEL_LENGTH = 200;

const CHARGE_KINDS: ReadonlySet<string> = new Set(['tax', 'delivery', 'discount', 'other']);
const CHARGE_OPERATIONS: ReadonlySet<string> = new Set(['add', 'subtract']);

/** Validate a Charge. Returns null on success, error string on failure. */
export function validateCharge(charge: unknown): string | null {
  if (typeof charge !== 'object' || charge === null) {
    return 'charge: value must be an object';
  }
  const c = charge as Record<string, unknown>;
  if (typeof c.kind !== 'string' || !CHARGE_KINDS.has(c.kind)) {
    return 'charge: kind must be one of tax | delivery | discount | other';
  }
  if (typeof c.operation !== 'string' || !CHARGE_OPERATIONS.has(c.operation)) {
    return 'charge: operation must be add | subtract';
  }
  if (typeof c.label !== 'string' || c.label.length === 0) {
    return 'charge: label must be a non-empty string';
  }
  if (c.label.length > MAX_CHARGE_LABEL_LENGTH) {
    return `charge: label exceeds ${MAX_CHARGE_LABEL_LENGTH} characters`;
  }
  const moneyError = validateMoney(c.amount);
  if (moneyError) return `charge: ${moneyError}`;
  return null;
}

/**
 * Round a non-negative rational (numerator/denominator, denominator
 * > 0) to the nearest integer, ties to even. The ONE rounding step
 * the contract permits.
 */
export function roundRationalHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('arithmetic: denominator must be positive');
  if (numerator < 0n) throw new Error('arithmetic: negative rational has no meaning for money');
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = remainder * 2n;
  if (twice < denominator) return quotient;
  if (twice > denominator) return quotient + 1n;
  // Exact tie: to even.
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

export interface ArithmeticResult {
  value: Money | null;
  error: string | null;
}

/**
 * Line subtotal (§9.1): unit_price × (quantity / price_basis), exact
 * rational, one half-even rounding to minor units. Inputs are
 * re-validated — arithmetic used for approval never trusts upstream
 * validation to have happened.
 */
export function computeLineSubtotal(
  unit_price: Money,
  quantity: Quantity,
  price_basis: Quantity,
): ArithmeticResult {
  const priceError = validateMoney(unit_price);
  if (priceError) return { value: null, error: `line_subtotal: ${priceError}` };
  const quantityError = validateQuantity(quantity);
  if (quantityError) return { value: null, error: `line_subtotal: ${quantityError}` };
  const basisError = validateQuantity(price_basis, { require_positive: true });
  if (basisError) return { value: null, error: `line_subtotal: price_basis ${basisError}` };

  const q = quantityToRational(quantity);
  const basis = quantityToRational(price_basis);
  if (!unitsComparable(q.unit, basis.unit)) {
    return {
      value: null,
      error:
        `line_subtotal: quantity unit "${q.unit.code}" and price basis unit ` +
        `"${basis.unit.code}" have no exact declared conversion — the line is invalid (§9.1)`,
    };
  }

  // ratio = (qn/qd) / (bn/bd) = (qn·bd) / (qd·bn); subtotal rational =
  // price · ratio. All BigInt — exact at every step.
  const price = moneyMinorUnits(unit_price);
  const numerator = price * q.numerator * basis.denominator;
  const denominator = q.denominator * basis.numerator;
  const rounded = roundRationalHalfEven(numerator, denominator);

  const { value, error } = minorUnitsToString(rounded);
  if (error) return { value: null, error: `line_subtotal: ${error}` };
  return { value: { currency: unit_price.currency, minor_units: value as string }, error: null };
}

/**
 * Document total (§9.1): plain integer sum of line subtotals and
 * charges in minor units. One currency per document; a subtract that
 * drives the running result negative, and any overflow, are
 * validation failures.
 */
export function computeTotal(
  currency: string,
  line_subtotals: readonly Money[],
  charges: readonly Charge[],
): ArithmeticResult {
  if (line_subtotals.length === 0) {
    return { value: null, error: 'total: a document needs at least one line subtotal' };
  }
  let total = 0n;
  for (const subtotal of line_subtotals) {
    const err = validateMoney(subtotal);
    if (err) return { value: null, error: `total: ${err}` };
    if (subtotal.currency !== currency) {
      return {
        value: null,
        error: `total: mixed currencies ("${subtotal.currency}" in a "${currency}" document) are invalid in v1`,
      };
    }
    total += moneyMinorUnits(subtotal);
  }
  for (const charge of charges) {
    const err = validateCharge(charge);
    if (err) return { value: null, error: `total: ${err}` };
    if (charge.amount.currency !== currency) {
      return {
        value: null,
        error: `total: mixed currencies ("${charge.amount.currency}" in a "${currency}" document) are invalid in v1`,
      };
    }
    const amount = moneyMinorUnits(charge.amount);
    total = charge.operation === 'add' ? total + amount : total - amount;
  }
  // Non-negativity is a property of the FINAL total, not of every
  // intermediate running value.
  //
  // Rejecting mid-sum made validity depend on charge ORDER: subtotal 100,
  // subtract 200, add 500 was refused, while the same three charges
  // reordered summed to 400 and passed. §9.1 specifies a plain integer sum,
  // and two conforming implementations that iterate a charge set in
  // different orders must agree — otherwise the byte-identical guarantee the
  // whole protocol rests on is false for any document with a discount
  // preceding a surcharge, which is an ordinary invoice shape.
  //
  // The final check itself lives in `minorUnitsToString`, which already
  // refuses a negative bigint. Re-checking it here would duplicate a rule
  // that has an owner — a mutation proved the duplicate was a no-op.
  const { value, error } = minorUnitsToString(total);
  if (error) return { value: null, error: `total: ${error}` };
  return { value: { currency, minor_units: value as string }, error: null };
}
