/**
 * The khata fold (TRADE_FIRST_STRATEGY §4.4) — the derived balance.
 *
 * No document carries a balance. Both sides compute TWO numbers from
 * the shared document set, and this module is the one arithmetic
 * authority for both, so two conforming nodes cannot diverge:
 *
 *   agreed balance = Σ receipted goods value + accrued charges
 *                    − Σ acknowledged payments
 *   disputed       = Σ (delivered − accepted, floor 0) × bound price
 *
 * The pinned rules, in the order they bite:
 *
 * - RECEIPTED QUANTITIES DRIVE THE MONEY. An unreceipted DeliveryNote
 *   contributes nothing (it sweeps instead); a buyer admits debt by
 *   the receipt, the only basis a shared ledger can price without one
 *   side's unilateral word. A cancelled-after-acceptance order needs
 *   no special case: it simply has only its receipted deliveries.
 * - LINE VALUE: bound unit price × (Σ accepted quantity / price
 *   basis), exact rationals, ONE half-even rounding per line — the
 *   §9.1 discipline, via the same primitives `computeLineSubtotal`
 *   uses. Quantities sum exactly in dimension-base rationals, so a
 *   250 g receipt and a 0.75 kg receipt make 1 kg, not a float.
 * - CHARGE ACCRUAL BY KIND (the shipped `Charge` has no
 *   fixed/proportional field, so kind IS the rule): every `delivery`
 *   charge accrues IN FULL with the first receipt whose accepted
 *   value is positive; `tax`/`discount`/`other` accrue by
 *   `accepted_fraction = accepted_minor_sum / full_quoted_minor_sum`,
 *   one half-even rounding per charge, `subtract` applying its sign.
 *   The fraction is a ratio of ROUNDED line values — the same numbers
 *   the statement displays — so display and arithmetic cannot
 *   disagree. While accepted value is zero, NO charge accrues; a
 *   zero full subtotal accrues no proportional charge (nothing
 *   divides by zero).
 * - ONE CURRENCY PER FOLD. Every Money input must carry the fold's
 *   currency; a second currency is a second ledger, and the caller
 *   runs a second fold. No conversion, ever.
 * - PAYMENTS: Σ `amount_received` over acknowledgements with kind
 *   `received` (the caller extracts them; `disputed` credits zero by
 *   §4.2 and never reaches this input).
 *
 * The balance is SIGNED by direction, never by a negative Money —
 * on-account prepayment legitimately swings it the other way.
 *
 * Inputs are DISTILLED, not raw documents: the caller (the store
 * layer) joins each receipt line to its note line AFTER the pairwise
 * verifiers in `trade_documents.ts` have passed, and hands this
 * module plain values. Arithmetic re-validates money/quantity shapes
 * anyway — fold output is what a statement shows an owner, and this
 * package's rule is that arithmetic never trusts upstream validation
 * to have happened.
 */

import { roundRationalHalfEven, validateCharge, type Charge } from './arithmetic';
import { moneyMinorUnits, minorUnitsToString, validateMoney, type Money } from './money';
import {
  compareQuantities,
  quantityToRational,
  validateQuantity,
  type Quantity,
} from './quantity';

// ---------------------------------------------------------------------------
// Input shapes (distilled by the caller from verified stores)
// ---------------------------------------------------------------------------

export interface FoldOrderLine {
  line_id: string;
  /** From the BOUND quote revision. */
  unit_price: Money;
  /** The quote line's price basis (§9.1). */
  price_basis: Quantity;
  /** The ordered quantity — the full-subtotal denominator input. */
  ordered_quantity: Quantity;
}

/** One receipt line JOINED to its note line (pairwise-verified upstream). */
export interface FoldReceiptedEntry {
  line_id: string;
  delivered_quantity: Quantity;
  accepted_quantity: Quantity;
}

export interface FoldOrder {
  purchase_order_id: string;
  lines: FoldOrderLine[];
  /** The bound quote revision's charges, verbatim. */
  charges: Charge[];
  /** Every receipted (note, receipt) line pair for this order. */
  receipted: FoldReceiptedEntry[];
}

export interface TradeFoldInput {
  /** The fold's single currency — every Money input must match. */
  currency: string;
  orders: FoldOrder[];
  /** `amount_received` of every ack with kind 'received'. */
  payments_received: Money[];
}

export interface OrderFoldBreakdown {
  purchase_order_id: string;
  goods_minor: string;
  charges_minor: string;
  disputed_minor: string;
}

export type TradeFoldResult =
  | {
      ok: true;
      currency: string;
      goods_owed_minor: string;
      payments_minor: string;
      balance: { direction: 'buyer_owes' | 'supplier_owes' | 'settled'; minor_units: string };
      disputed_minor: string;
      per_order: OrderFoldBreakdown[];
    }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

interface Rational {
  n: bigint;
  d: bigint;
}

/** price × (quantity rational / basis rational), unrounded. */
function lineValueRational(priceMinor: bigint, quantity: Rational, basis: Rational): Rational {
  return { n: priceMinor * quantity.n * basis.d, d: quantity.d * basis.n };
}

export function computeTradeFold(input: TradeFoldInput): TradeFoldResult {
  const currency = input.currency;
  const refuse = (error: string): TradeFoldResult => ({ ok: false, error });

  let goodsTotal = 0n;
  let chargesTotal = 0n;
  let disputedTotal = 0n;
  const perOrder: OrderFoldBreakdown[] = [];

  for (const order of input.orders) {
    let fullSubtotal = 0n;
    let acceptedSubtotal = 0n;
    let orderDisputed = 0n;

    // Group receipted entries by line — several receipts per line sum
    // EXACTLY as rationals before the line's one rounding.
    const acceptedByLine = new Map<string, Rational>();
    const deliveredByLine = new Map<string, Rational>();
    for (const entry of order.receipted) {
      const line = order.lines.find((l) => l.line_id === entry.line_id);
      if (line === undefined) {
        return refuse(`fold: order ${order.purchase_order_id} receipted unknown line "${entry.line_id}"`);
      }
      for (const [quantity, sums] of [
        [entry.accepted_quantity, acceptedByLine],
        [entry.delivered_quantity, deliveredByLine],
      ] as const) {
        const quantityError = validateQuantity(quantity);
        if (quantityError) return refuse(`fold: ${quantityError}`);
        // Comparability with the line's basis — the same gate §9.1
        // applies, expressed through the exported comparator.
        const comparable = compareQuantities(quantity, line.price_basis);
        if (typeof comparable === 'string') return refuse(`fold: ${comparable}`);
        const r = quantityToRational(quantity);
        const prior = sums.get(entry.line_id) ?? { n: 0n, d: 1n };
        sums.set(entry.line_id, { n: prior.n * r.denominator + r.numerator * prior.d, d: prior.d * r.denominator });
      }
    }

    for (const line of order.lines) {
      const priceError = validateMoney(line.unit_price);
      if (priceError) return refuse(`fold: ${priceError}`);
      if (line.unit_price.currency !== currency) {
        return refuse(
          `fold: order ${order.purchase_order_id} line "${line.line_id}" is priced in ${line.unit_price.currency}; this fold is ${currency} (one currency per ledger)`,
        );
      }
      const orderedError = validateQuantity(line.ordered_quantity, { require_positive: true });
      if (orderedError) return refuse(`fold: ${orderedError}`);
      const basisError = validateQuantity(line.price_basis, { require_positive: true });
      if (basisError) return refuse(`fold: ${basisError}`);
      const comparable = compareQuantities(line.ordered_quantity, line.price_basis);
      if (typeof comparable === 'string') return refuse(`fold: ${comparable}`);

      const price = moneyMinorUnits(line.unit_price);
      const basis = quantityToRational(line.price_basis);
      const basisRational: Rational = { n: basis.numerator, d: basis.denominator };

      const ordered = quantityToRational(line.ordered_quantity);
      const fullValue = lineValueRational(price, { n: ordered.numerator, d: ordered.denominator }, basisRational);
      fullSubtotal += roundRationalHalfEven(fullValue.n, fullValue.d);

      const accepted = acceptedByLine.get(line.line_id);
      if (accepted !== undefined) {
        const acceptedValue = lineValueRational(price, accepted, basisRational);
        acceptedSubtotal += roundRationalHalfEven(acceptedValue.n, acceptedValue.d);

        const delivered = deliveredByLine.get(line.line_id) ?? { n: 0n, d: 1n };
        // disputed qty = max(0, delivered − accepted), exact.
        const diffN = delivered.n * accepted.d - accepted.n * delivered.d;
        if (diffN > 0n) {
          const disputedValue = lineValueRational(price, { n: diffN, d: delivered.d * accepted.d }, basisRational);
          orderDisputed += roundRationalHalfEven(disputedValue.n, disputedValue.d);
        }
      }
    }

    // Charges accrue by KIND (§4.4): delivery = full on first positive
    // acceptance; the rest pro-rata over rounded line values.
    let orderCharges = 0n;
    for (const charge of order.charges) {
      const chargeError = validateCharge(charge);
      if (chargeError) return refuse(`fold: ${chargeError}`);
      if (charge.amount.currency !== currency) {
        return refuse(
          `fold: order ${order.purchase_order_id} charge "${charge.label}" is in ${charge.amount.currency}; this fold is ${currency} (one currency per ledger)`,
        );
      }
      if (acceptedSubtotal === 0n) continue; // nothing accepted, nothing accrues
      const amount = moneyMinorUnits(charge.amount);
      let accrued: bigint;
      if (charge.kind === 'delivery') {
        accrued = amount;
      } else if (fullSubtotal === 0n) {
        continue; // zero-priced order: no proportional base exists
      } else {
        accrued = roundRationalHalfEven(amount * acceptedSubtotal, fullSubtotal);
      }
      orderCharges += charge.operation === 'subtract' ? -accrued : accrued;
    }

    goodsTotal += acceptedSubtotal;
    chargesTotal += orderCharges;
    disputedTotal += orderDisputed;

    const goodsOut = minorUnitsToString(acceptedSubtotal);
    if (goodsOut.error) return refuse(`fold: ${goodsOut.error}`);
    const disputedOut = minorUnitsToString(orderDisputed);
    if (disputedOut.error) return refuse(`fold: ${disputedOut.error}`);
    // Per-order charges may be net-negative (a discount larger than
    // accrued additions); render signed for the breakdown.
    perOrder.push({
      purchase_order_id: order.purchase_order_id,
      goods_minor: goodsOut.value as string,
      charges_minor: orderCharges < 0n ? `-${(-orderCharges).toString(10)}` : orderCharges.toString(10),
      disputed_minor: disputedOut.value as string,
    });
  }

  let paymentsTotal = 0n;
  for (const payment of input.payments_received) {
    const paymentError = validateMoney(payment);
    if (paymentError) return refuse(`fold: ${paymentError}`);
    if (payment.currency !== currency) {
      return refuse(`fold: payment in ${payment.currency}; this fold is ${currency} (one currency per ledger)`);
    }
    paymentsTotal += moneyMinorUnits(payment);
  }

  const owed = goodsTotal + chargesTotal;
  if (owed < 0n) {
    // Discounts cannot make a relationship owe less than nothing for
    // goods — the shipped computeTotal refuses the same shape.
    return refuse('fold: net charges drive the goods total negative');
  }
  const balanceRaw = owed - paymentsTotal;
  const direction = balanceRaw > 0n ? 'buyer_owes' : balanceRaw < 0n ? 'supplier_owes' : 'settled';
  const magnitude = balanceRaw < 0n ? -balanceRaw : balanceRaw;

  const owedOut = minorUnitsToString(owed);
  if (owedOut.error) return refuse(`fold: ${owedOut.error}`);
  const paymentsOut = minorUnitsToString(paymentsTotal);
  if (paymentsOut.error) return refuse(`fold: ${paymentsOut.error}`);
  const balanceOut = minorUnitsToString(magnitude);
  if (balanceOut.error) return refuse(`fold: ${balanceOut.error}`);
  const disputedOut = minorUnitsToString(disputedTotal);
  if (disputedOut.error) return refuse(`fold: ${disputedOut.error}`);

  return {
    ok: true,
    currency,
    goods_owed_minor: owedOut.value as string,
    payments_minor: paymentsOut.value as string,
    balance: { direction, minor_units: balanceOut.value as string },
    disputed_minor: disputedOut.value as string,
    per_order: perOrder,
  };
}
