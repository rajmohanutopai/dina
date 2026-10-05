/**
 * UCP quantities and units (overview/index.md:34-173; common/types/unit.json,
 * quantity_unit.json): a quantity is an integer count of steps, one step
 * being 10^-scale of `unit`. A unit's machine identity is (`unit`, effective
 * `scale`); `display_text` and `increment` are not part of it. No descriptor
 * means `each` (C62, scale 0). An unrecognized `unit` is opaque: Dina shows it
 * by its `display_text` and never converts it.
 *
 * Dina's own commerce vocabulary is closed (`each`, `case`, `pallet`, `g`,
 * `kg`, `ml`, `l`; @dina/commerce-protocol units.ts). Five codes map exactly to
 * Rec 20; `case` and `pallet` have no exact Rec 20 code (package form belongs
 * to variant identity, overview :114-143) and are refused.
 */

import { isPlainObject } from '@dina/a2a';

export interface QuantityUnit {
  unit: string;
  /** Effective scale, 0..15. */
  scale: number;
  displayText: string;
  /** Effective increment in steps, ≥ 1. */
  increment: number;
}

export const EACH: QuantityUnit = { unit: 'C62', scale: 0, displayText: 'each', increment: 1 };

const MAX_STEPS = 9_007_199_254_740_991n;

/** Parse `quantity_unit.json` (or `unit.json`, whose increment is then 1). Null when malformed. */
export function parseQuantityUnit(value: unknown): QuantityUnit | null {
  if (!isPlainObject(value)) return null;
  const { unit, display_text: displayText } = value;
  if (typeof unit !== 'string' || unit === '' || typeof displayText !== 'string') return null;
  const scale = value.scale === undefined ? 0 : value.scale;
  if (typeof scale !== 'number' || !Number.isInteger(scale) || scale < 0 || scale > 15) return null;
  if (unit === 'C62' && scale !== 0) return null;
  const increment = value.increment === undefined ? 1 : value.increment;
  if (typeof increment !== 'number' || !Number.isSafeInteger(increment) || increment < 1)
    return null;
  return { unit, scale, displayText, increment };
}

/** Machine identity equality: same `unit` and same effective `scale`. */
export function sameUnitIdentity(
  a: Pick<QuantityUnit, 'unit' | 'scale'>,
  b: Pick<QuantityUnit, 'unit' | 'scale'>,
): boolean {
  return a.unit === b.unit && a.scale === b.scale;
}

/** A Platform-authored quantity SHOULD be a whole multiple of the increment (quantity_unit.json). */
export function fitsIncrement(steps: bigint, unit: QuantityUnit): boolean {
  return steps % BigInt(unit.increment) === 0n;
}

/** A quantity in steps: an integer 1..2^53-1 (line_item.json). */
export function parseSteps(value: unknown, { allowZero = false } = {}): bigint | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  if (value < (allowZero ? 0 : 1)) return null;
  return BigInt(value);
}

// ------------------------------------------------------------ Rec 20 ↔ Dina

/**
 * Rec 20 Common Code → Dina unit code, for the five exact matches. Maps, not
 * object literals: the key is merchant-written, and `constructor` or
 * `__proto__` must find nothing.
 */
export const REC20_TO_DINA: ReadonlyMap<string, string> = new Map([
  ['C62', 'each'],
  ['GRM', 'g'],
  ['KGM', 'kg'],
  ['MLT', 'ml'],
  ['LTR', 'l'],
]);

const DINA_TO_REC20: ReadonlyMap<string, string> = new Map(
  [...REC20_TO_DINA].map(([rec, dina]) => [dina, rec]),
);

/** Dina's fractional precision per unit (@dina/commerce-protocol UNIT_VOCABULARY_V1). */
const DINA_SCALE: ReadonlyMap<string, number> = new Map([
  ['each', 0],
  ['g', 0],
  ['kg', 3],
  ['ml', 0],
  ['l', 3],
]);

/** Dina's `Quantity` shape (@dina/commerce-protocol quantity.ts): canonical decimal + unit code. */
export interface DinaQuantity {
  value: string;
  unit_code: string;
}

/**
 * A UCP quantity as Dina's `Quantity`, exactly, or null: an unrecognized unit,
 * a value Dina's unit cannot hold without rounding (more fraction digits than
 * its scale), or a step count out of range.
 */
export function toDinaQuantity(steps: bigint, unit: QuantityUnit = EACH): DinaQuantity | null {
  const dinaUnit = REC20_TO_DINA.get(unit.unit);
  const dinaScale = dinaUnit === undefined ? undefined : DINA_SCALE.get(dinaUnit);
  if (dinaUnit === undefined || dinaScale === undefined || steps < 0n || steps > MAX_STEPS)
    return null;
  const value = decimalFromSteps(steps, unit.scale);
  const fraction = value.split('.')[1] ?? '';
  if (fraction.length > dinaScale) return null;
  return { value, unit_code: dinaUnit };
}

/**
 * Dina's `Quantity` as a UCP step count in the given sale basis, or null when
 * the unit is not one of the five exact matches, differs from the basis, or
 * the value is not a whole number of steps at the basis scale.
 */
export function fromDinaQuantity(q: DinaQuantity, basis: QuantityUnit): bigint | null {
  const rec = DINA_TO_REC20.get(q.unit_code);
  if (rec === undefined || rec !== basis.unit) return null;
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]*[1-9]))?$/.exec(q.value);
  if (m === null) return null;
  const fraction = m[2] ?? '';
  if (fraction.length > basis.scale) return null;
  const steps = BigInt((m[1] as string) + fraction.padEnd(basis.scale, '0'));
  return steps > MAX_STEPS ? null : steps;
}

/** Steps as a canonical decimal at `scale` (no trailing fraction zeros), e.g. 150 @2 → "1.5". */
export function decimalFromSteps(steps: bigint, scale: number): string {
  const negative = steps < 0n;
  const digits = (negative ? -steps : steps).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? '' : digits.slice(digits.length - scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

/** For display: steps shifted by scale, then the unit's display text (overview :75-81). */
export function formatQuantity(steps: bigint, unit: QuantityUnit = EACH): string {
  return `${decimalFromSteps(steps, unit.scale)} ${unit.displayText}`;
}
