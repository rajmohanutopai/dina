/**
 * The §5.5 divergence check (PHOTO_COMMERCE_LANES_DESIGN, PC-8) — a quoted
 * price measured against the resolved catalog item's reference price.
 * Deterministic Core-side arithmetic, no LLM in any enforcement path, and
 * UNITS handled in two tiers, because a quote priced per case compared raw
 * against a catalog price per each is a 12× false alarm on identical real
 * prices:
 *
 *   1. VOCABULARY TIER — both units carry a `baseFactor` (g↔kg, ml↔l):
 *      convert exactly and compare.
 *   2. PACK-EVIDENCE TIER — `case` against `each`: relate them through the
 *      RESOLVED candidate's own `pack.units_per_pack`, the per-product
 *      evidence the catalog item already carries for exactly this. The
 *      §9.2 vocabulary ALONE cannot fix this case, deliberately: `case`
 *      and `pallet` carry `baseFactor: null` because a case is however
 *      many the product says it is.
 *
 * Only when neither tier applies — no factor, no pack evidence, or
 * mismatched variants — does the pair get the "no comparable basis" badge,
 * STATED, never guessed. `indicative_price` is optional, so the
 * no-baseline case is stated too: "no reference price" — most likely
 * exactly the flagged-new supplier the owner asked to see clearly.
 *
 * All arithmetic is exact bigint rationals; the only rounding is the
 * display percentage, computed after the flag decision, never before it.
 */

import { unitDef } from '@dina/commerce-protocol';

import type { CatalogItem, Money, ProductRef, Quantity } from '@dina/commerce-protocol';

export const DEFAULT_DIVERGENCE_THRESHOLD_PCT = 25;

export type DivergenceVerdict =
  | {
      kind: 'comparable';
      /** quoted/reference as a display percentage, rounded half-up. */
      ratioPct: number;
      flagged: boolean;
      direction: 'above' | 'below' | 'within';
    }
  /** Neither tier applies; the reason is stated on the badge. */
  | { kind: 'no_comparable_basis'; reason: string }
  /** The resolved item carries no `indicative_price`. */
  | { kind: 'no_reference_price' };

/** Exact decimal string → (numerator, denominator) rational. */
function parseDecimal(value: string): { n: bigint; d: bigint } | null {
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  const n = BigInt(`${whole ?? '0'}${frac}`);
  const d = 10n ** BigInt(frac.length);
  return n === 0n ? null : { n, d };
}

/**
 * The factor from `unit` to its dimension base, through the two tiers.
 * `item` is the resolved variant whose pack evidence may relate a `case`;
 * `pallet` has no per-product evidence field and never converts.
 */
function factorToBase(
  unitCode: string,
  item: CatalogItem,
): { factor: bigint; dimension: string } | { refusal: string } {
  const def = unitDef(unitCode);
  if (def === undefined) return { refusal: `unit ${unitCode} is outside the vocabulary` };
  if (def.baseFactor !== null) return { factor: def.baseFactor, dimension: def.dimension };
  if (def.code === 'case') {
    const perPack = item.pack.units_per_pack;
    if (perPack === undefined || !/^\d+$/.test(perPack) || BigInt(perPack) === 0n) {
      return { refusal: 'case has no pack evidence on the resolved item' };
    }
    return { factor: BigInt(perPack), dimension: def.dimension };
  }
  return { refusal: `${def.code} has no conversion evidence` };
}

function productRefsEqual(a: ProductRef, b: ProductRef): boolean {
  return a.scheme === b.scheme && a.value === b.value && a.issuer_did === b.issuer_did;
}

/**
 * Measure a quoted unit price against the resolved item's reference price.
 *
 * `resolvedProduct` is what the photographed line RESOLVED to, and it must
 * be the item's own identity: pack evidence from a different variant does
 * not transfer, and enforcing that here — rather than trusting the caller
 * to have matched them — is what makes the rule a rule.
 */
export function checkPriceDivergence(args: {
  quoted: { unitPrice: Money; priceBasis: Quantity };
  item: CatalogItem;
  resolvedProduct: ProductRef;
  /** Owner-set; default 25. Flagged when |quoted/reference − 1| exceeds it. */
  thresholdPct?: number;
}): DivergenceVerdict {
  const threshold = BigInt(Math.max(1, Math.round(args.thresholdPct ?? DEFAULT_DIVERGENCE_THRESHOLD_PCT)));

  if (!productRefsEqual(args.item.product, args.resolvedProduct)) {
    return {
      kind: 'no_comparable_basis',
      reason: 'pack evidence belongs to a different variant',
    };
  }
  const reference = args.item.indicative_price;
  if (reference === undefined) return { kind: 'no_reference_price' };
  if (reference.currency !== args.quoted.unitPrice.currency) {
    return {
      kind: 'no_comparable_basis',
      reason: `currencies differ (${args.quoted.unitPrice.currency} vs ${reference.currency})`,
    };
  }

  const quotedFactor = factorToBase(args.quoted.priceBasis.unit_code, args.item);
  if ('refusal' in quotedFactor) return { kind: 'no_comparable_basis', reason: quotedFactor.refusal };
  const referenceFactor = factorToBase(args.item.pack.sell_unit.unit_code, args.item);
  if ('refusal' in referenceFactor) {
    return { kind: 'no_comparable_basis', reason: referenceFactor.refusal };
  }
  if (quotedFactor.dimension !== referenceFactor.dimension) {
    return {
      kind: 'no_comparable_basis',
      reason: `dimensions differ (${quotedFactor.dimension} vs ${referenceFactor.dimension})`,
    };
  }

  const quotedBasis = parseDecimal(args.quoted.priceBasis.value);
  const referenceBasis = parseDecimal(args.item.pack.sell_unit.value);
  if (quotedBasis === null || referenceBasis === null) {
    return { kind: 'no_comparable_basis', reason: 'a price basis quantity is unreadable or zero' };
  }
  const quotedMinor = BigInt(args.quoted.unitPrice.minor_units);
  const referenceMinor = BigInt(reference.minor_units);
  if (referenceMinor === 0n) {
    return { kind: 'no_comparable_basis', reason: 'the reference price is zero' };
  }

  // price per BASE unit, as exact rationals:
  //   quoted    = quotedMinor    / (quotedBasis    × quotedFactor)
  //   reference = referenceMinor / (referenceBasis × referenceFactor)
  // ratio = quoted/reference = qn·rd / (qd·rn), cross-multiplied — no
  // division ever happens before the flag decision.
  const qn = quotedMinor * quotedBasis.d;
  const qd = quotedBasis.n * quotedFactor.factor;
  const rn = referenceMinor * referenceBasis.d;
  const rd = referenceBasis.n * referenceFactor.factor;

  const above = qn * rd * 100n > qd * rn * (100n + threshold);
  const below = qn * rd * 100n < qd * rn * (100n - threshold);
  const ratioPct = Number((qn * rd * 200n + qd * rn) / (qd * rn * 2n));
  return {
    kind: 'comparable',
    ratioPct,
    flagged: above || below,
    direction: above ? 'above' : below ? 'below' : 'within',
  };
}
