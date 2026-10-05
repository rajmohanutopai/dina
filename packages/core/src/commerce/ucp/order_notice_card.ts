/**
 * The `ucp_order_notice` card (UCP plan §3.13, §3.14, U3.4): the one way an
 * order interrupts the owner. Silence First: only a failure (a failed
 * delivery attempt, a shipment that cannot be delivered or comes back, a
 * failed refund or other adjustment), a cancellation or a dispute raises
 * one; every other change waits quietly in My Orders.
 *
 * Core mints it (`CORE_MINTED_PAYLOAD_TYPES`) from what its own order
 * reconciler recorded, never from Brain. Its text is Core's, from fixed
 * wording keyed on the spec's event and adjustment types; the merchant's
 * own words (labels, descriptions) never reach it. Its one action is "Seen",
 * and "Track or return at <merchant>" opens the order's permalink.
 *
 * The same card tells the owner, once, of a checkout that ended without Dina
 * knowing what the merchant holds (§3.7): a create whose answer was lost
 * (`create_unknown`) or a change never confirmed (`unsettled`). Its link is
 * then the store's home page.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { isPlainObject, parseStrictJson } from '@dina/a2a';

import type { OrderRow } from './order_store';
import type { OrderNotice } from './orders';

export const UCP_ORDER_NOTICE_TYPE = 'ucp_order_notice';

export interface OrderNoticeCard {
  type: typeof UCP_ORDER_NOTICE_TYPE;
  merchant_origin: string;
  /** The merchant's host, for the card's text. */
  merchant_host: string;
  order_id: string;
  permalink_url: string;
  /** What happened, in Core's words. */
  what: string;
  /**
   * The interruption as recorded: an event or adjustment, its id and type,
   * and why; or a checkout that ended unconfirmed (`type` its state).
   */
  notice: {
    kind: 'event' | 'adjustment' | 'checkout';
    id: string;
    type: string;
    reason?: 'new' | 'settled' | 'failed';
  };
  at: number;
}

const EVENT_WORDS: Readonly<Record<string, string>> = {
  failed_attempt: 'a delivery attempt failed',
  canceled: 'a shipment was cancelled',
  undeliverable: 'a shipment cannot be delivered',
  returned_to_sender: 'a shipment is going back to the shop',
};

/** The spec's typical adjustment types (adjustment.json), in Core's words; the type is the shop's open string. */
export const ADJUSTMENT_NAMES: Readonly<Record<string, string>> = {
  refund: 'a refund',
  return: 'a return',
  credit: 'a credit',
  price_adjustment: 'a price adjustment',
  dispute: 'a dispute',
  cancellation: 'a cancellation',
};

/** An adjustment type in Core's words; any type not in the spec's list reads generically. */
export function adjustmentName(type: string): string {
  return Object.prototype.hasOwnProperty.call(ADJUSTMENT_NAMES, type)
    ? (ADJUSTMENT_NAMES[type] as string)
    : 'a change to your order';
}

/**
 * Core's words for an interruption. Event and adjustment types are open
 * strings the shop chooses, so only the spec's own types are named; any
 * other reads generically, and the shop's string never reaches the card.
 */
export function noticeWords(notice: OrderNoticeCard['notice']): string {
  if (notice.kind === 'checkout')
    return notice.type === 'create_unknown'
      ? 'Dina could not confirm whether the shop opened your checkout'
      : 'a change to your checkout could not be confirmed, so it cannot be handed to you';
  if (notice.kind === 'event') return EVENT_WORDS[notice.type] ?? 'a shipment ran into a problem';
  if (notice.type === 'dispute')
    return notice.reason === 'failed'
      ? 'a dispute failed'
      : notice.reason === 'settled'
        ? 'a dispute was resolved'
        : 'a dispute was opened';
  if (notice.type === 'cancellation')
    return notice.reason === 'failed'
      ? 'a cancellation failed'
      : notice.reason === 'settled'
        ? 'the order was cancelled'
        : 'a cancellation was started';
  const name = adjustmentName(notice.type);
  return notice.reason === 'failed' ? `${name} failed` : `${name} changed`;
}

/** The card for one recorded interruption on an order. */
export function orderNoticeCard(row: OrderRow, notice: OrderNotice): OrderNoticeCard {
  const kept: OrderNoticeCard['notice'] =
    notice.kind === 'event'
      ? { kind: 'event', id: notice.id, type: notice.type }
      : { kind: 'adjustment', id: notice.id, type: notice.type, reason: notice.reason };
  return {
    type: UCP_ORDER_NOTICE_TYPE,
    merchant_origin: row.merchant_origin,
    merchant_host: new URL(row.merchant_origin).host,
    order_id: row.order_id,
    permalink_url: row.permalink_url,
    what: noticeWords(kept),
    notice: kept,
    at: notice.at,
  };
}

/** The card's title line. */
export function orderNoticeDescription(card: OrderNoticeCard): string {
  const what = card.what.charAt(0).toUpperCase() + card.what.slice(1);
  if (card.notice.kind === 'checkout')
    return `${what} at ${card.merchant_host}. Check with ${card.merchant_host} before buying again.`;
  return `${what} on your order at ${card.merchant_host}.`;
}

/** The card for a checkout that ended unconfirmed (§3.7); its link is the store. */
export function checkoutNoticeCard(
  session: { session_id: string; merchant_origin: string; state: string },
  at: number,
): OrderNoticeCard {
  const notice = { kind: 'checkout' as const, id: session.session_id, type: session.state };
  return {
    type: UCP_ORDER_NOTICE_TYPE,
    merchant_origin: session.merchant_origin,
    merchant_host: new URL(session.merchant_origin).host,
    order_id: session.session_id,
    permalink_url: `${session.merchant_origin}/`,
    what: noticeWords(notice),
    notice,
    at,
  };
}

const digest = (text: string): string =>
  bytesToHex(sha256(new TextEncoder().encode(text))).slice(0, 32);

/**
 * One card per interruption, ever: a replay of the same notice raises
 * nothing new. A digest, since a task's key is readable where its payload
 * is redacted: it names neither the merchant nor the order.
 */
export function orderNoticeKey(card: OrderNoticeCard): string {
  const n = card.notice;
  return `${UCP_ORDER_NOTICE_TYPE}:${digest(
    `${card.merchant_origin}|${card.order_id}|${n.kind}|${n.id}|${n.reason ?? ''}`,
  )}`;
}

/** The cards of one order share this correlation id; like the key, it names nothing. */
export function orderCorrelationId(row: { merchant_origin: string; order_id: string }): string {
  return `ucp-order:${digest(`${row.merchant_origin}|${row.order_id}`)}`;
}

const isStr = (v: unknown): v is string => typeof v === 'string';

/** A stored card read back field by field; null when it is not one. */
export function readOrderNoticeCard(payload: string): OrderNoticeCard | null {
  const parsed = parseStrictJson(payload);
  if (!parsed.ok || !isPlainObject(parsed.value)) return null;
  const v = parsed.value;
  if (v.type !== UCP_ORDER_NOTICE_TYPE) return null;
  if (
    !isStr(v.merchant_origin) ||
    !isStr(v.merchant_host) ||
    !isStr(v.order_id) ||
    !isStr(v.permalink_url) ||
    !isStr(v.what) ||
    !Number.isSafeInteger(v.at) ||
    !isPlainObject(v.notice)
  )
    return null;
  const n = v.notice;
  if (
    (n.kind !== 'event' && n.kind !== 'adjustment' && n.kind !== 'checkout') ||
    !isStr(n.id) ||
    !isStr(n.type)
  )
    return null;
  if (
    n.reason !== undefined &&
    n.reason !== 'new' &&
    n.reason !== 'settled' &&
    n.reason !== 'failed'
  )
    return null;
  let permalink: URL;
  try {
    permalink = new URL(v.permalink_url);
  } catch {
    return null;
  }
  // The link opens only an https page: the merchant names its own order page (§3.14).
  if (permalink.protocol !== 'https:') return null;
  return {
    type: UCP_ORDER_NOTICE_TYPE,
    merchant_origin: v.merchant_origin,
    merchant_host: v.merchant_host,
    order_id: v.order_id,
    permalink_url: v.permalink_url,
    what: v.what,
    notice: {
      kind: n.kind,
      id: n.id,
      type: n.type,
      ...(n.reason !== undefined ? { reason: n.reason } : {}),
    },
    at: v.at as number,
  };
}
