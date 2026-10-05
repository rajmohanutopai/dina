/**
 * Lines Brain names by handle, as a merchant receives them (UCP plan §3.7):
 * shared by carts and checkouts.
 *
 *  - Brain names a variant by the handle it saw (`v1.2`) and a step count;
 *    Core maps the handle back to the merchant's product and variant ids.
 *  - Each line's product is fetched afresh (`get_product`), so the line
 *    sends the merchant's own unit identity, and a quantity must be a whole
 *    number of that unit's increment. One variant appears once.
 *  - What the owner reads of a line (product and variant names, the unit's
 *    text, the price) comes from that fresh answer, cleaned for display.
 *    None of it reaches Brain.
 */

import { a2aDisplayText } from '@dina/a2a';
import {
  buildGetProductRequest,
  decimalFromSteps,
  readProductDetail,
  type IntentLine,
  type Price,
  type QuantityUnit,
} from '@dina/ucp';

import type { MerchantConnection } from './merchant_client';
import type { UcpSearchStore } from './search_store';
import type { UcpSettings } from './settings';

/** Lines one cart or checkout may hold. */
export const MAX_LINES = 50;

export interface LineInput {
  /** A variant handle Brain saw (`v1.2`). */
  variant: string;
  /** Steps of the variant's unit (10^-scale × unit), a whole number of its increment. */
  quantity: number;
}

export type LineRefusal =
  | 'no_lines'
  | 'too_many_lines'
  | 'unknown_variant'
  | 'one_merchant'
  | 'variant_gone'
  | 'bad_quantity';

export interface LineTarget {
  merchant: string;
  productId: string;
  variantId: string;
}

/** A line as the owner reads it on a card: the merchant's words, cleaned. */
export interface ShownLine {
  product: string;
  variant: string;
  /** The quantity in the unit, as a decimal: steps × 10^-scale (`2.5` kg is 250 steps at scale 2). */
  quantity: string;
  unit: string;
  price: Price;
}

/** The merchant and ids each handle names, all at one merchant; or why not. */
export function lineTargets(
  search: UcpSearchStore,
  conversation: string,
  input: readonly LineInput[],
): { ok: true; merchant: string; list: LineTarget[] } | { ok: false; reason: LineRefusal } {
  if (input.length === 0) return { ok: false, reason: 'no_lines' };
  if (input.length > MAX_LINES) return { ok: false, reason: 'too_many_lines' };
  const list = input.map((l) => search.variantTarget(conversation, l.variant));
  if (list.some((t) => t === null)) return { ok: false, reason: 'unknown_variant' };
  const targets = list as LineTarget[];
  const merchant = (targets[0] as LineTarget).merchant;
  if (targets.some((t) => t.merchant !== merchant)) return { ok: false, reason: 'one_merchant' };
  return { ok: true, merchant, list: targets };
}

/**
 * Each line's product afresh, its variant's unit, and the quantity checked
 * against the unit's increment: the lines to send, and the lines to show.
 */
export async function freshLines(
  connection: MerchantConnection,
  settings: Pick<UcpSettings, 'context'>,
  input: readonly LineInput[],
  targets: readonly LineTarget[],
): Promise<
  | { ok: true; lines: IntentLine[]; shown: ShownLine[] }
  | { ok: false; reason: LineRefusal; detail?: string }
> {
  const products = new Map<
    string,
    { title: string; variants: Map<string, { title: string; unit: QuantityUnit; price: Price }> }
  >();
  for (const productId of new Set(targets.map((t) => t.productId))) {
    const answer = await connection.call('get_product', {
      payload: buildGetProductRequest(productId, settings.context),
    });
    if (!answer.ok) return { ok: false, reason: 'variant_gone' };
    const product = readProductDetail(answer.value);
    if (!product.ok || product.value.id !== productId) return { ok: false, reason: 'variant_gone' };
    products.set(productId, {
      title: product.value.title,
      variants: new Map(
        product.value.variants.map((v) => [v.id, { title: v.title, unit: v.unit, price: v.price }]),
      ),
    });
  }
  const lines: IntentLine[] = [];
  const shown: ShownLine[] = [];
  const seen = new Set<string>();
  for (const [i, t] of targets.entries()) {
    const product = products.get(t.productId);
    const variant = product?.variants.get(t.variantId);
    if (product === undefined || variant === undefined)
      return { ok: false, reason: 'variant_gone' };
    const line = input[i] as LineInput;
    const { unit } = variant;
    if (
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < unit.increment ||
      line.quantity % unit.increment !== 0
    )
      return { ok: false, reason: 'bad_quantity', detail: line.variant };
    // Two lines for one variant could not be told apart in the merchant's answer.
    if (seen.has(t.variantId))
      return { ok: false, reason: 'bad_quantity', detail: 'repeated variant' };
    seen.add(t.variantId);
    lines.push({ itemId: t.variantId, quantity: BigInt(line.quantity), unit });
    shown.push({
      product: a2aDisplayText(product.title, 120),
      variant: a2aDisplayText(variant.title, 80),
      quantity: decimalFromSteps(BigInt(line.quantity), unit.scale),
      unit: a2aDisplayText(unit.displayText, 40),
      price: variant.price,
    });
  }
  return { ok: true, lines, shown };
}
