/**
 * Shopping permalinks (permalink.md; permalink.json): a browser link that hands
 * a cart to the merchant's own page. It is a GET the merchant answers with a
 * 303 and MUST NOT treat as an order (:34-36). Dina builds it from the
 * merchant's variant ids and quantities only: no personal data, no query
 * fields (UCP plan §3.8 step 2; S12).
 */

import { base64urlEncodeUtf8, utf8Length } from '@dina/a2a';

/** permalink.json `$defs/endpoint`. */
const ENDPOINT = /^https:\/\/[^/?#\s\\@]+(?:\/[^?#\s\\]*[^/?#\s\\])?$/;
const RAW_TOKEN = /^[A-Za-z0-9._-]+$/;

/** Recommended budget for an authenticated hand-off (permalink.md:725-752). */
export const PERMALINK_MAX_BYTES = 2048;

export interface PermalinkLine {
  /** The merchant's purchasable variant id (permalink.md:156-166). */
  itemId: string;
  /** Step count, a positive integer. */
  quantity: bigint;
}

export type PermalinkBuild =
  | { ok: true; url: string }
  | { ok: false; reason: 'bad_endpoint' | 'no_lines' | 'bad_quantity' | 'empty_id' | 'too_long' };

/** The compact token for an item id (permalink.md:171-200). */
export function itemIdToken(itemId: string): string {
  return RAW_TOKEN.test(itemId) ? itemId : `~${base64urlEncodeUtf8(itemId)}`;
}

export function buildPermalink(endpoint: string, lines: readonly PermalinkLine[]): PermalinkBuild {
  if (!ENDPOINT.test(endpoint)) return { ok: false, reason: 'bad_endpoint' };
  if (lines.length === 0) return { ok: false, reason: 'no_lines' };
  const pairs: string[] = [];
  for (const line of lines) {
    if (line.itemId === '') return { ok: false, reason: 'empty_id' };
    if (line.quantity < 1n) return { ok: false, reason: 'bad_quantity' };
    pairs.push(`${itemIdToken(line.itemId)}:${line.quantity.toString()}`);
  }
  const url = `${endpoint}/${pairs.join(',')}`;
  if (utf8Length(url) > PERMALINK_MAX_BYTES) return { ok: false, reason: 'too_long' };
  return { ok: true, url };
}
