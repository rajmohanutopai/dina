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

import { commerceRecordDigest } from '@dina/commerce-protocol';

import { offerEndOf, upperOfferEndsAt } from '../commitment/dependent';
import {
  optionTerms,
  orderRefOf,
  partnerAlternativeId,
  type OptionLink,
  type SellerOptionStore,
} from '../commitment/options';

import { deliveryDayOf } from './deal_kinds';
import { holds, passOf, shareChoice } from './goods_seller_alternatives';
import { rehydratePurchaseOrder, rehydrateQuoteRequest, rehydrateSignedQuote } from './rehydrate';

import type { ValueModel } from '../commitment';
import type { CancellationRequest, Charge, Sha256Fn, SignedQuote } from '@dina/commerce-protocol';

export interface PartnerRunAlternative {
  alternative_id: string;
  charges: Charge[];
  estimated_delivery_at: string;
  partner_run: true;
  offer_ends_at: string;
  /** §15 step 12: the buyer may cancel without charge if the run falls through. */
  exit_if_run_fails?: true;
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
  /** Brain's standing share of a saving, in hundredths of a percent (§15 step 11). */
  brainShareBps?: number;
  /** The buyer asked for the exit right and the seller grants it (§15 step 12; minor 1.5). */
  exitRight?: boolean;
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
  const choice = shareChoice(model, args.brainShareBps);
  const share = choice.label;
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
    const pass = passOf(saving, choice);
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
      ...(args.exitRight === true && minor >= 5 ? { exit_if_run_fails: true as const } : {}),
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
): { buyerDid: string; exitRight: boolean } | null {
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
  return alternative?.partner_run === true
    ? { buyerDid: record.buyerDid, exitRight: alternative.exit_if_run_fails === true }
    : null;
}

/**
 * COMMITMENT_KERNEL §15 step 12 — on the seller's node: does this order hold
 * the exit right? Read from the order and the quote version it names, as
 * this node retained them.
 */
export function sellerOrderHoldsExit(
  stores: {
    orders: { load(buyerDid: string, purchaseOrderId: string): { ref: { orderDigest: string; quoteDigest: string } } | null };
    receipts: { get(recordDigest: string): { recordJson: string } | null };
  },
  buyerDid: string,
  purchaseOrderId: string,
): boolean {
  const ref = stores.orders.load(buyerDid, purchaseOrderId)?.ref;
  if (ref === undefined) return false;
  const row = stores.receipts.get(ref.orderDigest);
  const order = row === null ? null : rehydratePurchaseOrder(row.recordJson, sha256 as Sha256Fn);
  if (order === null || !order.ok || order.value.alternative_id === undefined) return false;
  const alternative = retainedQuote(stores.receipts, ref.quoteDigest)?.alternatives?.find(
    (a) => a.alternative_id === order.value.alternative_id,
  );
  return alternative?.partner_run === true && alternative.exit_if_run_fails === true;
}

/**
 * On the seller's node: will a partner-run version of this quote carry the
 * exit right? The buyer asked in the request this node retained, and the
 * seller's settings grant it (§15 step 12).
 */
export function quoteGrantsExit(
  stores: {
    families: { load(quoteId: string): { headDigest: string } | null };
    receipts: { get(recordDigest: string): { recordJson: string } | null };
    settings: { readSupplier(): { ok: true; settings: { grantExitIfRunFails?: boolean } } | { ok: false } };
  },
  quoteId: string,
): boolean {
  const family = stores.families.load(quoteId);
  const head = family === null ? null : retainedQuote(stores.receipts, family.headDigest);
  const row = head === null ? null : stores.receipts.get(head.request_digest);
  const request = row === null ? null : rehydrateQuoteRequest(row.recordJson, sha256 as Sha256Fn);
  const settings = stores.settings.readSupplier();
  return (
    request !== null &&
    request.ok &&
    request.value.exit_if_run_fails === true &&
    settings.ok &&
    settings.settings.grantExitIfRunFails !== false
  );
}

/**
 * On the buyer's node: the cancellation request the exit right lets it send,
 * for an order it placed with this supplier. Null when it holds no such order.
 */
export function buyerExitCancellation(
  stores: {
    buyerOrders: {
      get(supplierDid: string, purchaseOrderId: string): { orderDigest: string } | null;
    };
    receipts: { get(recordDigest: string): { recordJson: string } | null };
  },
  supplierDid: string,
  purchaseOrderId: string,
  nowMs: number,
): CancellationRequest | null {
  const record = stores.buyerOrders.get(supplierDid, purchaseOrderId);
  if (record === null || record.orderDigest === '') return null;
  const row = stores.receipts.get(record.orderDigest);
  const order = row === null ? null : rehydratePurchaseOrder(row.recordJson, sha256 as Sha256Fn);
  if (order === null || !order.ok) return null;
  // One id for this order's exit: asking twice is the same request.
  const id = `exit-${record.orderDigest.slice(0, 24)}`;
  const draft = {
    protocol_version: order.value.protocol_version,
    cancellation_id: id,
    purchase_order_id: purchaseOrderId,
    order_digest: record.orderDigest,
    reason_code: 'partner_run_failed',
    idempotency_key: id,
    issued_at: new Date(nowMs).toISOString(),
  };
  return {
    ...draft,
    cancellation_digest: commerceRecordDigest('cancellation', draft, sha256 as Sha256Fn),
  };
}
