/**
 * GET /v1/commerce/orders/placed — the buyer's placed orders (iPhone buyer run
 * 2026-09-29: after Award → Send the order vanished from the phone).
 *
 * Pins the contract the "My Orders" screen reads: owner-only, 503 without
 * commerce, every order settled or not and newest placed first, the shared
 * `describeOrderForOwner` headline, the retained total, the owner's contact
 * name for the supplier, and a progress summary read from the supplier
 * integration's attachments and the buyer's own khata — joined only while the
 * money line is open. Real SQLite for the order and receipt stores.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  tradeRecordDigest,
  type OrderAttachment,
  type PaymentNote,
  type PurchaseOrderProposal,
} from '@dina/commerce-protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { OwnerCommerceClient } from '../../../src/client/owner-commerce-client';
import { inProcessOwnerDispatcher } from '../../../src/client/owner-dispatch';
import { newBuyerOrder } from '../../../src/commerce/buyer_reconciliation';
import { retainBuyerOrderAndQuote } from '../../../src/commerce/buyer_retention';
import { InMemoryOrderAttachmentRepository } from '../../../src/commerce/order_attachments';
import {
  createCommerceRuntime,
  installCommerceRuntime,
  type CommerceMoneyAccess,
  type CommerceRuntime,
} from '../../../src/commerce/runtime';
import { InMemoryTradeDocumentRepository } from '../../../src/commerce/trade_ledger';
import { addContact, resetContactDirectory } from '../../../src/contacts/directory';
import { setContactRepository, SQLiteContactRepository } from '../../../src/contacts/repository';
import { setPeopleRepository, SQLitePeopleRepository } from '../../../src/people/repository';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';
import {
  BUYER_DID,
  SUPPLIER_DID,
  hash,
  makeAcknowledgement,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
  moneyClosed,
  moneyOpen,
} from '../../commerce/helpers';

const OWNER_CAP = 'test-owner-capability-secret';
const DEVICE = 'did:key:zJiffyIntegration';
const NOW = Date.parse('2026-09-29T09:00:00.000Z');
const REQUEST = makeQuoteRequest();
const QUOTE = makeSignedQuote(REQUEST);

const NON_OWNER: (string | null)[] = [
  null,
  'brain',
  'admin',
  'connector',
  'device',
  'agent',
  'plugin',
  'service',
];

let dir: string;
let adapter: NodeSQLiteAdapter;
let base: CommerceRuntime;
let router: CoreRouter;
let money: () => CommerceMoneyAccess;
let attachments: InMemoryOrderAttachmentRepository;
let documents: InMemoryTradeDocumentRepository;

/** `as` is who is calling; `null` is Brain's in-process transport (no callerType). */
function get(query: Record<string, string> = {}, as: string | null = 'owner'): CoreRequest {
  const callerType = as ?? undefined;
  return {
    method: 'GET',
    path: '/v1/commerce/orders/placed',
    query,
    headers: {},
    body: {},
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(callerType !== undefined ? { callerType, callerDID: 'did:key:caller' } : {}),
    ...(callerType === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
  };
}

/** Record and retain an order exactly as `submitApprovedOrder` does before it sends. */
function placeOrder(id: string, submittedAt: string): PurchaseOrderProposal {
  const order = makeOrder(QUOTE, REQUEST.delivery.projection, {
    purchase_order_id: id,
    idempotency_key: `idem-${id}`,
    submitted_at: submittedAt,
  });
  retainBuyerOrderAndQuote(base, order, QUOTE, NOW);
  const created = base.buyerOrders.create(
    SUPPLIER_DID,
    newBuyerOrder(id, {
      orderDigest: order.order_digest,
      idempotencyKey: order.idempotency_key,
      quoteDigest: order.quote_digest,
      quoteId: order.quote_id,
      buyerDid: order.buyer_did,
      supplierDid: order.supplier_did,
      protocolVersion: order.protocol_version,
      serviceRkey: 'shop',
      orderLines: order.accepted_lines,
    }),
  );
  if (!created) throw new Error('fixture: order already tracked');
  return order;
}

/** The supplier accepts: the settle a real acknowledgement would make. */
function accept(order: PurchaseOrderProposal): void {
  const live = base.buyerOrders.get(SUPPLIER_DID, order.purchase_order_id);
  if (live === null) throw new Error('fixture: no order');
  const ok = base.buyerOrders.put(SUPPLIER_DID, {
    ...live,
    state: 'accepted',
    nextPollAtMs: null,
    acknowledgement: makeAcknowledgement({
      purchase_order_id: order.purchase_order_id,
      order_digest: order.order_digest,
    }),
  });
  if (!ok) throw new Error('fixture: settle lost the CAS');
}

/** An attachment as the supplier's integration seals it, retained inbound as ingress does. */
function arrives(
  order: PurchaseOrderProposal,
  kind: OrderAttachment['kind'],
  payload: Record<string, unknown>,
  at: number,
  over: { expires_at?: string; direction?: 'inbound' | 'outbound'; supplier?: string } = {},
): OrderAttachment {
  const draft = {
    protocol_version: order.protocol_version,
    attachment_id: `att_${kind}_${String(at)}`,
    purchase_order_id: order.purchase_order_id,
    buyer_did: order.buyer_did,
    supplier_did: over.supplier ?? order.supplier_did,
    order_digest: order.order_digest,
    kind,
    source: { kind: 'integration', device_did: DEVICE, provider: 'clover' },
    payload,
    issued_at: new Date(at).toISOString(),
    ...(over.expires_at !== undefined ? { expires_at: over.expires_at } : {}),
  };
  const sealed = {
    ...draft,
    attachment_digest: tradeRecordDigest('order_attachment', draft, hash),
  } as unknown as OrderAttachment;
  attachments.put({
    attachmentDigest: sealed.attachment_digest,
    kind: sealed.kind,
    orderDigest: sealed.order_digest,
    purchaseOrderId: sealed.purchase_order_id,
    counterpartyDid: SUPPLIER_DID,
    direction: over.direction ?? 'inbound',
    sourceDeviceDid: DEVICE,
    commandId: null,
    recordJson: JSON.stringify(sealed),
    evidenceJson: '{}',
    createdAt: at,
  });
  return sealed;
}

/** The buyer's own PaymentNote, as `issuePaymentNote` retains it. */
function recordPayment(orderRefs: string[], externalRef?: string): void {
  const draft = {
    protocol_version: '1.0',
    payment_note_id: `pn-${orderRefs.join('-')}`,
    buyer_did: BUYER_DID,
    supplier_did: SUPPLIER_DID,
    amount: QUOTE.total,
    method: 'upi',
    ...(externalRef !== undefined ? { external_ref: externalRef } : {}),
    paid_at: new Date(NOW).toISOString(),
    order_refs: orderRefs,
  };
  const note = {
    ...draft,
    note_digest: tradeRecordDigest('payment_note', draft, hash),
  } as PaymentNote;
  documents.put({
    recordDigest: note.note_digest,
    kind: 'payment_note',
    counterpartyDid: SUPPLIER_DID,
    purchaseOrderId: '',
    answersDigest: '',
    direction: 'outbound',
    recordJson: JSON.stringify(note),
    evidenceJson: '{}',
    createdAt: NOW,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-orders-placed-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  base = createCommerceRuntime({
    adapter,
    supplierDid: () => BUYER_DID,
    currentEpoch: () => '1',
    now: () => NOW,
  });
  attachments = new InMemoryOrderAttachmentRepository();
  documents = new InMemoryTradeDocumentRepository();
  money = moneyOpen({ orderAttachments: attachments, tradeDocuments: documents });
  // The money line is the plugin registry's to open; the test holds the switch.
  installCommerceRuntime({ ...base, money: () => money() });
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  installCommerceRuntime(null);
  resetContactDirectory();
  setContactRepository(null);
  setPeopleRepository(null);
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Body {
  orders: Record<string, unknown>[];
  evidence: string;
}

describe('GET /v1/commerce/orders/placed', () => {
  it('refuses every non-owner caller', async () => {
    for (const callerType of NON_OWNER) {
      expect((await router.handle(get({}, callerType))).status).toBe(403);
    }
  });

  it('answers 503 commerce_unavailable when the node has no commerce', async () => {
    installCommerceRuntime(null);
    const res = await router.handle(get());
    expect(res).toMatchObject({ status: 503, body: { error: 'commerce_unavailable' } });
  });

  it('an empty node answers an empty list, not an error', async () => {
    const res = await router.handle(get());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orders: [], evidence: 'available' });
  });

  it('lists settled and unsettled orders newest placed first, with the shared headline and the retained total', async () => {
    const first = placeOrder('po-first', '2026-09-28T08:00:00.000Z');
    placeOrder('po-second', '2026-09-29T08:00:00.000Z');
    // Settling the OLDER order must not move it: an UPDATE is not a placement.
    accept(first);

    const res = await router.handle(get());
    expect(res.status).toBe(200);
    const body = res.body as Body;
    expect(body.orders.map((o) => o.purchaseOrderId)).toEqual(['po-second', 'po-first']);
    expect(body.orders[0]).toMatchObject({
      supplierDid: SUPPLIER_DID,
      serviceRkey: 'shop',
      supplierName: null,
      state: 'submitted_unconfirmed',
      headline: 'Sent. Waiting for the supplier to confirm.',
      total: QUOTE.total,
      submittedAt: '2026-09-29T08:00:00.000Z',
      progress: {
        checkoutLink: null,
        payment: null,
        paymentRecorded: false,
        fulfilment: null,
      },
    });
    expect(body.orders[1]).toMatchObject({
      state: 'accepted',
      headline: 'Accepted by the supplier.',
      actions: ['view_acknowledgement', 'check_status'],
      total: QUOTE.total,
    });
    // The order digest is how the route joins evidence; it is not part of the view.
    expect(body.orders[0]).not.toHaveProperty('orderDigest');
  });

  it('carries the accepted lines, named as the supplier named them, and the tender the quote answered', async () => {
    // Reported on the iPhone: My Orders said only "ValueCrumb Bakery · USD
    // 170.00", with no item and no way back to the tender's bargaining.
    const [line] = QUOTE.lines;
    if (line === undefined) throw new Error('fixture: quote has no line');
    const named = makeSignedQuote(REQUEST, {
      lines: [{ ...line, substitution_evidence: ['matched "cake" to "Floral Celebration Cake"'] }],
    });
    base.buyerQuotes.append({
      supplierDid: SUPPLIER_DID,
      quoteId: named.quote_id,
      quote: named,
      acceptedAt: NOW,
    });
    base.tenders.putTender({
      tenderId: 'tnd-cake',
      linesJson: '[]',
      projectionJson: '{}',
      requestedTermsJson: '{}',
      expiresAt: NOW + 86_400_000,
      createdAt: NOW,
    });
    base.tenders.putMember({
      tenderId: 'tnd-cake',
      supplierDid: SUPPLIER_DID,
      requestId: REQUEST.request_id,
      requestDigest: REQUEST.request_digest,
      quoteId: QUOTE.quote_id,
      serviceRkey: 'shop',
    });
    placeOrder('po-cake', '2026-09-29T08:00:00.000Z');

    const body = (await router.handle(get())).body as Body;
    expect(body.orders[0]).toMatchObject({
      quoteId: QUOTE.quote_id,
      tenderId: 'tnd-cake',
      lines: [
        {
          lineId: line.line_id,
          product: line.offered_product,
          quantity: line.quantity,
          name: 'Floral Celebration Cake',
        },
      ],
    });
  });

  it('an order from no tender, whose quote named nothing, says so rather than guessing', async () => {
    placeOrder('po-plain', '2026-09-29T08:00:00.000Z');
    const body = (await router.handle(get())).body as Body;
    expect(body.orders[0]).toMatchObject({ tenderId: null, quoteId: QUOTE.quote_id });
    expect((body.orders[0]?.lines as { name: unknown }[])[0]?.name).toBeNull();
  });

  it('names a supplier the owner keeps as a contact', async () => {
    setPeopleRepository(new SQLitePeopleRepository(adapter));
    setContactRepository(new SQLiteContactRepository(adapter));
    resetContactDirectory();
    addContact(SUPPLIER_DID, 'ValueCrumb Bakery', 'verified');
    placeOrder('po-named', '2026-09-29T08:00:00.000Z');
    const body = (await router.handle(get())).body as Body;
    expect(body.orders[0]).toMatchObject({ supplierName: 'ValueCrumb Bakery' });
  });

  it('summarises the payment link, the processor, the buyer’s own record and the newest fulfilment step', async () => {
    const order = placeOrder('po-paid', '2026-09-29T08:00:00.000Z');
    accept(order);
    const later = new Date(NOW + 86_400_000).toISOString();
    arrives(
      order,
      'checkout_handoff',
      { session_ref: 'cs_old', url: 'https://pay.example.com/old', amount: order.approved_total },
      NOW - 5_000,
      { expires_at: later },
    );
    arrives(
      order,
      'checkout_handoff',
      { session_ref: 'cs_new', url: 'https://pay.example.com/new', amount: order.approved_total },
      NOW - 4_000,
      { expires_at: later },
    );
    arrives(
      order,
      'payment_evidence',
      { provider_ref: 'pay_1', amount: order.approved_total, state: 'authorized', version: '1' },
      NOW - 3_000,
    );
    arrives(
      order,
      'payment_evidence',
      { provider_ref: 'pay_1', amount: order.approved_total, state: 'captured', version: '2' },
      NOW - 2_900,
    );
    arrives(
      order,
      'fulfilment_evidence',
      { provider_ref: 'ship_1', state: 'production_started', version: '1' },
      NOW - 2_000,
    );
    arrives(
      order,
      'fulfilment_evidence',
      { provider_ref: 'ship_1', state: 'handed_to_carrier', version: '3' },
      NOW - 1_000,
    );
    // An older-numbered revision arriving late does not move the step back.
    arrives(
      order,
      'fulfilment_evidence',
      { provider_ref: 'ship_1', state: 'ready', version: '2' },
      NOW - 500,
    );
    // What THIS node's own connector authored (a node that also supplies) is not the buyer's evidence.
    arrives(
      order,
      'fulfilment_evidence',
      { provider_ref: 'ship_x', state: 'production_started', version: '9' },
      NOW - 100,
      { direction: 'outbound' },
    );

    let body = (await router.handle(get())).body as Body;
    expect(body.orders[0]?.progress).toEqual({
      checkoutLink: {
        url: 'https://pay.example.com/new',
        amount: order.approved_total,
        provider: 'clover',
        expiresAt: later,
        expired: false,
      },
      payment: { state: 'captured', amount: order.approved_total, provider: 'clover' },
      paymentRecorded: false,
      fulfilment: {
        state: 'handed_to_carrier',
        provider: 'clover',
        reportedAt: new Date(NOW - 1_000).toISOString(),
      },
    });

    // The buyer records the payment (a yes on the "record as paid?" card).
    recordPayment(['po-paid'], 'pay_1');
    body = (await router.handle(get())).body as Body;
    expect(body.orders[0]?.progress).toMatchObject({ paymentRecorded: true });
  });

  it('a lapsed link is history: returned with expired = true', async () => {
    const order = placeOrder('po-lapsed', '2026-09-29T08:00:00.000Z');
    accept(order);
    const lapsed = new Date(NOW - 1_000).toISOString();
    arrives(
      order,
      'checkout_handoff',
      { session_ref: 'cs_1', url: 'https://pay.example.com/1', amount: order.approved_total },
      NOW - 60_000,
      { expires_at: lapsed },
    );
    const body = (await router.handle(get())).body as Body;
    expect(body.orders[0]?.progress).toMatchObject({
      checkoutLink: { url: 'https://pay.example.com/1', expiresAt: lapsed, expired: true },
    });
  });

  it('a payment note for ANOTHER order does not mark this one paid', async () => {
    const order = placeOrder('po-unpaid', '2026-09-29T08:00:00.000Z');
    accept(order);
    recordPayment(['po-somewhere-else']);
    const body = (await router.handle(get())).body as Body;
    expect(body.orders[0]?.progress).toMatchObject({ paymentRecorded: false });
  });

  it('with the money line closed every order is still listed, with no progress and the reason', async () => {
    const order = placeOrder('po-closed', '2026-09-29T08:00:00.000Z');
    arrives(
      order,
      'fulfilment_evidence',
      { provider_ref: 'ship_1', state: 'production_started', version: '1' },
      NOW - 1_000,
    );
    money = moneyClosed('pack_paused');
    const res = await router.handle(get());
    expect(res.status).toBe(200);
    const body = res.body as Body;
    expect(body.evidence).toBe('pack_paused');
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).toMatchObject({ purchaseOrderId: 'po-closed', progress: null });
  });

  it('honours limit and refuses one outside 1–100', async () => {
    placeOrder('po-a', '2026-09-27T08:00:00.000Z');
    placeOrder('po-b', '2026-09-28T08:00:00.000Z');
    placeOrder('po-c', '2026-09-29T08:00:00.000Z');
    const page = (await router.handle(get({ limit: '2' }))).body as Body;
    expect(page.orders.map((o) => o.purchaseOrderId)).toEqual(['po-c', 'po-b']);
    for (const limit of ['0', '101', 'ten', '-1', '1.5']) {
      expect(await router.handle(get({ limit }))).toMatchObject({
        status: 400,
        body: { error: 'invalid_limit' },
      });
    }
  });

  it('the owner client reads it through the same route', async () => {
    placeOrder('po-client', '2026-09-29T08:00:00.000Z');
    const client = new OwnerCommerceClient(inProcessOwnerDispatcher(router, OWNER_CAP));
    const answer = await client.placedOrders(5);
    expect(answer.evidence).toBe('available');
    expect(answer.orders).toEqual([
      expect.objectContaining({
        purchaseOrderId: 'po-client',
        supplierDid: SUPPLIER_DID,
        headline: 'Sent. Waiting for the supplier to confirm.',
      }),
    ]);
    await expect(client.placedOrders(0)).rejects.toMatchObject({
      status: 400,
      errorKey: 'invalid_limit',
    });
  });
});
