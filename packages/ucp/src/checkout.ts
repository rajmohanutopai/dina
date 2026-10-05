/**
 * Checkout (checkout.json), response side, and the update Dina builds.
 *
 * Dina reads a checkout to fill the hand-off card (§3.7): lines, the merchant's
 * totals in its order, messages, links, fulfillment and discounts, expiry, and
 * after completion the order confirmation (§3.12). It never sends
 * `complete_checkout` (S6).
 */

import { isPlainObject, type JsonObject } from '@dina/a2a';

import { readDiscounts, type Discounts } from './discount';
import {
  readFulfillment,
  type FulfillmentDestination,
  type FulfillmentMethod,
} from './fulfillment';
import {
  buildCreateCheckoutBody,
  lineRequestJson,
  isApprovedAddress,
  shippingAddressJson,
  type CheckoutIntent,
  type IntentCheck,
} from './intent';
import { parseMessages, type MessagesParse } from './messages';
import { checkTotals, isCurrencyCode, parseTotals, type TotalEntry } from './money';
import {
  fail,
  ok,
  readHttpsUrl,
  readLineItems,
  readLinks,
  readTimestamp,
  type LineItem,
  type Link,
  type Read,
} from './resource';

export const CHECKOUT_STATUSES = [
  'incomplete',
  'requires_escalation',
  'ready_for_complete',
  'complete_in_progress',
  'completed',
  'canceled',
] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

/** Default checkout lifetime when the merchant omits `expires_at` (checkout.json:117-122). */
export const DEFAULT_CHECKOUT_TTL_MS = 6 * 60 * 60 * 1000;

export interface OrderConfirmation {
  id: string;
  permalinkUrl: string;
  label?: string;
}

export interface Checkout {
  id: string;
  /** An unknown status is kept as written; Dina acts only on known ones. */
  status: CheckoutStatus | { unknown: string };
  currency: string;
  lineItems: LineItem[];
  totals: TotalEntry[];
  /** The spec's own sum check; an inconsistent answer is shown as the merchant gave it, with a note. */
  totalsConsistent: boolean;
  messages: MessagesParse;
  links: Link[];
  continueUrl?: string;
  expiresAt?: number;
  order?: OrderConfirmation;
  fulfillment: FulfillmentMethod[];
  discounts: Discounts;
}

export function isTerminalStatus(status: Checkout['status']): boolean {
  return status === 'completed' || status === 'canceled';
}

export function readCheckout(value: unknown): Read<Checkout> {
  if (!isPlainObject(value)) return fail('not_object');
  if (typeof value.id !== 'string' || value.id === '') return fail('id');
  if (typeof value.status !== 'string') return fail('status');
  const status = (CHECKOUT_STATUSES as readonly string[]).includes(value.status)
    ? (value.status as CheckoutStatus)
    : { unknown: value.status };
  if (!isCurrencyCode(value.currency)) return fail('currency');
  const lines = readLineItems(value.line_items);
  if (!lines.ok) return lines;
  const totals = parseTotals(value.totals);
  if (!totals.ok) return fail(totals.reason);
  const fulfillment = readFulfillment(value.fulfillment);
  if (!fulfillment.ok) return fulfillment;
  const discounts = readDiscounts(value.discounts);
  if (!discounts.ok) return discounts;

  let expiresAt: number | undefined;
  if (value.expires_at !== undefined) {
    const t = readTimestamp(value.expires_at);
    if (t === null) return fail('expires_at');
    expiresAt = t;
  }
  let order: OrderConfirmation | undefined;
  if (value.order !== undefined) {
    const o = value.order;
    const permalink = isPlainObject(o) ? readHttpsUrl(o.permalink_url) : null;
    if (!isPlainObject(o) || typeof o.id !== 'string' || permalink === null) return fail('order');
    order = {
      id: o.id,
      permalinkUrl: permalink,
      ...(typeof o.label === 'string' ? { label: o.label } : {}),
    };
  }
  if (status === 'completed' && order === undefined) return fail('completed_without_order');
  const continueUrl = readHttpsUrl(value.continue_url);

  return ok({
    id: value.id,
    status,
    currency: value.currency,
    lineItems: lines.value,
    totals: totals.totals,
    totalsConsistent: checkTotals(totals.totals) === 'consistent',
    messages: parseMessages(value.messages),
    links: readLinks(value.links),
    fulfillment: fulfillment.value,
    discounts: discounts.value,
    ...(continueUrl !== null ? { continueUrl } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(order !== undefined ? { order } : {}),
  });
}

/** §3.12: the checkout's `expires_at`, or creation + 6 hours when omitted. */
export function effectiveExpiry(
  checkout: Pick<Checkout, 'expiresAt'>,
  createdAtMs: number,
): number {
  return checkout.expiresAt ?? createdAtMs + DEFAULT_CHECKOUT_TTL_MS;
}

/** The owner's fulfillment choice, by the merchant's own ids. */
export interface FulfillmentSelection {
  methodId: string;
  /** group id → option id. */
  options?: Readonly<Record<string, string>>;
  /** A business location the merchant listed, or the merchant's id for the approved address. */
  destinationId?: string;
}

/**
 * Whether a fulfillment selection names only what the merchant's last answer
 * offers: its method, a destination it listed (the merchant's copy of the
 * approved address, or one of its own locations for pickup), and the
 * shipping method when an address was approved. The option ids are checked
 * against the offer by `checkUpdateFitsIntent`.
 */
export function checkSelection(
  intent: CheckoutIntent,
  last: Checkout,
  selection: FulfillmentSelection,
): IntentCheck {
  const address =
    intent.shippingAddress !== undefined ? shippingAddressJson(intent.shippingAddress) : undefined;
  const method = last.fulfillment.find((m) => m.id === selection.methodId);
  if (method === undefined) return { ok: false, reason: 'method_not_offered' };
  if (address !== undefined && method.type !== 'shipping')
    return { ok: false, reason: 'address_needs_shipping' };
  if (selection.destinationId !== undefined) {
    const offered =
      method.type === 'shipping'
        ? echoedAddress(method, address)?.id === selection.destinationId
        : method.type === 'pickup' &&
          method.destinations.some(
            (d) => d.id === selection.destinationId && d.type === 'business_location',
          );
    if (!offered) return { ok: false, reason: 'destination_not_offered' };
  }
  return { ok: true };
}

/**
 * The `update_checkout` payload for an approved intent: the same lines (with
 * the merchant's line ids matched by item), codes, context and personal data,
 * plus a fulfillment selection. Updates are full replacements
 * (checkout/index.md:1078-1083), so every approved part is sent again: an
 * approved shipping address goes out on every update, under the id the
 * merchant gave it once it has echoed it unchanged. The caller still passes
 * the result through `checkUpdateFitsIntent` at the dispatch gate. A
 * selection must pass `checkSelection` first: one that does not is a caller's
 * bug here.
 */
export function buildUpdateCheckoutBody(
  intent: CheckoutIntent,
  last: Checkout,
  selection?: FulfillmentSelection,
): JsonObject {
  const lineIdByItem = new Map(last.lineItems.map((l) => [l.itemId, l.id]));
  const { fulfillment: _created, ...body } = buildCreateCheckoutBody(intent);
  body.line_items = intent.lines.map((line) => {
    const id = lineIdByItem.get(line.itemId);
    return { ...(id !== undefined ? { id } : {}), ...lineRequestJson(line) };
  });
  const address =
    intent.shippingAddress !== undefined ? shippingAddressJson(intent.shippingAddress) : undefined;

  if (selection === undefined) {
    if (address === undefined) return body;
    // Keep the approved address: on the merchant's shipping method if it lists
    // one, else in the create's own shape.
    const shipping = last.fulfillment.find((m) => m.type === 'shipping');
    body.fulfillment = {
      methods: [
        shipping !== undefined
          ? shippingMethodJson(shipping, address)
          : {
              type: 'shipping',
              line_item_ids: last.lineItems.map((l) => l.id),
              destinations: [address],
            },
      ],
    };
    return body;
  }

  const checked = checkSelection(intent, last, selection);
  if (!checked.ok) throw new Error(`checkout: ${checked.reason}`);
  const method = last.fulfillment.find((m) => m.id === selection.methodId) as FulfillmentMethod;
  const m: JsonObject =
    address !== undefined
      ? shippingMethodJson(method, address)
      : { id: method.id, type: method.type, line_item_ids: [...method.lineItemIds] };
  if (selection.destinationId !== undefined) m.selected_destination_id = selection.destinationId;
  if (selection.options !== undefined) {
    m.groups = Object.entries(selection.options).map(([groupId, optionId]) => ({
      id: groupId,
      selected_option_id: optionId,
    }));
  }
  body.fulfillment = { methods: [m] };
  return body;
}

/** The merchant's own copy of the approved address on this method, if it echoed one unchanged. */
function echoedAddress(
  method: FulfillmentMethod,
  address: JsonObject | undefined,
): FulfillmentDestination | undefined {
  return method.destinations.find(
    (d) =>
      d.type === 'shipping_address' && isApprovedAddress({ type: d.type, ...d.address }, address),
  );
}

/** A shipping method carrying the approved address (fulfillment_method.json: `type` beside `destinations`). */
function shippingMethodJson(method: FulfillmentMethod, address: JsonObject): JsonObject {
  const echoed = echoedAddress(method, address);
  return {
    id: method.id,
    type: method.type,
    line_item_ids: [...method.lineItemIds],
    destinations: [{ ...(echoed !== undefined ? { id: echoed.id } : {}), ...address }],
  };
}
