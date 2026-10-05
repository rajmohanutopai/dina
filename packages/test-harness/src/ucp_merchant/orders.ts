/**
 * The mock merchant's orders (order.json, v2026-08-25): made when a checkout
 * is completed "in the browser", changed by the test (a shipment, a refund,
 * a dispute), and read back with Get Order. Events and adjustments are
 * append-only, as the spec says, and the merchant may share an order or not.
 */

import { UCP_VERSION } from './catalog';

import type { MockCartLine } from './carts';

export interface MockOrderLine extends MockCartLine {
  fulfilled: number;
  status: 'processing' | 'partial' | 'fulfilled' | 'removed';
}

export interface MockOrder {
  id: string;
  checkoutId: string;
  currency: string;
  lines: MockOrderLine[];
  events: {
    id: string;
    type: string;
    occurredAt: number;
    lineItems: { id: string; quantity: number }[];
    trackingNumber?: string;
  }[];
  adjustments: {
    id: string;
    type: string;
    occurredAt: number;
    status: 'pending' | 'completed' | 'failed';
    amount?: number;
  }[];
}

/** An order from a completed checkout's lines. */
export function orderFrom(
  id: string,
  checkoutId: string,
  currency: string,
  lines: readonly MockCartLine[],
): MockOrder {
  return {
    id,
    checkoutId,
    currency,
    lines: lines.map((l) => ({ ...l, fulfilled: 0, status: 'processing' })),
    events: [],
    adjustments: [],
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The order as the merchant answers Get Order. */
export function orderAnswer(order: MockOrder, origin: string): Record<string, unknown> {
  const sum = order.lines.reduce((n, l) => n + l.price * l.quantity, 0);
  return {
    ucp: {
      version: UCP_VERSION,
      capabilities: { 'dev.ucp.shopping.order': [{ version: UCP_VERSION }] },
    },
    id: order.id,
    checkout_id: order.checkoutId,
    permalink_url: `${origin}/orders/${order.id}`,
    line_items: order.lines.map((l) => ({
      id: l.id,
      item: {
        id: l.variantId,
        title: l.title,
        price: l.price,
        ...(l.unit !== undefined ? { quantity_unit: l.unit } : {}),
      },
      quantity: { original: l.quantity, total: l.quantity, fulfilled: l.fulfilled },
      totals: [
        { type: 'subtotal', amount: l.price * l.quantity },
        { type: 'total', amount: l.price * l.quantity },
      ],
      status: l.status,
    })),
    fulfillment: {
      events: order.events.map((e) => ({
        id: e.id,
        occurred_at: iso(e.occurredAt),
        type: e.type,
        line_items: e.lineItems,
        ...(e.trackingNumber !== undefined ? { tracking_number: e.trackingNumber } : {}),
      })),
    },
    adjustments: order.adjustments.map((a) => ({
      id: a.id,
      type: a.type,
      occurred_at: iso(a.occurredAt),
      status: a.status,
      ...(a.amount !== undefined ? { totals: [{ type: 'total', amount: a.amount }] } : {}),
    })),
    currency: order.currency,
    totals: [
      { type: 'subtotal', amount: sum },
      { type: 'total', amount: sum },
    ],
  };
}

/** The merchant does not share this order with the platform (a business outcome, `order/index.md:635-653`). */
export const orderUnauthorized = () => ({
  ucp: { version: UCP_VERSION, status: 'error' },
  messages: [
    {
      type: 'error',
      code: 'unauthorized',
      content: 'This order is not shared with this platform.',
      severity: 'unrecoverable',
    },
  ],
});
