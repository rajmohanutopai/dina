/**
 * My Orders, for UCP orders (UCP plan §3.14, U3.4): what the owner sees of
 * each order Dina follows, in Core's words.
 *
 * Deviation, recorded in the notes: the plan says "a projection into
 * `listPlacedOrders`". That list is the D2D buyer's: every entry is bound to
 * a supplier DID, a signed quote and a retained proposal, and its progress
 * comes from the money line. A UCP order has none of these, so projecting
 * one there would mean inventing them. UCP orders get their own list
 * (`GET /v1/owner/ucp/orders`), shown beside placed orders.
 *
 * Every line here is Core's: the headline from the spec's event types and
 * the order's line statuses; lines and totals as the merchant last gave
 * them (a webhook-only order says so). The merchant's own free text (labels,
 * event descriptions) is not shown. "Track or return at <merchant>" opens the
 * order's permalink.
 */

import { parseStrictJson } from '@dina/a2a';

import { adjustmentName } from './order_notice_card';
import { readOrderSummary, type OrderSummary } from './orders';

import type { OrderCloseReason, OrderRow, OrderState } from './order_store';

export interface UcpOrderView {
  merchant_origin: string;
  merchant_host: string;
  order_id: string;
  state: OrderState;
  close_reason: OrderCloseReason | null;
  /** Whether the merchant shares the order with Dina (Get Order answers). */
  shared: boolean;
  /** Core's one-line account of where the order stands. */
  headline: string;
  /** Lines and totals as the merchant last gave them; null before the first answer. */
  summary: OrderSummary | null;
  /**
   * Each refund, return, credit, dispute or other change, in Core's words
   * ("A refund: completed"): recorded quietly here, as Silence First wants.
   */
  notes: string[];
  /** "Track or return at <merchant>". */
  permalink_url: string;
  /**
   * Set while following the order waits for the owner to link an account
   * at the merchant (§3.14, §3.17): the full scope set its challenge named
   * (empty: the ones Dina uses). The owner's "Link" starts with these.
   */
  link_scopes: string[] | null;
  created_at: number;
  last_change_at: number;
  closed_at: number | null;
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  pending: 'in progress',
  completed: 'completed',
  failed: 'failed',
};

const EVENT_HEADLINE: Readonly<Record<string, string>> = {
  processing: 'Being prepared',
  shipped: 'Shipped',
  in_transit: 'On its way',
  delivered: 'Delivered',
  failed_attempt: 'A delivery attempt failed',
  canceled: 'A shipment was cancelled',
  undeliverable: 'Cannot be delivered',
  returned_to_sender: 'Going back to the shop',
};

/** Core's headline for an order. */
export function orderHeadline(row: OrderRow, summary: OrderSummary | null): string {
  const host = new URL(row.merchant_origin).host;
  if (row.close_reason === 'not_found') return `${host} no longer has this order`;
  // Polling waits for the owner to link an account (§3.14, §3.17).
  if (row.state === 'open' && row.link_scopes !== null)
    return `Link your account at ${host} to follow this order`;
  if (row.state === 'not_shared' && summary === null)
    return `${host} does not share this order with Dina`;
  if (row.close_reason === 'not_shared') return `${host} does not share this order with Dina`;
  if (summary === null) return 'Placed';
  const statuses = summary.lines.map((l) => l.status);
  if (statuses.length > 0 && statuses.every((s) => s === 'removed')) return 'Cancelled';
  const pending = summary.adjustments.some((a) => a.status === 'pending');
  if (summary.settled && !pending)
    return statuses.every((s) => s === 'fulfilled' || s === 'removed') ? 'Complete' : 'Placed';
  if (summary.latest_event !== null)
    return EVENT_HEADLINE[summary.latest_event.type] ?? 'Being handled';
  if (statuses.some((s) => s === 'partial' || s === 'fulfilled')) return 'Partly sent';
  return 'Placed';
}

/** The stored challenge scopes; a list that does not read is none named (the scopes Dina uses). */
function linkScopesOf(text: string): string[] {
  const parsed = parseStrictJson(text);
  if (!parsed.ok || !Array.isArray(parsed.value)) return [];
  const v: unknown[] = parsed.value;
  return v.every((s): s is string => typeof s === 'string') ? (v as string[]) : [];
}

export function ucpOrderView(row: OrderRow): UcpOrderView {
  const summary = readOrderSummary(row.summary_json);
  return {
    merchant_origin: row.merchant_origin,
    merchant_host: new URL(row.merchant_origin).host,
    order_id: row.order_id,
    state: row.state,
    close_reason: row.close_reason,
    shared: row.state !== 'not_shared' && row.close_reason !== 'not_shared',
    headline: orderHeadline(row, summary),
    summary,
    notes: (summary?.adjustments ?? []).map((a) => {
      const name = adjustmentName(a.type);
      return `${name.charAt(0).toUpperCase()}${name.slice(1)}: ${STATUS_WORDS[a.status] ?? 'changed'}`;
    }),
    permalink_url: row.permalink_url,
    link_scopes:
      row.state === 'open' && row.link_scopes !== null ? linkScopesOf(row.link_scopes) : null,
    created_at: row.created_at,
    last_change_at: row.last_change_at,
    closed_at: row.closed_at,
  };
}
