/**
 * The checkout cards as the paired phone shows them (UCP plan §3.9): a title
 * and a detail inside the mirror's limits (`approval/mirror_text.ts`).
 *
 *  - The start card is mirrored only when every line, code and field the
 *    yes covers fits: the owner approves what they read, or decides on the
 *    console.
 *  - The hand-off card carries the merchant, the total with its label, the
 *    item count, the expiry and every message; when that does not fit, the
 *    total and "N more details on the merchant's page", which is honest
 *    because the hand-off itself shows them. Its yes needs a person present
 *    on the phone (`presence_required`), and opens `link_url` there.
 */

import { isMirrorableDetail, isMirrorableTitle } from '../../approval/mirror_text';
import { formatMoney } from '../money_display';

import { handoffCardDescription, type HandoffCard } from './handoff_card';
import { startCardDescription, type StartCard } from './start_card';

export interface CheckoutMirror {
  title: string;
  detail: string;
  /** The URL the phone opens after a yes made in person. */
  linkUrl?: string;
  presenceRequired?: true;
}

/** The start card on the phone, or null when its full text does not fit (the console decides). */
export function startCardMirror(card: StartCard): CheckoutMirror | null {
  const title = `Start checkout at ${new URL(card.merchant).host}?`;
  // Everything the description says but its first line (the title).
  const detail = startCardDescription(card).split('\n').slice(1).join('\n');
  return isMirrorableTitle(title) && isMirrorableDetail(detail) ? { title, detail } : null;
}

/** The hand-off card on the phone: everything that fits, and an honest count of the rest. */
export function handoffCardMirror(card: HandoffCard): CheckoutMirror | null {
  const host = new URL(card.merchant).host;
  const title = `Review and pay at ${host}`;
  const full = handoffCardDescription(card).split('\n').slice(1).join('\n');
  const link = { linkUrl: card.handoff.url, presenceRequired: true as const };
  if (isMirrorableTitle(title) && isMirrorableDetail(full)) return { title, detail: full, ...link };
  const total = card.totals.find((t) => t.type === 'total') ?? card.totals.at(-1);
  const shown = (amount: { amount: string; currency: string }) => {
    try {
      return formatMoney({ currency: amount.currency, minor_units: amount.amount });
    } catch {
      return `${amount.amount} ${amount.currency} (minor units)`;
    }
  };
  const details = card.lines.length + card.messages.length + card.fulfillment.length;
  const short = [
    total !== undefined ? `${total.label}: ${shown(total.amount)}` : null,
    `${card.lines.length} item${card.lines.length === 1 ? '' : 's'}`,
    `${details} more details on the merchant’s page.`,
    `Open until ${new Date(card.expires_at).toISOString()}.`,
    card.handoff.off_host
      ? `This opens ${card.handoff.url}, which is not ${host}.`
      : `This opens ${new URL(card.handoff.url).host}.`,
    'You pay on the merchant’s page; Dina never pays.',
  ]
    .filter((x): x is string => x !== null)
    .join('\n');
  return isMirrorableTitle(title) && isMirrorableDetail(short)
    ? { title, detail: short, ...link }
    : null;
}
