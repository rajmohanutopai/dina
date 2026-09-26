/**
 * The supplier's pricing policy for counter-offers (NEGOTIATION_PLAN §4.1).
 *
 * The owner sets it; Core enforces it before any revision is signed. The
 * runner proposes prices and never sees a refusal that names a floor, and a
 * floor never goes on the wire. Kept on `SupplierSettings.negotiation` and
 * off the integration proposal allowlist, so a connector cannot move a floor.
 *
 * Two numbers per line, both judged against the line's REVISION-1 unit price
 * (the price first quoted), never the current head, so rounds cannot compound
 * a percentage discount:
 *
 *   hard floor  — never below, whoever asks. An item's `floorMinorUnits`,
 *                 else the first price less `defaultMaxDiscountBps`, rounded
 *                 UP so the discount never exceeds the limit.
 *   auto floor  — the lowest Core signs on its own. An item's
 *                 `autoFloorMinorUnits`, else the hard floor. Between the two
 *                 needs the owner.
 *
 * Neither floor is ever above the first price: an owner who quoted below
 * their own floor has already decided, and Core does not raise a price the
 * buyer holds.
 */

import { productRefsEqual, validateProductRef, type ProductRef } from '@dina/commerce-protocol';

import type { SettingsFinding } from './commerce_settings';

/** The owner card a counter raises when a buyer asks below the automatic limit. */
export const NEGOTIATION_PRICE_APPROVAL_TYPE = 'negotiation_price_approval';

/** The one notice a buyer's owner gets when a negotiated tender is ready to award. */
export const TENDER_READY_TYPE = 'tender_ready';

export interface NegotiationItemPolicy {
  product: ProductRef;
  floorMinorUnits: string;
  autoFloorMinorUnits?: string;
}

export interface SupplierNegotiationPolicy {
  enabled: boolean;
  /** Per quote, 1..10. */
  maxRounds: number;
  /** From the quote's first issue, 60..86400. */
  windowSeconds: number;
  /** Across all quotes, per buyer, per rolling day, 1..200 (rule 2: no probing). */
  maxCountersPerBuyerPerDay: number;
  /** Off the first quoted unit price, 0..5000 (50%). */
  defaultMaxDiscountBps: number;
  items?: NegotiationItemPolicy[];
}

export const NEGOTIATION_LIMITS = {
  maxRounds: [1, 10],
  windowSeconds: [60, 86_400],
  maxCountersPerBuyerPerDay: [1, 200],
  defaultMaxDiscountBps: [0, 5_000],
} as const;

const MINOR_UNITS = /^(0|[1-9][0-9]{0,17})$/;
const MAX_POLICY_ITEMS = 500;

function inRange(value: unknown, [low, high]: readonly [number, number]): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high;
}

/** Findings for `SupplierSettings.negotiation`; absent is fine (counters are declined). */
export function negotiationPolicyFindings(policy: unknown): SettingsFinding[] {
  if (policy === undefined) return [];
  const findings: SettingsFinding[] = [];
  const refuse = (field: string, detail: string): void => {
    findings.push({ refusal: 'negotiation_policy_invalid', field: `negotiation.${field}`, detail });
  };
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    refuse('', 'must be an object');
    return findings;
  }
  const p = policy as Record<string, unknown>;
  if (typeof p.enabled !== 'boolean') refuse('enabled', 'must be true or false');
  for (const [field, range] of Object.entries(NEGOTIATION_LIMITS)) {
    if (!inRange(p[field], range))
      refuse(field, `must be a whole number from ${range[0]} to ${range[1]}`);
  }
  if (p.items !== undefined) {
    if (!Array.isArray(p.items)) {
      refuse('items', 'must be a list');
    } else if (p.items.length > MAX_POLICY_ITEMS) {
      refuse('items', `at most ${MAX_POLICY_ITEMS} items`);
    } else {
      const seen: ProductRef[] = [];
      for (const [index, raw] of p.items.entries()) {
        const at = `items[${index}]`;
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          refuse(at, 'must be an object');
          continue;
        }
        const item = raw as Record<string, unknown>;
        const productError = validateProductRef(item.product);
        if (productError !== null) {
          refuse(`${at}.product`, productError);
          continue;
        }
        if (seen.some((other) => productRefsEqual(other, item.product as ProductRef))) {
          refuse(`${at}.product`, 'listed twice');
        }
        seen.push(item.product as ProductRef);
        if (typeof item.floorMinorUnits !== 'string' || !MINOR_UNITS.test(item.floorMinorUnits)) {
          refuse(`${at}.floorMinorUnits`, 'must be a whole number of minor units, as a string');
          continue;
        }
        if (item.autoFloorMinorUnits !== undefined) {
          if (
            typeof item.autoFloorMinorUnits !== 'string' ||
            !MINOR_UNITS.test(item.autoFloorMinorUnits)
          ) {
            refuse(
              `${at}.autoFloorMinorUnits`,
              'must be a whole number of minor units, as a string',
            );
          } else if (BigInt(item.autoFloorMinorUnits) < BigInt(item.floorMinorUnits)) {
            refuse(`${at}.autoFloorMinorUnits`, 'cannot be below the floor');
          }
        }
      }
    }
  }
  return findings;
}

export interface LineBounds {
  /** Never signed below this. */
  hardFloor: bigint;
  /** Signed without the owner down to this. */
  autoFloor: bigint;
}

/** The floors for one line, from the price first quoted for it. */
export function lineBounds(
  policy: SupplierNegotiationPolicy,
  product: ProductRef,
  firstUnitMinor: bigint,
): LineBounds {
  const item = (policy.items ?? []).find((entry) => productRefsEqual(entry.product, product));
  const percentFloor =
    (firstUnitMinor * BigInt(10_000 - policy.defaultMaxDiscountBps) + 9_999n) / 10_000n;
  const hard = item === undefined ? percentFloor : BigInt(item.floorMinorUnits);
  const auto =
    item === undefined || item.autoFloorMinorUnits === undefined
      ? hard
      : BigInt(item.autoFloorMinorUnits);
  const cap = (value: bigint): bigint => (value > firstUnitMinor ? firstUnitMinor : value);
  return { hardFloor: cap(hard), autoFloor: cap(auto) };
}

export type ClampedPrice =
  /** Within what Core signs alone (or raised to the auto floor). */
  | { price: bigint; needsOwner: false }
  /** The runner asked below the auto floor but not below the hard floor. */
  | { price: bigint; needsOwner: true; asked: bigint };

/**
 * Where a runner's proposal lands. An owner-authorised price for this line
 * (from an earlier card) is honoured down to the hard floor; otherwise the
 * proposal is raised to the auto floor, and a proposal between the floors is
 * reported so the owner can be asked. Nothing is ever below the hard floor.
 */
export function clampProposal(
  proposed: bigint,
  bounds: LineBounds,
  ownerAuthorised: bigint | null,
): ClampedPrice {
  const lowestAllowed =
    ownerAuthorised !== null &&
    ownerAuthorised >= bounds.hardFloor &&
    ownerAuthorised < bounds.autoFloor
      ? ownerAuthorised
      : bounds.autoFloor;
  if (proposed >= lowestAllowed) return { price: proposed, needsOwner: false };
  // Below what Core may sign alone, with room between the floors and no
  // authorisation yet: sign the auto floor now and ask the owner about the
  // proposal — never about anything under the hard floor.
  if (ownerAuthorised === null && bounds.hardFloor < bounds.autoFloor) {
    const asked = proposed > bounds.hardFloor ? proposed : bounds.hardFloor;
    return { price: bounds.autoFloor, needsOwner: true, asked };
  }
  return { price: lowestAllowed, needsOwner: false };
}
