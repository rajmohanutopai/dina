/**
 * The goods runner's binding terms, checked like a counter (COMMITMENT_KERNEL
 * §10 "Where the agent decides alone", §15 step 10).
 *
 * The runner speaks for the supplier, but anything it sends that a buyer can
 * take up binds the owner: a first quote, the quote's other versions, and the
 * replacement quote sent back with an order decision. Each passes the floors
 * a counter passes, and every version passes the seller's never-rules.
 *
 * FLOORS ARE WHAT THE OWNER APPROVED, never the runner's own first price
 * (which would let the runner set the measure it is checked by):
 *
 *   the item's own floors   — in the negotiation policy. They stand as set:
 *                             a lower published price does not lower them.
 *                             Policy floors name no currency, so with no
 *                             published price they hold only in the
 *                             supplier's trading currency, and only for the
 *                             unit the floor names (`unitCode`). A floor that
 *                             names a unit never holds for another.
 *   else, a policy          — the published catalogue price less
 *                             `defaultMaxDiscountBps` (`lineBounds`).
 *   else                    — the published catalogue price: no discount.
 *
 * A published price in another currency, or for another sell unit, is not a
 * price the owner approved for this line, so it approves nothing, and the
 * item's own floors do not stand in for it. Prices are compared per one unit
 * of the line's own quantity (price basis 1, the same unit); any other basis
 * is refused rather than converted.
 *
 * A first quote cannot wait on the owner (the buyer asked a question and
 * gets one answer), so a price below the AUTOMATIC floor is withheld, not
 * carded. The owner widens the room by lowering a floor or the catalogue
 * price; nothing names a floor to the buyer.
 */

import {
  computeLineSubtotal,
  productRefsEqual,
  type CatalogItem,
  type Money,
  type ProductRef,
  type Quantity,
} from '@dina/commerce-protocol';

import { deliveryDayOf } from './deal_kinds';
import { holds } from './goods_seller_alternatives';
import { lineBounds, type LineBounds, type SupplierNegotiationPolicy } from './negotiation_policy';
import { findPublishedItem, publishedCatalogItems } from './published_catalog';

import type { CommerceRuntime } from './runtime';
import type { NeverCondition, ValueModel } from '../commitment';

/** Why a runner's terms were not signed. Never sent to the buyer. */
export type RunnerBoundsRefusal =
  /** A line has no price the owner approved, or one priced on another basis. */
  | 'price_not_approved'
  /** A line, or a version's total, is below the automatic floors. */
  | 'below_floor'
  /** A version falls on a day, or at a total, the seller's never-rules refuse. */
  | 'ruled_out'
  /** The seller's rules sit in a closed persona, or cannot be read now. */
  | 'persona_closed';

/** The seller's goods rules as read now; `unreadable` when the read failed. */
export interface SellerRules {
  model: ValueModel | null;
  closedPersonas: string[];
  unreadable?: true;
}

/**
 * Whether the seller's never-rules let these versions go out: a refusal when
 * the rules cannot be read now (a closed persona, a failed read) or one of
 * the versions breaks them. Null rules: the owner set none.
 */
export function sellerRulesRefuse(
  seller: SellerRules | null,
  versions: readonly BoundsVersion[],
  timeZone: string | null,
): 'persona_closed' | 'ruled_out' | null {
  if (seller === null) return null;
  if (seller.unreadable === true || seller.closedPersonas.length > 0) return 'persona_closed';
  const model = seller.model;
  if (model !== null && versions.some((v) => sellerRuledOut(model, v, timeZone)))
    return 'ruled_out';
  return null;
}

/** What the owner approved: the live catalogue and the supplier's settings. */
export interface ApprovedPrices {
  items: readonly CatalogItem[];
  policy: SupplierNegotiationPolicy | undefined;
  /** The supplier's trading currency, when set. */
  tradingCurrency: string | undefined;
  /**
   * Stored settings that do not validate: the owner's floors cannot be read,
   * so nothing is approved (never "no policy", which would fall back to the
   * catalogue price and drop a stricter floor).
   */
  unreadable?: true;
}

/** What this node's owner approved, read now. */
export function approvedPricesOf(
  runtime: Pick<CommerceRuntime, 'catalogPointers' | 'catalogDrafts' | 'settings'>,
): ApprovedPrices {
  const settings = runtime.settings.readSupplier();
  return {
    ...(!settings.ok && !settings.absent ? { unreadable: true as const } : {}),
    items: publishedCatalogItems(runtime),
    policy: settings.ok ? settings.settings.negotiation : undefined,
    tradingCurrency: settings.ok ? settings.settings.tradingCurrency : undefined,
  };
}

export interface BoundsLine {
  line_id: string;
  product: ProductRef;
  unit_price: Money;
  quantity: Quantity;
  price_basis: Quantity;
}

export interface BoundsVersion {
  estimatedDeliveryAt?: string;
  total: Money;
}

/**
 * The floors for one goods line, from what the owner approved. Null when the
 * owner approved no price for it. `capMinor` keeps the old promise that no
 * floor is above a price the buyer already holds for this same line.
 */
export function approvedLineFloors(
  approved: ApprovedPrices,
  line: { product: ProductRef; unitCode: string; currency: string; capMinor?: bigint },
): LineBounds | null {
  if (approved.unreadable === true) return null;
  const item = findPublishedItem(approved.items, line.product);
  const price = item?.indicative_price;
  let anchor: bigint | null = null;
  if (item !== null && item !== undefined && price !== undefined) {
    const sell = item.pack.sell_unit;
    // Published for something else: it approves nothing for this line.
    if (price.currency !== line.currency || sell.value !== '1' || sell.unit_code !== line.unitCode)
      return null;
    anchor = BigInt(price.minor_units);
  }
  const own = (approved.policy?.items ?? []).find((entry) =>
    productRefsEqual(entry.product, line.product),
  );
  let floors: LineBounds | null;
  if (own !== undefined) {
    // A floor that names its unit holds only for that unit. Without a
    // published price, nothing else says which currency or unit the owner's
    // figures are in: only the trading currency, and only a named unit.
    floors =
      (own.unitCode !== undefined && own.unitCode !== line.unitCode) ||
      (anchor === null &&
        (approved.tradingCurrency !== line.currency || own.unitCode === undefined))
        ? null
        : {
            hardFloor: BigInt(own.floorMinorUnits),
            autoFloor: BigInt(own.autoFloorMinorUnits ?? own.floorMinorUnits),
          };
  } else if (anchor === null) {
    floors = null;
  } else {
    floors =
      approved.policy === undefined
        ? { hardFloor: anchor, autoFloor: anchor }
        : lineBounds(approved.policy, line.product, anchor);
  }
  const capMinor = line.capMinor;
  if (floors === null || capMinor === undefined) return floors;
  const cap = (value: bigint): bigint => (value > capMinor ? capMinor : value);
  return { hardFloor: cap(floors.hardFloor), autoFloor: cap(floors.autoFloor) };
}

/** Is the line priced per one unit of its own quantity? Only then is it compared. */
export function pricedPerUnit(line: { quantity: Quantity; price_basis: Quantity }): boolean {
  return line.price_basis.value === '1' && line.price_basis.unit_code === line.quantity.unit_code;
}

/** A line's subtotal at `unitMinor`, on its own basis. */
export function subtotalAt(
  line: Pick<BoundsLine, 'unit_price' | 'quantity' | 'price_basis'>,
  unitMinor: bigint,
): bigint | null {
  const at = computeLineSubtotal(
    { currency: line.unit_price.currency, minor_units: unitMinor.toString(10) },
    line.quantity,
    line.price_basis,
  );
  return at.error || !at.value ? null : BigInt(at.value.minor_units);
}

/** Does a price the buyer holds on another line speak for this one? */
function sameLine(a: BoundsLine, b: BoundsLine): boolean {
  return (
    productRefsEqual(a.product, b.product) &&
    a.unit_price.currency === b.unit_price.currency &&
    a.quantity.unit_code === b.quantity.unit_code &&
    pricedPerUnit(a) &&
    pricedPerUnit(b)
  );
}

/**
 * The seller's never-rules against one version. A day that cannot be read
 * (no delivery date, or the owner's time zone unknown) is taken to match a
 * rule on the day, so an unreadable day is ruled out, never let by. A
 * runner's version passes on no saving, so a rule on the share does not hold.
 */
function sellerRuledOut(
  model: ValueModel,
  version: BoundsVersion,
  timeZone: string | null,
): boolean {
  const at =
    version.estimatedDeliveryAt === undefined ? NaN : Date.parse(version.estimatedDeliveryAt);
  const day = Number.isNaN(at) || timeZone === null ? null : deliveryDayOf(at, timeZone);
  const totalMinor = BigInt(version.total.minor_units);
  const test = (c: NeverCondition): boolean => {
    if (c.part === 'delivery_day' && day === null) return true;
    if (c.part === 'saving_share') return false;
    return holds(c, { day: day ?? '', share: '', totalMinor });
  };
  return model.never.some((rule) => rule.all.length > 0 && rule.all.every(test));
}

/**
 * Check a runner's binding terms: every line priced per unit and at or above
 * its automatic floor, each version's total at or above the goods at those
 * floors, and each version clear of the seller's never-rules. On success,
 * the goods at their floors: a version Core makes itself (a cheaper day, a
 * partner's run) must not fall below it either.
 *
 * `held`: the lines the buyer already holds (a replacement quote's countered
 * quote). A floor is never above the price held for the same line: same
 * product, currency and unit.
 */
export function checkRunnerTerms(args: {
  approved: ApprovedPrices;
  lines: readonly BoundsLine[];
  versions: readonly BoundsVersion[];
  seller: SellerRules | null;
  timeZone: string | null;
  held?: readonly BoundsLine[];
}): { ok: true; floorGoodsMinor: bigint } | { ok: false; refusal: RunnerBoundsRefusal } {
  let floorGoods = 0n;
  for (const line of args.lines) {
    if (!pricedPerUnit(line)) return { ok: false, refusal: 'price_not_approved' };
    const kept = args.held?.find((h) => h.line_id === line.line_id && sameLine(h, line));
    const floors = approvedLineFloors(args.approved, {
      product: line.product,
      unitCode: line.quantity.unit_code,
      currency: line.unit_price.currency,
      ...(kept === undefined ? {} : { capMinor: BigInt(kept.unit_price.minor_units) }),
    });
    if (floors === null) return { ok: false, refusal: 'price_not_approved' };
    if (BigInt(line.unit_price.minor_units) < floors.autoFloor)
      return { ok: false, refusal: 'below_floor' };
    const atFloor = subtotalAt(line, floors.autoFloor);
    if (atFloor === null) return { ok: false, refusal: 'price_not_approved' };
    floorGoods += atFloor;
  }
  // A discount written as a charge is still a price: no version's total may
  // fall below the goods at their floors. Its own added charges (delivery)
  // may pay for a discount, so free delivery stays possible.
  if (args.versions.some((v) => BigInt(v.total.minor_units) < floorGoods))
    return { ok: false, refusal: 'below_floor' };
  const rules = sellerRulesRefuse(args.seller, args.versions, args.timeZone);
  if (rules !== null) return { ok: false, refusal: rules };
  return { ok: true, floorGoodsMinor: floorGoods };
}

/** The versions whose total keeps the goods at or above their floors. */
export function atOrAboveFloor<T extends { total: Money }>(
  versions: readonly T[],
  floorGoodsMinor: bigint,
): T[] {
  return versions.filter((v) => BigInt(v.total.minor_units) >= floorGoodsMinor);
}
