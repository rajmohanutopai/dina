/**
 * Goods versions resting on a shipper's firm option (COMMITMENT_KERNEL §6,
 * §15 step 7): "my partner's van runs your way on Tuesday; take delivery then
 * and it is ₹35 less".
 *
 * For each option this seller holds for a quote, the seller's own model says
 * what delivering that day itself would cost; the shipper's fee is what the
 * run costs instead. The saving is the seller's, and the share the owner
 * chose is offered (half by default) as a discount, on the same lines at the
 * same prices. The version is offered only until a margin before the
 * option's hold (`upperOfferEndsAt`), and the quote's own terms are its
 * fallback if the run is lost after binding. Nothing about the seller's costs
 * or the shipper's fee leaves Core: the buyer sees only the change.
 *
 * And the binding: the buyer's order for such a version takes the option up
 * in the same transaction that accepts the order (`takeUpForOrderInTx`).
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { offerEndOf, upperOfferEndsAt } from '../commitment/dependent';
import {
  optionTerms,
  orderRefOf,
  partnerAlternativeId,
  type OptionLink,
  type SellerOptionStore,
} from '../commitment/options';

import { deliveryDayOf } from './deal_kinds';
import { chosenShare, holds, shareOf } from './goods_seller_alternatives';
import { rehydratePurchaseOrder, rehydrateSignedQuote } from './rehydrate';

import type { ValueModel } from '../commitment';
import type { Charge, Sha256Fn, SignedQuote } from '@dina/commerce-protocol';

export interface PartnerRunAlternative {
  alternative_id: string;
  charges: Charge[];
  estimated_delivery_at: string;
  partner_run: true;
  offer_ends_at: string;
}

/**
 * The partner-run versions a quote may carry now: one per held option whose
 * fee saves the seller money on that day, within the owner's rules, offered
 * until the earlier of the option's offer end and the quote's own validity.
 * None for a buyer below minor 1.4, while a persona holding the seller's
 * entries is closed, or before the owner's time zone is known.
 */
export function partnerRunAlternatives(args: {
  store: SellerOptionStore | null;
  dealRef: string;
  seller: { model: ValueModel | null; closedPersonas: string[] } | null;
  protocolVersion: string;
  charges: readonly Charge[];
  currency: string;
  totalMinor: bigint;
  validUntilMs: number;
  nowMs: number;
  timeZone: string | null;
}): PartnerRunAlternative[] {
  const minor = Number(args.protocolVersion.split('.')[1] ?? '0');
  const { store, seller, timeZone } = args;
  if (
    store === null ||
    seller === null ||
    seller.model === null ||
    seller.closedPersonas.length > 0 ||
    timeZone === null ||
    !Number.isFinite(minor) ||
    minor < 4 ||
    args.currency !== 'INR'
  )
    return [];
  const model = seller.model;
  const share = chosenShare(model);
  const out: PartnerRunAlternative[] = [];
  for (const link of store.forDeal(args.dealRef)) {
    // Only an option the seller's owner cleared (§6 step 3).
    if (link.state !== 'held' || link.option === null || link.clearedAt === null) continue;
    const option = link.option;
    const ends = upperOfferEndsAt(optionTerms(option), args.nowMs);
    if (ends === null) continue;
    const offerEnds = Math.min(ends, args.validUntilMs);
    if (offerEnds <= args.nowMs) continue;
    const day = deliveryDayOf(Date.parse(option.service_at), timeZone);
    const ownCost = day === null ? undefined : model.choiceValues.delivery_day?.[day];
    if (day === null || ownCost === undefined || ownCost >= 0n) continue;
    // What the seller saves by the partner's run, in whole rupees.
    const saving = -ownCost - BigInt(option.fee_minor) / 100n;
    if (saving <= 0n) continue;
    const pass = shareOf(saving, share);
    if (pass < 1n) continue;
    const totalMinor = args.totalMinor - pass * 100n;
    if (totalMinor < 0n) continue;
    const ruledOut = model.never.some(
      (rule) => rule.all.length > 0 && rule.all.every((c) => holds(c, { day, share, totalMinor })),
    );
    if (ruledOut) continue;
    out.push({
      alternative_id: partnerAlternativeId(link.requestId),
      charges: [
        ...args.charges,
        {
          kind: 'discount',
          label: 'Delivery by a partner run',
          amount: { currency: 'INR', minor_units: (pass * 100n).toString(10) },
          operation: 'subtract',
        },
      ],
      estimated_delivery_at: option.service_at,
      partner_run: true,
      offer_ends_at: new Date(offerEnds).toISOString(),
    });
  }
  return out;
}

/**
 * The buyer's order reaches the seller and is about to be accepted: inside
 * that same transaction, take up the option its version rests on (§6 step
 * 5). Whether the version rests on an option is the quote's own word — the
 * alternative's `partner_run` mark — never its name. `none`: no run. `taken`:
 * both bind now (or this same order took it before). `lapsed`: the yes came
 * after the offer ended, the hold has ended at the seller's time, or another
 * order took the run — nothing binds, and the order is refused
 * `option_lapsed`.
 */
export function takeUpForOrderInTx(args: {
  store: SellerOptionStore | null;
  quote: SignedQuote | null;
  order: {
    buyer_did: string;
    purchase_order_id: string;
    quote_id: string;
    alternative_id?: string;
    submitted_at: string;
  };
  nowMs: number;
}): 'none' | 'taken' | 'lapsed' {
  const { order } = args;
  if (order.alternative_id === undefined) return 'none';
  const alternative = args.quote?.alternatives?.find(
    (a) => a.alternative_id === order.alternative_id,
  );
  if (alternative?.partner_run !== true) return 'none';
  const link: OptionLink | undefined = args.store
    ?.forDeal(order.quote_id)
    .find((l) => partnerAlternativeId(l.requestId) === order.alternative_id);
  if (link === undefined || link.option === null) return 'lapsed';
  const submitted = Date.parse(order.submitted_at);
  if (Number.isNaN(submitted) || submitted > offerEndOf(optionTerms(link.option))) return 'lapsed';
  const ref = orderRefOf(order.buyer_did, order.purchase_order_id);
  return args.store?.takeUp(link.requestId, ref, args.nowMs) === true ? 'taken' : 'lapsed';
}

/**
 * Is this order's version a cleared partner run? Such an order binds on the
 * buyer's yes, with no further card for the seller's owner: the owner cleared
 * the version before it went out, and a card now could outlast the hold.
 */
export function isClearedPartnerRun(args: {
  store: SellerOptionStore | null;
  quote: SignedQuote | null;
  quoteId: string;
  alternativeId: string | undefined;
}): boolean {
  if (args.alternativeId === undefined) return false;
  const alternative = args.quote?.alternatives?.find(
    (a) => a.alternative_id === args.alternativeId,
  );
  if (alternative?.partner_run !== true) return false;
  const link = args.store
    ?.forDeal(args.quoteId)
    .find((l) => partnerAlternativeId(l.requestId) === args.alternativeId);
  return link !== undefined && link.clearedAt !== null;
}

/** The quote an order names, as this node retained it, re-validated; null when it cannot be read. */
export function retainedQuote(
  receipts: { get(recordDigest: string): { recordJson: string } | null },
  quoteDigest: string,
): SignedQuote | null {
  const row = receipts.get(quoteDigest);
  if (row === null) return null;
  const quote = rehydrateSignedQuote(row.recordJson, sha256 as Sha256Fn);
  return quote.ok ? quote.value : null;
}

/**
 * Does this held order take a cleared partner run? Read from the order and
 * quote this node retained, never from what a caller says.
 */
export function orderTakesClearedRun(args: {
  store: SellerOptionStore | null;
  orders: {
    load(
      buyerDid: string,
      purchaseOrderId: string,
    ): { ref: { orderDigest: string; quoteDigest: string; quoteId: string } } | null;
  };
  receipts: { get(recordDigest: string): { recordJson: string } | null };
  buyerDid: string;
  purchaseOrderId: string;
}): boolean {
  const ref = args.orders.load(args.buyerDid, args.purchaseOrderId)?.ref;
  if (ref === undefined) return false;
  const row = args.receipts.get(ref.orderDigest);
  const order = row === null ? null : rehydratePurchaseOrder(row.recordJson, sha256 as Sha256Fn);
  if (order === null || !order.ok) return false;
  return isClearedPartnerRun({
    store: args.store,
    quote: retainedQuote(args.receipts, ref.quoteDigest),
    quoteId: ref.quoteId,
    alternativeId: order.value.alternative_id,
  });
}

/**
 * The buyer's check of a fallback notice (§6 step 6): from the supplier this
 * order went to, for this buyer's own order, which named that alternative of
 * that quote, which the quote marked as resting on a run. Anything else is
 * not kept: a supplier cannot move an order's terms with a notice.
 */
export function checkFallbackNotice(
  stores: {
    buyerOrders: {
      get(
        supplierDid: string,
        purchaseOrderId: string,
      ): { orderDigest: string; quoteDigest: string; buyerDid: string } | null;
    };
    receipts: { get(recordDigest: string): { recordJson: string } | null };
  },
  args: {
    supplierDid: string;
    notice: { purchase_order_id: string; quote_id: string; alternative_id: string };
  },
): { buyerDid: string } | null {
  const record = stores.buyerOrders.get(args.supplierDid, args.notice.purchase_order_id);
  if (record === null || record.orderDigest === '') return null;
  const row = stores.receipts.get(record.orderDigest);
  const order = row === null ? null : rehydratePurchaseOrder(row.recordJson, sha256 as Sha256Fn);
  if (order === null || !order.ok) return null;
  if (
    order.value.supplier_did !== args.supplierDid ||
    order.value.quote_id !== args.notice.quote_id ||
    order.value.alternative_id !== args.notice.alternative_id
  )
    return null;
  const quote = retainedQuote(stores.receipts, record.quoteDigest);
  const alternative = quote?.alternatives?.find(
    (a) => a.alternative_id === args.notice.alternative_id,
  );
  return alternative?.partner_run === true ? { buyerDid: record.buyerDid } : null;
}
