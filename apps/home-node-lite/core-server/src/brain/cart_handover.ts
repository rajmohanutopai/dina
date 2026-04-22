/**
 * Cart handover — purchase handoff builder (README §Core Principles).
 *
 * From README:
 *
 *   "Cart Handover: Dina advises on purchases but never touches money."
 *
 * Dina can research, compare, and recommend — but the final click
 * happens in the merchant's own flow, under the user's direct
 * control. This primitive produces the structured handover:
 *
 *   - A URL the user / client app can open directly.
 *   - A JSON payload the merchant can consume via the Dina cart-
 *     handover protocol (same shape across merchants so the client
 *     UI renders uniformly).
 *
 * **Pure builder** — no IO, no signing, no persistence. Callers pair
 * this with whatever transport / signing layer is appropriate
 * (DIDComm for authenticated handover, a plain HTTPS URL for
 * anonymous).
 *
 * **Money handling posture** — this primitive NEVER:
 *   - Includes stored card numbers.
 *   - Pre-authorises a charge.
 *   - Produces a "click-to-pay" URL where Dina already holds the
 *     credential.
 *
 * It only produces DEEP LINKS into the merchant's cart with items
 * preselected — the user completes payment under their own session
 * on the merchant's side.
 *
 * **URL + payload symmetry** — the same {items, coupon, returnUrl,
 * memo} inputs populate both the URL query params AND the JSON
 * payload. Tests pin that they carry the same information.
 *
 * Source: README.md (Core Principles — Cart Handover) + this
 * primitive is the v0.1 scaffold.
 */

export interface CartItem {
  /** Stable merchant-side product id. */
  sku: string;
  /** Quantity. Positive integer. */
  quantity: number;
  /** Display name for the client-side preview. */
  name?: string;
  /** Unit price in minor units (cents for USD). */
  unitPriceMinor?: number;
  /** ISO-4217 currency code. Required when `unitPriceMinor` is present. */
  currency?: string;
  /** Optional variant id (color, size, etc.). */
  variant?: string;
}

export interface CartHandoverInput {
  /** Stable merchant id (e.g. `chairmaker.shop`). */
  merchant: { id: string; displayName?: string; baseUrl: string };
  /** Items being handed over. */
  items: ReadonlyArray<CartItem>;
  /** Coupon / discount code. */
  coupon?: string;
  /** Optional return URL the merchant should redirect to after checkout. */
  returnUrl?: string;
  /** Short memo surfaced in the preview UI. */
  memo?: string;
  /** Caller-supplied handover id — defaults to a deterministic hash of the input. */
  handoverId?: string;
}

export interface CartHandoverOutcome {
  /** Machine-readable handover payload. */
  payload: CartHandoverPayload;
  /** Opaque deep-link URL for the user/client. */
  url: string;
  /** Computed pricing snapshot if `unitPriceMinor` given. */
  totals: CartTotals | null;
}

export interface CartHandoverPayload {
  /** Protocol version — matches Dina cart-handover schema. */
  version: '1';
  handoverId: string;
  merchantId: string;
  items: CartItem[];
  coupon?: string;
  returnUrl?: string;
  memo?: string;
}

export interface CartTotals {
  currency: string;
  subtotalMinor: number;
  itemCount: number;
}

export class CartHandoverError extends Error {
  constructor(
    public readonly code:
      | 'missing_merchant'
      | 'invalid_merchant_url'
      | 'empty_items'
      | 'invalid_item'
      | 'mixed_currencies'
      | 'invalid_return_url',
    message: string,
  ) {
    // Prefix with the code so stringified + regex-matched errors carry
    // the machine-readable tag. Keeps messages actionable for ops too.
    super(`[${code}] ${message}`);
    this.name = 'CartHandoverError';
  }
}

/**
 * Build the handover. Throws `CartHandoverError` on invalid input.
 */
export function buildCartHandover(
  input: CartHandoverInput,
): CartHandoverOutcome {
  validateMerchant(input.merchant);
  validateItems(input.items);
  if (input.returnUrl !== undefined) validateUrl(input.returnUrl, 'return url', 'invalid_return_url');

  const handoverId =
    input.handoverId && input.handoverId.trim() !== ''
      ? input.handoverId
      : deriveHandoverId(input);

  const items: CartItem[] = input.items.map((i) => ({ ...i }));
  const payload: CartHandoverPayload = {
    version: '1',
    handoverId,
    merchantId: input.merchant.id,
    items,
  };
  if (input.coupon !== undefined) payload.coupon = input.coupon;
  if (input.returnUrl !== undefined) payload.returnUrl = input.returnUrl;
  if (input.memo !== undefined) payload.memo = input.memo;

  const totals = computeTotals(items);
  const url = buildUrl(input.merchant.baseUrl, payload);

  return { payload, url, totals };
}

// ── Internals ──────────────────────────────────────────────────────────

function validateMerchant(m: CartHandoverInput['merchant']): void {
  if (!m || typeof m !== 'object') {
    throw new CartHandoverError('missing_merchant', 'merchant required');
  }
  if (typeof m.id !== 'string' || m.id === '') {
    throw new CartHandoverError('missing_merchant', 'merchant.id required');
  }
  if (typeof m.baseUrl !== 'string' || m.baseUrl === '') {
    throw new CartHandoverError('missing_merchant', 'merchant.baseUrl required');
  }
  validateUrl(m.baseUrl, 'merchant baseUrl', 'invalid_merchant_url');
}

function validateItems(items: ReadonlyArray<CartItem>): void {
  if (!Array.isArray(items) || items.length === 0) {
    throw new CartHandoverError('empty_items', 'at least one item required');
  }
  let currencySeen: string | null = null;
  for (const [i, item] of items.entries()) {
    if (!item || typeof item !== 'object') {
      throw new CartHandoverError('invalid_item', `item ${i}: object required`);
    }
    if (typeof item.sku !== 'string' || item.sku === '') {
      throw new CartHandoverError('invalid_item', `item ${i}: sku required`);
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new CartHandoverError(
        'invalid_item',
        `item ${i}: quantity must be a positive integer`,
      );
    }
    if (item.unitPriceMinor !== undefined) {
      if (!Number.isInteger(item.unitPriceMinor) || item.unitPriceMinor < 0) {
        throw new CartHandoverError(
          'invalid_item',
          `item ${i}: unitPriceMinor must be a non-negative integer`,
        );
      }
      if (typeof item.currency !== 'string' || item.currency === '') {
        throw new CartHandoverError(
          'invalid_item',
          `item ${i}: currency required when unitPriceMinor is set`,
        );
      }
      if (currencySeen === null) currencySeen = item.currency;
      else if (currencySeen !== item.currency) {
        throw new CartHandoverError(
          'mixed_currencies',
          `cart contains ${currencySeen} + ${item.currency} items`,
        );
      }
    }
  }
}

function validateUrl(
  raw: string,
  label: string,
  code:
    | 'invalid_merchant_url'
    | 'invalid_return_url',
): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CartHandoverError(code, `${label} must be a valid URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new CartHandoverError(code, `${label} must be http(s)`);
  }
  return parsed;
}

function computeTotals(items: ReadonlyArray<CartItem>): CartTotals | null {
  let subtotal = 0;
  let currency: string | null = null;
  let itemCount = 0;
  for (const i of items) {
    itemCount += i.quantity;
    if (i.unitPriceMinor === undefined || i.currency === undefined) {
      // Mixed priced + unpriced items → caller can't display a
      // meaningful subtotal. Bail out rather than report a half-total.
      return null;
    }
    subtotal += i.unitPriceMinor * i.quantity;
    currency = i.currency;
  }
  if (currency === null) return null;
  return { currency, subtotalMinor: subtotal, itemCount };
}

function buildUrl(baseUrl: string, payload: CartHandoverPayload): string {
  const url = new URL(baseUrl);
  url.searchParams.set('dina_cart', '1');
  url.searchParams.set('handover_id', payload.handoverId);
  const skus = payload.items.map((i) => `${i.sku}:${i.quantity}`).join(',');
  url.searchParams.set('items', skus);
  if (payload.coupon) url.searchParams.set('coupon', payload.coupon);
  if (payload.returnUrl) url.searchParams.set('return_url', payload.returnUrl);
  return url.toString();
}

function deriveHandoverId(input: CartHandoverInput): string {
  // Deterministic, non-cryptographic id so repeated builds with the
  // same input produce the same id. Callers needing a crypto-strong
  // id supply `handoverId` explicitly.
  const seed = [
    input.merchant.id,
    ...input.items.map((i) => `${i.sku}x${i.quantity}:${i.variant ?? ''}`),
    input.coupon ?? '',
  ].join('|');
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  return `cart-${hex}`;
}
