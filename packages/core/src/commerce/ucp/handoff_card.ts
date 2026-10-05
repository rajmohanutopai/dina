/**
 * The `ucp_checkout_handoff` card (UCP plan §3.7, §3.8): "Review and pay at
 * <merchant>", raised from the merchant's checkout answer once every
 * mutation of the session has settled. Its action opens the hand-off URL;
 * Dina never pays and never completes.
 *
 * Core mints it (`CORE_MINTED_PAYLOAD_TYPES`) and a person must be present
 * to say yes (`PRESENCE_GATED_PAYLOAD_TYPES`): a person, not an agent, opens
 * a payment page. Card text is Core's rendering of the merchant's answer,
 * cleaned for display (invisible characters removed, lengths capped), never
 * Brain's. The rendering rules the spec puts on any buyer
 * (`checkout/index.md:837-886, 1296-1353`): totals in the merchant's order
 * with its `display_text`, never recomputed; every message shown (errors,
 * warnings, notices); a disclosure kept beside the item it names and never
 * dismissible; the fulfillment choice and its cost. Whatever the card cannot
 * carry faithfully (more than it holds, a merchant image, a disclosure it
 * cannot place, totals that do not add up, a hand-off to a page that is not
 * this session) is named in its notes, and the merchant's page is the
 * escalation. Nothing is dropped without a note.
 */

import { a2aDisplayText, parseStrictJson } from '@dina/a2a';
import { decimalFromSteps, type Checkout, type HandoffSource, type TotalEntry } from '@dina/ucp';

import { formatMoney } from '../money_display';

export const UCP_CHECKOUT_HANDOFF_TYPE = 'ucp_checkout_handoff';

/** What a card carries at most; past these the merchant's page shows the rest, and a note says so. */
const MAX_LINES = 50;
const MAX_TOTALS = 20;
const MAX_MESSAGES = 20;
const MAX_LINKS = 10;
const MAX_FULFILLMENT = 5;
/** Longest hand-off URL a card carries (the phone mirror's `link_url` cap, §3.9). */
export const MAX_HANDOFF_URL_BYTES = 2048;

export interface HandoffCardAmount {
  /** Minor units, as the merchant gave them. */
  amount: string;
  currency: string;
}

export interface HandoffCardMessage {
  kind: 'error' | 'warning' | 'info';
  /** The spec's code, or `other` (empty for an info without one). */
  code: string;
  text: string;
  /** A warning the spec says must sit beside its item and stay. */
  disclosure: boolean;
  /** The line it is about (index into `lines`), when its `path` names one. */
  line: number | null;
  /** The merchant's link for it, https only. */
  url: string | null;
}

export interface HandoffCard {
  type: typeof UCP_CHECKOUT_HANDOFF_TYPE;
  session_id: string;
  merchant: string;
  /** The checkout's status as the merchant gave it (`incomplete`, `requires_escalation`, …). */
  status: string;
  lines: { title: string; quantity: string; unit: string; total: HandoffCardAmount | null }[];
  /** In the merchant's order, with its own label when it gave one. */
  totals: { type: string; label: string; amount: HandoffCardAmount }[];
  messages: HandoffCardMessage[];
  discounts: { title: string; amount: HandoffCardAmount; provisional: boolean }[];
  /** The fulfillment chosen so far: method, where, option and its cost. */
  fulfillment: {
    method: string;
    destination: string | null;
    option: string | null;
    cost: HandoffCardAmount | null;
  }[];
  links: { type: string; url: string; title: string }[];
  /** The session's effective expiry, epoch ms. */
  expires_at: number;
  handoff: { url: string; source: HandoffSource; off_host: boolean };
  /** What the merchant's page shows that this card does not: shown, never dropped silently. */
  notes: HandoffNote[];
}

export type HandoffNote =
  | 'more_lines'
  | 'more_totals'
  | 'more_messages'
  | 'more_links'
  | 'more_fulfillment'
  | 'totals_inconsistent'
  | 'unreadable_messages'
  | 'merchant_image'
  | 'disclosure_on_merchant_page'
  | 'needs_merchant_page'
  | 'permalink_new_cart'
  | 'home_page_only';

const text = (v: unknown, max: number): string => a2aDisplayText(v, max);
const money = (amount: bigint, currency: string): HandoffCardAmount => ({
  amount: amount.toString(),
  currency,
});

function totalLabel(t: TotalEntry): string {
  return t.displayText !== undefined ? text(t.displayText, 80) : t.type;
}

function httpsOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || new TextEncoder().encode(v).length > MAX_HANDOFF_URL_BYTES)
    return null;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? v : null;
  } catch {
    return null;
  }
}

/** The line a message's JSONPath names (`$.line_items[2]…`), or null. */
function lineOf(path: string | undefined, lines: number): number | null {
  const m = path === undefined ? null : /^\$\.line_items\[(\d{1,4})\]/.exec(path);
  if (m === null) return null;
  const i = Number(m[1]);
  return i < lines ? i : null;
}

/** The card from the merchant's checkout answer and the URL chosen for it. */
export function buildHandoffCard(
  sessionId: string,
  merchant: string,
  checkout: Checkout,
  expiresAt: number,
  handoff: HandoffCard['handoff'],
  specCode: (code: string) => string,
): HandoffCard {
  const notes: HandoffNote[] = [];
  const note = (n: HandoffNote) => {
    if (!notes.includes(n)) notes.push(n);
  };
  const { currency } = checkout;
  const lines = checkout.lineItems.slice(0, MAX_LINES).map((l) => {
    const total = l.totals.find((t) => t.type === 'total');
    return {
      title: text(l.title, 120),
      // In the unit, as a decimal: the merchant counts in steps of 10^-scale.
      quantity: decimalFromSteps(l.quantity, l.unit.scale),
      unit: text(l.unit.displayText, 40),
      total: total !== undefined ? money(total.amount, currency) : null,
    };
  });
  if (checkout.lineItems.length > MAX_LINES) note('more_lines');
  const totals = checkout.totals.slice(0, MAX_TOTALS).map((t) => ({
    type: t.type,
    label: totalLabel(t),
    amount: money(t.amount, currency),
  }));
  if (checkout.totals.length > MAX_TOTALS) note('more_totals');
  if (!checkout.totalsConsistent) note('totals_inconsistent');

  const all = checkout.messages.messages;
  const messages: HandoffCardMessage[] = all.slice(0, MAX_MESSAGES).map((m) => {
    const disclosure = m.type === 'warning' && m.presentation === 'disclosure';
    const line = lineOf(m.path, lines.length);
    // A disclosure the card cannot place beside its item is read on the merchant's page.
    if (disclosure && m.path !== undefined && m.path !== '$' && line === null)
      note('disclosure_on_merchant_page');
    // Dina loads no merchant images (§3.11): one is seen on the merchant's page.
    if (m.type === 'warning' && m.imageUrl !== undefined) note('merchant_image');
    return {
      kind: m.type,
      code: m.code !== undefined ? specCode(m.code) : '',
      text: text(m.content, 600),
      disclosure,
      line,
      url: m.type === 'warning' ? httpsOrNull(m.url) : null,
    };
  });
  if (all.length > MAX_MESSAGES) note('more_messages');
  if (checkout.messages.unreadable > 0) note('unreadable_messages');
  if (checkout.status === 'requires_escalation') note('needs_merchant_page');

  const fulfillment: HandoffCard['fulfillment'] = checkout.fulfillment
    .slice(0, MAX_FULFILLMENT)
    .map((m) => {
      const dest = m.destinations.find((d) => d.id === m.selectedDestinationId);
      const chosen = m.groups
        .map((g) => g.options.find((o) => o.id === g.selectedOptionId))
        .find((o) => o !== undefined);
      const cost = chosen?.totals.find((t) => t.type === 'total');
      return {
        method: text(m.type, 40),
        destination: dest === undefined ? null : text(dest.name ?? dest.type, 120),
        option: chosen === undefined ? null : text(chosen.title, 120),
        cost: cost === undefined ? null : money(cost.amount, currency),
      };
    });
  if (checkout.fulfillment.length > MAX_FULFILLMENT) note('more_fulfillment');

  if (checkout.links.length > MAX_LINKS) note('more_links');
  // A permalink opens a new cart at the merchant, not this session: its totals, codes and
  // choices may differ there, and Dina cannot follow what happens next (§3.8 step 2, §3.12).
  if (handoff.source === 'permalink') note('permalink_new_cart');
  if (handoff.source === 'home_page') note('home_page_only');
  return {
    type: UCP_CHECKOUT_HANDOFF_TYPE,
    session_id: sessionId,
    merchant,
    status: typeof checkout.status === 'string' ? checkout.status : 'unknown',
    lines,
    totals,
    messages,
    discounts: checkout.discounts.applied.map((d) => ({
      title: text(d.title, 80),
      amount: money(d.amount, currency),
      provisional: d.provisional,
    })),
    fulfillment,
    links: checkout.links.slice(0, MAX_LINKS).map((l) => ({
      type: text(l.type, 40),
      url: l.url,
      title: text(l.title ?? l.type, 80),
    })),
    expires_at: expiresAt,
    handoff,
    notes,
  };
}

function shown(a: HandoffCardAmount): string {
  try {
    return formatMoney({ currency: a.currency, minor_units: a.amount.replace(/^-/, '') });
  } catch {
    return `${a.amount} ${a.currency} (minor units)`;
  }
}

const NOTE_TEXT: Record<HandoffNote, string> = {
  more_lines: 'More items are listed on the merchant’s page.',
  more_totals: 'More charges are listed on the merchant’s page.',
  more_messages: 'More notices are on the merchant’s page; read them there.',
  more_links: 'More policies are linked on the merchant’s page.',
  more_fulfillment: 'More delivery choices are on the merchant’s page.',
  totals_inconsistent: 'The merchant’s totals do not add up as sent; check them on its page.',
  unreadable_messages: 'The merchant sent notices Dina could not read; read them on its page.',
  merchant_image: 'A notice carries an image; see it on the merchant’s page.',
  disclosure_on_merchant_page:
    'A disclosure is about something this card does not show; read it on the merchant’s page.',
  needs_merchant_page: 'The merchant needs something from you that only its page can ask.',
  permalink_new_cart:
    'This opens a new cart at the merchant with the same items: totals, codes and choices may differ there, and Dina cannot follow what happens next.',
  home_page_only: 'Your cart could not be carried over; this opens the store’s home page.',
};

const SIGNED_NEGATIVE = new Set(['discount', 'items_discount']);

/** The card's text where no renderer knows the type: everything the owner must see before paying. */
export function handoffCardDescription(card: HandoffCard): string {
  const host = new URL(card.merchant).host;
  const sign = (t: { type: string; amount: HandoffCardAmount }) =>
    SIGNED_NEGATIVE.has(t.type) || t.amount.amount.startsWith('-') ? '−' : '';
  const message = (m: HandoffCardMessage) =>
    `${m.kind === 'error' ? 'Problem' : m.disclosure ? 'Disclosure' : 'Notice'}: ${m.text}${
      m.url !== null ? ` (${m.url})` : ''
    }`;
  const target = card.handoff.off_host
    ? `This opens ${card.handoff.url}, which is not ${host}.`
    : `This opens ${new URL(card.handoff.url).host}.`;
  return [
    `Review and pay at ${host}`,
    // Each line, with the messages about it right after it.
    ...card.lines.flatMap((l, i) => [
      `${l.quantity} ${l.unit} × ${l.title}${l.total !== null ? ` — ${shown(l.total)}` : ''}`,
      ...card.messages.filter((m) => m.line === i).map((m) => `  ${message(m)}`),
    ]),
    ...card.fulfillment.map(
      (f) =>
        `${f.method}${f.destination !== null ? ` at ${f.destination}` : ''}${
          f.option !== null ? `: ${f.option}` : ''
        }${f.cost !== null ? ` — ${shown(f.cost)}` : ''}`,
    ),
    ...card.totals.map((t) => `${t.label}: ${sign(t)}${shown(t.amount)}`),
    ...card.discounts.map(
      (d) => `Discount ${d.title}: −${shown(d.amount)}${d.provisional ? ' (not final)' : ''}`,
    ),
    ...card.messages.filter((m) => m.line === null).map(message),
    ...card.notes.map((n) => NOTE_TEXT[n]),
    `Open until ${new Date(card.expires_at).toISOString()}.`,
    target,
    'You pay on the merchant’s page; Dina never pays.',
  ].join('\n');
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const MINOR = /^-?(0|[1-9]\d{0,17})$/;

function readAmount(v: unknown): HandoffCardAmount | null {
  return isRecord(v) &&
    isString(v.amount) &&
    MINOR.test(v.amount) &&
    isString(v.currency) &&
    /^[A-Z]{3}$/.test(v.currency)
    ? { amount: v.amount, currency: v.currency }
    : null;
}

/** An amount, or null where the card carries none; `undefined` when malformed. */
function readOptionalAmount(v: unknown): HandoffCardAmount | null | undefined {
  if (v === null) return null;
  return readAmount(v) ?? undefined;
}

const SOURCES: readonly HandoffSource[] = [
  'continue_url',
  'permalink',
  'error_continue_url',
  'home_page',
];
const NOTES = Object.keys(NOTE_TEXT) as HandoffNote[];
const nullableString = (v: unknown): v is string | null => v === null || isString(v);

/** A stored hand-off card, checked field by field; null when the payload is not one. */
export function readHandoffCard(payload: string): HandoffCard | null {
  const parsed = parseStrictJson(payload);
  if (!parsed.ok || !isRecord(parsed.value)) return null;
  const v = parsed.value;
  if (v.type !== UCP_CHECKOUT_HANDOFF_TYPE || !isString(v.session_id) || !isString(v.status))
    return null;
  if (httpsOrNull(v.merchant) === null || !Number.isSafeInteger(v.expires_at)) return null;
  const h = v.handoff;
  if (!isRecord(h) || httpsOrNull(h.url) === null || typeof h.off_host !== 'boolean') return null;
  if (!SOURCES.includes(h.source as HandoffSource)) return null;
  const list = <T>(x: unknown, read: (e: unknown) => T | null): T[] | null => {
    if (!Array.isArray(x)) return null;
    const out = x.map(read);
    return out.some((e) => e === null) ? null : (out as T[]);
  };
  const lines = list(v.lines, (e) => {
    if (!isRecord(e) || !isString(e.title) || !isString(e.quantity) || !isString(e.unit))
      return null;
    const total = readOptionalAmount(e.total);
    return total === undefined
      ? null
      : { title: e.title, quantity: e.quantity, unit: e.unit, total };
  });
  const totals = list(v.totals, (e) => {
    const amount = isRecord(e) ? readAmount(e.amount) : null;
    return isRecord(e) && isString(e.type) && isString(e.label) && amount !== null
      ? { type: e.type, label: e.label, amount }
      : null;
  });
  const messages = list(v.messages, (e): HandoffCardMessage | null => {
    if (!isRecord(e)) return null;
    if (e.kind !== 'error' && e.kind !== 'warning' && e.kind !== 'info') return null;
    if (!isString(e.code) || !isString(e.text) || typeof e.disclosure !== 'boolean') return null;
    if (e.line !== null && !(Number.isSafeInteger(e.line) && (e.line as number) >= 0)) return null;
    if (e.url !== null && httpsOrNull(e.url) === null) return null;
    return {
      kind: e.kind,
      code: e.code,
      text: e.text,
      disclosure: e.disclosure,
      line: e.line as number | null,
      url: e.url as string | null,
    };
  });
  const discounts = list(v.discounts, (e) => {
    const amount = isRecord(e) ? readAmount(e.amount) : null;
    return isRecord(e) && isString(e.title) && amount !== null && typeof e.provisional === 'boolean'
      ? { title: e.title, amount, provisional: e.provisional }
      : null;
  });
  const fulfillment = list(v.fulfillment, (e) => {
    if (!isRecord(e) || !isString(e.method)) return null;
    if (!nullableString(e.destination) || !nullableString(e.option)) return null;
    const cost = readOptionalAmount(e.cost);
    return cost === undefined
      ? null
      : { method: e.method, destination: e.destination, option: e.option, cost };
  });
  const links = list(v.links, (e) => {
    const url = isRecord(e) ? httpsOrNull(e.url) : null;
    return isRecord(e) && isString(e.type) && isString(e.title) && url !== null
      ? { type: e.type, url, title: e.title }
      : null;
  });
  const notes = list(v.notes, (e) =>
    NOTES.includes(e as HandoffNote) ? (e as HandoffNote) : null,
  );
  if (
    lines === null ||
    totals === null ||
    messages === null ||
    discounts === null ||
    fulfillment === null ||
    links === null ||
    notes === null ||
    messages.some((m) => m.line !== null && m.line >= lines.length)
  )
    return null;
  return {
    type: UCP_CHECKOUT_HANDOFF_TYPE,
    session_id: v.session_id,
    merchant: v.merchant as string,
    status: v.status,
    lines,
    totals,
    messages,
    discounts,
    fulfillment,
    links,
    expires_at: v.expires_at as number,
    handoff: { url: h.url as string, source: h.source as HandoffSource, off_host: h.off_host },
    notes,
  };
}
