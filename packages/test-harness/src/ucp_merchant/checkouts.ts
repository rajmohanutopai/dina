/**
 * The mock merchant's checkout sessions (checkout.json, v2026-08-25), up to
 * the hand-off: created from line items naming variant ids of its catalogue
 * (prices from the catalogue, in minor units), replaced whole on update,
 * ended by cancel, gone once past `expires_at`. A session stays
 * `incomplete`: the buyer finishes on the merchant's page (`continue_url`),
 * which `completeInBrowser` stands in for. There is no `complete_checkout`:
 * Dina never sends one.
 */

import { linesFrom, type MockCartLine } from './carts';
import { UCP_VERSION, type MockProduct } from './catalog';

export interface MockCheckout {
  id: string;
  currency: string;
  lines: MockCartLine[];
  status: 'incomplete' | 'completed' | 'canceled';
  expiresAt: number;
  /** The order the buyer placed in the browser, once completed. */
  orderId?: string;
  /** The buyer as the platform gave it (Dina gives none, D3), echoed back. */
  buyer?: Record<string, unknown>;
  /** Pickup offered (the merchant's fulfillment), with what the buyer chose so far. */
  pickup?: { destination: string | null; option: string | null };
  /**
   * Shipping offered: the addresses the buyer gave, which one, and the option. Only the
   * conformance run uses it; Dina sends no address (D3).
   */
  shipping?: {
    destinations: Record<string, unknown>[];
    destination: string | null;
    option: string | null;
  };
}

/** The one shipping option the mock offers. */
const SHIP = { method: 'ship', group: 'g_ship', option: 'standard', cost: 500 } as const;

/** The one pickup method the mock offers: a store, and two options. */
export const PICKUP = {
  method: 'pickup',
  location: 'loc_main',
  group: 'g_pickup',
  options: ['same_day', 'next_day'],
} as const;

const pickupAnswer = (checkout: MockCheckout) => {
  const ids = checkout.lines.map((l) => l.id);
  return {
    methods: [
      {
        id: PICKUP.method,
        type: 'pickup',
        line_item_ids: ids,
        destinations: [
          { id: PICKUP.location, type: 'business_location', name: 'Main street shop' },
        ],
        selected_destination_id: checkout.pickup?.destination ?? null,
        groups: [
          {
            id: PICKUP.group,
            line_item_ids: ids,
            options: PICKUP.options.map((id) => ({
              id,
              title: id === 'same_day' ? 'Same day' : 'Next day',
              totals: [{ type: 'total', amount: 0 }],
            })),
            selected_option_id: checkout.pickup?.option ?? null,
          },
        ],
      },
    ],
  };
};

const shippingAnswer = (checkout: MockCheckout) => {
  const ids = checkout.lines.map((l) => l.id);
  const ship = checkout.shipping;
  return [
    {
      id: SHIP.method,
      type: 'shipping',
      line_item_ids: ids,
      destinations: (ship?.destinations ?? []).map((d) => ({ ...d, type: 'shipping_address' })),
      selected_destination_id: ship?.destination ?? null,
      groups: [
        {
          id: SHIP.group,
          line_item_ids: ids,
          options:
            (ship?.destinations.length ?? 0) > 0
              ? [
                  {
                    id: SHIP.option,
                    title: 'Standard',
                    totals: [{ type: 'total', amount: SHIP.cost }],
                  },
                ]
              : [],
          selected_option_id: ship?.option ?? null,
        },
      ],
    },
  ];
};

/**
 * The buyer's shipping choice from an update's `fulfillment`: the addresses it names (each
 * given an id if it has none), the one selected, and the option; `undefined` when it names
 * no shipping method; a refusal when it selects what was not offered.
 */
export function shippingChoice(
  payload: Record<string, unknown>,
): NonNullable<MockCheckout['shipping']> | { refused: string } | undefined {
  const f = payload.fulfillment as { methods?: unknown } | undefined;
  const methods = Array.isArray(f?.methods) ? (f.methods as Record<string, unknown>[]) : [];
  const m = methods.find((x) => x.type === 'shipping');
  if (m === undefined) return undefined;
  const destinations = (Array.isArray(m.destinations) ? m.destinations : [])
    .filter((d): d is Record<string, unknown> => d !== null && typeof d === 'object')
    .map((d, i) => {
      const { type: _type, ...rest } = d;
      return { ...rest, id: typeof d.id === 'string' ? d.id : `dest_${i + 1}` };
    });
  const destination =
    typeof m.selected_destination_id === 'string' ? m.selected_destination_id : null;
  if (destination !== null && !destinations.some((d) => d.id === destination))
    return { refused: 'destination' };
  const group = (Array.isArray(m.groups) ? m.groups[0] : undefined) as
    | { selected_option_id?: unknown }
    | undefined;
  const option = typeof group?.selected_option_id === 'string' ? group.selected_option_id : null;
  if (option !== null && option !== SHIP.option) return { refused: 'option' };
  return { destinations, destination, option };
}

/**
 * The buyer's pickup choice from an update's `fulfillment`, or why it is not
 * one the merchant offered; `undefined` when the update names none.
 */
export function pickupChoice(
  payload: Record<string, unknown>,
): { destination: string | null; option: string | null } | { refused: string } | undefined {
  const f = payload.fulfillment as { methods?: unknown } | undefined;
  if (f === undefined) return undefined;
  const methods = Array.isArray(f.methods) ? f.methods : [];
  const m = (methods as { type?: unknown }[]).find((x) => x.type !== 'shipping') as
    | { id?: unknown; selected_destination_id?: unknown; groups?: unknown }
    | undefined;
  if (m === undefined) return undefined;
  if (m.id !== PICKUP.method) return { refused: 'method' };
  const destination = m.selected_destination_id ?? null;
  if (destination !== null && destination !== PICKUP.location) return { refused: 'destination' };
  const groups = Array.isArray(m.groups) ? m.groups : [];
  const g = groups[0] as { id?: unknown; selected_option_id?: unknown } | undefined;
  const option = g?.selected_option_id ?? null;
  if (g !== undefined && (g.id !== PICKUP.group || !PICKUP.options.includes(option as never)))
    return { refused: 'option' };
  return { destination: destination as string | null, option: option as string | null };
}

const lineAnswer = (l: MockCartLine) => ({
  id: l.id,
  item: {
    id: l.variantId,
    title: l.title,
    price: l.price,
    ...(l.unit !== undefined ? { quantity_unit: l.unit } : {}),
  },
  quantity: l.quantity,
  totals: [
    { type: 'subtotal', amount: l.price * l.quantity },
    { type: 'total', amount: l.price * l.quantity },
  ],
});

/** A checkout session as the merchant answers it. */
export function checkoutAnswer(
  checkout: MockCheckout,
  origin: string,
  extra: {
    messages?: readonly Record<string, unknown>[];
    continueUrl?: boolean;
    /** An empty `payment` block (no instruments): the conformance suite reads it; Dina never pays. */
    emptyPayment?: boolean;
  } = {},
): Record<string, unknown> {
  const sum = checkout.lines.reduce((n, l) => n + l.price * l.quantity, 0);
  return {
    ucp: {
      version: UCP_VERSION,
      capabilities: { 'dev.ucp.shopping.checkout': [{ version: UCP_VERSION }] },
      // Required on every checkout answer; Dina never pays, so it reads none of them.
      payment_handlers: {},
    },
    id: checkout.id,
    status: checkout.status,
    currency: checkout.currency,
    line_items: checkout.lines.map(lineAnswer),
    totals: [
      { type: 'subtotal', amount: sum },
      { type: 'total', amount: sum },
    ],
    links: [
      { type: 'terms_of_service', url: `${origin}/terms` },
      { type: 'privacy_policy', url: `${origin}/privacy` },
    ],
    expires_at: new Date(checkout.expiresAt).toISOString(),
    ...(extra.emptyPayment === true ? { payment: { instruments: [] } } : {}),
    ...(checkout.buyer !== undefined ? { buyer: checkout.buyer } : {}),
    ...(extra.continueUrl !== false ? { continue_url: `${origin}/checkout/${checkout.id}` } : {}),
    ...(extra.messages !== undefined && extra.messages.length > 0
      ? { messages: extra.messages }
      : {}),
    ...(checkout.pickup !== undefined || checkout.shipping !== undefined
      ? {
          fulfillment: {
            methods: [
              ...(checkout.shipping !== undefined ? shippingAnswer(checkout) : []),
              ...(checkout.pickup !== undefined ? pickupAnswer(checkout).methods : []),
            ],
          },
        }
      : {}),
    ...(checkout.orderId !== undefined
      ? {
          order: {
            id: checkout.orderId,
            permalink_url: `${origin}/orders/${checkout.orderId}`,
          },
        }
      : {}),
  };
}

/** An item the merchant cannot sell now, as a UCP error answer with a way to carry on. */
export const outOfStock = (origin: string) => ({
  ucp: { version: UCP_VERSION, status: 'error' },
  messages: [
    {
      type: 'error',
      code: 'out_of_stock',
      content: 'An item is out of stock.',
      severity: 'recoverable',
    },
  ],
  continue_url: `${origin}/cart`,
});

/** Lines for a checkout from its request's line items (the same rules as a cart's). */
export function checkoutLines(
  products: readonly MockProduct[],
  payload: Record<string, unknown>,
  previous: readonly MockCartLine[],
  newLineId: () => string,
): ReturnType<typeof linesFrom> {
  return linesFrom(products, payload, previous, newLineId);
}
