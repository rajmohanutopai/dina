/**
 * The khata keeps each relationship's books apart (docs/STATE_MACHINES.md
 * COM-2, COM-9, COM-10, COM-13). Real SQLite, real receipts store, real readers:
 * these faults live in the seams between them.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { tradeRecordDigest } from '@dina/commerce-protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { newBuyerOrder } from '../../src/commerce/buyer_reconciliation';
import { applyInboundBuyerResponse } from '../../src/commerce/buyer_response';
import { retainBuyerOrderAndQuote } from '../../src/commerce/buyer_retention';
import {
  createCommerceRuntime,
  installCommerceRuntime,
  type CommerceRuntime,
} from '../../src/commerce/runtime';
import { applyInboundTradeDocument } from '../../src/commerce/trade_ingress';
import {
  SQLiteTradeDocumentRepository,
  verifyInboundDeliveryReceipt,
} from '../../src/commerce/trade_ledger';
import { TradeLedgerService } from '../../src/commerce/trade_ledger_service';
import { tradeRelationshipReaders } from '../../src/commerce/trade_readers';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import { hash, makeAcknowledgement, makeOrder, makeQuoteRequest, makeSignedQuote } from './helpers';

const SUPPLIER = 'did:plc:supplierS';
const B1 = 'did:plc:buyerOne';
const B2 = 'did:plc:buyerTwo';

let dir: string;
let adapter: NodeSQLiteAdapter;
let runtime: CommerceRuntime;
let docs: SQLiteTradeDocumentRepository;

function seat(selfDid: string): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-khata-rel-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  docs = new SQLiteTradeDocumentRepository(adapter);
  runtime = createCommerceRuntime({
    adapter,
    supplierDid: () => selfDid,
    currentEpoch: () => '1',
    now: () => Date.now(),
  });
  runtime.money = () =>
    ({ available: true, stores: { tradeDocuments: docs } }) as unknown as ReturnType<
      CommerceRuntime['money']
    >;
  installCommerceRuntime(runtime);
}

afterEach(() => {
  installCommerceRuntime(null);
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fullOrder(
  buyer: string,
  supplier: string,
  po: string,
  unit = '500',
  currency = 'INR',
): {
  order: ReturnType<typeof makeOrder>;
  quote: ReturnType<typeof makeSignedQuote>;
  ack: ReturnType<typeof makeAcknowledgement>;
} {
  const request = makeQuoteRequest({ buyer_did: buyer, supplier_did: supplier } as never);
  const product = { scheme: 'gtin', value: '09506000134352' };
  const quote = makeSignedQuote(request, {
    quote_id: `q-${po}-${buyer.slice(-3)}`,
    valid_until: '2036-01-01T00:00:00.000Z',
    lines: [
      {
        line_id: 'l1',
        requested_product: product,
        offered_product: product,
        quantity: { value: '100', unit_code: 'each' },
        price_basis: { value: '1', unit_code: 'each' },
        unit_price: { currency, minor_units: unit },
        line_subtotal: { currency, minor_units: String(Number(unit) * 100) },
        stock_status: 'available',
      },
    ],
    total: { currency, minor_units: String(Number(unit) * 100) },
  } as never);
  const order = makeOrder(quote, request.delivery.projection, {
    purchase_order_id: po,
    idempotency_key: `idem-${po}-${buyer}`,
  });
  const ack = makeAcknowledgement({
    purchase_order_id: po,
    order_digest: order.order_digest,
    buyer_did: buyer,
    supplier_did: supplier,
    accepted_quote_digest: quote.quote_digest,
    acknowledgement_id: `ack-${po}-${buyer}`,
  } as never);
  return { order, quote, ack };
}

function retain(o: ReturnType<typeof fullOrder>): void {
  const buyer = o.order.buyer_did;
  const po = o.order.purchase_order_id;
  const put = (
    recordDigest: string,
    domain: 'quote' | 'order' | 'acknowledgement',
    record: unknown,
    purchaseOrderId: string,
    quoteId: string,
  ): void => {
    runtime.receipts.put({
      recordDigest,
      domain,
      buyerDid: buyer,
      quoteId,
      purchaseOrderId,
      recordJson: JSON.stringify(record),
      evidenceJson: '{}',
      createdAt: 1,
    });
  };
  put(o.quote.quote_digest, 'quote', o.quote, '', o.quote.quote_id);
  put(o.order.order_digest, 'order', o.order, po, o.quote.quote_id);
  put(o.ack.acknowledgement_digest, 'acknowledgement', o.ack, po, '');
}

const service = (self: string): TradeLedgerService =>
  new TradeLedgerService({
    documents: docs,
    nodeDid: () => self,
    now: () => Date.now(),
    ...tradeRelationshipReaders(runtime),
  });
const qty = (value: string): { value: string; unit_code: string } => ({ value, unit_code: 'each' });

function receiptFor(noteDigest: string, accepted: string): Record<string, unknown> {
  const draft = {
    protocol_version: '1.0',
    delivery_receipt_id: `dr-${noteDigest.slice(0, 6)}`,
    delivery_note_digest: noteDigest,
    lines: [{ line_id: 'l1', accepted_quantity: qty(accepted) }],
    received_at: new Date().toISOString(),
  };
  return { ...draft, receipt_digest: tradeRecordDigest('delivery_receipt', draft as never, hash) };
}

describe("COM-2: one buyer's documents stay on that buyer's books", () => {
  it('two buyers with one PO id: delivery and receipt to one leave the other untouched', () => {
    seat(SUPPLIER);
    retain(fullOrder(B1, SUPPLIER, 'po-1001'));
    retain(fullOrder(B2, SUPPLIER, 'po-1001'));
    const s = service(SUPPLIER);

    const toB2 = s.issueDeliveryNote({
      counterpartyDid: B2,
      purchaseOrderId: 'po-1001',
      supplierOrderId: 'so',
      lines: [{ line_id: 'l1', delivered_quantity: qty('60') }],
    });
    if (!toB2.ok) throw new Error(toB2.refusal);
    const verdict = verifyInboundDeliveryReceipt({
      senderDid: B2,
      selfDid: SUPPLIER,
      receipt: receiptFor(toB2.document.note_digest, '60'),
      repository: docs,
      readOrder: (po) => tradeRelationshipReaders(runtime).readOrder(B2, po, 'supplier'),
      evidenceJson: '{}',
      nowMs: Date.now(),
    });
    expect(verdict.outcome).toBe('applied');

    const b1 = s.statement({ counterpartyDid: B1, currency: 'INR', role: 'supplier' });
    if (!b1.ok) throw new Error(b1.error);
    expect(b1.balance.minor_units).toBe('0');
    const b2 = s.statement({ counterpartyDid: B2, currency: 'INR', role: 'supplier' });
    if (!b2.ok) throw new Error(b2.error);
    expect(b2.balance.minor_units).toBe('30000');

    // B1's own full delivery is not counted against B2's 60.
    const toB1 = s.issueDeliveryNote({
      counterpartyDid: B1,
      purchaseOrderId: 'po-1001',
      supplierOrderId: 'so',
      lines: [{ line_id: 'l1', delivered_quantity: qty('100') }],
    });
    expect(toB1.ok).toBe(true);
  });

  it('a receipt from a party the note was not sent to is refused, and does not store', () => {
    seat(SUPPLIER);
    retain(fullOrder(B1, SUPPLIER, 'po-1001'));
    retain(fullOrder(B2, SUPPLIER, 'po-1001'));
    const toB2 = service(SUPPLIER).issueDeliveryNote({
      counterpartyDid: B2,
      purchaseOrderId: 'po-1001',
      supplierOrderId: 'so',
      lines: [{ line_id: 'l1', delivered_quantity: qty('60') }],
    });
    if (!toB2.ok) throw new Error(toB2.refusal);
    const verdict = verifyInboundDeliveryReceipt({
      senderDid: B1,
      selfDid: SUPPLIER,
      receipt: receiptFor(toB2.document.note_digest, '60'),
      repository: docs,
      readOrder: (po) => tradeRelationshipReaders(runtime).readOrder(B1, po, 'supplier'),
      evidenceJson: '{}',
      nowMs: Date.now(),
    });
    expect(verdict.outcome).toBe('not_ours');
    expect(docs.listByOrder(B1, 'po-1001', 'delivery_receipt')).toHaveLength(0);
    expect(docs.listByOrder(B2, 'po-1001', 'delivery_receipt')).toHaveLength(0);
  });

  it('a dual-role pair who picked one PO id: each order is read by its own side', () => {
    const ME = 'did:plc:mememe';
    const THEM = 'did:plc:themthem';
    seat(ME);
    const mine = fullOrder(ME, THEM, 'po-shared', '900');
    const theirs = fullOrder(THEM, ME, 'po-shared', '100');
    retain(mine);
    retain(theirs);
    const readers = tradeRelationshipReaders(runtime);
    expect(readers.readOrder(THEM, 'po-shared', 'supplier')?.buyer_did).toBe(THEM);
    expect(readers.readOrder(THEM, 'po-shared', 'buyer')?.buyer_did).toBe(ME);
    expect(readers.readBoundQuote(THEM, 'po-shared', 'supplier')?.quote_digest).toBe(
      theirs.quote.quote_digest,
    );

    const s = service(ME);
    const note = s.issueDeliveryNote({
      counterpartyDid: THEM,
      purchaseOrderId: 'po-shared',
      supplierOrderId: 'so',
      lines: [{ line_id: 'l1', delivered_quantity: qty('100') }],
    });
    if (!note.ok) throw new Error(note.refusal);

    // Their note on MY purchase counts against my purchase, not my supply.
    const draft = {
      protocol_version: '1.0',
      delivery_note_id: 'dn-in',
      purchase_order_id: 'po-shared',
      order_digest: mine.order.order_digest,
      supplier_order_id: 'so',
      lines: [{ line_id: 'l1', delivered_quantity: qty('100') }],
      dispatched_at: new Date().toISOString(),
    };
    const inbound = {
      ...draft,
      note_digest: tradeRecordDigest('delivery_note', draft as never, hash),
    };
    const verdict = applyInboundTradeDocument({
      senderDid: THEM,
      body: { kind: 'delivery_note', document: inbound },
      evidenceJson: '{}',
      nowMs: Date.now(),
    });
    expect(verdict.outcome).toBe('applied');

    // One receipt, on my supply side: my purchase balance stays settled.
    const supplyReceipt = verifyInboundDeliveryReceipt({
      senderDid: THEM,
      selfDid: ME,
      receipt: receiptFor(note.document.note_digest, '100'),
      repository: docs,
      readOrder: (po) => readers.readOrder(THEM, po, 'supplier'),
      evidenceJson: '{}',
      nowMs: Date.now(),
    });
    expect(supplyReceipt.outcome).toBe('applied');
    const buying = s.statement({ counterpartyDid: THEM, currency: 'INR', role: 'buyer' });
    if (!buying.ok) throw new Error(buying.error);
    expect(buying.balance.minor_units).toBe('0');
    const supplying = s.statement({ counterpartyDid: THEM, currency: 'INR', role: 'supplier' });
    if (!supplying.ok) throw new Error(supplying.error);
    expect(supplying.balance.minor_units).toBe('10000');
  });

  it('a buyer who used one PO id with two suppliers reads each order from its own supplier', () => {
    const OTHER = 'did:plc:supplierT';
    seat(B1);
    const fromS = fullOrder(B1, SUPPLIER, 'po-7', '500');
    const fromT = fullOrder(B1, OTHER, 'po-7', '600');
    retain(fromS);
    retain(fromT);
    const readers = tradeRelationshipReaders(runtime);
    expect(readers.readOrder(SUPPLIER, 'po-7', 'buyer')?.order_digest).toBe(
      fromS.order.order_digest,
    );
    expect(readers.readOrder(OTHER, 'po-7', 'buyer')?.order_digest).toBe(fromT.order.order_digest);
    expect(readers.readBoundQuote(OTHER, 'po-7', 'buyer')?.quote_digest).toBe(
      fromT.quote.quote_digest,
    );
  });
});

describe('COM-10: authoring is idempotent', () => {
  const amount = { currency: 'INR', minor_units: '100' };

  it('a payment note: same key, one document', () => {
    seat(B1);
    const s = service(B1);
    const args = { supplierDid: SUPPLIER, amount, method: 'upi' as const, idempotencyKey: 'tap-1' };
    const a = s.issuePaymentNote(args);
    const b = s.issuePaymentNote(args);
    if (!a.ok || !b.ok) throw new Error('refused');
    expect(b.document.note_digest).toBe(a.document.note_digest);
    expect(b.replayed).toBe(true);
    expect(docs.listByCounterparty(SUPPLIER, 'payment_note')).toHaveLength(1);
  });

  it('a payment note: the same external ref is one payment, with or without a key', () => {
    seat(B1);
    const s = service(B1);
    const args = { supplierDid: SUPPLIER, amount, method: 'upi' as const, externalRef: 'UTR-1' };
    const a = s.issuePaymentNote(args);
    const b = s.issuePaymentNote(args);
    if (!a.ok || !b.ok) throw new Error('refused');
    expect(b.document.note_digest).toBe(a.document.note_digest);
    expect(docs.listByCounterparty(SUPPLIER, 'payment_note')).toHaveLength(1);
    // Another amount under that ref is a mistake to show, not a second payment.
    const c = s.issuePaymentNote({
      ...args,
      amount: { currency: 'INR', minor_units: '200' },
    });
    expect(c.ok).toBe(false);
    // The ref belongs to one relationship: another supplier may carry it.
    expect(s.issuePaymentNote({ ...args, supplierDid: 'did:plc:other' }).ok).toBe(true);
  });

  it('with no key and no ref, two notes stay two (a person can pay twice)', () => {
    seat(B1);
    const s = service(B1);
    s.issuePaymentNote({ supplierDid: SUPPLIER, amount, method: 'upi' });
    s.issuePaymentNote({ supplierDid: SUPPLIER, amount, method: 'upi' });
    expect(docs.listByCounterparty(SUPPLIER, 'payment_note')).toHaveLength(2);
  });

  it('a delivery receipt: same key returns the first receipt', () => {
    seat(B1);
    const o = fullOrder(B1, SUPPLIER, 'po-rc');
    retain(o);
    const draft = {
      protocol_version: '1.0',
      delivery_note_id: 'dn-rc',
      purchase_order_id: 'po-rc',
      order_digest: o.order.order_digest,
      supplier_order_id: 'so',
      lines: [{ line_id: 'l1', delivered_quantity: qty('10') }],
      dispatched_at: new Date().toISOString(),
    };
    const note = {
      ...draft,
      note_digest: tradeRecordDigest('delivery_note', draft as never, hash),
    };
    expect(
      applyInboundTradeDocument({
        senderDid: SUPPLIER,
        body: { kind: 'delivery_note', document: note },
        evidenceJson: '{}',
        nowMs: Date.now(),
      }).outcome,
    ).toBe('applied');
    const s = service(B1);
    const args = {
      deliveryNoteDigest: note.note_digest,
      lines: [{ line_id: 'l1', accepted_quantity: qty('10') }],
      idempotencyKey: 'tap-r',
    };
    const a = s.issueDeliveryReceipt(args);
    const b = s.issueDeliveryReceipt(args);
    if (!a.ok || !b.ok) throw new Error('refused');
    expect(b.document.receipt_digest).toBe(a.document.receipt_digest);
    expect(docs.listByOrder(SUPPLIER, 'po-rc', 'delivery_receipt')).toHaveLength(1);
  });

  it('the key travels with the document: a fresh repository reads it back', () => {
    seat(B1);
    const s = service(B1);
    const args = { supplierDid: SUPPLIER, amount, method: 'upi' as const, idempotencyKey: 'tap-1' };
    const a = s.issuePaymentNote(args);
    if (!a.ok) throw new Error('refused');
    const fresh = new SQLiteTradeDocumentRepository(adapter);
    expect(fresh.getByAuthoringKey('payment_note', 'tap-1')?.recordDigest).toBe(
      a.document.note_digest,
    );
  });
});

describe('COM-9: one order in another currency', () => {
  it('each currency folds its own orders', () => {
    seat(SUPPLIER);
    retain(fullOrder(B1, SUPPLIER, 'po-inr', '500', 'INR'));
    retain(fullOrder(B1, SUPPLIER, 'po-usd', '700', 'USD'));
    const s = service(SUPPLIER);
    const inr = s.statement({ counterpartyDid: B1, currency: 'INR', role: 'supplier' });
    if (!inr.ok) throw new Error(inr.error);
    expect(inr.balance).toMatchObject({ direction: 'settled', minor_units: '0' });
    const usd = s.statement({ counterpartyDid: B1, currency: 'USD', role: 'supplier' });
    if (!usd.ok) throw new Error(usd.error);
    expect(usd.balance).toMatchObject({ direction: 'settled', minor_units: '0' });
  });
});

describe('COM-13: a delivery note on an order the supplier rejected', () => {
  it('a live buyer refuses it', () => {
    seat(B1);
    const o = fullOrder(B1, SUPPLIER, 'po-rej');
    retainBuyerOrderAndQuote(runtime, o.order, o.quote, Date.now());
    runtime.buyerOrders.create(
      SUPPLIER,
      newBuyerOrder('po-rej', {
        orderDigest: o.order.order_digest,
        idempotencyKey: o.order.idempotency_key,
        quoteDigest: o.order.quote_digest,
        quoteId: o.order.quote_id,
        buyerDid: B1,
        supplierDid: SUPPLIER,
        protocolVersion: '1.0',
        serviceRkey: 'self',
        orderLines: o.order.accepted_lines,
      }),
    );
    const rejected = makeAcknowledgement({
      purchase_order_id: 'po-rej',
      order_digest: o.order.order_digest,
      buyer_did: B1,
      supplier_did: SUPPLIER,
      kind: 'rejected',
      reason_code: 'out_of_stock',
    } as never);
    applyInboundBuyerResponse({
      supplierDid: SUPPLIER,
      response: {
        capability: 'submit_order',
        query_id: 'po-rej',
        status: 'success',
        result: rejected,
      },
      nowMs: Date.now(),
    } as never);
    expect(runtime.buyerOrders.get(SUPPLIER, 'po-rej')?.state).toBe('rejected');

    const draft = {
      protocol_version: '1.0',
      delivery_note_id: 'dn-x',
      purchase_order_id: 'po-rej',
      order_digest: o.order.order_digest,
      supplier_order_id: 'so',
      lines: [{ line_id: 'l1', delivered_quantity: qty('10') }],
      dispatched_at: new Date().toISOString(),
    };
    const note = {
      ...draft,
      note_digest: tradeRecordDigest('delivery_note', draft as never, hash),
    };
    const verdict = applyInboundTradeDocument({
      senderDid: SUPPLIER,
      body: { kind: 'delivery_note', document: note },
      evidenceJson: '{}',
      nowMs: Date.now(),
    });
    expect(verdict.outcome).toBe('refused');
    expect((verdict as { detail?: string }).detail).toContain('rejected');
  });
});
