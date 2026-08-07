/**
 * Quantity (§9.2) — canonical decimal value + closed-vocabulary unit.
 *
 * Validation enforces the unit's declared scale exactly: a value with
 * more fraction digits than the unit allows is invalid, never rounded
 * (§9.1). Arithmetic consumers get an exact rational representation
 * in the unit's dimension base (each / g / ml) so division and
 * comparison never touch floating point.
 */

import { parseCanonicalDecimal, pow10 } from './numeric';
import { unitDef, unitsComparable, type UnitDef } from './units';

export interface Quantity {
  /** Canonical decimal string (numeric.ts rules). */
  value: string;
  /** Unit code from the versioned closed vocabulary (units.ts). */
  unit_code: string;
}

/** Magnitude bound for the integer part of every quantity (§9.1). */
export const MAX_QUANTITY_INTEGER_DIGITS = 12;

export interface QuantityValidationOptions {
  /** Reject zero quantities (order/quote lines require > 0). */
  require_positive?: boolean;
}

/** Validate a Quantity. Returns null on success, error string on failure. */
export function validateQuantity(
  quantity: unknown,
  options: QuantityValidationOptions = {},
): string | null {
  if (typeof quantity !== 'object' || quantity === null) {
    return 'quantity: value must be an object';
  }
  const q = quantity as Record<string, unknown>;
  if (typeof q.unit_code !== 'string') {
    return 'quantity: unit_code must be a string';
  }
  const unit = unitDef(q.unit_code);
  if (!unit) {
    return `quantity: unknown unit "${q.unit_code}" (vocabulary v1 is closed; custom units are not valid in v1)`;
  }
  if (typeof q.value !== 'string') {
    return 'quantity: value must be a string';
  }
  const { parsed, error } = parseCanonicalDecimal(q.value, MAX_QUANTITY_INTEGER_DIGITS, unit.scale);
  if (error) return `quantity: ${error}`;
  if (options.require_positive && parsed !== null && parsed.scaled === 0n) {
    return 'quantity: value must be positive';
  }
  return null;
}

/**
 * Exact rational amount of a VALIDATED quantity, normalized to the
 * unit's dimension base (each / g / ml) when the unit converts, or to
 * the unit's own kind when it does not (case, pallet). The fraction
 * is `numerator / denominator`; denominator is always a power of ten.
 */
export interface QuantityRational {
  numerator: bigint;
  denominator: bigint;
  unit: UnitDef;
}

/** Convert a validated Quantity to its exact rational representation. */
export function quantityToRational(quantity: Quantity): QuantityRational {
  const unit = unitDef(quantity.unit_code);
  if (!unit) throw new Error(`quantityToRational: unknown unit "${quantity.unit_code}"`);
  const { parsed, error } = parseCanonicalDecimal(
    quantity.value,
    MAX_QUANTITY_INTEGER_DIGITS,
    unit.scale,
  );
  if (error || parsed === null) {
    throw new Error(`quantityToRational: ${error ?? 'unparseable value'}`);
  }
  const factor = unit.baseFactor ?? 1n;
  return { numerator: parsed.scaled * factor, denominator: pow10(parsed.scale), unit };
}

/**
 * Compare two validated quantities of comparable units. Returns
 * negative/zero/positive like a comparator, or an error string when
 * the units are not comparable at this layer (cross-dimension, or a
 * pack-evidence unit against a different unit).
 */
export function compareQuantities(a: Quantity, b: Quantity): number | string {
  const ra = quantityToRational(a);
  const rb = quantityToRational(b);
  if (!unitsComparable(ra.unit, rb.unit)) {
    return `quantity: units "${ra.unit.code}" and "${rb.unit.code}" are not comparable without pack evidence`;
  }
  const left = ra.numerator * rb.denominator;
  const right = rb.numerator * ra.denominator;
  return left < right ? -1 : left > right ? 1 : 0;
}
