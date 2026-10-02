/**
 * The owner's order and quote views on the wire, in snake_case.
 *
 * Core's read models (`describeOrderForOwner`, `describeQuoteForOwner`,
 * `listPlacedOrders`) are camelCase TypeScript; the wire is snake_case, like
 * the rest of Dina's HTTP surface. These answers used to spread the read model
 * straight into the body, so `/orders/placed`, `/orders/unsettled`,
 * `/orders/command`, an order send and `/quotes` answered `purchaseOrderId`,
 * `nextPollAtMs` and the like. The mapping lives here, once, so every route
 * that answers with one of these views says it the same way.
 *
 * Nested protocol values (`Money`, `ProductRef`, `Quantity`) are already
 * snake_case and pass through untouched.
 */

import type { OwnerOrderView } from './buyer_reconciliation';
import type { PlacedOrderBase } from './placed_orders';
import type { OwnerQuoteView } from './quote_read_model';
import type { Money } from '@dina/commerce-protocol';

/**
 * The shape of `order_attachments`' PlacedOrderProgress, stated here rather
 * than imported: that module is the money engine, and the money boundary
 * (`money_boundary.test.ts`) admits no new couplings — a wire mapper only
 * needs the fields it renames.
 */
export interface PlacedOrderProgressLike {
  checkoutLink: {
    url: string;
    amount: Money;
    provider: string;
    expiresAt: string | null;
    expired: boolean;
  } | null;
  payment: unknown;
  paymentRecorded: boolean;
  fulfilment: { state: string; provider: string; reportedAt: string } | null;
}

export interface OwnerOrderViewWire {
  purchase_order_id: string;
  state: OwnerOrderView['state'];
  headline: string;
  detail: string | null;
  actions: OwnerOrderView['actions'];
  next_poll_at_ms: number | null;
  poll_count: number;
}

export function ownerOrderViewWire(view: OwnerOrderView): OwnerOrderViewWire {
  return {
    purchase_order_id: view.purchaseOrderId,
    state: view.state,
    headline: view.headline,
    detail: view.detail,
    actions: view.actions,
    next_poll_at_ms: view.nextPollAtMs,
    poll_count: view.pollCount,
  };
}

export interface OwnerQuoteViewWire {
  quote_id: string;
  buyer_did: string;
  state: OwnerQuoteView['state'];
  headline: string;
  detail: string | null;
  actions: OwnerQuoteView['actions'];
  uses_spent: number;
  max_uses: number;
  valid_until: number;
  head_revision: string;
}

export function ownerQuoteViewWire(view: OwnerQuoteView): OwnerQuoteViewWire {
  return {
    quote_id: view.quoteId,
    buyer_did: view.buyerDid,
    state: view.state,
    headline: view.headline,
    detail: view.detail,
    actions: view.actions,
    uses_spent: view.usesSpent,
    max_uses: view.maxUses,
    valid_until: view.validUntil,
    head_revision: view.headRevision,
  };
}

export function placedOrderProgressWire(progress: PlacedOrderProgressLike | null): unknown {
  if (progress === null) return null;
  return {
    checkout_link:
      progress.checkoutLink === null
        ? null
        : {
            url: progress.checkoutLink.url,
            amount: progress.checkoutLink.amount,
            provider: progress.checkoutLink.provider,
            expires_at: progress.checkoutLink.expiresAt,
            expired: progress.checkoutLink.expired,
          },
    payment: progress.payment,
    payment_recorded: progress.paymentRecorded,
    fulfilment:
      progress.fulfilment === null
        ? null
        : {
            state: progress.fulfilment.state,
            provider: progress.fulfilment.provider,
            reported_at: progress.fulfilment.reportedAt,
          },
  };
}

/** One placed order on the wire (`GET /v1/commerce/orders/placed`). */
export function placedOrderWire(
  order: Omit<PlacedOrderBase, 'orderDigest'>,
  progress: PlacedOrderProgressLike | null,
): Record<string, unknown> {
  return {
    ...ownerOrderViewWire(order),
    supplier_did: order.supplierDid,
    service_rkey: order.serviceRkey,
    supplier_name: order.supplierName,
    total: order.total,
    submitted_at: order.submittedAt,
    quote_id: order.quoteId,
    lines: order.lines.map((line) => ({
      line_id: line.lineId,
      product: line.product,
      quantity: line.quantity,
      name: line.name,
    })),
    tender_id: order.tenderId,
    progress: placedOrderProgressWire(progress),
  };
}
