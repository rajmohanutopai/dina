/**
 * §10 — the Tally export's unit seams the route test never reaches:
 * the BUYER-side legs (Purchase + Payment), settled-facts-only (a
 * pending or rejected order never books), byte determinism, XML
 * escaping, and zero-exponent currency amounts.
 */

import { createHash } from 'node:crypto';

import {
  commerceRecordDigest,
  tradeRecordDigest,
  type OrderAcknowledgement,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import { InMemoryCommerceReceiptRepository } from '../../src/commerce/receipts';
import { collectTallyVouchers, renderTallyXml } from '../../src/commerce/tally_export';
import { InMemoryTradeDocumentRepository } from '../../src/commerce/trade_ledger';

import { BUYER_DID, SUPPLIER_DID, makeOrder, makeQuoteRequest, makeSignedQuote } from './helpers';

import type { CommerceRuntime } from '../../src/commerce/runtime';

const hash: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());
const T0 = 1_800_000_000_000;

const REQUEST = makeQuoteRequest();
const QUOTE = makeSignedQuote(REQUEST); // totals 50000 INR
const ORDER = makeOrder(QUOTE, REQUEST.delivery.projection);

let receipts: InMemoryCommerceReceiptRepository;
let tradeDocs: InMemoryTradeDocumentRepository;

function runtimeAs(self: string): CommerceRuntime {
  return {
    nodeDid: () => self,
    receipts,
    tradeDocuments: tradeDocs,
  } as unknown as CommerceRuntime;
}

function retainOrder(): void {
  receipts.put({
    recordDigest: ORDER.order_digest,
    domain: 'order',
    buyerDid: ORDER.buyer_did,
    quoteId: ORDER.quote_id,
    purchaseOrderId: ORDER.purchase_order_id,
    recordJson: JSON.stringify(ORDER),
    evidenceJson: '{}',
    createdAt: T0,
  });
}

function retainAck(kind: 'accepted' | 'rejected'): void {
  const draft = {
    protocol_version: '1.0',
    acknowledgement_id: `ack-${kind}`,
    purchase_order_id: ORDER.purchase_order_id,
    order_digest: ORDER.order_digest,
    buyer_did: ORDER.buyer_did,
    supplier_did: ORDER.supplier_did,
    issued_at: '2026-08-07T13:00:00.000Z',
    kind,
    ...(kind === 'accepted'
      ? {
          supplier_order_id: 'so-1',
          accepted_quote_digest: QUOTE.quote_digest,
          accepted_at: '2026-08-07T13:00:00.000Z',
        }
      : { reason_code: 'other' }),
  };
  const ack = {
    ...draft,
    acknowledgement_digest: commerceRecordDigest('acknowledgement', draft, hash),
  } as OrderAcknowledgement;
  receipts.put({
    recordDigest: ack.acknowledgement_digest,
    domain: 'acknowledgement',
    buyerDid: ack.buyer_did,
    quoteId: '',
    purchaseOrderId: ack.purchase_order_id,
    recordJson: JSON.stringify(ack),
    evidenceJson: '{}',
    createdAt: T0,
  });
}

beforeEach(() => {
  receipts = new InMemoryCommerceReceiptRepository();
  tradeDocs = new InMemoryTradeDocumentRepository();
});

describe('side mapping', () => {
  it('the SAME accepted order books as Sales on the supplier and Purchase on the buyer', () => {
    retainOrder();
    retainAck('accepted');
    const asSupplier = collectTallyVouchers(runtimeAs(SUPPLIER_DID), { currency: 'INR' }, hash);
    const asBuyer = collectTallyVouchers(runtimeAs(BUYER_DID), { currency: 'INR' }, hash);
    expect(asSupplier).toEqual([
      expect.objectContaining({ vchType: 'Sales', partyLedger: BUYER_DID, amount: '500.00' }),
    ]);
    expect(asBuyer).toEqual([
      expect.objectContaining({ vchType: 'Purchase', partyLedger: SUPPLIER_DID, amount: '500.00' }),
    ]);
  });

  it("this node's own payment note books as Payment", () => {
    const draft = {
      protocol_version: '1.1',
      payment_note_id: 'pn-out',
      buyer_did: BUYER_DID,
      supplier_did: SUPPLIER_DID,
      amount: { currency: 'INR', minor_units: '20000' },
      method: 'cash',
      paid_at: '2026-08-08T10:00:00.000Z',
    };
    const note = { ...draft, note_digest: tradeRecordDigest('payment_note', draft, hash) };
    tradeDocs.put({
      recordDigest: note.note_digest,
      kind: 'payment_note',
      counterpartyDid: SUPPLIER_DID,
      purchaseOrderId: '',
      answersDigest: '',
      direction: 'outbound',
      recordJson: JSON.stringify(note),
      evidenceJson: '{}',
      createdAt: T0,
    });
    const vouchers = collectTallyVouchers(runtimeAs(BUYER_DID), { currency: 'INR' }, hash);
    expect(vouchers).toEqual([
      expect.objectContaining({ vchType: 'Payment', partyLedger: SUPPLIER_DID, amount: '200.00' }),
    ]);
    expect(vouchers[0]?.narration).toContain(note.note_digest);
  });
});

describe('settled facts only', () => {
  it('an order with NO acknowledgement books nothing', () => {
    retainOrder();
    expect(collectTallyVouchers(runtimeAs(SUPPLIER_DID), { currency: 'INR' }, hash)).toEqual([]);
  });

  it('a REJECTED order books nothing', () => {
    retainOrder();
    retainAck('rejected');
    expect(collectTallyVouchers(runtimeAs(SUPPLIER_DID), { currency: 'INR' }, hash)).toEqual([]);
  });
});

describe('the rendered envelope', () => {
  it('is byte-deterministic: the same facts render the same XML twice', () => {
    retainOrder();
    retainAck('accepted');
    const first = renderTallyXml(collectTallyVouchers(runtimeAs(SUPPLIER_DID), { currency: 'INR' }, hash));
    const second = renderTallyXml(collectTallyVouchers(runtimeAs(SUPPLIER_DID), { currency: 'INR' }, hash));
    expect(first).toBe(second);
  });

  it('escapes ledger names and narrations — markup in a DID cannot break the document', () => {
    const xml = renderTallyXml([
      {
        vchType: 'Receipt',
        date: '20260807',
        partyLedger: 'did:web:<evil>&"co"',
        amount: '1.00',
        currency: 'INR',
        narration: `dina payment ack <a> & 'b'`,
      },
    ]);
    expect(xml).toContain('did:web:&lt;evil&gt;&amp;&quot;co&quot;');
    expect(xml).toContain('&lt;a&gt; &amp; &apos;b&apos;');
    expect(xml).not.toContain('<evil>');
  });

  it('a zero-exponent currency COLLECTS as whole units — a yen never gains paise', () => {
    const draft = {
      protocol_version: '1.1',
      payment_note_id: 'pn-jpy',
      buyer_did: BUYER_DID,
      supplier_did: SUPPLIER_DID,
      amount: { currency: 'JPY', minor_units: '500' },
      method: 'cash',
      paid_at: '2026-08-08T10:00:00.000Z',
    };
    const note = { ...draft, note_digest: tradeRecordDigest('payment_note', draft, hash) };
    tradeDocs.put({
      recordDigest: note.note_digest,
      kind: 'payment_note',
      counterpartyDid: SUPPLIER_DID,
      purchaseOrderId: '',
      answersDigest: '',
      direction: 'outbound',
      recordJson: JSON.stringify(note),
      evidenceJson: '{}',
      createdAt: T0,
    });
    const vouchers = collectTallyVouchers(runtimeAs(BUYER_DID), { currency: 'JPY' }, hash);
    expect(vouchers).toEqual([expect.objectContaining({ amount: '500', currency: 'JPY' })]);
  });

  it('a zero-exponent currency renders whole units in the envelope', () => {
    const xml = renderTallyXml([
      {
        vchType: 'Sales',
        date: '20260807',
        partyLedger: BUYER_DID,
        amount: '500',
        currency: 'JPY',
        narration: 'dina order po-jpy digest ' + 'a'.repeat(64),
      },
    ]);
    expect(xml).toContain('<AMOUNT>500</AMOUNT>');
    expect(xml).not.toContain('<AMOUNT>500.00</AMOUNT>');
  });
});
