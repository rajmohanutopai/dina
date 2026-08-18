/**
 * The khata service (TRADE_FIRST_STRATEGY §4.2–§4.4): authoring runs
 * the receiver's rules on itself, the statement is the fold, and the
 * PROOF AT THE CENTRE of the whole design — two nodes exchanging the
 * five documents compute IDENTICAL balances from their own stores.
 */

import { createHash } from 'node:crypto';

import {
  tradeRecordDigest,
  type PurchaseOrderProposal,
  type QuoteRequest,
  type Sha256Fn,
  type SignedQuote,
} from '@dina/commerce-protocol';

import {
  InMemoryTradeDocumentRepository,
  verifyInboundDeliveryNote,
  verifyInboundDeliveryReceipt,
  verifyInboundPaymentAck,
  verifyInboundPaymentNote,
  verifyInboundQuoteDecline,
} from '../../src/commerce/trade_ledger';
import { TradeLedgerService } from '../../src/commerce/trade_ledger_service';

const hash: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());

const BUYER = 'did:plc:khatabuyer000000000000000';
const SUPPLIER = 'did:plc:khatasupplier0000000000000';
const T0 = 1_800_000_000_000;

/** Fields the service and verifiers consume; route layer feeds real ones. */
const ORDER = {
  protocol_version: '1.0',
  purchase_order_id: 'po-1',
  buyer_did: BUYER,
  supplier_did: SUPPLIER,
  order_digest: 'd'.repeat(64),
  approved_total: { currency: 'INR', minor_units: '522500' },
  accepted_lines: [
    {
      line_id: 'line-1',
      product: { scheme: 'custom', value: 'CHAIR', issuer_did: SUPPLIER },
      quantity: { value: '10', unit_code: 'each' },
    },
  ],
} as unknown as PurchaseOrderProposal;

/** The bound quote revision: ₹450.00/chair, freight ₹500, 5% tax. */
const QUOTE = {
  lines: [
    {
      line_id: 'line-1',
      unit_price: { currency: 'INR', minor_units: '45000' },
      price_basis: { value: '1', unit_code: 'each' },
      quantity: { value: '10', unit_code: 'each' },
    },
  ],
  charges: [
    { kind: 'delivery', label: 'freight', amount: { currency: 'INR', minor_units: '50000' }, operation: 'add' },
    { kind: 'tax', label: 'gst', amount: { currency: 'INR', minor_units: '22500' }, operation: 'add' },
  ],
  total: { currency: 'INR', minor_units: '522500' },
  payment_terms: { credit_days: 30, due_basis: 'from_delivery' },
} as unknown as SignedQuote;

function makeSide(did: string): {
  service: TradeLedgerService;
  repo: InMemoryTradeDocumentRepository;
} {
  const repo = new InMemoryTradeDocumentRepository();
  const service = new TradeLedgerService({
    documents: repo,
    nodeDid: () => did,
    now: () => T0,
    readOrder: (_counterparty, id) => (id === 'po-1' ? ORDER : null),
    readAcceptance: (_counterparty, id) =>
      id === 'po-1' ? { acceptedAt: '2026-08-07T13:00:00.000Z' } : null,
    readBoundQuote: (_counterparty, id) => (id === 'po-1' ? QUOTE : null),
    listAcceptedOrderIds: (counterparty) =>
      counterparty === (did === BUYER ? SUPPLIER : BUYER) ? ['po-1'] : [],
  });
  return { service, repo };
}

describe('authoring runs the receiver rules on itself', () => {
  it('a note over the order quantity refuses at issue, before anything stores', () => {
    const { service, repo } = makeSide(SUPPLIER);
    const over = service.issueDeliveryNote({
      counterpartyDid: BUYER,
      purchaseOrderId: 'po-1',
      supplierOrderId: 'so-1',
      lines: [{ line_id: 'line-1', delivered_quantity: { value: '11', unit_code: 'each' } }],
    });
    expect(over.ok).toBe(false);
    expect(!over.ok && over.refusal).toContain('cumulative');
    expect(repo.listByOrder('po-1', 'delivery_note')).toHaveLength(0);
  });

  it('two notes 6 then 5 refuse at the SECOND issue — own retained set counts', () => {
    const { service } = makeSide(SUPPLIER);
    const first = service.issueDeliveryNote({
      counterpartyDid: BUYER,
      purchaseOrderId: 'po-1',
      supplierOrderId: 'so-1',
      lines: [{ line_id: 'line-1', delivered_quantity: { value: '6', unit_code: 'each' } }],
    });
    expect(first.ok).toBe(true);
    const second = service.issueDeliveryNote({
      counterpartyDid: BUYER,
      purchaseOrderId: 'po-1',
      supplierOrderId: 'so-1',
      lines: [{ line_id: 'line-1', delivered_quantity: { value: '5', unit_code: 'each' } }],
    });
    expect(!second.ok && second.refusal).toContain('cumulative');
  });

  it('only the order supplier may issue a note; only the order buyer may receipt one', () => {
    const { service: buyerService } = makeSide(BUYER);
    const wrongSide = buyerService.issueDeliveryNote({
      counterpartyDid: BUYER,
      purchaseOrderId: 'po-1',
      supplierOrderId: 'so-1',
      lines: [{ line_id: 'line-1', delivered_quantity: { value: '1', unit_code: 'each' } }],
    });
    expect(!wrongSide.ok && wrongSide.refusal).toContain('not the order supplier');
  });

  it('a second acknowledgement of one payment note refuses — first answer stands', () => {
    const { service, repo } = makeSide(SUPPLIER);
    const paymentNote = {
      protocol_version: '1.0',
      payment_note_id: 'pn-1',
      buyer_did: BUYER,
      supplier_did: SUPPLIER,
      amount: { currency: 'INR', minor_units: '100000' },
      method: 'cash',
      paid_at: '2026-08-17T13:00:00.000Z',
    };
    const sealed = {
      ...paymentNote,
      note_digest: tradeRecordDigest('payment_note', paymentNote, hash),
    };
    repo.put({
      recordDigest: sealed.note_digest,
      kind: 'payment_note',
      counterpartyDid: BUYER,
      purchaseOrderId: '',
      answersDigest: '',
      direction: 'inbound',
      recordJson: JSON.stringify(sealed),
      evidenceJson: '{}',
      createdAt: T0,
    });
    const first = service.acknowledgePayment({
      paymentNoteDigest: sealed.note_digest,
      kind: 'received',
      amountReceived: { currency: 'INR', minor_units: '100000' },
    });
    expect(first.ok).toBe(true);
    const second = service.acknowledgePayment({
      paymentNoteDigest: sealed.note_digest,
      kind: 'disputed',
    });
    expect(!second.ok && second.refusal).toContain('first answer stands');
  });

  it('declineQuote refuses a second decline for one request', () => {
    const { service } = makeSide(SUPPLIER);
    const request = {
      protocol_version: '1.0',
      request_id: 'req-1',
      request_digest: 'e'.repeat(64),
      buyer_did: BUYER,
      supplier_did: SUPPLIER,
    } as unknown as QuoteRequest;
    expect(service.declineQuote({ request, reasonCode: 'capacity' }).ok).toBe(true);
    const second = service.declineQuote({ request, reasonCode: 'policy' });
    expect(!second.ok && second.refusal).toContain('already has a decline');
  });
});

describe('the two-node journey — both sides fold to IDENTICAL numbers', () => {
  it('note → receipt (short) → payment → partial ack, exchanged over the verifiers', () => {
    const supplier = makeSide(SUPPLIER);
    const buyer = makeSide(BUYER);

    // Supplier dispatches 10; the document crosses to the buyer.
    const note = supplier.service.issueDeliveryNote({
      counterpartyDid: BUYER,
      purchaseOrderId: 'po-1',
      supplierOrderId: 'so-1',
      lines: [{ line_id: 'line-1', delivered_quantity: { value: '10', unit_code: 'each' } }],
    });
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    expect(
      verifyInboundDeliveryNote({
        senderDid: SUPPLIER,
        selfDid: BUYER,
        note: note.document,
        repository: buyer.repo,
        readOrder: (id) => (id === 'po-1' ? ORDER : null),
        evidenceJson: '{}',
        nowMs: T0,
      }).outcome,
    ).toBe('applied');

    // Buyer accepts 7 (3 damaged); the receipt crosses back.
    const receipt = buyer.service.issueDeliveryReceipt({
      deliveryNoteDigest: note.document.note_digest,
      lines: [
        {
          line_id: 'line-1',
          accepted_quantity: { value: '7', unit_code: 'each' },
          reason_code: 'damaged',
        },
      ],
    });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(
      verifyInboundDeliveryReceipt({
        senderDid: BUYER,
        selfDid: SUPPLIER,
        receipt: receipt.document,
        repository: supplier.repo,
        readOrder: (id) => (id === 'po-1' ? ORDER : null),
        evidenceJson: '{}',
        nowMs: T0,
      }).outcome,
    ).toBe('applied');

    // Buyer pays ₹2,000 on account; the note crosses; supplier credits
    // ₹1,500 of it (partial — visible, never inferred).
    const payment = buyer.service.issuePaymentNote({
      supplierDid: SUPPLIER,
      amount: { currency: 'INR', minor_units: '200000' },
      method: 'upi',
      externalRef: 'upi-42',
    });
    expect(payment.ok).toBe(true);
    if (!payment.ok) return;
    expect(
      verifyInboundPaymentNote({
        senderDid: BUYER,
        selfDid: SUPPLIER,
        note: payment.document,
        repository: supplier.repo,
        evidenceJson: '{}',
        nowMs: T0,
      }).outcome,
    ).toBe('applied');
    const ack = supplier.service.acknowledgePayment({
      paymentNoteDigest: payment.document.note_digest,
      kind: 'received',
      amountReceived: { currency: 'INR', minor_units: '150000' },
    });
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    expect(
      verifyInboundPaymentAck({
        senderDid: SUPPLIER,
        selfDid: BUYER,
        ack: ack.document,
        repository: buyer.repo,
        evidenceJson: '{}',
        nowMs: T0,
      }).outcome,
    ).toBe('applied');

    // THE claim: both statements are byte-identical.
    // goods = 7×45000 = 315000; delivery 50000 full; tax 22500×0.7 = 15750
    // → owed 380750; payments 150000 → buyer_owes 230750; disputed 135000.
    const buyerStatement = buyer.service.statement({
      counterpartyDid: SUPPLIER,
      currency: 'INR',
      role: 'buyer',
    });
    const supplierStatement = supplier.service.statement({
      counterpartyDid: BUYER,
      currency: 'INR',
      role: 'supplier',
    });
    expect(buyerStatement).toEqual(supplierStatement);
    expect(buyerStatement.ok && buyerStatement.goods_owed_minor).toBe('380750');
    expect(buyerStatement.ok && buyerStatement.balance).toEqual({
      direction: 'buyer_owes',
      minor_units: '230750',
    });
    expect(buyerStatement.ok && buyerStatement.disputed_minor).toBe('135000');
  });

  it('unanswered sweeps: an unreceipted note and an unacked payment appear, answers clear them', () => {
    const supplier = makeSide(SUPPLIER);
    const note = supplier.service.issueDeliveryNote({
      counterpartyDid: BUYER,
      purchaseOrderId: 'po-1',
      supplierOrderId: 'so-1',
      lines: [{ line_id: 'line-1', delivered_quantity: { value: '2', unit_code: 'each' } }],
    });
    expect(note.ok).toBe(true);
    const before = supplier.service.unanswered({ counterpartyDid: BUYER, olderThanMs: 0 });
    expect(before.deliveryNotes).toHaveLength(1);
    expect(before.paymentNotes).toHaveLength(0);

    // The buyer's receipt arrives; the sweep clears.
    if (!note.ok) return;
    const buyer = makeSide(BUYER);
    expect(
      verifyInboundDeliveryNote({
        senderDid: SUPPLIER,
        selfDid: BUYER,
        note: note.document,
        repository: buyer.repo,
        readOrder: (id) => (id === 'po-1' ? ORDER : null),
        evidenceJson: '{}',
        nowMs: T0,
      }).outcome,
    ).toBe('applied');
    const receipt = buyer.service.issueDeliveryReceipt({
      deliveryNoteDigest: note.document.note_digest,
      lines: [{ line_id: 'line-1', accepted_quantity: { value: '2', unit_code: 'each' } }],
    });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(
      verifyInboundDeliveryReceipt({
        senderDid: BUYER,
        selfDid: SUPPLIER,
        receipt: receipt.document,
        repository: supplier.repo,
        readOrder: (id) => (id === 'po-1' ? ORDER : null),
        evidenceJson: '{}',
        nowMs: T0,
      }).outcome,
    ).toBe('applied');
    const after = supplier.service.unanswered({ counterpartyDid: BUYER, olderThanMs: 0 });
    expect(after.deliveryNotes).toHaveLength(0);
  });

  it('a decline authored by the supplier verifies at the buyer', () => {
    const supplier = makeSide(SUPPLIER);
    const request = {
      protocol_version: '1.0',
      request_id: 'req-1',
      request_digest: 'e'.repeat(64),
      buyer_did: BUYER,
      supplier_did: SUPPLIER,
    } as unknown as QuoteRequest;
    const decline = supplier.service.declineQuote({ request, reasonCode: 'out_of_region' });
    expect(decline.ok).toBe(true);
    if (!decline.ok) return;
    const buyer = makeSide(BUYER);
    expect(
      verifyInboundQuoteDecline({
        senderDid: SUPPLIER,
        selfDid: BUYER,
        decline: decline.document,
        repository: buyer.repo,
        readRequest: (id) => (id === 'req-1' ? request : null),
        evidenceJson: '{}',
        nowMs: T0,
      }).outcome,
    ).toBe('applied');
  });
});

describe('derived dues (§4.5)', () => {
  it('from_delivery: each receipted portion runs its own clock at its own value', () => {
    const supplier = makeSide(SUPPLIER);
    const buyer = makeSide(BUYER);

    // Two dispatches, two receipts: 6 accepted, then 3 of 4 accepted.
    const firstNote = supplier.service.issueDeliveryNote({
      counterpartyDid: BUYER,
      purchaseOrderId: 'po-1',
      supplierOrderId: 'so-1',
      lines: [{ line_id: 'line-1', delivered_quantity: { value: '6', unit_code: 'each' } }],
    });
    if (!firstNote.ok) throw new Error(firstNote.refusal);
    expect(
      verifyInboundDeliveryNote({
        senderDid: SUPPLIER,
        selfDid: BUYER,
        note: firstNote.document,
        repository: buyer.repo,
        readOrder: (id) => (id === 'po-1' ? ORDER : null),
        evidenceJson: '{}',
        nowMs: T0,
      }).outcome,
    ).toBe('applied');
    const firstReceipt = buyer.service.issueDeliveryReceipt({
      deliveryNoteDigest: firstNote.document.note_digest,
      lines: [{ line_id: 'line-1', accepted_quantity: { value: '6', unit_code: 'each' } }],
    });
    if (!firstReceipt.ok) throw new Error(firstReceipt.refusal);
    expect(
      verifyInboundDeliveryReceipt({
        senderDid: BUYER,
        selfDid: SUPPLIER,
        receipt: firstReceipt.document,
        repository: supplier.repo,
        readOrder: (id) => (id === 'po-1' ? ORDER : null),
        evidenceJson: '{}',
        nowMs: T0,
      }).outcome,
    ).toBe('applied');

    // BOTH sides derive the same due from the same documents.
    const supplierDues = supplier.service.dues({
      counterpartyDid: BUYER,
      currency: 'INR',
      role: 'supplier',
    });
    const buyerDues = buyer.service.dues({ counterpartyDid: SUPPLIER, currency: 'INR', role: 'buyer' });
    expect(supplierDues).toEqual(buyerDues);
    expect(supplierDues.dues).toEqual([
      {
        purchase_order_id: 'po-1',
        basis: 'from_delivery',
        // received_at = T0's ISO instant; + 30 days.
        due_at: new Date(T0 + 30 * 24 * 60 * 60 * 1000).toISOString(),
        amount: { currency: 'INR', minor_units: '270000' }, // 6 × 45000
      },
    ]);
  });

  it('a quote naming no due_basis derives NO dues — a clock is never guessed', () => {
    const repo = new InMemoryTradeDocumentRepository();
    const service = new TradeLedgerService({
      documents: repo,
      nodeDid: () => SUPPLIER,
      now: () => T0,
      readOrder: (_c, id) => (id === 'po-1' ? ORDER : null),
      readBoundQuote: (_c, id) =>
        id === 'po-1'
          ? ({ ...(QUOTE as unknown as Record<string, unknown>), payment_terms: { credit_days: 30 } } as never)
          : null,
      listAcceptedOrderIds: () => ['po-1'],
      readAcceptance: () => ({ acceptedAt: '2026-08-07T13:00:00.000Z' }),
    });
    expect(service.dues({ counterpartyDid: BUYER, currency: 'INR', role: 'supplier' }).dues).toEqual([]);
  });

  it('from_acceptance: one clock from the acknowledgement for the whole order', () => {
    const repo = new InMemoryTradeDocumentRepository();
    const service = new TradeLedgerService({
      documents: repo,
      nodeDid: () => SUPPLIER,
      now: () => T0,
      readOrder: (_c, id) => (id === 'po-1' ? ORDER : null),
      readBoundQuote: (_c, id) =>
        id === 'po-1'
          ? ({
              ...(QUOTE as unknown as Record<string, unknown>),
              payment_terms: { credit_days: 15, due_basis: 'from_acceptance' },
            } as never)
          : null,
      listAcceptedOrderIds: () => ['po-1'],
      readAcceptance: (_c, id) =>
        id === 'po-1' ? { acceptedAt: '2026-08-07T13:00:00.000Z' } : null,
    });
    expect(service.dues({ counterpartyDid: BUYER, currency: 'INR', role: 'supplier' }).dues).toEqual([
      {
        purchase_order_id: 'po-1',
        basis: 'from_acceptance',
        due_at: '2026-08-22T13:00:00.000Z',
        amount: { currency: 'INR', minor_units: '522500' },
      },
    ]);
  });
});
