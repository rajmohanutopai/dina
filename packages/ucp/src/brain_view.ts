/**
 * What Brain may read of a merchant's product (UCP plan §3.11), and the text
 * that must pass the guard first. Pure: Core supplies the handles.
 *
 *  - Opaque values become handles: the merchant (`m1`), the product (`p3`),
 *    its variants (`v3.2`), and any unit code Dina does not know (`u1`).
 *    Brain proposes actions in handles; Core maps them back. URLs, SKUs and
 *    ids never reach Brain (the owner sees them on Core's own surfaces).
 *  - Checked structured fields pass as they are: prices (minor units and
 *    currency), known Rec 20 unit codes with scale and increment, and
 *    availability.
 *  - Text is the guard's: the product's title (200 characters) and
 *    description (1,000), each variant's title (300) and an unknown unit's
 *    display text (300). One job per product, at most 8 KiB; past that,
 *    variant texts are dropped from the end, then the description is cut.
 */

import { toMinorUnitsString } from './money';
import { REC20_TO_DINA } from './units';

import type { Product } from './catalog';
import type { Price } from './money';

export const TEXT_LIMITS = { title: 200, description: 1000, other: 300 } as const;
export const GUARD_JOB_MAX_BYTES = 8 * 1024;
/**
 * Variants of one product Brain is shown; a merchant decides how many it
 * sends (`product.json` sets no maximum), and the rest are dropped.
 */
export const VARIANTS_PER_PRODUCT = 10;

/** Handles Core hands out; the same value always gets the same handle in a conversation. */
export interface HandleSink {
  product(productId: string): string;
  variant(productHandle: string, variantId: string): string;
  /** A unit code Dina does not know. */
  unit(code: string): string;
}

export interface BrainPrice {
  /** Minor units, as a decimal string. */
  amount: string;
  currency: string;
}

export interface BrainVariant {
  handle: string;
  price: BrainPrice;
  list_price?: BrainPrice;
  /** A known Rec 20 code, or a unit handle (`u1`). */
  unit: string;
  scale: number;
  increment: number;
  available?: boolean;
}

export interface BrainProduct {
  handle: string;
  merchant: string;
  price_range: { min: BrainPrice; max: BrainPrice };
  variants: BrainVariant[];
}

/** The merchant text of one product, cut, for one guard job. */
export interface GuardText {
  title: string;
  description?: string;
  variants: { handle: string; title: string; unit_text?: string }[];
}

/**
 * The most digits a price Dina shows may have: what Dina's money type holds
 * (`MAX_MONEY_MINOR_UNIT_DIGITS` in @dina/commerce-protocol). UCP allows up to
 * 2^53-1, sixteen digits; a product priced past fifteen is not shown at all,
 * so no surface is ever handed an amount it cannot format.
 */
export const SHOWN_PRICE_MAX_DIGITS = 15;

const shown = (p: Price): boolean => p.amount.toString().length <= SHOWN_PRICE_MAX_DIGITS;

/** Whether every price a product carries (its range, each variant's price and list price) can be shown. */
export function hasShownPrices(product: Product): boolean {
  return (
    shown(product.priceRange.min) &&
    shown(product.priceRange.max) &&
    product.variants.every(
      (v) => shown(v.price) && (v.listPrice === undefined || shown(v.listPrice)),
    )
  );
}

const brainPrice = (p: Price): BrainPrice => ({
  amount: toMinorUnitsString(p.amount),
  currency: p.currency,
});

/** Cut to at most `n` characters (code points), never inside a surrogate pair. */
export function cutText(text: string, n: number): string {
  const chars = [...text];
  return chars.length <= n ? text : chars.slice(0, n).join('');
}

function plainDescription(product: Product): string | undefined {
  const d = product.description;
  if (d === undefined) return undefined;
  // Plain text first; markdown or HTML go through the guard as written (the guard reads text, never renders it).
  return d.plain ?? d.markdown ?? d.html;
}

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * The product as Brain reads it, and its text for the guard. The text is cut
 * to fit `GUARD_JOB_MAX_BYTES` less `reserveBytes`, the room the caller's job
 * wrapper takes (the merchant's origin, for one). A variant id the product
 * repeats is kept once: two variants behind one handle could not be told
 * apart. At most `VARIANTS_PER_PRODUCT` variants are kept, in order.
 */
export function brainView(
  product: Product,
  merchantHandle: string,
  handles: HandleSink,
  reserveBytes = 0,
): { product: BrainProduct; text: GuardText } {
  const handle = handles.product(product.id);
  const variants: BrainVariant[] = [];
  const texts: GuardText['variants'] = [];
  const seen = new Set<string>();
  for (const v of product.variants) {
    if (variants.length >= VARIANTS_PER_PRODUCT) break;
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    const vh = handles.variant(handle, v.id);
    const known = REC20_TO_DINA.has(v.unit.unit);
    variants.push({
      handle: vh,
      price: brainPrice(v.price),
      ...(v.listPrice !== undefined ? { list_price: brainPrice(v.listPrice) } : {}),
      unit: known ? v.unit.unit : handles.unit(v.unit.unit),
      scale: v.unit.scale,
      increment: v.unit.increment,
      ...(v.available !== undefined ? { available: v.available } : {}),
    });
    texts.push({
      handle: vh,
      title: cutText(v.title, TEXT_LIMITS.other),
      ...(known ? {} : { unit_text: cutText(v.unit.displayText, TEXT_LIMITS.other) }),
    });
  }
  const description = plainDescription(product);
  const text: GuardText = {
    title: cutText(product.title, TEXT_LIMITS.title),
    ...(description !== undefined
      ? { description: cutText(description, TEXT_LIMITS.description) }
      : {}),
    variants: texts,
  };
  // Within the job cap: drop variant texts from the end, then shorten the description.
  // Each dropped variant takes its own bytes and the comma before it (or, the
  // last one left, just its bytes): the size is kept, not re-measured.
  const cap = GUARD_JOB_MAX_BYTES - reserveBytes;
  let size = byteLength(text);
  while (size > cap && text.variants.length > 0) {
    const dropped = text.variants.pop();
    size -= byteLength(dropped) + (text.variants.length > 0 ? 1 : 0);
  }
  while (byteLength(text) > cap && text.description !== undefined && text.description.length > 0) {
    text.description = cutText(text.description, Math.floor([...text.description].length / 2));
  }
  return {
    product: {
      handle,
      merchant: merchantHandle,
      price_range: {
        min: brainPrice(product.priceRange.min),
        max: brainPrice(product.priceRange.max),
      },
      variants,
    },
    text,
  };
}
