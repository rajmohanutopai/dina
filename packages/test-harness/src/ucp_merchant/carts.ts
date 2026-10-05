/**
 * The mock merchant's carts (cart.json, v2026-08-25): created from line items
 * that name variant ids of its catalogue, replaced whole on update, ended by
 * cancel, gone once past `expires_at`. Prices come from the catalogue, in
 * minor units; each line gets a merchant line id that an update may echo.
 */

import { UCP_VERSION, type MockProduct } from './catalog';

export interface MockCartLine {
  id: string;
  variantId: string;
  title: string;
  price: number;
  quantity: number;
  /** The variant's `quantity_unit`, echoed on the line; none for each. */
  unit?: Record<string, unknown>;
}

export interface MockCart {
  id: string;
  currency: string;
  lines: MockCartLine[];
  expiresAt: number;
  canceled: boolean;
}

/** A not-found outcome in the UCP envelope. */
export const notFound = (what: string) => ({
  ucp: { version: UCP_VERSION, status: 'error' },
  messages: [
    { type: 'error', code: 'not_found', content: `No such ${what}.`, severity: 'unrecoverable' },
  ],
});

/** A merchant's own total line (a type outside the spec's list), shown at zero. */
export interface MockExtraTotal {
  type: string;
  display_text: string;
}

const totals = (amount: number, extra: readonly MockExtraTotal[] = []) => [
  { type: 'subtotal', amount },
  ...extra.map((t) => ({ ...t, amount: 0 })),
  { type: 'total', amount },
];

/** A cart as the merchant answers it. */
export function cartAnswer(
  cart: MockCart,
  extra: readonly MockExtraTotal[] = [],
): Record<string, unknown> {
  const lines = cart.lines.map((l) => ({
    id: l.id,
    item: {
      id: l.variantId,
      title: l.title,
      price: l.price,
      ...(l.unit !== undefined ? { quantity_unit: l.unit } : {}),
    },
    quantity: l.quantity,
    totals: totals(l.price * l.quantity),
  }));
  return {
    ucp: {
      version: UCP_VERSION,
      capabilities: { 'dev.ucp.shopping.cart': [{ version: UCP_VERSION }] },
    },
    id: cart.id,
    currency: cart.currency,
    line_items: lines,
    totals: totals(
      cart.lines.reduce((n, l) => n + l.price * l.quantity, 0),
      extra,
    ),
    expires_at: new Date(cart.expiresAt).toISOString(),
  };
}

/** The variant a line names, with its product, or null. */
function variantOf(products: readonly MockProduct[], id: string) {
  for (const p of products) {
    const v = (
      p.variants as {
        id: string;
        title: string;
        price: { amount: number; currency: string };
        quantity_unit?: { increment?: number } & Record<string, unknown>;
      }[]
    ).find((x) => x.id === id);
    if (v !== undefined) return { product: p, variant: v };
  }
  return null;
}

/**
 * Lines from a request's `line_items`, priced from the catalogue; an unknown
 * item is the spec's `item_unavailable` (an error answer, nothing changed).
 */
export function linesFrom(
  products: readonly MockProduct[],
  payload: Record<string, unknown>,
  previous: readonly MockCartLine[],
  newLineId: () => string,
):
  | { ok: true; lines: MockCartLine[]; currency: string }
  | { ok: false; answer: Record<string, unknown> } {
  const items = Array.isArray(payload.line_items) ? payload.line_items : [];
  const lines: MockCartLine[] = [];
  let currency = 'EUR';
  for (const raw of items) {
    const li = (raw ?? {}) as { id?: unknown; item?: { id?: unknown }; quantity?: unknown };
    const id = typeof li.item?.id === 'string' ? li.item.id : '';
    const found = variantOf(products, id);
    const quantity = typeof li.quantity === 'number' ? li.quantity : 0;
    const increment = found?.variant.quantity_unit?.increment ?? 1;
    if (found === null || quantity < 1 || quantity % increment !== 0)
      return {
        ok: false,
        answer: {
          ucp: { version: UCP_VERSION, status: 'error' },
          messages: [
            {
              type: 'error',
              code: 'item_unavailable',
              content: 'That item is not available.',
              severity: 'unrecoverable',
            },
          ],
        },
      };
    currency = found.variant.price.currency;
    const kept = typeof li.id === 'string' ? previous.find((p) => p.id === li.id) : undefined;
    lines.push({
      id: kept?.id ?? newLineId(),
      variantId: id,
      title: `${found.product.title} — ${found.variant.title}`,
      price: found.variant.price.amount,
      quantity,
      ...(found.variant.quantity_unit !== undefined ? { unit: found.variant.quantity_unit } : {}),
    });
  }
  return { ok: true, lines, currency };
}
