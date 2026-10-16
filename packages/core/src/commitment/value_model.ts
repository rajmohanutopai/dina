/**
 * The owner's value model (COMMITMENT_KERNEL §7) and how Core counts a
 * deal's worth with it — kernel-owned, deterministic, no model in the loop.
 *
 * A DEAL VERSION is a set of parts, each of a kind the kernel knows (§6):
 * a number with a direction, a choice, a flag, a promise with structured
 * dimensions, or a price to someone outside the deal (always refused, §3).
 *
 * WORTH is in one unit, rupees a month (§16, item 4). The rules are fixed:
 *   - a money part counts at face value for its payee and against its payer;
 *     a weekly figure is turned into a monthly one at 52/12; a one-off
 *     amount is spread over the deal's length in whole months (at least one);
 *   - each part's monthly figure is rounded to the rupee against the owner:
 *     gains down, costs up (floor, in both directions);
 *   - a money part in another currency, or a ratio, has no rupee value: it is
 *     governed by its limits, or it is unvalued;
 *   - a choice, a flag or a promise counts only through a value the owner
 *     gave it; a promise matches a value only if every dimension is the same
 *     or better, and the best matching value applies.
 *
 * A LIMIT-ONLY MODEL (every migrated model) has per-part limits and no
 * values and no walk-away point; it keeps today's behaviour exactly (§7).
 *
 * PURE: no I/O, no clock.
 */

import type { PartBounds } from './limits';
import type { NumberPartSpec, PartyRole } from './parts';

/** How often a money amount recurs. */
export type Recurrence = 'month' | 'week' | 'once';

export type DealPart =
  | {
      kind: 'number';
      name: string;
      value: bigint;
      /** Money parts: the currency and how often it recurs. Ratios carry neither. */
      currency?: string;
      per?: Recurrence;
    }
  | { kind: 'choice'; name: string; option: string }
  | { kind: 'flag'; name: string; set: boolean }
  | {
      kind: 'promise';
      name: string;
      dimensions: Readonly<Record<string, string | bigint>>;
      /** Who keeps it. "Better" on a dimension is read from the owner's side (§7). */
      by?: PartyRole;
    }
  /** A price set for someone outside the deal: always refused (§3). */
  | { kind: 'price_to_non_party'; name: string };

export interface DealVersion {
  parts: readonly DealPart[];
  /** The deal's length in whole months, for spreading one-off amounts. */
  months: number;
}

/** Which way is better on a promise dimension, as the vocabulary declares it. */
export type DimensionOrder = 'higher_better' | 'lower_better' | 'exact';

/** What the kernel needs from a vocabulary to check a deal. */
export interface ModelVocabulary {
  numbers: readonly NumberPartSpec[];
  /** Allowed options per choice part. */
  choices: Readonly<Record<string, readonly string[]>>;
  flags: readonly string[];
  /** Per promise part, the order of each dimension. */
  promises: Readonly<Record<string, Readonly<Record<string, DimensionOrder>>>>;
}

/** One condition a never-rule tests; a rule refuses when ALL its conditions hold. */
export type NeverCondition =
  | { part: string; present: true }
  | { part: string; flag: boolean }
  | { part: string; choice: string }
  /** A number part strictly below / above this value. */
  | { part: string; below: bigint }
  | { part: string; above: bigint };

export interface NeverRule {
  /** The owner's words for the card; carries no number the other side may see. */
  label: string;
  all: readonly NeverCondition[];
}

export interface PromiseValue {
  dimensions: Readonly<Record<string, string | bigint>>;
  /** Rupees a month. */
  rupees: bigint;
}

export interface ValueModel {
  /** The deal kind this model governs (a pack's kind id, or a built-in one). */
  kind: string;
  /** Bumped on every confirmed change; recorded with each deal it checks. */
  version: number;
  /** The least a whole deal must be worth, rupees a month. Absent: limit-only. */
  walkAway?: bigint;
  /** The worth at or above which Core may sign alone; at or above `walkAway`. */
  autoSign?: bigint;
  /** Per-part limits for number parts, for the party the model belongs to. */
  limits: Readonly<Record<string, PartBounds>>;
  /** Rupees a month per option. */
  choiceValues: Readonly<Record<string, Readonly<Record<string, bigint>>>>;
  /** Rupees a month when the flag is set and when it is not. */
  flagValues: Readonly<Record<string, { set: bigint; unset: bigint }>>;
  promiseValues: Readonly<Record<string, readonly PromiseValue[]>>;
  never: readonly NeverRule[];
  /** How much Dina may commit alone in a period, rupees a month. */
  totals: { overall?: bigint; perCounterparty?: bigint };
  /**
   * What the owner can promise in all, per promise kind: one dimension and its
   * total across live deals (two crates of spare room, never promised twice).
   */
  capacities?: Readonly<Record<string, { dimension: string; amount: bigint }>>;
}

/** A model with no values and no walk-away point (§7, "Limit-only models"). */
export function isLimitOnly(model: ValueModel): boolean {
  return (
    model.walkAway === undefined &&
    Object.keys(model.choiceValues).length === 0 &&
    Object.keys(model.flagValues).length === 0 &&
    Object.keys(model.promiseValues).length === 0
  );
}

/** Floor division for bigints: towards minus infinity. */
function floorDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && n < 0n !== d < 0n ? q - 1n : q;
}

/** Minor units per rupee: every money figure the kernel values is in paise. */
const MINOR_PER_RUPEE = 100n;
export const WORTH_CURRENCY = 'INR';

/**
 * A money part's worth to `holder` in rupees a month, rounded against the
 * owner; null when it has no rupee value (another currency, or a ratio).
 */
export function moneyWorth(
  spec: NumberPartSpec,
  holder: PartyRole,
  part: Extract<DealPart, { kind: 'number' }>,
  months: number,
): bigint | null {
  if (spec.kind !== 'money' || part.currency !== WORTH_CURRENCY) return null;
  const signed = holder === spec.payee ? part.value : -part.value;
  const per = part.per ?? 'month';
  // Monthly paise as a fraction num/den, then floored to rupees once.
  const [num, den] =
    per === 'month'
      ? [signed, 1n]
      : per === 'week'
        ? [signed * 52n, 12n]
        : [signed, BigInt(Math.max(1, Math.floor(months)))];
  return floorDiv(num, den * MINOR_PER_RUPEE);
}

/**
 * Does the offered promise meet a valued one on every dimension? Both must
 * name exactly the dimensions the vocabulary declares: a missing or unknown
 * dimension (how long, how often) leaves the promise unvalued (§7).
 */
export function promiseMatches(
  orders: Readonly<Record<string, DimensionOrder>>,
  offered: Readonly<Record<string, string | bigint>>,
  valued: Readonly<Record<string, string | bigint>>,
): boolean {
  const declared = Object.keys(orders);
  const complete = (dims: Readonly<Record<string, string | bigint>>): boolean =>
    Object.keys(dims).length === declared.length && declared.every((d) => d in dims);
  if (!complete(offered) || !complete(valued)) return false;
  for (const [dim, order] of Object.entries(orders)) {
    const got = offered[dim];
    const want = valued[dim];
    if (order === 'exact' || typeof want !== 'bigint' || typeof got !== 'bigint') {
      if (got !== want) return false;
      continue;
    }
    if (order === 'higher_better' ? got < want : got > want) return false;
  }
  return true;
}

/** Turn "better" around: what is better for the one a promise is made to is worse for its keeper. */
export function flipOrders(
  orders: Readonly<Record<string, DimensionOrder>>,
): Record<string, DimensionOrder> {
  const out: Record<string, DimensionOrder> = {};
  for (const [d, o] of Object.entries(orders))
    out[d] = o === 'higher_better' ? 'lower_better' : o === 'lower_better' ? 'higher_better' : o;
  return out;
}

/**
 * A part's worth in rupees a month, or null when the model gives it none
 * (an unvalued part). Number parts governed only by limits are valued for
 * the envelope's purposes but add nothing to worth: `limitGoverned` says so.
 */
export function partWorth(
  model: ValueModel,
  vocabulary: ModelVocabulary,
  holder: PartyRole,
  part: DealPart,
  months: number,
): { worth: bigint | null; limitGoverned: boolean } {
  switch (part.kind) {
    case 'number': {
      const spec = vocabulary.numbers.find((s) => s.name === part.name);
      if (spec === undefined) return { worth: null, limitGoverned: false };
      const limitGoverned = model.limits[part.name] !== undefined;
      return { worth: moneyWorth(spec, holder, part, months), limitGoverned };
    }
    case 'choice': {
      const value = model.choiceValues[part.name]?.[part.option];
      return { worth: value ?? null, limitGoverned: false };
    }
    case 'flag': {
      const value = model.flagValues[part.name];
      return {
        worth: value === undefined ? null : part.set ? value.set : value.unset,
        limitGoverned: false,
      };
    }
    case 'promise': {
      const orders = vocabulary.promises[part.name];
      if (orders === undefined) return { worth: null, limitGoverned: false };
      // The vocabulary's order says what is better for the party a promise is
      // made to; when the owner keeps it, more crates is a heavier promise.
      const own = part.by !== undefined && part.by === holder;
      const sided = own ? flipOrders(orders) : orders;
      let best: bigint | null = null;
      for (const valued of model.promiseValues[part.name] ?? []) {
        if (!promiseMatches(sided, part.dimensions, valued.dimensions)) continue;
        if (best === null || valued.rupees > best) best = valued.rupees;
      }
      return { worth: best, limitGoverned: false };
    }
    case 'price_to_non_party':
      return { worth: null, limitGoverned: false };
  }
}

/**
 * What a version commits the owner to pay, rupees a month, rounded against
 * the owner (up), for the totals: only money parts the holder pays.
 */
export function monthlyCommitment(
  vocabulary: ModelVocabulary,
  holder: PartyRole,
  version: DealVersion,
): bigint {
  let total = 0n;
  for (const part of version.parts) {
    if (part.kind !== 'number') continue;
    const spec = vocabulary.numbers.find((s) => s.name === part.name);
    if (spec === undefined || spec.payer !== holder) continue;
    const worth = moneyWorth(spec, holder, part, version.months);
    if (worth !== null) total += -worth;
  }
  return total;
}
