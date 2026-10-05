/**
 * Carts (cart.json): for browsing only (§3.7). A cart carries items,
 * quantities, units and the owner-allowed context, never buyer fields; it
 * needs no card. Updates are full replacements built from the last answer.
 */

import { isPlainObject, type JsonObject } from '@dina/a2a';

import { contextRequestJson, lineRequestJson, type IntentContext, type IntentLine } from './intent';
import { parseMessages, type MessagesParse } from './messages';
import { MAX_AMOUNT, checkTotals, isCurrencyCode, parseTotals, type TotalEntry } from './money';
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

export interface Cart {
  id: string;
  currency: string;
  lineItems: LineItem[];
  totals: TotalEntry[];
  totalsConsistent: boolean;
  messages: MessagesParse;
  links: Link[];
  continueUrl?: string;
  expiresAt?: number;
}

function checkLines(lines: readonly IntentLine[]): void {
  if (lines.length === 0) throw new Error('cart: no lines');
  const seen = new Set<string>();
  for (const l of lines) {
    if (l.itemId === '' || l.quantity < 1n || l.quantity > MAX_AMOUNT)
      throw new Error('cart: bad line');
    // As for checkout: two lines for one variant could not be matched to the merchant's line ids.
    if (seen.has(l.itemId)) throw new Error('cart: duplicate item');
    seen.add(l.itemId);
  }
}

/** `create_cart` payload. */
export function buildCreateCartBody(
  lines: readonly IntentLine[],
  context: IntentContext,
): JsonObject {
  checkLines(lines);
  const body: JsonObject = { line_items: lines.map(lineRequestJson) };
  const ctx = contextRequestJson(context);
  if (ctx !== undefined) body.context = ctx;
  return body;
}

/** `update_cart` payload: the whole new cart, reusing the merchant's line ids for items it already holds. */
export function buildUpdateCartBody(
  lines: readonly IntentLine[],
  context: IntentContext,
  last: Cart,
): JsonObject {
  checkLines(lines);
  const lineIdByItem = new Map(last.lineItems.map((l) => [l.itemId, l.id]));
  const body: JsonObject = {
    line_items: lines.map((line) => {
      const id = lineIdByItem.get(line.itemId);
      return { ...(id !== undefined ? { id } : {}), ...lineRequestJson(line) };
    }),
  };
  const ctx = contextRequestJson(context);
  if (ctx !== undefined) body.context = ctx;
  return body;
}

export function readCart(value: unknown): Read<Cart> {
  if (!isPlainObject(value)) return fail('not_object');
  if (typeof value.id !== 'string' || value.id === '') return fail('id');
  if (!isCurrencyCode(value.currency)) return fail('currency');
  const lines = readLineItems(value.line_items);
  if (!lines.ok) return lines;
  const totals = parseTotals(value.totals);
  if (!totals.ok) return fail(totals.reason);
  let expiresAt: number | undefined;
  if (value.expires_at !== undefined) {
    const t = readTimestamp(value.expires_at);
    if (t === null) return fail('expires_at');
    expiresAt = t;
  }
  const continueUrl = readHttpsUrl(value.continue_url);
  return ok({
    id: value.id,
    currency: value.currency,
    lineItems: lines.value,
    totals: totals.totals,
    totalsConsistent: checkTotals(totals.totals) === 'consistent',
    messages: parseMessages(value.messages),
    links: readLinks(value.links),
    ...(continueUrl !== null ? { continueUrl } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
}
