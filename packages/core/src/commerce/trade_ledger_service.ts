/**
 * The khata service (TRADE_FIRST_STRATEGY §4.2–§4.5) — authoring,
 * statement, and the sweep queries, over the trade-document ledger.
 *
 * AUTHORING RUNS THE INBOUND RULES ON ITSELF. Every issue-operation
 * seals the document and then applies exactly the checks the receiving
 * side will apply (cumulative over-delivery, pairwise binding, the
 * one-answer rule) BEFORE storing it outbound — a node must never
 * author a document it would refuse to receive, because the
 * counterparty will refuse it and the two ledgers would diverge by one
 * document forever.
 *
 * THE STATEMENT IS THE FOLD (§4.4). This service assembles the
 * distilled fold input from the retained stores — order lines priced
 * from the BOUND quote revision, receipt lines joined to their notes,
 * received payment amounts — and hands it to `computeTradeFold`, the
 * one arithmetic authority. Nothing here computes money.
 *
 * SIDE-AGNOSTIC BY INJECTION. Which store retains orders, bound quotes
 * and acceptance facts differs between the buyer and supplier
 * composition; the service takes readers and stays one implementation.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import {
  computeLineSubtotal,
  computeTradeFold,
  deriveDues,
  minorUnitsToString,
  moneyMinorUnits,
  tradeRecordDigest,
  validateDeliveryNote,
  validateDeliveryReceipt,
  validatePaymentAcknowledgement,
  validatePaymentNote,
  validateQuoteDecline,
  verifyDeliveryReceiptAgainstNote,
  verifyPaymentAckAgainstNote,
  verifyQuoteDeclineAgainstRequest,
  type DeliveryNote,
  type DeliveryNoteLine,
  type DeliveryReceipt,
  type DeliveryReceiptLine,
  type DerivedDue,
  type FoldOrder,
  type Money,
  type PaymentAcknowledgement,
  type PaymentMethod,
  type PaymentNote,
  type PurchaseOrderProposal,
  type QuoteDecline,
  type QuoteRequest,
  type Sha256Fn,
  type SignedQuote,
  type TradeFoldResult,
} from '@dina/commerce-protocol';

import {
  checkCumulativeDelivery,
  rehydrateTradeDocument,
  type TradeDocumentRepository,
  type TradeDocumentRow,
} from './trade_ledger';

const hash: Sha256Fn = (data) => sha256(data);

export type TradeAuthorOutcome<T> =
  | { ok: true; document: T }
  | { ok: false; refusal: string };

export interface TradeLedgerServiceDeps {
  documents: TradeDocumentRepository;
  /** THIS node's DID — buyer on one side, supplier on the other. */
  nodeDid: () => string;
  now: () => number;
  /**
   * The retained, validated order. `counterpartyDid` is the OTHER party
   * of the relationship — the composition root resolves which of (self,
   * counterparty) the order's buyer key is, so the service never guesses
   * sides.
   */
  readOrder: (counterpartyDid: string, purchaseOrderId: string) => PurchaseOrderProposal | null;
  /** The bound quote revision an order accepted — the fold's price source. */
  readBoundQuote: (counterpartyDid: string, purchaseOrderId: string) => SignedQuote | null;
  /** Orders of this relationship holding an accepted acknowledgement, per role. */
  listAcceptedOrderIds: (counterpartyDid: string, role?: 'buyer' | 'supplier') => string[];
  /** The acceptance's clock, for §4.5 `from_acceptance` dues. */
  readAcceptance: (
    counterpartyDid: string,
    purchaseOrderId: string,
  ) => { acceptedAt: string } | null;
}

function mintId(prefix: string): string {
  return `${prefix}_${bytesToHex(randomBytes(12))}`;
}

function isoNow(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

export class TradeLedgerService {
  constructor(private readonly deps: TradeLedgerServiceDeps) {}

  // -------------------------------------------------------------------------
  // Authoring — supplier side
  // -------------------------------------------------------------------------

  /**
   * Issue a DeliveryNote against an accepted order. The cumulative
   * over-delivery rule is `checkCumulativeDelivery` — the same single
   * definition the buyer's inbound verifier runs — applied against this
   * node's own retained note set before anything is stored.
   */
  issueDeliveryNote(args: {
    /** The buyer — the relationship this dispatch belongs to. */
    counterpartyDid: string;
    purchaseOrderId: string;
    supplierOrderId: string;
    lines: DeliveryNoteLine[];
    expectedBy?: string;
  }): TradeAuthorOutcome<DeliveryNote> {
    const order = this.deps.readOrder(args.counterpartyDid, args.purchaseOrderId);
    if (order === null) return { ok: false, refusal: `no retained order ${args.purchaseOrderId}` };
    if (order.supplier_did !== this.deps.nodeDid()) {
      return { ok: false, refusal: 'this node is not the order supplier' };
    }
    if (order.buyer_did !== args.counterpartyDid) {
      return { ok: false, refusal: 'the order belongs to a different buyer' };
    }
    const draft = {
      protocol_version: order.protocol_version,
      delivery_note_id: mintId('dn'),
      purchase_order_id: order.purchase_order_id,
      order_digest: order.order_digest,
      supplier_order_id: args.supplierOrderId,
      lines: args.lines,
      dispatched_at: isoNow(this.deps.now()),
      ...(args.expectedBy !== undefined ? { expected_by: args.expectedBy } : {}),
    };
    const note = { ...draft, note_digest: tradeRecordDigest('delivery_note', draft, hash) } as DeliveryNote;
    const shapeError = validateDeliveryNote(note, hash);
    if (shapeError) return { ok: false, refusal: shapeError };

    // The SAME cumulative rule the buyer's verifier runs on arrival —
    // one definition, so a node cannot author a note its counterparty
    // will refuse.
    const cumulativeError = checkCumulativeDelivery({
      note,
      order,
      repository: this.deps.documents,
    });
    if (cumulativeError) return { ok: false, refusal: cumulativeError };

    this.deps.documents.put({
      recordDigest: note.note_digest,
      kind: 'delivery_note',
      counterpartyDid: order.buyer_did,
      purchaseOrderId: order.purchase_order_id,
      answersDigest: '',
      direction: 'outbound',
      recordJson: JSON.stringify(note),
      evidenceJson: '{}',
      createdAt: this.deps.now(),
    });
    return { ok: true, document: note };
  }

  /** Acknowledge a received PaymentNote (supplier side). */
  acknowledgePayment(args: {
    paymentNoteDigest: string;
    kind: 'received' | 'disputed';
    amountReceived?: Money;
  }): TradeAuthorOutcome<PaymentAcknowledgement> {
    const noteRow = this.deps.documents.get(args.paymentNoteDigest);
    if (noteRow === null || noteRow.kind !== 'payment_note' || noteRow.direction !== 'inbound') {
      return { ok: false, refusal: 'no received payment note with that digest' };
    }
    const note = rehydrateTradeDocument(noteRow);
    if (note.kind !== 'payment_note') return { ok: false, refusal: 'retained row is not a payment note' };
    if (note.document.supplier_did !== this.deps.nodeDid()) {
      return { ok: false, refusal: 'this node is not the note supplier' };
    }
    const existing = this.deps.documents.answersTo(args.paymentNoteDigest, 'payment_ack');
    if (existing.length > 0) {
      return { ok: false, refusal: 'the note already has an acknowledgement — the first answer stands' };
    }
    const draft = {
      protocol_version: note.document.protocol_version,
      payment_ack_id: mintId('pa'),
      payment_note_digest: args.paymentNoteDigest,
      kind: args.kind,
      ...(args.kind === 'received' ? { amount_received: args.amountReceived } : {}),
      acknowledged_at: isoNow(this.deps.now()),
    };
    const ack = {
      ...draft,
      ack_digest: tradeRecordDigest('payment_ack', draft, hash),
    } as unknown as PaymentAcknowledgement;
    const shapeError = validatePaymentAcknowledgement(ack, hash);
    if (shapeError) return { ok: false, refusal: shapeError };
    const pairError = verifyPaymentAckAgainstNote(ack, note.document, hash);
    if (pairError) return { ok: false, refusal: pairError };

    this.deps.documents.put({
      recordDigest: ack.ack_digest,
      kind: 'payment_ack',
      counterpartyDid: note.document.buyer_did,
      purchaseOrderId: '',
      answersDigest: args.paymentNoteDigest,
      direction: 'outbound',
      recordJson: JSON.stringify(ack),
      evidenceJson: '{}',
      createdAt: this.deps.now(),
    });
    return { ok: true, document: ack };
  }

  /** Decline a quote request (supplier side, §3.4). */
  declineQuote(args: {
    request: QuoteRequest;
    reasonCode: string;
  }): TradeAuthorOutcome<QuoteDecline> {
    if (args.request.supplier_did !== this.deps.nodeDid()) {
      return { ok: false, refusal: 'this node is not the request supplier' };
    }
    const existing = this.deps.documents.answersTo(args.request.request_digest, 'quote_decline');
    if (existing.length > 0) {
      return { ok: false, refusal: 'the request already has a decline' };
    }
    const draft = {
      protocol_version: args.request.protocol_version,
      decline_id: mintId('dec'),
      request_id: args.request.request_id,
      request_digest: args.request.request_digest,
      buyer_did: args.request.buyer_did,
      supplier_did: args.request.supplier_did,
      reason_code: args.reasonCode,
      issued_at: isoNow(this.deps.now()),
    };
    const decline = {
      ...draft,
      decline_digest: tradeRecordDigest('quote_decline', draft, hash),
    } as QuoteDecline;
    const shapeError = validateQuoteDecline(decline, hash);
    if (shapeError) return { ok: false, refusal: shapeError };
    const bindError = verifyQuoteDeclineAgainstRequest(decline, args.request);
    if (bindError) return { ok: false, refusal: bindError };

    this.deps.documents.put({
      recordDigest: decline.decline_digest,
      kind: 'quote_decline',
      counterpartyDid: args.request.buyer_did,
      purchaseOrderId: '',
      answersDigest: args.request.request_digest,
      direction: 'outbound',
      recordJson: JSON.stringify(decline),
      evidenceJson: '{}',
      createdAt: this.deps.now(),
    });
    return { ok: true, document: decline };
  }

  // -------------------------------------------------------------------------
  // Authoring — buyer side
  // -------------------------------------------------------------------------

  /** Receipt a received DeliveryNote (buyer side). Zero acceptance is legal. */
  issueDeliveryReceipt(args: {
    deliveryNoteDigest: string;
    lines: DeliveryReceiptLine[];
  }): TradeAuthorOutcome<DeliveryReceipt> {
    const noteRow = this.deps.documents.get(args.deliveryNoteDigest);
    if (noteRow === null || noteRow.kind !== 'delivery_note' || noteRow.direction !== 'inbound') {
      return { ok: false, refusal: 'no received delivery note with that digest' };
    }
    const note = rehydrateTradeDocument(noteRow);
    if (note.kind !== 'delivery_note') return { ok: false, refusal: 'retained row is not a note' };
    const order = this.deps.readOrder(noteRow.counterpartyDid, note.document.purchase_order_id);
    if (order === null || order.buyer_did !== this.deps.nodeDid()) {
      return { ok: false, refusal: 'this node is not the order buyer' };
    }
    const existing = this.deps.documents.answersTo(args.deliveryNoteDigest, 'delivery_receipt');
    if (existing.length > 0) {
      return { ok: false, refusal: 'the note already has a receipt — the first answer stands' };
    }
    const draft = {
      protocol_version: note.document.protocol_version,
      delivery_receipt_id: mintId('dr'),
      delivery_note_digest: args.deliveryNoteDigest,
      lines: args.lines,
      received_at: isoNow(this.deps.now()),
    };
    const receipt = {
      ...draft,
      receipt_digest: tradeRecordDigest('delivery_receipt', draft, hash),
    } as DeliveryReceipt;
    const shapeError = validateDeliveryReceipt(receipt, hash);
    if (shapeError) return { ok: false, refusal: shapeError };
    const pairError = verifyDeliveryReceiptAgainstNote(receipt, note.document, hash);
    if (pairError) return { ok: false, refusal: pairError };

    this.deps.documents.put({
      recordDigest: receipt.receipt_digest,
      kind: 'delivery_receipt',
      counterpartyDid: noteRow.counterpartyDid,
      purchaseOrderId: note.document.purchase_order_id,
      answersDigest: args.deliveryNoteDigest,
      direction: 'outbound',
      recordJson: JSON.stringify(receipt),
      evidenceJson: '{}',
      createdAt: this.deps.now(),
    });
    return { ok: true, document: receipt };
  }

  /**
   * The §6.5 cap basis for `commerce_receive_goods`: what a proposed
   * receipt is WORTH, priced from the bound quote — the chain
   * receipt → note → order → quote makes it computable, and the staff
   * gate compares this number against the grant cap BEFORE the receipt
   * is signed. Per-line rounding matches the fold (§9.1: one rounding
   * per line, half-even), so the gate and the statement price the same
   * acceptance identically.
   *
   * FAIL-CLOSED PRICING: a receipt whose value cannot be established
   * (no bound quote, an unpriceable line) refuses rather than passing a
   * partial sum — a cap compared against an undercount is no cap.
   */
  priceDeliveryReceipt(args: {
    deliveryNoteDigest: string;
    lines: DeliveryReceiptLine[];
  }): { ok: true; value: Money } | { ok: false; refusal: string } {
    const noteRow = this.deps.documents.get(args.deliveryNoteDigest);
    if (noteRow === null || noteRow.kind !== 'delivery_note' || noteRow.direction !== 'inbound') {
      return { ok: false, refusal: 'no received delivery note with that digest' };
    }
    const note = rehydrateTradeDocument(noteRow);
    if (note.kind !== 'delivery_note') return { ok: false, refusal: 'retained row is not a note' };
    const quote = this.deps.readBoundQuote(noteRow.counterpartyDid, note.document.purchase_order_id);
    if (quote === null) {
      return { ok: false, refusal: 'no bound quote — the receipt value cannot be established' };
    }
    return this.priceAcceptedLines(quote, args.lines);
  }

  /**
   * Σ per-line accepted value against the bound quote — ONE definition
   * for the §6.5 cap basis and the §4.5 `from_delivery` due values, so
   * the gate and the statement price the same acceptance identically.
   * Per-line rounding matches the fold (§9.1: one rounding per line).
   */
  private priceAcceptedLines(
    quote: SignedQuote,
    lines: readonly DeliveryReceiptLine[],
  ): { ok: true; value: Money } | { ok: false; refusal: string } {
    const quoteLines = new Map(quote.lines.map((line) => [line.line_id, line]));
    let total = 0n;
    for (const line of lines) {
      const quoteLine = quoteLines.get(line.line_id);
      if (quoteLine === undefined) {
        return { ok: false, refusal: `line ${line.line_id} has no bound quote line to price it` };
      }
      const subtotal = computeLineSubtotal(
        quoteLine.unit_price,
        line.accepted_quantity,
        quoteLine.price_basis,
      );
      if (subtotal.value === null) {
        return { ok: false, refusal: subtotal.error ?? `line ${line.line_id} is not priceable` };
      }
      total += moneyMinorUnits(subtotal.value);
    }
    const rendered = minorUnitsToString(total);
    if (rendered.value === null) {
      return { ok: false, refusal: rendered.error ?? 'receipt value out of range' };
    }
    // One currency per quote (§9.1) — the total's currency IS the quote's.
    return { ok: true, value: { currency: quote.total.currency, minor_units: rendered.value } };
  }

  /** Assert a payment made (buyer side). Relationship-scoped (§4.4). */
  issuePaymentNote(args: {
    supplierDid: string;
    amount: Money;
    method: PaymentMethod;
    externalRef?: string;
    orderRefs?: string[];
  }): TradeAuthorOutcome<PaymentNote> {
    const draft = {
      protocol_version: '1.0',
      payment_note_id: mintId('pn'),
      buyer_did: this.deps.nodeDid(),
      supplier_did: args.supplierDid,
      amount: args.amount,
      method: args.method,
      ...(args.externalRef !== undefined ? { external_ref: args.externalRef } : {}),
      paid_at: isoNow(this.deps.now()),
      ...(args.orderRefs !== undefined ? { order_refs: args.orderRefs } : {}),
    };
    const note = { ...draft, note_digest: tradeRecordDigest('payment_note', draft, hash) } as PaymentNote;
    const shapeError = validatePaymentNote(note, hash);
    if (shapeError) return { ok: false, refusal: shapeError };

    this.deps.documents.put({
      recordDigest: note.note_digest,
      kind: 'payment_note',
      counterpartyDid: args.supplierDid,
      purchaseOrderId: '',
      answersDigest: '',
      direction: 'outbound',
      recordJson: JSON.stringify(note),
      evidenceJson: '{}',
      createdAt: this.deps.now(),
    });
    return { ok: true, document: note };
  }

  // -------------------------------------------------------------------------
  // The statement (§4.4) and the sweeps (§4.3)
  // -------------------------------------------------------------------------

  /**
   * The two numbers both sides can compute, plus the document counts a
   * statement screen renders. Fold input is assembled from retained,
   * re-validated documents only.
   */
  statement(args: {
    counterpartyDid: string;
    currency: string;
    /**
     * THIS node's side of the ledger being folded. §4.4 defines the fold
     * per orientation, so a dual-role pair (each supplies the other) is
     * TWO ledgers; merging them once produced a balance neither side's
     * documents backed.
     */
    role: 'buyer' | 'supplier';
  }): TradeFoldResult {
    const orders: FoldOrder[] = [];
    for (const purchaseOrderId of this.deps.listAcceptedOrderIds(args.counterpartyDid, args.role)) {
      const order = this.deps.readOrder(args.counterpartyDid, purchaseOrderId);
      const quote = this.deps.readBoundQuote(args.counterpartyDid, purchaseOrderId);
      if (order === null || quote === null) continue; // not priceable, sweeps elsewhere
      const quoteLines = new Map(quote.lines.map((line) => [line.line_id, line]));

      const receipted: FoldOrder['receipted'] = [];
      for (const receiptRow of this.deps.documents.listByOrder(purchaseOrderId, 'delivery_receipt')) {
        const receipt = rehydrateTradeDocument(receiptRow);
        if (receipt.kind !== 'delivery_receipt') continue;
        const noteRow = this.deps.documents.get(receipt.document.delivery_note_digest);
        if (noteRow === null) continue;
        const note = rehydrateTradeDocument(noteRow);
        if (note.kind !== 'delivery_note') continue;
        const noteLines = new Map(note.document.lines.map((line) => [line.line_id, line]));
        for (const line of receipt.document.lines) {
          const noteLine = noteLines.get(line.line_id);
          if (noteLine === undefined) continue;
          receipted.push({
            line_id: line.line_id,
            delivered_quantity: noteLine.delivered_quantity,
            accepted_quantity: line.accepted_quantity,
          });
        }
      }

      orders.push({
        purchase_order_id: purchaseOrderId,
        lines: order.accepted_lines.flatMap((line) => {
          const quoteLine = quoteLines.get(line.line_id);
          return quoteLine === undefined
            ? []
            : [
                {
                  line_id: line.line_id,
                  unit_price: quoteLine.unit_price,
                  price_basis: quoteLine.price_basis,
                  ordered_quantity: line.quantity,
                },
              ];
        }),
        charges: quote.charges,
        receipted,
      });
    }

    // Payments of THIS orientation only: as supplier, money this node
    // acknowledged receiving (outbound acks); as buyer, money the
    // counterparty acknowledged receiving from this node (inbound acks).
    // Unfiltered, a dual-role node's own purchase payments credited the
    // counterparty's debt on its supply ledger.
    const paymentDirection = args.role === 'supplier' ? 'outbound' : 'inbound';
    const payments: Money[] = [];
    for (const ackRow of this.deps.documents.listByCounterparty(args.counterpartyDid, 'payment_ack')) {
      if (ackRow.direction !== paymentDirection) continue;
      const ack = rehydrateTradeDocument(ackRow);
      if (ack.kind !== 'payment_ack' || ack.document.kind !== 'received') continue;
      if (ack.document.amount_received.currency !== args.currency) continue;
      payments.push(ack.document.amount_received);
    }

    return computeTradeFold({ currency: args.currency, orders, payments_received: payments });
  }

  /**
   * §4.5 — the relationship's derived due dates, from documents both
   * sides hold. A quote whose payment_terms names no `due_basis` derives
   * NO dues (guessing a clock would assert a due date nobody agreed to);
   * `from_delivery` prices each receipt's accepted value against the
   * bound quote through the SAME pricing the §6.5 gate uses.
   */
  dues(args: {
    counterpartyDid: string;
    currency: string;
    role: 'buyer' | 'supplier';
  }): {
    dues: (DerivedDue & { purchase_order_id: string })[];
  } {
    const out: (DerivedDue & { purchase_order_id: string })[] = [];
    for (const purchaseOrderId of this.deps.listAcceptedOrderIds(args.counterpartyDid, args.role)) {
      const order = this.deps.readOrder(args.counterpartyDid, purchaseOrderId);
      const quote = this.deps.readBoundQuote(args.counterpartyDid, purchaseOrderId);
      if (order === null || quote === null) continue;
      if (quote.total.currency !== args.currency) continue;
      const terms = quote.payment_terms;
      if (terms?.due_basis === undefined || terms.credit_days === undefined) continue;

      if (terms.due_basis === 'from_acceptance') {
        const acceptance = this.deps.readAcceptance(args.counterpartyDid, purchaseOrderId);
        if (acceptance === null) continue;
        const derived = deriveDues({
          currency: args.currency,
          credit_days: terms.credit_days,
          due_basis: 'from_acceptance',
          accepted_at: acceptance.acceptedAt,
          order_total_minor: order.approved_total.minor_units,
        });
        if (derived.value !== null) {
          out.push(...derived.value.map((due) => ({ ...due, purchase_order_id: purchaseOrderId })));
        }
        continue;
      }

      const receipted: { received_at: string; value_minor: string }[] = [];
      for (const receiptRow of this.deps.documents.listByOrder(purchaseOrderId, 'delivery_receipt')) {
        const receipt = rehydrateTradeDocument(receiptRow);
        if (receipt.kind !== 'delivery_receipt') continue;
        const priced = this.priceAcceptedLines(quote, receipt.document.lines);
        if (!priced.ok) continue; // unpriceable derives nothing, never guesses
        receipted.push({
          received_at: receipt.document.received_at,
          value_minor: priced.value.minor_units,
        });
      }
      const derived = deriveDues({
        currency: args.currency,
        credit_days: terms.credit_days,
        due_basis: 'from_delivery',
        receipted,
      });
      if (derived.value !== null) {
        out.push(...derived.value.map((due) => ({ ...due, purchase_order_id: purchaseOrderId })));
      }
    }
    return { dues: out };
  }

  /**
   * §4.3's sweeps: what this relationship is waiting on. Silence is
   * never agreement, in either direction — an unanswered document keeps
   * appearing here until its answer or its resolution.
   */
  unanswered(args: { counterpartyDid: string; olderThanMs: number }): {
    deliveryNotes: TradeDocumentRow[];
    paymentNotes: TradeDocumentRow[];
  } {
    const cutoff = this.deps.now() - args.olderThanMs;
    const pending = (kind: 'delivery_note' | 'payment_note', answerKind: 'delivery_receipt' | 'payment_ack') =>
      this.deps.documents
        .listByCounterparty(args.counterpartyDid, kind)
        .filter(
          (row) =>
            row.createdAt <= cutoff &&
            this.deps.documents.answersTo(row.recordDigest, answerKind).length === 0,
        );
    return {
      deliveryNotes: pending('delivery_note', 'delivery_receipt'),
      paymentNotes: pending('payment_note', 'payment_ack'),
    };
  }

}
