/**
 * The trade-document ledger (TRADE_FIRST_STRATEGY §4.2/§4.3): store
 * discipline (digest idempotency, verified-on-read), the inbound
 * verifiers' binding rules, the CUMULATIVE over-delivery check, and the
 * one-answer rule. One test body runs against real SQLite AND the
 * in-memory double, so the double cannot be quietly more permissive.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  tradeRecordDigest,
  type DeliveryNote,
  type DeliveryReceipt,
  type PaymentAcknowledgement,
  type PaymentNote,
  type PurchaseOrderProposal,
  type QuoteDecline,
  type QuoteRequest,
  type Sha256Fn,
} from '@dina/commerce-protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';


import {
  InMemoryTradeDocumentRepository,
  SQLiteTradeDocumentRepository,
  TradeLedgerIntegrityError,
  verifyInboundDeliveryNote,
  verifyInboundDeliveryReceipt,
  verifyInboundPaymentAck,
  verifyInboundPaymentNote,
  verifyInboundQuoteDecline,
  type TradeDocumentRepository,
} from '../../src/commerce/trade_ledger';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const hash: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());

const BUYER = 'did:plc:tradebuyer000000000000000';
const SUPPLIER = 'did:plc:tradesupplier0000000000000';
const T0 = 1_800_000_000_000;

/**
 * The verifiers read only the named fields of the retained order; this
 * fixture carries exactly those. The route layer feeds REAL validated
 * orders — this is the injected-reader contract, not a wire admission.
 */
function retainedOrder(overrides: Partial<PurchaseOrderProposal> = {}): PurchaseOrderProposal {
  return {
    protocol_version: '1.0',
    purchase_order_id: 'po-1',
    buyer_did: BUYER,
    supplier_did: SUPPLIER,
    order_digest: 'd'.repeat(64),
    accepted_lines: [
      { line_id: 'line-1', product: { scheme: 'custom', value: 'CHAIR', issuer_did: SUPPLIER }, quantity: { value: '10', unit_code: 'each' } },
    ],
    ...overrides,
  } as PurchaseOrderProposal;
}

function sealedNote(overrides: Partial<DeliveryNote> = {}): DeliveryNote {
  const draft = {
    protocol_version: '1.0',
    delivery_note_id: `dn-${randomBytes(4).toString('hex')}`,
    purchase_order_id: 'po-1',
    order_digest: 'd'.repeat(64),
    supplier_order_id: 'so-1',
    lines: [{ line_id: 'line-1', delivered_quantity: { value: '6', unit_code: 'each' } }],
    dispatched_at: '2026-08-17T09:00:00.000Z',
    ...overrides,
  };
  return { ...draft, note_digest: tradeRecordDigest('delivery_note', draft, hash) } as DeliveryNote;
}

function sealedReceipt(note: DeliveryNote, overrides: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
  const draft = {
    protocol_version: note.protocol_version,
    delivery_receipt_id: `dr-${randomBytes(4).toString('hex')}`,
    delivery_note_digest: note.note_digest,
    lines: note.lines.map((line) => ({
      line_id: line.line_id,
      accepted_quantity: line.delivered_quantity,
    })),
    received_at: '2026-08-17T12:00:00.000Z',
    ...overrides,
  };
  return {
    ...draft,
    receipt_digest: tradeRecordDigest('delivery_receipt', draft, hash),
  } as DeliveryReceipt;
}

function sealedPaymentNote(overrides: Partial<PaymentNote> = {}): PaymentNote {
  const draft = {
    protocol_version: '1.0',
    payment_note_id: `pn-${randomBytes(4).toString('hex')}`,
    buyer_did: BUYER,
    supplier_did: SUPPLIER,
    amount: { currency: 'INR', minor_units: '500000' },
    method: 'upi',
    paid_at: '2026-08-17T13:00:00.000Z',
    ...overrides,
  };
  return { ...draft, note_digest: tradeRecordDigest('payment_note', draft, hash) } as PaymentNote;
}

function sealedAck(
  note: PaymentNote,
  overrides: Partial<Record<string, unknown>> = {},
): PaymentAcknowledgement {
  const draft = {
    protocol_version: note.protocol_version,
    payment_ack_id: `pa-${randomBytes(4).toString('hex')}`,
    payment_note_digest: note.note_digest,
    kind: 'received',
    amount_received: { ...note.amount },
    acknowledged_at: '2026-08-17T14:00:00.000Z',
    ...overrides,
  };
  return {
    ...draft,
    ack_digest: tradeRecordDigest('payment_ack', draft, hash),
  } as unknown as PaymentAcknowledgement;
}

function sealedDecline(overrides: Partial<QuoteDecline> = {}): QuoteDecline {
  const draft = {
    protocol_version: '1.0',
    decline_id: `dec-${randomBytes(4).toString('hex')}`,
    request_id: 'req-1',
    request_digest: 'e'.repeat(64),
    buyer_did: BUYER,
    supplier_did: SUPPLIER,
    reason_code: 'capacity',
    issued_at: '2026-08-17T10:00:00.000Z',
    ...overrides,
  };
  return { ...draft, decline_digest: tradeRecordDigest('quote_decline', draft, hash) } as QuoteDecline;
}

const retainedRequest = {
  protocol_version: '1.0',
  request_id: 'req-1',
  request_digest: 'e'.repeat(64),
  buyer_did: BUYER,
  supplier_did: SUPPLIER,
} as unknown as QuoteRequest;

// ---------------------------------------------------------------------------
// Both backends, one body
// ---------------------------------------------------------------------------

interface Backend {
  name: string;
  make: () => { repo: TradeDocumentRepository; close: () => void };
}

const backends: Backend[] = [
  {
    name: 'sqlite',
    make: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-trade-ledger-'));
      const adapter = new NodeSQLiteAdapter({
        path: path.join(dir, 'identity.sqlite'),
        passphraseHex: randomBytes(32).toString('hex'),
        journalMode: 'WAL',
        synchronous: 'NORMAL',
      });
      applyMigrations(adapter, IDENTITY_MIGRATIONS);
      return {
        repo: new SQLiteTradeDocumentRepository(adapter),
        close: () => {
          adapter.close();
          fs.rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: 'memory',
    make: () => ({ repo: new InMemoryTradeDocumentRepository(), close: () => undefined }),
  },
];

describe.each(backends)('trade ledger ($name)', ({ make }) => {
  let repo: TradeDocumentRepository;
  let close: () => void;

  beforeEach(() => {
    ({ repo, close } = make());
  });
  afterEach(() => close());

  const ingestNote = (note: DeliveryNote, extra: Partial<Parameters<typeof verifyInboundDeliveryNote>[0]> = {}) =>
    verifyInboundDeliveryNote({
      senderDid: SUPPLIER,
      selfDid: BUYER,
      note,
      repository: repo,
      readOrder: (id) => (id === 'po-1' ? retainedOrder() : null),
      evidenceJson: '{}',
      nowMs: T0,
      ...extra,
    });

  describe('inbound DeliveryNote (at the buyer)', () => {
    it('applies, and a byte-identical replay is a duplicate', () => {
      const note = sealedNote();
      expect(ingestNote(note).outcome).toBe('applied');
      expect(ingestNote(note).outcome).toBe('duplicate');
      expect(repo.listByOrder('po-1', 'delivery_note')).toHaveLength(1);
    });

    it('binds: unknown order, wrong sender, wrong buyer, stale order digest, §9.13', () => {
      expect(ingestNote(sealedNote({ purchase_order_id: 'po-9' }), {}).outcome).toBe('refused');
      expect(ingestNote(sealedNote(), { senderDid: BUYER }).outcome).toBe('not_ours');
      expect(ingestNote(sealedNote(), { selfDid: SUPPLIER }).outcome).toBe('not_ours');
      expect(ingestNote(sealedNote({ order_digest: 'f'.repeat(64) })).detail).toContain(
        'retained order',
      );
      expect(ingestNote(sealedNote({ protocol_version: '1.1' })).detail).toContain('§9.13');
    });

    it('refuses a line the order does not carry, and an incomparable unit', () => {
      const alien = sealedNote({
        lines: [{ line_id: 'line-9', delivered_quantity: { value: '1', unit_code: 'each' } }],
      });
      expect(ingestNote(alien).detail).toContain('not on the order');
      const wrongUnit = sealedNote({
        lines: [{ line_id: 'line-1', delivered_quantity: { value: '1', unit_code: 'kg' } }],
      });
      expect(ingestNote(wrongUnit).outcome).toBe('refused');
    });

    it('CUMULATIVE over-delivery: 6 then 4 pass, 6 then 5 refuses — the §9.11 pattern', () => {
      expect(ingestNote(sealedNote()).outcome).toBe('applied'); // 6 of 10
      const five = sealedNote({
        lines: [{ line_id: 'line-1', delivered_quantity: { value: '5', unit_code: 'each' } }],
      });
      expect(ingestNote(five).detail).toContain('cumulative');
      const four = sealedNote({
        lines: [{ line_id: 'line-1', delivered_quantity: { value: '4', unit_code: 'each' } }],
      });
      expect(ingestNote(four).outcome).toBe('applied'); // exactly 10
    });

    it('a tampered stored note surfaces as an integrity error, never a silent read', () => {
      const note = sealedNote();
      expect(ingestNote(note).outcome).toBe('applied');
      // Corrupt the stored record via the store's own surface: write a
      // second row whose JSON does not match its digest.
      repo.put({
        recordDigest: 'b'.repeat(64),
        kind: 'delivery_note',
        counterpartyDid: SUPPLIER,
        purchaseOrderId: 'po-1',
        answersDigest: '',
        direction: 'inbound',
        recordJson: JSON.stringify({ tampered: true }),
        evidenceJson: '{}',
        createdAt: T0,
      });
      expect(() => ingestNote(sealedNote({ delivery_note_id: 'dn-x' }))).toThrow(
        TradeLedgerIntegrityError,
      );
    });
  });

  describe('inbound DeliveryReceipt (at the supplier)', () => {
    function withNote(): DeliveryNote {
      const note = sealedNote();
      // The supplier authored the note — outbound on this side.
      repo.put({
        recordDigest: note.note_digest,
        kind: 'delivery_note',
        counterpartyDid: BUYER,
        purchaseOrderId: note.purchase_order_id,
        answersDigest: '',
        direction: 'outbound',
        recordJson: JSON.stringify(note),
        evidenceJson: '{}',
        createdAt: T0,
      });
      return note;
    }

    const ingestReceipt = (
      receipt: DeliveryReceipt,
      extra: Partial<Parameters<typeof verifyInboundDeliveryReceipt>[0]> = {},
    ) =>
      verifyInboundDeliveryReceipt({
        senderDid: BUYER,
        selfDid: SUPPLIER,
        receipt,
        repository: repo,
        readOrder: (id) => (id === 'po-1' ? retainedOrder() : null),
        evidenceJson: '{}',
        nowMs: T0,
        ...extra,
      });

    it('applies against the authored note; replay duplicates; a DIFFERENT second receipt conflicts', () => {
      const note = withNote();
      const receipt = sealedReceipt(note);
      expect(ingestReceipt(receipt).outcome).toBe('applied');
      expect(ingestReceipt(receipt).outcome).toBe('duplicate');
      const second = sealedReceipt(note, {
        lines: [{ line_id: 'line-1', accepted_quantity: { value: '1', unit_code: 'each' } }],
      });
      const conflicted = ingestReceipt(second);
      expect(conflicted.outcome).toBe('conflict');
      expect(conflicted.recordDigest).toBe(receipt.receipt_digest); // the held answer stands
    });

    it('refuses: no retained note, over-acceptance, wrong sender', () => {
      const orphan = sealedReceipt(sealedNote());
      expect(ingestReceipt(orphan).detail).toContain('no retained note');
      const note = withNote();
      const over = sealedReceipt(note, {
        lines: [{ line_id: 'line-1', accepted_quantity: { value: '7', unit_code: 'each' } }],
      });
      expect(ingestReceipt(over).detail).toContain('more than');
      expect(ingestReceipt(sealedReceipt(note), { senderDid: SUPPLIER }).outcome).toBe('not_ours');
    });
  });

  describe('inbound PaymentNote (at the supplier) + PaymentAck (at the buyer)', () => {
    const ingestPayment = (
      note: PaymentNote,
      extra: Partial<Parameters<typeof verifyInboundPaymentNote>[0]> = {},
    ) =>
      verifyInboundPaymentNote({
        senderDid: BUYER,
        selfDid: SUPPLIER,
        note,
        repository: repo,
        evidenceJson: '{}',
        nowMs: T0,
        ...extra,
      });

    it('a payment note applies once; parties are checked against the transport', () => {
      const note = sealedPaymentNote();
      expect(ingestPayment(note).outcome).toBe('applied');
      expect(ingestPayment(note).outcome).toBe('duplicate');
      expect(ingestPayment(sealedPaymentNote(), { senderDid: SUPPLIER }).outcome).toBe('not_ours');
      expect(ingestPayment(sealedPaymentNote(), { selfDid: BUYER }).outcome).toBe('not_ours');
    });

    it('an ack applies only against a note THIS node authored, one ack per note', () => {
      const note = sealedPaymentNote();
      // Buyer side: the note is OURS (outbound).
      repo.put({
        recordDigest: note.note_digest,
        kind: 'payment_note',
        counterpartyDid: SUPPLIER,
        purchaseOrderId: '',
        answersDigest: '',
        direction: 'outbound',
        recordJson: JSON.stringify(note),
        evidenceJson: '{}',
        createdAt: T0,
      });
      const ingestAck = (ack: PaymentAcknowledgement) =>
        verifyInboundPaymentAck({
          senderDid: SUPPLIER,
          selfDid: BUYER,
          ack,
          repository: repo,
          evidenceJson: '{}',
          nowMs: T0,
        });

      const ack = sealedAck(note);
      expect(ingestAck(ack).outcome).toBe('applied');
      expect(ingestAck(ack).outcome).toBe('duplicate');
      const disputed = sealedAck(note, { kind: 'disputed', amount_received: undefined });
      expect(ingestAck(disputed).outcome).toBe('conflict');

      const overCredit = sealedAck(note, {
        payment_note_digest: note.note_digest,
        amount_received: { currency: 'INR', minor_units: '500001' },
      });
      expect(ingestAck(overCredit).detail ?? '').not.toBe(''); // refused by pairwise rule
    });

    it('an ack for a note we merely RECEIVED refuses — direction is the authorship record', () => {
      const note = sealedPaymentNote();
      expect(ingestPayment(note).outcome).toBe('applied'); // stored inbound at supplier
      const result = verifyInboundPaymentAck({
        senderDid: SUPPLIER,
        selfDid: BUYER,
        ack: sealedAck(note),
        repository: repo,
        evidenceJson: '{}',
        nowMs: T0,
      });
      expect(result.outcome).toBe('refused');
      expect(result.detail).toContain('authored');
    });
  });

  describe('inbound QuoteDecline (at the buyer)', () => {
    const ingestDecline = (
      decline: QuoteDecline,
      extra: Partial<Parameters<typeof verifyInboundQuoteDecline>[0]> = {},
    ) =>
      verifyInboundQuoteDecline({
        senderDid: SUPPLIER,
        selfDid: BUYER,
        decline,
        repository: repo,
        readRequest: (id) => (id === 'req-1' ? retainedRequest : null),
        evidenceJson: '{}',
        nowMs: T0,
        ...extra,
      });

    it('applies once per request; a different second decline conflicts', () => {
      const decline = sealedDecline();
      expect(ingestDecline(decline).outcome).toBe('applied');
      expect(ingestDecline(decline).outcome).toBe('duplicate');
      expect(ingestDecline(sealedDecline({ reason_code: 'policy' })).outcome).toBe('conflict');
    });

    it('binds: unknown request, wrong sender, digest mismatch', () => {
      expect(ingestDecline(sealedDecline({ request_id: 'req-9' })).outcome).toBe('refused');
      expect(ingestDecline(sealedDecline(), { senderDid: BUYER }).outcome).toBe('not_ours');
      expect(ingestDecline(sealedDecline({ request_digest: 'f'.repeat(64) })).detail).toContain(
        'request_digest',
      );
    });
  });
});
