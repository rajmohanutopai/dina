/**
 * UCP money (overview/index.md:83-112; common/types/amount.json, price.json,
 * totals.json): amounts are JSON integers in ISO 4217 minor units, at most
 * 2^53-1 in magnitude; arithmetic must be exact, and an inexact or wrapped
 * result must be an error, never a value. Dina holds them as `bigint`.
 *
 * Dina never substitutes its own totals for the merchant's
 * (checkout/index.md:1313-1328). It may check that the merchant's totals add
 * up; on a mismatch it hands off instead of acting (:1335-1339).
 */

import { isPlainObject } from '@dina/a2a';

export const MAX_AMOUNT = 9_007_199_254_740_991n; // 2^53 - 1

const CURRENCY = /^[A-Z]{3}$/;

/** A non-negative `amount` (amount.json), or null. */
export function parseAmount(value: unknown): bigint | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return BigInt(value);
}

/** A `signed_amount` (signed_amount.json), or null. */
export function parseSignedAmount(value: unknown): bigint | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  return BigInt(value);
}

export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY.test(value);
}

export interface Price {
  amount: bigint;
  currency: string;
}

/** `price.json`: `{amount, currency}`, both required. */
export function parsePrice(value: unknown): Price | null {
  if (!isPlainObject(value)) return null;
  const amount = parseAmount(value.amount);
  if (amount === null || !isCurrencyCode(value.currency)) return null;
  return { amount, currency: value.currency };
}

/** An amount as Dina's commerce protocol writes minor units: a canonical integer string. */
export function toMinorUnitsString(amount: bigint): string {
  return amount.toString();
}

/** Exact addition with the UCP bound; null when the result leaves it. */
export function addExact(a: bigint, b: bigint): bigint | null {
  const sum = a + b;
  return sum > MAX_AMOUNT || sum < -MAX_AMOUNT ? null : sum;
}

// ------------------------------------------------------------ totals

export interface TotalEntry {
  type: string;
  amount: bigint;
  displayText?: string;
  lines?: { displayText: string; amount: bigint }[];
}

/** The sign each well-known total type must carry (totals.json; checkout/index.md:1285-1424). */
const WELL_KNOWN_SIGN: ReadonlyMap<string, 'pos' | 'neg' | 'any'> = new Map([
  ['subtotal', 'pos'],
  ['discount', 'neg'],
  ['items_discount', 'neg'],
  ['fulfillment', 'pos'],
  ['tax', 'pos'],
  ['fee', 'pos'],
  ['total', 'any'],
]);

/** Whether `type` is one of the spec's well-known total types (not a merchant's own label). */
export function isWellKnownTotalType(type: string): boolean {
  return WELL_KNOWN_SIGN.has(type);
}

export type TotalsParse = { ok: true; totals: TotalEntry[] } | { ok: false; reason: string };

/** `totals.json`: an ordered array with exactly one `subtotal` and one `total`. */
export function parseTotals(value: unknown): TotalsParse {
  const parsed = parseTotalEntries(value);
  if (!parsed.ok) return parsed;
  if (parsed.totals.filter((t) => t.type === 'subtotal').length !== 1)
    return { ok: false, reason: 'subtotal_count' };
  if (parsed.totals.filter((t) => t.type === 'total').length !== 1)
    return { ok: false, reason: 'total_count' };
  return parsed;
}

/**
 * An array of `total.json` entries, as line items, fulfillment options and
 * adjustments carry them: same entry rules, no count rule.
 */
export function parseTotalEntries(value: unknown): TotalsParse {
  if (!Array.isArray(value)) return { ok: false, reason: 'totals_not_array' };
  const out: TotalEntry[] = [];
  for (const raw of value) {
    if (!isPlainObject(raw) || typeof raw.type !== 'string' || raw.type === '')
      return { ok: false, reason: 'total_malformed' };
    const amount = parseSignedAmount(raw.amount);
    if (amount === null) return { ok: false, reason: 'total_amount' };
    const sign = WELL_KNOWN_SIGN.get(raw.type);
    if (sign === 'pos' && amount < 0n) return { ok: false, reason: `total_sign_${raw.type}` };
    if (sign === 'neg' && amount > 0n) return { ok: false, reason: `total_sign_${raw.type}` };
    const entry: TotalEntry = { type: raw.type, amount };
    if (raw.display_text !== undefined) {
      if (typeof raw.display_text !== 'string') return { ok: false, reason: 'total_display_text' };
      entry.displayText = raw.display_text;
    } else if (sign === undefined) {
      // An unknown type MUST carry display_text (totals.json).
      return { ok: false, reason: 'unknown_total_without_display_text' };
    }
    if (raw.lines !== undefined) {
      if (!Array.isArray(raw.lines)) return { ok: false, reason: 'total_lines' };
      const lines: { displayText: string; amount: bigint }[] = [];
      for (const line of raw.lines) {
        if (!isPlainObject(line) || typeof line.display_text !== 'string')
          return { ok: false, reason: 'total_line' };
        const la = parseSignedAmount(line.amount);
        if (la === null) return { ok: false, reason: 'total_line_amount' };
        lines.push({ displayText: line.display_text, amount: la });
      }
      entry.lines = lines;
    }
    out.push(entry);
  }
  return { ok: true, totals: out };
}

/**
 * Whether the merchant's totals add up, by the spec's own check
 * (checkout/index.md:1330-1334): the sum of every entry other than `total`
 * (unknown types included, their signs self-describing) equals `total`; and
 * each entry's sub-lines sum to it (totals.json).
 */
export function checkTotals(totals: readonly TotalEntry[]): 'consistent' | 'inconsistent' {
  let computed = 0n;
  let total: bigint | null = null;
  for (const t of totals) {
    if (t.lines !== undefined && t.lines.length > 0) {
      const sum = t.lines.reduce((acc, l) => acc + l.amount, 0n);
      if (sum !== t.amount) return 'inconsistent';
    }
    if (t.type === 'total') total = t.amount;
    else computed += t.amount;
  }
  return total !== null && computed === total ? 'consistent' : 'inconsistent';
}
