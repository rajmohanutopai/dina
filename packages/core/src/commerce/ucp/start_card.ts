/**
 * The `ucp_checkout_start` card (UCP plan §3.7): "Start checkout at
 * <merchant>?", raised before anything that opens a checkout is sent.
 *
 * Core mints it, in the transaction that writes its session row, from the
 * checkout intent Core built; Brain can neither create, decide nor move it
 * (`CORE_MINTED_PAYLOAD_TYPES`). It shows the owner exactly what the
 * approval covers: the merchant and its PeerLens trust line, every line
 * (the merchant's product and variant names, cleaned), quantities and units,
 * discount codes, and the personal-data fields to be sent (none by default,
 * D3). It carries the intent's hash: the permit the approval mints is bound
 * to it, and a card whose hash is not its session's mints nothing.
 *
 * The merchant's words on it are for the owner only; none reach Brain.
 */

import { parseStrictJson } from '@dina/a2a';

import { formatMoney } from '../money_display';

import type { ShownLine } from './lines';
import type { MerchantTrust } from './merchant_trust';

export const UCP_CHECKOUT_START_TYPE = 'ucp_checkout_start';

/** How long a start card waits for the owner. */
export const START_CARD_TTL_MS = 60 * 60_000;

export interface StartCardLine {
  product: string;
  variant: string;
  /** In the unit, as a decimal (steps × 10^-scale). */
  quantity: string;
  unit: string;
  /** The variant's price per unit when the card was raised, in minor units. */
  price: { amount: string; currency: string };
}

export interface StartCard {
  type: typeof UCP_CHECKOUT_START_TYPE;
  session_id: string;
  intent_hash: string;
  /** The merchant's canonical identity (the origin of its root profile). */
  merchant: string;
  trust: StartCardTrust;
  lines: StartCardLine[];
  discount_codes: string[];
  /** The personal-data fields the create will carry; none by default (D3). */
  personal_data: string[];
}

export type StartCardTrust =
  | { state: 'rated'; recommendation: string; level: string; reviews: number }
  | { state: 'unrated' }
  | { state: 'unavailable' };

export function startCardLines(shown: readonly ShownLine[]): StartCardLine[] {
  return shown.map((l) => ({
    product: l.product,
    variant: l.variant,
    quantity: l.quantity,
    unit: l.unit,
    price: { amount: l.price.amount.toString(), currency: l.price.currency },
  }));
}

export function startCardTrust(trust: MerchantTrust): StartCardTrust {
  return trust.state === 'rated'
    ? {
        state: 'rated',
        recommendation: trust.recommendation,
        level: trust.level,
        reviews: trust.reviews,
      }
    : { state: trust.state };
}

/** The trust line as text. */
export function trustLine(trust: StartCardTrust): string {
  if (trust.state === 'unavailable') return 'PeerLens trust: not available now';
  if (trust.state === 'unrated') return 'PeerLens trust: no reviews yet';
  const reviews = `${trust.reviews} review${trust.reviews === 1 ? '' : 's'}`;
  return `PeerLens trust: ${trust.recommendation} (${trust.level}, ${reviews})`;
}

function lineText(l: StartCardLine): string {
  const variant = l.variant !== '' && l.variant !== l.product ? ` (${l.variant})` : '';
  const each = formatMoney({ currency: l.price.currency, minor_units: l.price.amount });
  return `${l.quantity} ${l.unit} × ${l.product}${variant} at ${each}`;
}

/** The card's text where no renderer knows the type: everything the approval covers. */
export function startCardDescription(card: StartCard): string {
  const host = new URL(card.merchant).host;
  return [
    `Start checkout at ${host}?`,
    trustLine(card.trust),
    ...card.lines.map(lineText),
    card.discount_codes.length > 0 ? `Discount codes: ${card.discount_codes.join(', ')}` : null,
    card.personal_data.length > 0
      ? `Personal data sent: ${card.personal_data.join(', ')}`
      : 'No personal data is sent.',
    'You pay on the merchant’s own page; Dina never pays.',
  ]
    .filter((x): x is string => x !== null)
    .join('\n');
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function readTrust(v: unknown): StartCardTrust | null {
  if (!isRecord(v)) return null;
  if (v.state === 'unrated' || v.state === 'unavailable') return { state: v.state };
  if (
    v.state === 'rated' &&
    isString(v.recommendation) &&
    isString(v.level) &&
    Number.isSafeInteger(v.reviews)
  )
    return {
      state: 'rated',
      recommendation: v.recommendation,
      level: v.level,
      reviews: v.reviews as number,
    };
  return null;
}

function readLine(v: unknown): StartCardLine | null {
  if (!isRecord(v) || !isRecord(v.price)) return null;
  const { product, variant, quantity, unit, price } = v;
  if (!isString(product) || !isString(variant) || !isString(unit)) return null;
  if (!isString(quantity) || !/^\d{1,16}(\.\d{1,15})?$/.test(quantity)) return null;
  // A price as `formatMoney` reads it: a non-negative integer of at most 15 digits, ISO 4217.
  if (
    !isString(price.amount) ||
    !/^(0|[1-9]\d{0,14})$/.test(price.amount) ||
    !isString(price.currency) ||
    !/^[A-Z]{3}$/.test(price.currency)
  )
    return null;
  return {
    product,
    variant,
    quantity,
    unit,
    price: { amount: price.amount, currency: price.currency },
  };
}

/** A stored start card, checked field by field; null when the payload is not one. */
export function readStartCard(payload: string): StartCard | null {
  const parsed = parseStrictJson(payload);
  if (!parsed.ok || !isRecord(parsed.value)) return null;
  const v = parsed.value;
  if (v.type !== UCP_CHECKOUT_START_TYPE) return null;
  if (!isString(v.session_id) || !isString(v.intent_hash) || !isString(v.merchant)) return null;
  const trust = readTrust(v.trust);
  if (trust === null) return null;
  if (!Array.isArray(v.lines) || v.lines.length === 0) return null;
  const lines = v.lines.map(readLine);
  if (lines.some((l) => l === null)) return null;
  if (!Array.isArray(v.discount_codes) || !v.discount_codes.every(isString)) return null;
  if (!Array.isArray(v.personal_data) || !v.personal_data.every(isString)) return null;
  return {
    type: UCP_CHECKOUT_START_TYPE,
    session_id: v.session_id,
    intent_hash: v.intent_hash,
    merchant: v.merchant,
    trust,
    lines: lines as StartCardLine[],
    discount_codes: v.discount_codes as string[],
    personal_data: v.personal_data as string[],
  };
}
