/**
 * The checkout intent (UCP plan §3.7): everything the owner approves on the
 * `ucp_checkout_start` card, hashed so a single-use start permit binds to it.
 *
 *  - `checkoutIntentHash`: SHA-256 over RFC 8785 canonical JSON of the intent.
 *  - `buildCreateCheckoutBody`: the one `create_checkout` body the permit allows,
 *    built from the intent alone. Dina never sends `cart_id` (§2.1 row 12).
 *  - `checkUpdateFitsIntent`: an update to that session needs no new card only
 *    if it keeps the lines, quantities, units, codes and personal data identical
 *    and fills in nothing but ids the merchant itself offered in its last answer.
 *  - `checkIntentDrift`: a profile refresh that moved the endpoint, transport,
 *    version or negotiated capability set voids the permit; other profile
 *    changes (a merchant key rotation) do not.
 */

import { bytesToHex, canonicalize, isPlainObject, utf8Bytes, type JsonObject } from '@dina/a2a';

import { MAX_AMOUNT } from './money';
import { EACH, type QuantityUnit } from './units';

import type { Sha256Fn } from './signatures';

export interface IntentLine {
  /** The merchant's variant id, as the merchant wrote it. */
  itemId: string;
  /** Step count (10^-scale × unit), ≥ 1. */
  quantity: bigint;
  /** The merchant's sale basis for this item; omitted means each. */
  unit?: QuantityUnit;
}

/**
 * `context` fields the owner may allow (§3.16): country, region and language by
 * default, postal code only on opt-in. Never coordinates; `signals` are never sent.
 */
export interface IntentContext {
  address_country?: string;
  address_region?: string;
  postal_code?: string;
  language?: string;
}

/** buyer.json fields; sent only on the owner's per-merchant opt-in (S12). */
export interface IntentBuyer {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone_number?: string;
}

/** postal_address.json fields of a platform-authored shipping destination (S12 opt-in). */
export interface IntentShippingAddress {
  first_name?: string;
  last_name?: string;
  street_address?: string;
  extended_address?: string;
  address_locality?: string;
  address_region?: string;
  postal_code?: string;
  address_country?: string;
  phone_number?: string;
}

export interface CheckoutIntent {
  /** Canonical merchant identity: the origin of its root `/.well-known/ucp` (§3.12). */
  merchantOrigin: string;
  version: string;
  transport: 'mcp' | 'rest';
  endpoint: string;
  /** Negotiated capability name → version. */
  capabilities: Readonly<Record<string, string>>;
  /** A linked account (U4): credential reference and revision. */
  credential?: { ref: string; revision: number };
  lines: readonly IntentLine[];
  discountCodes: readonly string[];
  context: IntentContext;
  buyer?: IntentBuyer;
  shippingAddress?: IntentShippingAddress;
}

const CONTEXT_KEYS = ['address_country', 'address_region', 'postal_code', 'language'] as const;
const BUYER_KEYS = ['first_name', 'last_name', 'email', 'phone_number'] as const;
const ADDRESS_KEYS = [
  'first_name',
  'last_name',
  'street_address',
  'extended_address',
  'address_locality',
  'address_region',
  'postal_code',
  'address_country',
  'phone_number',
] as const;

// ------------------------------------------------------------ validation

export type IntentCheck = { ok: true } | { ok: false; reason: string };

/** Refuse an intent Dina could not send faithfully. */
export function validateIntent(intent: CheckoutIntent): IntentCheck {
  if (intent.lines.length === 0) return { ok: false, reason: 'no_lines' };
  const seen = new Set<string>();
  for (const line of intent.lines) {
    if (line.itemId === '') return { ok: false, reason: 'empty_item_id' };
    if (line.quantity < 1n || line.quantity > MAX_AMOUNT)
      return { ok: false, reason: 'bad_quantity' };
    // Two lines for one variant would make the merchant's line ids ambiguous to match.
    if (seen.has(line.itemId)) return { ok: false, reason: 'duplicate_item' };
    seen.add(line.itemId);
  }
  if (intent.discountCodes.some((c) => c === '')) return { ok: false, reason: 'empty_code' };
  if (
    intent.discountCodes.length > 0 &&
    intent.capabilities['dev.ucp.shopping.discount'] === undefined
  ) {
    return { ok: false, reason: 'discount_not_negotiated' };
  }
  if (
    intent.shippingAddress !== undefined &&
    intent.capabilities['dev.ucp.shopping.fulfillment'] === undefined
  ) {
    return { ok: false, reason: 'fulfillment_not_negotiated' };
  }
  if (intent.capabilities['dev.ucp.shopping.checkout'] === undefined)
    return { ok: false, reason: 'checkout_not_negotiated' };
  return { ok: true };
}

// ------------------------------------------------------------ wire shapes

function pick<K extends string>(
  source: Partial<Record<K, string>> | undefined,
  keys: readonly K[],
): JsonObject | undefined {
  if (source === undefined) return undefined;
  const out: JsonObject = {};
  for (const k of keys) {
    const v = source[k];
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The `quantity_unit` Dina sends: always, each included. A request that omits
 * it asserts nothing, and the merchant reads the quantity in its own basis
 * (checkout/index.md:90-104); sending the approved unit lets the merchant
 * refuse a basis that changed instead of reinterpreting the count.
 * `increment` is the merchant's policy, outside the unit's identity.
 */
function unitJson(unit: QuantityUnit = EACH): JsonObject {
  return { unit: unit.unit, scale: unit.scale, display_text: unit.displayText };
}

/** The `context` Dina sends: only the owner-allowed fields, or nothing. */
export function contextRequestJson(context: IntentContext): JsonObject | undefined {
  return pick(context, CONTEXT_KEYS);
}

/** A request line item: `item.id`, its `quantity_unit`, and the step count. */
export function lineRequestJson(line: IntentLine): JsonObject {
  return {
    item: { id: line.itemId, quantity_unit: unitJson(line.unit) },
    quantity: Number(line.quantity),
  };
}

/**
 * The one destination Dina writes: the opted-in address, postal fields only.
 * No `id` (in a request an id refers to an address the merchant already holds,
 * fulfillment.md:270-289) and no `type` (the shipping method implies it).
 */
export function shippingAddressJson(address: IntentShippingAddress): JsonObject | undefined {
  return pick(address, ADDRESS_KEYS);
}

/**
 * Whether a destination the merchant lists is the approved address: a shipping
 * address with exactly the approved postal fields, no more and no fewer. A
 * merchant that rewrites the address, or lists a saved one that shares some
 * fields, does not match, and Dina hands off rather than select it.
 */
export function isApprovedAddress(
  destination: Readonly<Record<string, unknown>>,
  approved: JsonObject | undefined,
): boolean {
  if (approved === undefined) return false;
  if (destination.type !== undefined && destination.type !== 'shipping_address') return false;
  return ADDRESS_KEYS.every((k) => destination[k] === approved[k]);
}

/** The canonical JSON form the hash covers. */
export function intentJson(intent: CheckoutIntent): JsonObject {
  const caps: JsonObject = {};
  for (const name of Object.keys(intent.capabilities).sort())
    caps[name] = intent.capabilities[name] as string;
  const out: JsonObject = {
    v: 1,
    merchant_origin: intent.merchantOrigin,
    version: intent.version,
    transport: intent.transport,
    endpoint: intent.endpoint,
    capabilities: caps,
    lines: intent.lines.map((l) => {
      const unit = l.unit ?? EACH;
      return {
        item_id: l.itemId,
        quantity: l.quantity.toString(),
        unit: unit.unit,
        scale: unit.scale,
      };
    }),
    discount_codes: [...intent.discountCodes],
    context: contextRequestJson(intent.context) ?? {},
  };
  if (intent.credential !== undefined)
    out.credential = { ref: intent.credential.ref, revision: intent.credential.revision };
  const buyer = pick(intent.buyer, BUYER_KEYS);
  if (buyer !== undefined) out.buyer = buyer;
  const ship = pick(intent.shippingAddress, ADDRESS_KEYS);
  if (ship !== undefined) out.shipping_address = ship;
  return out;
}

export function checkoutIntentHash(intent: CheckoutIntent, sha256: Sha256Fn): string {
  return bytesToHex(sha256(utf8Bytes(canonicalize(intentJson(intent)))));
}

/** The `create_checkout` payload (without `id`; the bindings add `meta`). */
export function buildCreateCheckoutBody(intent: CheckoutIntent): JsonObject {
  const check = validateIntent(intent);
  if (!check.ok) throw new Error(`intent: ${check.reason}`);
  const body: JsonObject = { line_items: intent.lines.map(lineRequestJson) };
  if (intent.discountCodes.length > 0) body.discounts = { codes: [...intent.discountCodes] };
  const context = contextRequestJson(intent.context);
  if (context !== undefined) body.context = context;
  const buyer = pick(intent.buyer, BUYER_KEYS);
  if (buyer !== undefined) body.buyer = buyer;
  const address =
    intent.shippingAddress !== undefined ? shippingAddressJson(intent.shippingAddress) : undefined;
  if (address !== undefined) {
    body.fulfillment = { methods: [{ type: 'shipping', destinations: [address] }] };
  }
  return body;
}

// ------------------------------------------------------------ update check

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length &&
      ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
    );
  }
  return false;
}

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(obj).every((k) => allowed.includes(k));
}

function ids(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.filter(isPlainObject).flatMap((x) => (typeof x.id === 'string' ? [x.id] : []));
}

function byId(list: unknown, id: string): Record<string, unknown> | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.find((x): x is Record<string, unknown> => isPlainObject(x) && x.id === id);
}

/**
 * Whether `body` (an `update_checkout` payload) fits the approved intent, given
 * the merchant's last checkout answer `last`. Updates are full replacements, so
 * each part Dina sends must equal what was approved, and every id it names must
 * come from `last`.
 */
export function checkUpdateFitsIntent(
  intent: CheckoutIntent,
  last: Readonly<Record<string, unknown>>,
  body: Readonly<Record<string, unknown>>,
): IntentCheck {
  if (!onlyKeys(body, ['line_items', 'discounts', 'context', 'buyer', 'fulfillment']))
    return { ok: false, reason: 'field_not_allowed' };

  // Lines: the approved items and quantities in order; a line id only if the merchant gave it for that item.
  const lines = body.line_items;
  if (!Array.isArray(lines) || lines.length !== intent.lines.length)
    return { ok: false, reason: 'lines_changed' };
  const lastLines = Array.isArray(last.line_items) ? last.line_items : [];
  for (let i = 0; i < lines.length; i++) {
    const sent = lines[i];
    const want = intent.lines[i] as IntentLine;
    if (!isPlainObject(sent) || !onlyKeys(sent, ['id', 'item', 'quantity']))
      return { ok: false, reason: 'lines_changed' };
    const { id, ...rest } = sent;
    if (!deepEqual(rest, lineRequestJson(want))) return { ok: false, reason: 'lines_changed' };
    if (id !== undefined) {
      if (typeof id !== 'string') return { ok: false, reason: 'line_id_not_offered' };
      const offered = byId(lastLines, id);
      if (
        offered === undefined ||
        !isPlainObject(offered.item) ||
        offered.item.id !== want.itemId
      ) {
        return { ok: false, reason: 'line_id_not_offered' };
      }
    }
  }

  const discounts =
    intent.discountCodes.length > 0 ? { codes: [...intent.discountCodes] } : undefined;
  if (!deepEqual(body.discounts, discounts)) return { ok: false, reason: 'codes_changed' };
  if (!deepEqual(body.context, contextRequestJson(intent.context)))
    return { ok: false, reason: 'context_changed' };
  if (!deepEqual(body.buyer, pick(intent.buyer, BUYER_KEYS)))
    return { ok: false, reason: 'personal_data_changed' };

  // An update is a full replacement: an approved address must be sent again,
  // or the update would erase it at the merchant.
  const address =
    intent.shippingAddress !== undefined ? shippingAddressJson(intent.shippingAddress) : undefined;
  if (body.fulfillment === undefined) {
    return address === undefined ? { ok: true } : { ok: false, reason: 'personal_data_changed' };
  }
  return checkFulfillmentUpdate(address, last, body.fulfillment);
}

const METHOD_KEYS = [
  'id',
  'type',
  'line_item_ids',
  'destinations',
  'selected_destination_id',
  'groups',
];

function checkFulfillmentUpdate(
  address: JsonObject | undefined,
  last: Readonly<Record<string, unknown>>,
  fulfillment: unknown,
): IntentCheck {
  if (
    !isPlainObject(fulfillment) ||
    !onlyKeys(fulfillment, ['methods']) ||
    !Array.isArray(fulfillment.methods)
  ) {
    return { ok: false, reason: 'fulfillment_shape' };
  }
  const offeredMethods = isPlainObject(last.fulfillment) ? last.fulfillment.methods : undefined;
  const lastLineIds = new Set(ids(last.line_items));
  let addressSent = false;

  for (const m of fulfillment.methods) {
    if (!isPlainObject(m) || !onlyKeys(m, METHOD_KEYS))
      return { ok: false, reason: 'fulfillment_shape' };
    if (
      !Array.isArray(m.line_item_ids) ||
      !m.line_item_ids.every((x) => typeof x === 'string' && lastLineIds.has(x))
    ) {
      return { ok: false, reason: 'line_id_not_offered' };
    }
    // fulfillment_method.json: a request that writes destinations names its type.
    if (m.destinations !== undefined && m.type === undefined)
      return { ok: false, reason: 'fulfillment_shape' };

    if (m.id === undefined) {
      // Before the merchant lists the shipping method, Dina may only resend the
      // create's own shape: a shipping method carrying the bare approved address.
      if (
        m.type !== 'shipping' ||
        address === undefined ||
        !deepEqual(m.destinations, [address]) ||
        m.selected_destination_id !== undefined ||
        m.groups !== undefined
      ) {
        return { ok: false, reason: 'method_not_offered' };
      }
      addressSent = true;
      continue;
    }
    if (typeof m.id !== 'string') return { ok: false, reason: 'method_not_offered' };
    const offered = byId(offeredMethods, m.id);
    if (offered === undefined) return { ok: false, reason: 'method_not_offered' };
    if (m.type !== undefined && m.type !== offered.type)
      return { ok: false, reason: 'method_not_offered' };

    const approvedHere = (id: unknown): boolean => {
      const d = typeof id === 'string' ? byId(offered.destinations, id) : undefined;
      return d !== undefined && isApprovedAddress(d, address);
    };
    if (m.destinations !== undefined) {
      // The only destination Dina may write is the approved address, bare or
      // under the id the merchant gave it.
      if (offered.type !== 'shipping' || address === undefined) {
        return { ok: false, reason: 'personal_data_changed' };
      }
      const d: unknown =
        Array.isArray(m.destinations) && m.destinations.length === 1
          ? m.destinations[0]
          : undefined;
      if (!isPlainObject(d)) return { ok: false, reason: 'personal_data_changed' };
      const { id, ...fields } = d;
      if (!deepEqual(fields, address)) return { ok: false, reason: 'personal_data_changed' };
      if (id !== undefined && !approvedHere(id))
        return { ok: false, reason: 'destination_not_offered' };
      addressSent = true;
    }
    if (m.selected_destination_id !== undefined && m.selected_destination_id !== null) {
      const sel = m.selected_destination_id;
      // A shipping selection must be the approved address; otherwise only a
      // pickup method may choose, and only one of the merchant's own locations.
      let fits: boolean;
      if (offered.type === 'shipping') fits = approvedHere(sel);
      else if (offered.type === 'pickup') {
        const d = typeof sel === 'string' ? byId(offered.destinations, sel) : undefined;
        fits = d !== undefined && d.type === 'business_location';
      } else fits = false;
      if (!fits) return { ok: false, reason: 'destination_not_offered' };
    }
    if (m.groups !== undefined) {
      if (!Array.isArray(m.groups)) return { ok: false, reason: 'fulfillment_shape' };
      for (const g of m.groups) {
        if (
          !isPlainObject(g) ||
          !onlyKeys(g, ['id', 'selected_option_id']) ||
          typeof g.id !== 'string'
        ) {
          return { ok: false, reason: 'fulfillment_shape' };
        }
        const group = byId(offered.groups, g.id);
        if (group === undefined) return { ok: false, reason: 'group_not_offered' };
        if (g.selected_option_id !== undefined && g.selected_option_id !== null) {
          if (!ids(group.options).includes(g.selected_option_id as string))
            return { ok: false, reason: 'option_not_offered' };
        }
      }
    }
  }
  if (address !== undefined && !addressSent) return { ok: false, reason: 'personal_data_changed' };
  return { ok: true };
}

// ------------------------------------------------------------ drift

export interface NegotiatedState {
  version: string;
  transport: 'mcp' | 'rest';
  endpoint: string;
  capabilities: Readonly<Record<string, string>>;
  /** The linked account calls would be sent under now; absent: none. */
  credential?: { ref: string; revision: number };
}

/** Whether a refreshed negotiation still matches the one the permit was approved under. */
export function checkIntentDrift(intent: CheckoutIntent, now: NegotiatedState): IntentCheck {
  if (now.version !== intent.version) return { ok: false, reason: 'version_changed' };
  if (now.transport !== intent.transport) return { ok: false, reason: 'transport_changed' };
  if (now.endpoint !== intent.endpoint) return { ok: false, reason: 'endpoint_changed' };
  if (!deepEqual(now.capabilities, intent.capabilities))
    return { ok: false, reason: 'capabilities_changed' };
  // Linked, unlinked, relinked, or authorized again: the account the merchant would act for
  // is not the one approved.
  if (
    now.credential?.ref !== intent.credential?.ref ||
    now.credential?.revision !== intent.credential?.revision
  )
    return { ok: false, reason: 'credential_changed' };
  return { ok: true };
}

/** The canonical merchant identity: the origin of the merchant's root profile URL. */
export function merchantOriginOf(rootProfileUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rootProfileUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  return url.origin;
}
