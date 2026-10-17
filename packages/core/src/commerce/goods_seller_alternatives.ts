/**
 * The seller's own cheaper days, offered as alternatives (COMMITMENT_KERNEL
 * §3, §6, §15 step 6): "my vehicle passes your way on day Z, so if you take
 * delivery then, shipping is ₹40 less."
 *
 * The fixed style for the goods seller's side. The seller's model
 * (`goods.seller`) says what delivering on each day costs it, as a negative
 * value ("Friday −₹120; Tuesday −₹40, my van passes then"). For each day
 * within three days of the quote's own delivery date that costs the seller
 * less than that day, Core offers it as an alternative and passes on the share
 * of the saving the owner chose (half by default, the even split of §16) as a
 * discount on the same lines at the same
 * prices. The seller keeps the other half; the buyer is offered the rest. No
 * cost leaves Core: the buyer sees only the change.
 *
 * PURE: the caller passes the model, the quote's delivery date and charges.
 */

import { deliveryDayOf, SAVING_SHARES } from './deal_kinds';

import type { NeverCondition, ValueModel } from '../commitment';
import type { Charge } from '@dina/commerce-protocol';

/** At most this many days are offered beside the quote's own (MAX_QUOTE_ALTERNATIVES). */
const MAX_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CostLedAlternative {
  alternative_id: string;
  charges: Charge[];
  estimated_delivery_at: string;
}

/**
 * The alternatives the seller's own costs justify, best saving first: none
 * when there is no model, no delivery date to compare against, no value for
 * that day, or a currency other than rupees (the model is in rupees).
 */
export function costLedAlternatives(args: {
  model: ValueModel | null;
  deliveryAt: string | undefined;
  charges: readonly Charge[];
  currency: string;
  /** The quote's own total, in paise: no alternative may take it below zero. */
  totalMinor: bigint;
  nowMs: number;
  /** The owner's time zone: a day is the owner's day. */
  timeZone: string;
  /** Brain's standing share of a saving, in hundredths of a percent (§15 step 11). */
  brainShareBps?: number;
}): CostLedAlternative[] {
  const { model } = args;
  if (model === null || args.deliveryAt === undefined || args.currency !== 'INR') return [];
  const base = Date.parse(args.deliveryAt);
  if (Number.isNaN(base)) return [];
  const costOf = model.choiceValues.delivery_day ?? {};
  const baseDay = deliveryDayOf(base, args.timeZone);
  if (baseDay === null) return [];
  const baseValue = costOf[baseDay];
  if (baseValue === undefined) return [];
  const choice = shareChoice(model, args.brainShareBps);
  const share = choice.label;
  // A never-rule is judged against the whole version offered: its day, the
  // share passed on, and its total. Every test the owner's doors accept for
  // this kind is judged; a test on any other part is taken to hold, so a
  // rule this code cannot read rules the day out rather than letting it by.
  const ruledOut = (day: string, totalMinor: bigint): boolean =>
    model.never.some(
      (rule) =>
        rule.all.length > 0 &&
        rule.all.every((c) => holds(c, { day, share, totalMinor })),
    );
  // The other days of the week around the quote's own delivery date, three
  // either side, at its time of day, each once, and only days still ahead.
  const offers: { day: string; at: number; pass: bigint }[] = [];
  const seen = new Set<string>([baseDay]);
  for (const offset of [-3, -2, -1, 1, 2, 3]) {
    const at = base + offset * DAY_MS;
    if (at <= args.nowMs) continue;
    const day = deliveryDayOf(at, args.timeZone);
    if (day === null || seen.has(day)) continue;
    seen.add(day);
    const value = costOf[day];
    if (value === undefined || value <= baseValue) continue;
    // The saving is the seller's; the share the owner chose, in whole
    // rupees, is offered (half when they chose none).
    const pass = passOf(value - baseValue, choice);
    if (pass < 1n) continue;
    // Never a discount larger than the order: that day is simply not offered.
    const totalMinor = args.totalMinor - pass * 100n;
    if (totalMinor < 0n || ruledOut(day, totalMinor)) continue;
    offers.push({ day, at, pass });
  }
  offers.sort((a, b) => (a.pass === b.pass ? a.at - b.at : a.pass > b.pass ? -1 : 1));
  return offers.slice(0, MAX_DAYS).map((o) => ({
    alternative_id: o.day,
    charges: [
      ...args.charges,
      {
        kind: 'discount' as const,
        label: `Delivery on ${o.day}`,
        amount: { currency: 'INR', minor_units: (o.pass * 100n).toString(10) },
        operation: 'subtract' as const,
      },
    ],
    estimated_delivery_at: new Date(o.at).toISOString().replace('.000Z', 'Z'),
  }));
}

/** Does one test of a never-rule hold for a version offered? */
export function holds(
  c: NeverCondition,
  v: { day: string; share: string; totalMinor: bigint },
): boolean {
  if (c.part === 'delivery_day') {
    if ('choice' in c) return c.choice === v.day;
    return 'present' in c;
  }
  if (c.part === 'saving_share') {
    if ('choice' in c) return c.choice === v.share;
    return 'present' in c;
  }
  if (c.part === 'total') {
    if ('below' in c) return v.totalMinor < c.below;
    if ('above' in c) return v.totalMinor > c.above;
    return 'present' in c;
  }
  return true;
}

/**
 * The owner's chosen share: their one `saving_share` entry (its id is fixed,
 * so a newer choice replaces the older); half when there is none.
 */
export function chosenShare(model: ValueModel): (typeof SAVING_SHARES)[number] {
  const options = model.choiceValues.saving_share ?? {};
  let best: (typeof SAVING_SHARES)[number] = 'half';
  let bestValue: bigint | null = null;
  for (const share of SAVING_SHARES) {
    const v = options[share];
    if (v !== undefined && (bestValue === null || v > bestValue)) {
      best = share;
      bestValue = v;
    }
  }
  return best;
}

/** The part of a saving passed on, in whole rupees, rounded down. */
export function shareOf(saving: bigint, share: (typeof SAVING_SHARES)[number]): bigint {
  if (share === 'third') return saving / 3n;
  if (share === 'most') return (saving * 3n) / 4n;
  return saving / 2n;
}

/**
 * The parts a goods seller's rules are read for. A closed persona holding a
 * rule on any of them withholds the quote, since the rules cannot be read whole.
 */
export const GOODS_SELLER_TOUCHES: readonly string[] = ['delivery_day', 'saving_share', 'total'];

/**
 * The share passed on (COMMITMENT_KERNEL §15 step 11): the standing share
 * Brain set, in hundredths of a percent of the saving, when there is one;
 * otherwise the owner's chosen share. `label` is the nearest of the owner's
 * words, which is what a never-rule on the share is judged against.
 */
export interface ShareChoice {
  label: (typeof SAVING_SHARES)[number];
  bps?: number;
}

export function shareChoice(model: ValueModel, brainShareBps?: number): ShareChoice {
  if (brainShareBps === undefined) return { label: chosenShare(model) };
  const label = brainShareBps <= 4_166 ? 'third' : brainShareBps <= 6_250 ? 'half' : 'most';
  return { label, bps: brainShareBps };
}

/** The part of a saving passed on under a share choice, in whole rupees, rounded down. */
export function passOf(saving: bigint, choice: ShareChoice): bigint {
  return choice.bps === undefined ? shareOf(saving, choice.label) : (saving * BigInt(choice.bps)) / 10_000n;
}
