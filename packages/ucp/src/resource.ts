/**
 * Readers shared by the resource modules. A reader types only the fields Dina
 * acts on; unknown fields pass untouched (the schemas are open, A16). The full
 * check against the merchant's negotiated schemas happens in Core (§3.6 step 4a);
 * these readers are the second line, and refuse a resource whose acted-on
 * fields are malformed rather than guess.
 */

import { isPlainObject } from '@dina/a2a';

import { parseAmount, parseTotalEntries, type TotalEntry } from './money';
import { EACH, parseQuantityUnit, parseSteps, type QuantityUnit } from './units';

export type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

export const ok = <T>(value: T): Read<T> => ({ ok: true, value });
export const fail = <T = never>(reason: string): Read<T> => ({ ok: false, reason });

/** An optional list: absent reads as empty; anything other than an array is malformed (null). */
export function listOrEmpty(value: unknown): readonly unknown[] | null {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : null;
}

export function optString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** RFC 3339 date-time with a zone, as epoch ms; null otherwise. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
export function readTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !RFC3339.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** An https URL Dina may show or open; null for anything else. */
export function readHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export interface Link {
  type: string;
  url: string;
  title?: string;
}

/** `link.json` entries; a link that is not https is left out (Dina never opens one). */
export function readLinks(value: unknown): Link[] {
  if (!Array.isArray(value)) return [];
  const out: Link[] = [];
  for (const raw of value) {
    if (!isPlainObject(raw) || typeof raw.type !== 'string') continue;
    const url = readHttpsUrl(raw.url);
    if (url === null) continue;
    out.push({
      type: raw.type,
      url,
      ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    });
  }
  return out;
}

export interface Description {
  plain?: string;
  markdown?: string;
  html?: string;
}

export function readDescription(value: unknown): Description | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Description = {};
  if (typeof value.plain === 'string') out.plain = value.plain;
  if (typeof value.markdown === 'string') out.markdown = value.markdown;
  if (typeof value.html === 'string') out.html = value.html;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The item of a line (item.json, response side): id, title, unit price in the resource currency. */
export interface LineItem {
  id: string;
  itemId: string;
  title: string;
  /** item.price: minor units of the resource's currency. */
  unitPrice: bigint;
  quantity: bigint;
  unit: QuantityUnit;
  totals: TotalEntry[];
  parentId?: string;
}

/** A cart or checkout line item (line_item.json, response side). */
export function readLineItem(value: unknown): Read<LineItem> {
  if (!isPlainObject(value) || typeof value.id !== 'string') return fail('line_item');
  const item = value.item;
  if (!isPlainObject(item) || typeof item.id !== 'string' || typeof item.title !== 'string')
    return fail('line_item_item');
  const unitPrice = parseAmount(item.price);
  if (unitPrice === null) return fail('line_item_price');
  const quantity = parseSteps(value.quantity, { allowZero: true });
  if (quantity === null) return fail('line_item_quantity');
  let unit = EACH;
  if (item.quantity_unit !== undefined) {
    const parsed = parseQuantityUnit(item.quantity_unit);
    if (parsed === null) return fail('line_item_unit');
    unit = parsed;
  }
  const totals = parseTotalEntries(value.totals);
  if (!totals.ok) return fail(`line_item_${totals.reason}`);
  return ok({
    id: value.id,
    itemId: item.id,
    title: item.title,
    unitPrice,
    quantity,
    unit,
    totals: totals.totals,
    ...(typeof value.parent_id === 'string' ? { parentId: value.parent_id } : {}),
  });
}

export function readLineItems(value: unknown): Read<LineItem[]> {
  if (!Array.isArray(value)) return fail('line_items');
  const out: LineItem[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    const r = readLineItem(raw);
    if (!r.ok) return r;
    if (ids.has(r.value.id)) return fail('line_item_duplicate_id');
    ids.add(r.value.id);
    out.push(r.value);
  }
  return ok(out);
}
