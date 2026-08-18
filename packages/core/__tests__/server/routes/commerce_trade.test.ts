/**
 * The khata owner routes (TRADE_FIRST_STRATEGY §4.2–§4.4, §3.4) — the
 * supplier node's surface: issue notes against the retained order,
 * acknowledge payments, decline requests, read the statement and the
 * sweeps. Fixtures are REAL validated records (the receipts readers
 * re-validate, so a hand-built stand-in cannot pass by accident).
 */

import { createHash } from 'node:crypto';

import {
  commerceRecordDigest,
  tradeRecordDigest,
  type OrderAcknowledgement,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import { InMemoryCommerceReceiptRepository } from '../../../src/commerce/receipts';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import {
  InMemoryTradeDocumentRepository,
  verifyInboundDeliveryReceipt,
  verifyInboundPaymentNote,
} from '../../../src/commerce/trade_ledger';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import {
  BUYER_DID,
  SUPPLIER_DID,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
} from '../../commerce/helpers';

const hash: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());
const OWNER_CAP = 'test-owner-capability-secret';
const T0 = 1_800_000_000_000;

const REQUEST = makeQuoteRequest();
// 100 each @ ₹5.00 → total 50000; §4.5 terms at protocol 1.1 so the
// statement derives dues.
const QUOTE = makeSignedQuote(REQUEST, {
  protocol_version: '1.1',
  payment_terms: { credit_days: 30, due_basis: 'from_delivery' },
});
const ORDER = makeOrder(QUOTE, REQUEST.delivery.projection, { protocol_version: '1.1' });

/** A real §9.10 accepted acknowledgement, digest-sealed. */
function makeAcceptedAck(): OrderAcknowledgement {
  const draft = {
    protocol_version: '1.0',
    acknowledgement_id: 'ack-1',
    purchase_order_id: ORDER.purchase_order_id,
    order_digest: ORDER.order_digest,
    buyer_did: ORDER.buyer_did,
    supplier_did: ORDER.supplier_did,
    issued_at: '2026-08-07T13:00:00.000Z',
    kind: 'accepted',
    supplier_order_id: 'so-1',
    accepted_quote_digest: QUOTE.quote_digest,
    accepted_at: '2026-08-07T13:00:00.000Z',
  };
  return {
    ...draft,
    acknowledgement_digest: commerceRecordDigest('acknowledgement', draft, hash),
  } as OrderAcknowledgement;
}

let router: CoreRouter;
let tradeDocs: InMemoryTradeDocumentRepository;
let receipts: InMemoryCommerceReceiptRepository;

function owner(path: string, body?: Record<string, unknown>): CoreRequest {
  return {
    method: body === undefined ? 'GET' : 'POST',
    path,
    query: {},
    headers: {},
    body: body ?? {},
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'owner',
    callerDID: 'did:key:owner',
    ownerCapability: OWNER_CAP,
  } as unknown as CoreRequest;
}

beforeEach(() => {
  setNodeDID(SUPPLIER_DID);
  tradeDocs = new InMemoryTradeDocumentRepository();
  receipts = new InMemoryCommerceReceiptRepository();
  // The supplier retains the order, the bound quote and its own accepted
  // acknowledgement — all under the ORDER'S buyer key, which is how the
  // §16.2 store keys them.
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
  receipts.put({
    recordDigest: QUOTE.quote_digest,
    domain: 'quote',
    buyerDid: QUOTE.buyer_did,
    quoteId: QUOTE.quote_id,
    purchaseOrderId: '',
    recordJson: JSON.stringify(QUOTE),
    evidenceJson: '{}',
    createdAt: T0,
  });
  const ack = makeAcceptedAck();
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
  receipts.put({
    recordDigest: REQUEST.request_digest,
    domain: 'request',
    buyerDid: REQUEST.buyer_did,
    quoteId: '',
    purchaseOrderId: '',
    recordJson: JSON.stringify(REQUEST),
    evidenceJson: '{}',
    createdAt: T0,
  });
  installCommerceRuntime({
    tradeDocuments: tradeDocs,
    receipts,
    nodeDid: () => SUPPLIER_DID,
    now: () => T0,
  } as unknown as CommerceRuntime);
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  installCommerceRuntime(null);
});

describe('POST /v1/commerce/trade/delivery-note', () => {
  it('issues against the retained order; the cumulative rule refuses the overrun', async () => {
    const first = await router.handle(
      owner('/v1/commerce/trade/delivery-note', {
        counterparty_did: BUYER_DID,
        purchase_order_id: ORDER.purchase_order_id,
        supplier_order_id: 'so-1',
        lines: [{ line_id: 'l1', delivered_quantity: { value: '60', unit_code: 'each' } }],
      }),
    );
    expect(first.status).toBe(200);

    const overrun = await router.handle(
      owner('/v1/commerce/trade/delivery-note', {
        counterparty_did: BUYER_DID,
        purchase_order_id: ORDER.purchase_order_id,
        supplier_order_id: 'so-1',
        lines: [{ line_id: 'l1', delivered_quantity: { value: '50', unit_code: 'each' } }],
      }),
    );
    expect(overrun.status).toBe(409);
    expect(String((overrun.body as { error: string }).error)).toContain('cumulative');
  });

  it('refuses without the owner capability', async () => {
    const denied = await router.handle({
      ...owner('/v1/commerce/trade/delivery-note', {}),
      callerType: 'device',
      ownerCapability: undefined,
    } as unknown as CoreRequest);
    expect(denied.status).toBeGreaterThanOrEqual(401);
  });
});

describe('the supplier journey: note → buyer receipt → payment → ack → statement', () => {
  it('folds the routes and the inbound documents to one statement', async () => {
    // 1. Issue a note for 60.
    const noteResp = await router.handle(
      owner('/v1/commerce/trade/delivery-note', {
        counterparty_did: BUYER_DID,
        purchase_order_id: ORDER.purchase_order_id,
        supplier_order_id: 'so-1',
        lines: [{ line_id: 'l1', delivered_quantity: { value: '60', unit_code: 'each' } }],
      }),
    );
    expect(noteResp.status).toBe(200);
    const note = (noteResp.body as { document: { note_digest: string } }).document;

    // Unanswered sweep shows it.
    const pendingBefore = await router.handle(
      owner(`/v1/commerce/trade/unanswered`, undefined),
    );
    // GET carries query via the request object:
    const pending = await router.handle({
      ...owner('/v1/commerce/trade/unanswered', undefined),
      query: { counterparty_did: BUYER_DID },
    } as unknown as CoreRequest);
    expect(pendingBefore.status).toBe(400); // counterparty required
    expect(pending.status).toBe(200);
    expect((pending.body as { delivery_notes: unknown[] }).delivery_notes).toHaveLength(1);

    // 2. The buyer's receipt arrives (55 accepted, 5 short) — inbound leg.
    const receiptDraft = {
      protocol_version: '1.1',
      delivery_receipt_id: 'dr-1',
      delivery_note_digest: note.note_digest,
      lines: [
        {
          line_id: 'l1',
          accepted_quantity: { value: '55', unit_code: 'each' },
          reason_code: 'short',
        },
      ],
      received_at: '2026-08-07T15:00:00.000Z',
    };
    const receipt = {
      ...receiptDraft,
      receipt_digest: tradeRecordDigest('delivery_receipt', receiptDraft, hash),
    };
    const receiptIngest = verifyInboundDeliveryReceipt({
      senderDid: BUYER_DID,
      selfDid: SUPPLIER_DID,
      receipt,
      repository: tradeDocs,
      readOrder: () => ORDER,
      evidenceJson: '{}',
      nowMs: T0,
    });
    expect(receiptIngest.outcome).toBe('applied');

    // 3. The buyer's payment note arrives; the supplier acknowledges 20000.
    const paymentDraft = {
      protocol_version: '1.0',
      payment_note_id: 'pn-1',
      buyer_did: BUYER_DID,
      supplier_did: SUPPLIER_DID,
      amount: { currency: 'INR', minor_units: '25000' },
      method: 'cash',
      paid_at: '2026-08-07T16:00:00.000Z',
    };
    const payment = {
      ...paymentDraft,
      note_digest: tradeRecordDigest('payment_note', paymentDraft, hash),
    };
    expect(
      verifyInboundPaymentNote({
        senderDid: BUYER_DID,
        selfDid: SUPPLIER_DID,
        note: payment,
        repository: tradeDocs,
        evidenceJson: '{}',
        nowMs: T0,
      }).outcome,
    ).toBe('applied');
    const ackResp = await router.handle(
      owner('/v1/commerce/trade/payment-ack', {
        payment_note_digest: payment.note_digest,
        kind: 'received',
        amount_received: { currency: 'INR', minor_units: '20000' },
      }),
    );
    expect(ackResp.status).toBe(200);

    // 4. The statement: goods = 55×500 = 27500; payments 20000 →
    //    buyer_owes 7500; disputed = 5×500 = 2500.
    const statement = await router.handle({
      ...owner('/v1/commerce/trade/statement', undefined),
      query: { counterparty_did: BUYER_DID, currency: 'INR' },
    } as unknown as CoreRequest);
    expect(statement.status).toBe(200);
    const fold = (statement.body as { statement: Record<string, unknown> }).statement;
    expect(fold.goods_owed_minor).toBe('27500');
    expect(fold.balance).toEqual({ direction: 'buyer_owes', minor_units: '7500' });
    expect(fold.disputed_minor).toBe('2500');
    // §4.5 — the receipted portion's derived due rides the statement,
    // flagged overdue against the route clock (T0 is past 2026-10-06).
    expect((statement.body as { dues: unknown[] }).dues).toEqual([
      {
        purchase_order_id: ORDER.purchase_order_id,
        basis: 'from_delivery',
        due_at: '2026-09-06T15:00:00.000Z',
        amount: { currency: 'INR', minor_units: '27500' },
        overdue: true,
      },
    ]);

    // 5. The receipted note leaves the sweep.
    const pendingAfter = await router.handle({
      ...owner('/v1/commerce/trade/unanswered', undefined),
      query: { counterparty_did: BUYER_DID },
    } as unknown as CoreRequest);
    expect((pendingAfter.body as { delivery_notes: unknown[] }).delivery_notes).toHaveLength(0);
  });
});

describe('POST /v1/commerce/trade/quote-decline', () => {
  it('declines the RETAINED request once; a second decline refuses', async () => {
    const first = await router.handle(
      owner('/v1/commerce/trade/quote-decline', {
        request_id: REQUEST.request_id,
        buyer_did: BUYER_DID,
        reason_code: 'capacity',
      }),
    );
    expect(first.status).toBe(200);
    const second = await router.handle(
      owner('/v1/commerce/trade/quote-decline', {
        request_id: REQUEST.request_id,
        buyer_did: BUYER_DID,
        reason_code: 'policy',
      }),
    );
    expect(second.status).toBe(409);
    const unknown = await router.handle(
      owner('/v1/commerce/trade/quote-decline', {
        request_id: 'req-nope',
        buyer_did: BUYER_DID,
        reason_code: 'capacity',
      }),
    );
    expect(unknown.status).toBe(404);
  });
});

describe('GET /v1/commerce/trade/books-export (§10)', () => {
  it('settled facts only, each voucher naming its chain digest; deterministic XML', async () => {
    // Author the note, receive the buyer's payment note, acknowledge it —
    // the same journey the statement test walks, condensed.
    const paymentDraft = {
      protocol_version: '1.1',
      payment_note_id: 'pn-books',
      buyer_did: BUYER_DID,
      supplier_did: SUPPLIER_DID,
      amount: { currency: 'INR', minor_units: '20000' },
      method: 'cash',
      paid_at: '2026-08-07T16:00:00.000Z',
    };
    const payment = {
      ...paymentDraft,
      note_digest: tradeRecordDigest('payment_note', paymentDraft, hash),
    };
    expect(
      verifyInboundPaymentNote({
        senderDid: BUYER_DID,
        selfDid: SUPPLIER_DID,
        note: payment,
        repository: tradeDocs,
        evidenceJson: '{}',
        nowMs: T0,
      }).outcome,
    ).toBe('applied');
    const acked = await router.handle(
      owner('/v1/commerce/trade/payment-ack', {
        payment_note_digest: payment.note_digest,
        kind: 'received',
        amount_received: { currency: 'INR', minor_units: '20000' },
      }),
    );
    expect(acked.status).toBe(200);

    const exported = await router.handle({
      ...owner('/v1/commerce/trade/books-export', undefined),
      query: { currency: 'INR' },
    } as unknown as CoreRequest);
    expect(exported.status).toBe(200);
    const body = exported.body as { voucher_count: number; xml: string };
    // The accepted order (Sales, this node supplied) + the received
    // payment (Receipt). The buyer's unacked half exports nothing.
    expect(body.voucher_count).toBe(2);
    expect(body.xml).toContain('VCHTYPE="Sales"');
    expect(body.xml).toContain('<AMOUNT>500.00</AMOUNT>'); // 50000 minor
    expect(body.xml).toContain('VCHTYPE="Receipt"');
    expect(body.xml).toContain('<AMOUNT>200.00</AMOUNT>');
    // The chain reference: every voucher names the digest it derives from.
    expect(body.xml).toContain(`digest ${ORDER.order_digest}`);
    expect(body.xml).toContain(`<PARTYLEDGERNAME>${BUYER_DID}</PARTYLEDGERNAME>`);
  });
});
describe('POST /v1/commerce/trade/resend (§4.3 — the promised owner re-send)', () => {
  it('re-dispatches the RETAINED outbound document; inbound and unknown refuse', async () => {
    const { setD2DSender } = jest.requireActual<
      typeof import('../../../src/server/routes/d2d_msg')
    >('../../../src/server/routes/d2d_msg');
    const sent: { toDid: string; type: string; body: unknown }[] = [];
    setD2DSender(async (toDid, type, body) => {
      sent.push({ toDid, type, body });
      return { sent: true, delivered: true } as never;
    });
    try {
      const noteResp = await router.handle(
        owner('/v1/commerce/trade/delivery-note', {
          counterparty_did: BUYER_DID,
          purchase_order_id: ORDER.purchase_order_id,
          supplier_order_id: 'so-1',
          lines: [{ line_id: 'l1', delivered_quantity: { value: '60', unit_code: 'each' } }],
        }),
      );
      expect(noteResp.status).toBe(200);
      const digest = (noteResp.body as { document: { note_digest: string } }).document.note_digest;
      sent.length = 0;

      const resent = await router.handle(
        owner('/v1/commerce/trade/resend', { record_digest: digest }),
      );
      expect(resent.status).toBe(200);
      expect((resent.body as { dispatched: boolean }).dispatched).toBe(true);
      // EXACTLY the retained bytes, to the retained counterparty.
      expect(sent).toEqual([
        {
          toDid: BUYER_DID,
          type: 'commerce.trade',
          body: {
            kind: 'delivery_note',
            document: expect.objectContaining({ note_digest: digest }),
          },
        },
      ]);

      const unknown = await router.handle(
        owner('/v1/commerce/trade/resend', { record_digest: 'f'.repeat(64) }),
      );
      expect(unknown.status).toBe(404);

      // An INBOUND row (the buyer's receipt of this note) is not ours to re-send.
      const receiptDraft = {
        protocol_version: '1.1', // the ORDER's conversation version (§9.13)
        delivery_receipt_id: 'dr-resend',
        delivery_note_digest: digest,
        lines: [{ line_id: 'l1', accepted_quantity: { value: '60', unit_code: 'each' } }],
        // After the note's real-clock dispatch stamp.
        received_at: '2027-06-01T00:00:00.000Z',
      };
      const receipt = {
        ...receiptDraft,
        receipt_digest: tradeRecordDigest('delivery_receipt', receiptDraft, hash),
      };
      expect(
        verifyInboundDeliveryReceipt({
          senderDid: BUYER_DID,
          selfDid: SUPPLIER_DID,
          receipt,
          repository: tradeDocs,
          readOrder: (id) => (id === ORDER.purchase_order_id ? ORDER : null),
          evidenceJson: '{}',
          nowMs: T0,
        }).outcome,
      ).toBe('applied');
      const foreign = await router.handle(
        owner('/v1/commerce/trade/resend', { record_digest: receipt.receipt_digest }),
      );
      expect(foreign.status).toBe(409);

      // An OUTBOUND answer is addressable by what it answered: issue our
      // own receipt-shaped answer? — the supplier side answers with the
      // note itself, so exercise answers_to on the note's own family:
      // no outbound answer exists for this receipt, so the lookup 404s
      // rather than resending someone else's document.
      const byAnswer = await router.handle(
        owner('/v1/commerce/trade/resend', { answers_to: digest, kind: 'delivery_receipt' }),
      );
      expect(byAnswer.status).toBe(404);
    } finally {
      setD2DSender(null);
    }
  });
});

describe('GET /v1/commerce/trade/statement — §4.4 one fold per orientation', () => {
  it('refuses a stranger DID by name instead of fabricating "settled 0"', async () => {
    const resp = await router.handle({
      ...owner('/v1/commerce/trade/statement', undefined),
      query: { counterparty_did: 'did:key:zStrangerNoTrade', currency: 'INR' },
    } as unknown as CoreRequest);
    expect(resp.status).toBe(404);
    expect((resp.body as { error: string }).error).toBe('no_trade_relationship');
  });

  it('a dual-role pair is TWO ledgers: the bare call refuses, each role folds only its own money', async () => {
    // The fixture already supplies BUYER_DID (the retained accepted
    // order). Add the buyer orientation with the SAME counterparty:
    // BUYER_DID acknowledged receiving 20000 from this node — an INBOUND
    // payment ack, i.e. money this node paid as a buyer.
    const ackDraft = {
      protocol_version: '1.1',
      payment_ack_id: 'pa-dual',
      payment_note_digest: 'b'.repeat(64),
      acknowledged_at: '2026-08-07T17:00:00.000Z',
      kind: 'received',
      amount_received: { currency: 'INR', minor_units: '20000' },
    };
    const inboundAck = { ...ackDraft, ack_digest: tradeRecordDigest('payment_ack', ackDraft, hash) };
    tradeDocs.put({
      recordDigest: inboundAck.ack_digest,
      kind: 'payment_ack',
      counterpartyDid: BUYER_DID,
      purchaseOrderId: '',
      answersDigest: ackDraft.payment_note_digest,
      direction: 'inbound',
      recordJson: JSON.stringify(inboundAck),
      evidenceJson: '{}',
      createdAt: T0,
    });

    // Bare call: the pair trades both ways, so no single fold is honest.
    const bare = await router.handle({
      ...owner('/v1/commerce/trade/statement', undefined),
      query: { counterparty_did: BUYER_DID, currency: 'INR' },
    } as unknown as CoreRequest);
    expect(bare.status).toBe(409);
    expect((bare.body as { error: string }).error).toBe('role_required');

    // Supply ledger: nothing receipted, and the node's own PURCHASE
    // payment must not credit the buyer's debt — the merge once said
    // "buyer paid me 20000" about money flowing the other way.
    const asSupplier = await router.handle({
      ...owner('/v1/commerce/trade/statement', undefined),
      query: { counterparty_did: BUYER_DID, currency: 'INR', role: 'supplier' },
    } as unknown as CoreRequest);
    expect(asSupplier.status).toBe(200);
    const supplierBody = asSupplier.body as { statement: Record<string, unknown>; role: string };
    expect(supplierBody.role).toBe('supplier');
    expect(supplierBody.statement.balance).toEqual({ direction: 'settled', minor_units: '0' });

    // Purchase ledger: the 20000 this node paid, no goods folded yet.
    const asBuyer = await router.handle({
      ...owner('/v1/commerce/trade/statement', undefined),
      query: { counterparty_did: BUYER_DID, currency: 'INR', role: 'buyer' },
    } as unknown as CoreRequest);
    expect(asBuyer.status).toBe(200);
    const buyerBody = asBuyer.body as { statement: Record<string, unknown>; role: string };
    expect(buyerBody.role).toBe('buyer');
    expect(buyerBody.statement.balance).toEqual({
      direction: 'supplier_owes',
      minor_units: '20000',
    });
  });
});
