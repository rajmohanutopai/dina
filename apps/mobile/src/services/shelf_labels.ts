/**
 * Shelf-space words and labels (docs/SHELF_SPACE_NEGOTIATION.md) — pure, no
 * I/O, so the inbox can name a term card without loading the AppView client.
 */

import { formatMoney } from '@dina/core';

import type { Term, TermGeneral } from '@dina/commerce-protocol';

/** The Slot Pack's id, as listings and requests name it. */
export const SLOT_PACK_ID = 'com.dinakernel.slot';

/** The shelf categories the Slot Pack ships (its tag vocabulary). */
export const SHELF_CATEGORIES: readonly { tag: string; label: string }[] = [
  { tag: 'bakery', label: 'Bakery' },
  { tag: 'beverages.juice', label: 'Juice' },
  { tag: 'beverages.soft_drinks', label: 'Soft drinks' },
  { tag: 'beverages.tea_coffee', label: 'Tea and coffee' },
  { tag: 'dairy', label: 'Dairy' },
  { tag: 'frozen', label: 'Frozen' },
  { tag: 'home_care', label: 'Home care' },
  { tag: 'personal_care', label: 'Personal care' },
  { tag: 'snacks', label: 'Snacks' },
  { tag: 'staples', label: 'Staples' },
];

export const SLOT_KINDS: readonly { kind: string; label: string }[] = [
  { kind: 'shelf', label: 'Shelf' },
  { kind: 'end_cap', label: 'End of aisle' },
  { kind: 'chiller', label: 'Chiller' },
  { kind: 'counter', label: 'Counter' },
];

export function categoryLabel(tag: string): string {
  return SHELF_CATEGORIES.find((c) => c.tag === tag)?.label ?? tag;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Basis points as a percentage: 800 → "8%", 1250 → "12.5%". */
export function bpsText(bps: string | number): string {
  const n = Number(bps);
  return `${String(n / 100)}%`;
}

/** Rent and share, the way the owner reads them: "INR 1950.00 a month + 8% of sales". */
export function termsText(
  terms: readonly Term[],
  general: Pick<TermGeneral, 'currency' | 'period'>,
): string {
  const fee = terms.find((t) => t.name === 'fee')?.value ?? '0';
  const share = terms.find((t) => t.name === 'share_bps')?.value ?? '0';
  const per = general.period === 'weekly' ? 'a week' : 'a month';
  const parts: string[] = [];
  if (fee !== '0')
    parts.push(`${formatMoney({ currency: general.currency, minor_units: fee })} ${per}`);
  if (share !== '0') parts.push(`${bpsText(share)} of sales`);
  return parts.length === 0 ? 'Nothing' : parts.join(' + ');
}

export const NEGOTIATION_STATE_LABELS: Readonly<Record<string, string>> = {
  negotiating: 'Bargaining',
  ready: 'Offer ready — your yes needed',
  proposed: 'Proposal sent — waiting for the store',
  agreed: 'Agreed',
  closed: 'Closed',
};

export const CLOSE_REASON_LABELS: Readonly<Record<string, string>> = {
  no_offer: 'The store did not answer in time',
  refused: 'The store said no',
  rejected: 'The store did not accept the proposal',
  declined: 'You declined the offer',
  above_ceiling: 'The best offer was above your limit',
  offer_expired: 'The offer expired before you answered',
  unreadable_policy: 'Your limits could not be read',
};

/**
 * Where the document the owner's yes sent stands (§5.3): the proposal on the
 * brand's side, the decision on the store's.
 */
export const DELIVERY_LABELS: Readonly<Record<string, string>> = {
  sent: 'Sent',
  waiting: 'Sent · waiting on the other side',
  delivered: 'Delivered',
  refused: 'Refused by the other side',
  not_delivered: 'Not delivered — the other side never answered',
};

/** An amount in its currency's own decimals ("INR 1950.00", "JPY 1950"); '' when unreadable. */
export function moneyText(currency: unknown, minor: unknown): string {
  return typeof currency === 'string' && typeof minor === 'string' && /^\d+$/.test(minor)
    ? formatMoney({ currency, minor_units: minor })
    : '';
}
