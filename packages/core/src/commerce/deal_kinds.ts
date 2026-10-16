/**
 * The deal kinds the Commerce Pack's vocabularies define, each from one
 * party's side (COMMITMENT_KERNEL §7: a value model belongs to the owner and
 * to one kind of deal). The kernel knows only `DealKind`; which kinds exist
 * is the packs' data.
 *
 *   - `shelf_space.host`: the store renting out a slot (the seller's side);
 *   - `shelf_space.vendor`: the brand renting it (the buyer's side);
 *   - `goods.buyer`: buying stock — the delivery day and what each day is
 *     worth to the buyer;
 *   - `goods.seller`: selling it — what delivering on each day costs;
 *   - `delivery.shipper`: the shipper a goods seller asks for a run — what a
 *     run costs each day, how many crates it carries, the least fee.
 *
 * The goods kinds' vocabulary is built-in, money-free kernel data
 * (COMMITMENT_KERNEL §10); it lives here beside the others for now.
 */

import { SLOT_PACK_PARTS, SLOT_PACK_PROMISES } from './slot_pack_manifests';

import type { ModelVocabulary, PartyRole } from '../commitment';

/** Fields of the Core form a kind's engine applies; the form refuses the rest. */
export type FormField =
  | 'walk_away'
  | 'auto_sign'
  | 'limits'
  | 'totals'
  | 'asking'
  | 'firm'
  /** Value entries (choices, flags, promises): they make the model one with values. */
  | 'values'
  /** Capacity entries for promises this side keeps. */
  | 'capacity';

export interface DealKind {
  id: string;
  /** The party whose model this is. */
  holder: PartyRole;
  vocabulary: ModelVocabulary;
  /**
   * What the engine for this kind applies from the form. Shelf floors,
   * ceilings and asking terms are set per resource or per negotiation on the
   * shelf forms, and shelf deals stay subject to a card on both sides, so a
   * shelf kind takes never-rules and persona entries only, for now.
   */
  honours: ReadonlySet<FormField>;
  /** For promise dimensions with a closed set of words: the words allowed. */
  promiseWords: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}

const SHELF_PROMISE_WORDS = Object.fromEntries(
  Object.entries(SLOT_PACK_PROMISES).map(([name, p]) => [
    name,
    Object.fromEntries(
      Object.entries(p.dimensions).flatMap(([d, spec]) =>
        spec.order === 'exact' ? [[d, spec.values] as const] : [],
      ),
    ),
  ]),
);

export const SHELF_VOCABULARY: ModelVocabulary = {
  numbers: SLOT_PACK_PARTS,
  choices: {},
  flags: [],
  promises: Object.fromEntries(
    Object.entries(SLOT_PACK_PROMISES).map(([name, p]) => [
      name,
      Object.fromEntries(Object.entries(p.dimensions).map(([d, spec]) => [d, spec.order])),
    ]),
  ),
};

/** The days a goods delivery can fall on, as the buyer's model names them. */
export const DELIVERY_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/**
 * The day a delivery falls on in the owner's own time zone ("Tuesday" is the
 * owner's Tuesday, not UTC's); null when the moment is not a date.
 */
export function deliveryDayOf(atMs: number, timeZone: string): (typeof DELIVERY_DAYS)[number] | null {
  if (Number.isNaN(atMs)) return null;
  try {
    const name = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone })
      .format(new Date(atMs))
      .slice(0, 3)
      .toLowerCase();
    return (DELIVERY_DAYS as readonly string[]).includes(name)
      ? (name as (typeof DELIVERY_DAYS)[number])
      : null;
  } catch {
    return null;
  }
}

/**
 * Buying stock: the total the buyer pays, and the delivery day. A value on a
 * day says what that day is worth to the buyer ("Tuesdays cost me a trip:
 * −₹100"); a never-rule rules a day out ("never on Sunday").
 */
export const GOODS_BUYER_VOCABULARY: ModelVocabulary = {
  numbers: [{ name: 'total', kind: 'money', payer: 'buyer', payee: 'seller' }],
  choices: { delivery_day: DELIVERY_DAYS },
  flags: [],
  promises: {},
};

/**
 * How much of what a cheaper delivery day saves the seller is passed on to the
 * buyer. The owner's confirmed choice is the option with the highest value
 * among their `saving_share` entries; with none, half (the even split, §16).
 */
export const SAVING_SHARES = ['third', 'half', 'most'] as const;

/** Selling stock: the delivery day (what each costs), and the share of a saving passed on. */
export const GOODS_SELLER_VOCABULARY: ModelVocabulary = {
  ...GOODS_BUYER_VOCABULARY,
  choices: { delivery_day: DELIVERY_DAYS, saving_share: SAVING_SHARES },
};

/**
 * A shipper's runs (COMMITMENT_KERNEL §15 step 7, the built-in delivery
 * vocabulary): what a run on each day costs it (a negative value; a day with
 * none is a day with no run), how many crates a run carries (a capacity on
 * the `run` promise), and the least fee Core may agree alone (`fee`).
 */
export const DELIVERY_SHIPPER_VOCABULARY: ModelVocabulary = {
  numbers: [{ name: 'fee', kind: 'money', payer: 'buyer', payee: 'seller' }],
  choices: { delivery_day: DELIVERY_DAYS },
  flags: [],
  promises: { run: { crates: 'lower_better' } },
};

export const DEAL_KINDS: readonly DealKind[] = [
  // The store signs offers alone: values would put every offer past an
  // auto-sign worth it cannot set, so it takes none yet. The brand never signs
  // alone (every proposal is its owner's card): values show what a version is
  // worth there, and capacity guards its runs.
  {
    id: 'shelf_space.host',
    holder: 'seller',
    vocabulary: SHELF_VOCABULARY,
    honours: new Set(),
    promiseWords: SHELF_PROMISE_WORDS,
  },
  {
    id: 'shelf_space.vendor',
    holder: 'buyer',
    vocabulary: SHELF_VOCABULARY,
    honours: new Set(['values', 'capacity']),
    promiseWords: SHELF_PROMISE_WORDS,
  },
  // The buyer of goods ranks the versions it is offered by what each is worth
  // to it; it signs nothing alone (every order is its owner's card).
  {
    id: 'goods.buyer',
    holder: 'buyer',
    vocabulary: GOODS_BUYER_VOCABULARY,
    honours: new Set(['values']),
    promiseWords: {},
  },
  // The seller of goods: what delivering on each day costs it ("Friday
  // −₹120; Tuesday −₹40, my van passes then"). Core offers the cheaper days
  // as alternatives and passes on half the saving (goods_seller_alternatives.ts).
  {
    id: 'goods.seller',
    holder: 'seller',
    vocabulary: GOODS_SELLER_VOCABULARY,
    // `firm`: versions resting on a shipper's run go out without a clearance card (§6 step 3).
    honours: new Set(['values', 'firm']),
    promiseWords: {},
  },
  // The shipper a goods seller asks for a firm option on a run (§6, §15 step 7).
  {
    id: 'delivery.shipper',
    holder: 'seller',
    vocabulary: DELIVERY_SHIPPER_VOCABULARY,
    // `asking`: the owner's price for a run (the fee an option carries).
    honours: new Set(['values', 'limits', 'capacity', 'asking']),
    promiseWords: {},
  },
];

export function dealKind(id: string): DealKind | null {
  return DEAL_KINDS.find((kind) => kind.id === id) ?? null;
}
