/**
 * The `purchase_decision` vault item (UCP plan §3.14, D5, S14): a minimal
 * record of what was bought, where, when and for how much, written once the
 * order is known. It is the one part of a purchase that outlives the order's
 * close; the merchant's snapshot is dropped then.
 *
 * Where: the `consumer` persona when this node has one (purchases are what
 * it holds), else `general`. A `consumer` persona that is closed is waited
 * for, never bypassed into `general`: crossing compartments is the owner's
 * choice, not Core's.
 *
 * How: Core's own append-only write (origin `staging_item`), under an id
 * derived from the merchant and order, so a retry after a crash finds the
 * item it already wrote rather than writing a second.
 *
 * What: Core's words only. The shop's host (an origin the owner allowed),
 * how many items, the total and when. Brain reads the vault, and plan §3.11
 * keeps every merchant-written string (line titles) and merchant-chosen id or
 * URL (the order id, its link) from Brain unless the guard passed it; nothing
 * on an order has passed it. Titles and the order's link stay in My Orders,
 * which only the owner reads.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { isPersonaOpen, personaExists } from '../../persona/service';
import { getItemIncludeDeleted, storeItem } from '../../vault/crud';
import { formatMoney } from '../money_display';

import { readOrderSummary, type OrderSummary } from './orders';

import type { OrderRow } from './order_store';

/** The persona a purchase is recorded in now; null when it must wait (its persona closed). */
export function purchasePersona(): string | null {
  if (personaExists('consumer')) return isPersonaOpen('consumer') ? 'consumer' : null;
  return isPersonaOpen('general') ? 'general' : null;
}

/** The item's id: one per merchant order, ever. */
export function purchaseItemId(row: Pick<OrderRow, 'merchant_origin' | 'order_id'>): string {
  const digest = sha256(new TextEncoder().encode(`${row.merchant_origin}|${row.order_id}`));
  return `ucp-purchase-${bytesToHex(digest).slice(0, 24)}`;
}

/** A total as the owner reads it; null when it does not read as money (it is then left out). */
function moneyText(minor: string, currency: string): string | null {
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  try {
    return formatMoney({ currency, minor_units: minor });
  } catch {
    return null;
  }
}

/** One line in Core's words: "Bought 3 items at tea.example for EUR 27.00". */
export function purchaseSummaryText(host: string, summary: OrderSummary | null): string {
  if (summary === null) return `Bought at ${host}`;
  const items = itemCount(summary);
  // Every line removed: an order placed, and nothing of it kept.
  if (items === 0) return `Ordered at ${host}; every item was removed from the order`;
  const what = items === 1 ? '1 item' : `${String(items)} items`;
  const money = summary.total === null ? null : moneyText(summary.total, summary.currency);
  const total = money === null ? '' : ` for ${money}`;
  return `Bought ${what} at ${host}${total}`;
}

/** Lines kept on the order (removed ones left out); a line sold by weight counts once. */
function itemCount(summary: OrderSummary): number {
  return summary.lines.filter((l) => l.status !== 'removed').length;
}

/**
 * Record the purchase once: the item's id, or null when its persona is
 * closed now (the next sweep tries again).
 */
export function recordPurchase(row: OrderRow): string | null {
  const persona = purchasePersona();
  if (persona === null) return null;
  const id = purchaseItemId(row);
  // Written before a crash took the order's mark: that item stands.
  if (getItemIncludeDeleted(persona, id) !== null) return id;
  const host = new URL(row.merchant_origin).host;
  const summary = readOrderSummary(row.summary_json);
  // Nothing the merchant chose or wrote (§3.11): no order id, no link, no titles.
  const metadata = {
    kind: 'ucp_order',
    merchant_origin: row.merchant_origin,
    currency: summary?.currency ?? null,
    total: summary?.total ?? null,
    lines: summary === null ? null : itemCount(summary),
  };
  storeItem(
    persona,
    {
      id,
      type: 'purchase_decision',
      source: 'ucp',
      source_id: id,
      summary: purchaseSummaryText(host, summary),
      body: '',
      metadata: JSON.stringify(metadata),
      timestamp: row.created_at,
      sender: host,
      source_type: 'service',
    },
    'staging_item',
  );
  return id;
}
