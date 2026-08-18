/**
 * §7 order inbox — the khata-document kinds the route suites never
 * earn: `short_acceptance` (the §4.3 dispute surface) and
 * `unacknowledged_payment`. The short comparison must run through
 * `compareQuantities`, because a receipt line may legally answer a kg
 * note in grams — raw values called 750 g against 1 kg full, and
 * 0.5 kg against 500 g short.
 */

import { createHash } from 'node:crypto';

import { tradeRecordDigest, type Sha256Fn } from '@dina/commerce-protocol';

import { buildTradeInbox } from '../../src/commerce/trade_inbox';
import { InMemoryTradeDocumentRepository } from '../../src/commerce/trade_ledger';

import type { CommerceRuntime } from '../../src/commerce/runtime';

const hash: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());
const T0 = 1_800_000_000_000;
const BUYER = 'did:key:zBuyerInbox';

let docs: InMemoryTradeDocumentRepository;

function runtimeStub(): CommerceRuntime {
  return {
    orderDrafts: { list: () => [] },
    tenders: { listTenders: () => [] },
    pendingDecisions: { list: () => [] },
    tradeDocuments: docs,
  } as unknown as CommerceRuntime;
}

function putNote(noteQuantity: { value: string; unit_code: string }): string {
  const draft = {
    protocol_version: '1.1',
    delivery_note_id: 'dn-1',
    purchase_order_id: 'po-1',
    order_digest: 'a'.repeat(64),
    supplier_order_id: 'so-1',
    lines: [{ line_id: 'l1', delivered_quantity: noteQuantity }],
    dispatched_at: '2026-08-07T15:00:00.000Z',
  };
  const note = { ...draft, note_digest: tradeRecordDigest('delivery_note', draft, hash) };
  docs.put({
    recordDigest: note.note_digest,
    kind: 'delivery_note',
    counterpartyDid: BUYER,
    purchaseOrderId: 'po-1',
    answersDigest: '',
    direction: 'outbound',
    recordJson: JSON.stringify(note),
    evidenceJson: '{}',
    createdAt: T0,
  });
  return note.note_digest;
}

function putReceipt(
  noteDigest: string,
  acceptedQuantity: { value: string; unit_code: string },
): void {
  const draft = {
    protocol_version: '1.1',
    delivery_receipt_id: 'dr-1',
    delivery_note_digest: noteDigest,
    lines: [{ line_id: 'l1', accepted_quantity: acceptedQuantity }],
    received_at: '2026-08-07T16:00:00.000Z',
  };
  const receipt = { ...draft, receipt_digest: tradeRecordDigest('delivery_receipt', draft, hash) };
  docs.put({
    recordDigest: receipt.receipt_digest,
    kind: 'delivery_receipt',
    counterpartyDid: BUYER,
    purchaseOrderId: 'po-1',
    answersDigest: noteDigest,
    direction: 'inbound',
    recordJson: JSON.stringify(receipt),
    evidenceJson: '{}',
    createdAt: T0,
  });
}

beforeEach(() => {
  docs = new InMemoryTradeDocumentRepository();
});

describe('short_acceptance (§4.3) — unit-aware', () => {
  it('a 750 g receipt of a 1 kg note IS a short (250 g the raw values hid)', () => {
    const noteDigest = putNote({ value: '1', unit_code: 'kg' });
    putReceipt(noteDigest, { value: '750', unit_code: 'g' });
    const kinds = buildTradeInbox(runtimeStub(), T0).items.map((item) => item.kind);
    expect(kinds).toContain('short_acceptance');
  });

  it('a 0.5 kg receipt of a 500 g note is FULL acceptance, not a dispute', () => {
    const noteDigest = putNote({ value: '500', unit_code: 'g' });
    putReceipt(noteDigest, { value: '0.5', unit_code: 'kg' });
    const items = buildTradeInbox(runtimeStub(), T0).items;
    expect(items.map((item) => item.kind)).not.toContain('short_acceptance');
    // The receipted note also leaves the unreceipted sweep.
    expect(items.map((item) => item.kind)).not.toContain('unreceipted_delivery');
  });

  it('same-unit short still flags (the plain case the comparator must not lose)', () => {
    const noteDigest = putNote({ value: '100', unit_code: 'each' });
    putReceipt(noteDigest, { value: '90', unit_code: 'each' });
    const shortItem = buildTradeInbox(runtimeStub(), T0).items.find(
      (item) => item.kind === 'short_acceptance',
    );
    expect(shortItem).toMatchObject({ role: 'supplier', counterpartyDid: BUYER });
  });
});

describe('unacknowledged_payment', () => {
  function putPaymentNote(): string {
    const draft = {
      protocol_version: '1.1',
      payment_note_id: 'pn-1',
      buyer_did: BUYER,
      supplier_did: 'did:key:zSelfInbox',
      amount: { currency: 'INR', minor_units: '20000' },
      method: 'cash',
      paid_at: '2026-08-07T16:00:00.000Z',
    };
    const note = { ...draft, note_digest: tradeRecordDigest('payment_note', draft, hash) };
    docs.put({
      recordDigest: note.note_digest,
      kind: 'payment_note',
      counterpartyDid: BUYER,
      purchaseOrderId: '',
      answersDigest: '',
      direction: 'inbound',
      recordJson: JSON.stringify(note),
      evidenceJson: '{}',
      createdAt: T0,
    });
    return note.note_digest;
  }

  it('an unanswered inbound payment note is the supplier’s to acknowledge', () => {
    putPaymentNote();
    const item = buildTradeInbox(runtimeStub(), T0).items.find(
      (entry) => entry.kind === 'unacknowledged_payment',
    );
    expect(item).toMatchObject({ role: 'supplier', counterpartyDid: BUYER });
  });

  it('an acknowledged note leaves the inbox', () => {
    const noteDigest = putPaymentNote();
    const ackDraft = {
      protocol_version: '1.1',
      payment_ack_id: 'pa-1',
      payment_note_digest: noteDigest,
      acknowledged_at: '2026-08-07T17:00:00.000Z',
      kind: 'received',
      amount_received: { currency: 'INR', minor_units: '20000' },
    };
    const ack = { ...ackDraft, ack_digest: tradeRecordDigest('payment_ack', ackDraft, hash) };
    docs.put({
      recordDigest: ack.ack_digest,
      kind: 'payment_ack',
      counterpartyDid: BUYER,
      purchaseOrderId: '',
      answersDigest: noteDigest,
      direction: 'outbound',
      recordJson: JSON.stringify(ack),
      evidenceJson: '{}',
      createdAt: T0,
    });
    const kinds = buildTradeInbox(runtimeStub(), T0).items.map((item) => item.kind);
    expect(kinds).not.toContain('unacknowledged_payment');
  });
});
describe('the buyer-side and supplier-side queue kinds', () => {
  it('an unexpired tender, a pending supplier decision and a quoted conversation each earn their item', () => {
    const runtime = {
      orderDrafts: {
        list: () => [
          {
            draftId: 'odr-q',
            abandoned: false,
            ceremonyCounter: 0,
            lines: [],
            requirements: [],
            conversations: [
              { conversationId: 'c-1', state: 'quoted', supplierDid: 'did:key:zQuotingSupplier' },
            ],
            createdAtMs: T0,
            updatedAtMs: T0,
          } as never,
        ],
      },
      tenders: {
        listTenders: () => [
          { tenderId: 'tender-live', expiresAt: T0 + 60_000, createdAt: T0 },
          { tenderId: 'tender-dead', expiresAt: T0 - 1, createdAt: T0 - 100 },
        ],
      },
      pendingDecisions: {
        list: () => [{ buyerDid: BUYER, purchaseOrderId: 'po-9', createdAt: T0 }],
      },
      tradeDocuments: docs,
    } as unknown as CommerceRuntime;

    const items = buildTradeInbox(runtime, T0).items;
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'pending_quote', role: 'buyer', subject: 'odr-q:c-1' }),
        expect.objectContaining({ kind: 'open_tender', role: 'buyer', subject: 'tender-live' }),
        expect.objectContaining({
          kind: 'pending_decision',
          role: 'supplier',
          subject: 'po-9',
          counterpartyDid: BUYER,
        }),
      ]),
    );
    // The expired tender never surfaces.
    expect(items.map((item) => item.subject)).not.toContain('tender-dead');
  });
});
