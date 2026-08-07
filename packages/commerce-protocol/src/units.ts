/**
 * Unit vocabulary v1 (§9.2, Open Question 4).
 *
 * A closed, versioned vocabulary: every unit declares its dimension,
 * the maximum decimal scale a Quantity of that unit may carry, and —
 * where one exists — an exact integer factor to the dimension's base
 * unit. "100" without a unit is invalid everywhere.
 *
 * Two deliberate v1 narrowings, both recorded in implementation notes:
 *
 * 1. `case` and `pallet` are counting units with NO fixed factor to
 *    `each` — a case is however many the catalog item's
 *    `pack.units_per_pack` says it is. They therefore carry
 *    `baseFactor: null` and are never converted by this module;
 *    cross-unit arithmetic that would need pack evidence is invalid
 *    at the protocol layer rather than guessed.
 * 2. Custom/qualified unit codes are NOT accepted in v1 quote or
 *    order lines: the §9.1 arithmetic contract requires the declared
 *    scale and exact conversion of a vocabulary unit, and a custom
 *    unit has neither. The vocabulary version field exists so later
 *    versions can widen additively.
 */

export const UNIT_VOCABULARY_VERSION = 'v1';

export type UnitDimension = 'count' | 'mass' | 'volume';

export interface UnitDef {
  readonly code: string;
  readonly dimension: UnitDimension;
  /** Maximum fraction digits a Quantity of this unit may carry. */
  readonly scale: number;
  /**
   * Exact factor to the dimension base unit (count -> each, mass -> g,
   * volume -> ml); null when conversion needs pack evidence and is
   * therefore invalid at this layer (case, pallet).
   */
  readonly baseFactor: bigint | null;
}

/** Dimension base units: count -> each, mass -> g, volume -> ml. */
export const UNIT_VOCABULARY_V1: readonly UnitDef[] = [
  { code: 'each', dimension: 'count', scale: 0, baseFactor: 1n },
  { code: 'case', dimension: 'count', scale: 0, baseFactor: null },
  { code: 'pallet', dimension: 'count', scale: 0, baseFactor: null },
  { code: 'g', dimension: 'mass', scale: 0, baseFactor: 1n },
  { code: 'kg', dimension: 'mass', scale: 3, baseFactor: 1000n },
  { code: 'ml', dimension: 'volume', scale: 0, baseFactor: 1n },
  { code: 'l', dimension: 'volume', scale: 3, baseFactor: 1000n },
];

const BY_CODE: ReadonlyMap<string, UnitDef> = new Map(UNIT_VOCABULARY_V1.map((u) => [u.code, u]));

/** Look up a unit definition; undefined for anything outside the vocabulary. */
export function unitDef(unitCode: string): UnitDef | undefined {
  return BY_CODE.get(unitCode);
}

/**
 * Whether two units are directly comparable at this layer: same
 * dimension AND both carry an exact base factor. `case` vs `each` is
 * NOT comparable here — that conversion needs catalog pack evidence.
 * Same-code units are always comparable (including case/case).
 */
export function unitsComparable(a: UnitDef, b: UnitDef): boolean {
  if (a.code === b.code) return true;
  return a.dimension === b.dimension && a.baseFactor !== null && b.baseFactor !== null;
}
