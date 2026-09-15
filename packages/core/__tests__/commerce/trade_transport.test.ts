/**
 * The khata transport (TRADE_FIRST_STRATEGY §4.2/§4.3): an authored
 * document leaves the owner route as a `commerce.trade` D2D message and
 * lands in the counterparty's trade ledger through the REAL receive
 * pipeline — sealed, signed, contact-gated, verified against the
 * retained order, and retained with its envelope evidence.
 */

import { TEST_ED25519_SEED } from '@dina/test-harness';

import { resetAuditState } from '../../src/audit/service';
import { InMemoryCommerceReceiptRepository } from '../../src/commerce/receipts';
import {
  getCommerceRuntime,
  installCommerceRuntime,
  type CommerceMoneyAccess,
  type CommerceRuntime,
} from '../../src/commerce/runtime';
import { buildTradeInbox } from '../../src/commerce/trade_inbox';
import { applyInboundTradeDocument, drainTradeSpool } from '../../src/commerce/trade_ingress';
import { InMemoryTradeDocumentRepository } from '../../src/commerce/trade_ledger';
import { InMemoryTradeSpoolRepository, MAX_TRADE_SPOOL_ROWS } from '../../src/commerce/trade_spool';
import { getPublicKey } from '../../src/crypto/ed25519';
import { sealMessage, type DinaMessage } from '../../src/d2d/envelope';
import { addContact, clearGatesState } from '../../src/d2d/gates';
import { receiveD2D } from '../../src/d2d/receive_pipeline';
import { setNodeDID } from '../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerCommerceRoutes } from '../../src/server/routes/commerce';
import { setD2DSender } from '../../src/server/routes/d2d_msg';
import { clearReplayCache } from '../../src/transport/adversarial';

import {
  BUYER_DID,
  SUPPLIER_DID,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
  moneyClosed,
  moneyOpen,
} from './helpers';

const OWNER_CAP = 'test-owner-capability-secret';
const T0 = 1_800_000_000_000;

const REQUEST = makeQuoteRequest();
const QUOTE = makeSignedQuote(REQUEST);
const ORDER = makeOrder(QUOTE, REQUEST.delivery.projection);

const supplierPriv = TEST_ED25519_SEED;
const supplierPub = getPublicKey(supplierPriv);
const buyerPriv = new Uint8Array(32).fill(0x42);
const buyerPub = getPublicKey(buyerPriv);

function owner(path: string, body: Record<string, unknown>): CoreRequest {
  return {
    method: 'POST',
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'owner',
    callerDID: 'did:key:owner',
    ownerCapability: OWNER_CAP,
  } as unknown as CoreRequest;
}

/** Install a runtime holding the retained ORDER + QUOTE + acceptance. */
function installNode(
  nodeDid: string,
  money: () => CommerceMoneyAccess = moneyOpen(),
): InMemoryTradeDocumentRepository {
  const tradeDocs = new InMemoryTradeDocumentRepository();
  const receipts = new InMemoryCommerceReceiptRepository();
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
  installCommerceRuntime(nodeRuntime(nodeDid, receipts, tradeDocs, money, new InMemoryTradeSpoolRepository()));
  return tradeDocs;
}

/** The node's runtime: the money line resolves per call; an OPEN line serves THIS node's khata store. */
function nodeRuntime(
  nodeDid: string,
  receipts: InMemoryCommerceReceiptRepository,
  tradeDocs: InMemoryTradeDocumentRepository,
  money: () => CommerceMoneyAccess,
  tradeSpool: InMemoryTradeSpoolRepository,
): CommerceRuntime {
  return {
    money: () => {
      const line = money();
      return line.available ? { ...line, stores: { ...line.stores, tradeDocuments: tradeDocs } } : line;
    },
    receipts,
    tradeSpool,
    nodeDid: () => nodeDid,
    now: () => T0,
  } as unknown as CommerceRuntime;
}

afterEach(() => {
  installCommerceRuntime(null);
  setD2DSender(null);
  clearGatesState();
  clearReplayCache();
  resetAuditState();
});

describe('the send leg: an authored note leaves as commerce.trade', () => {
  it('dispatches to the buyer and reports it; a sender-less node retains and says so', async () => {
    setNodeDID(SUPPLIER_DID);
    installNode(SUPPLIER_DID);
    const sent: { toDid: string; type: string; body: Record<string, unknown> }[] = [];
    setD2DSender(async (toDid, type, body) => {
      sent.push({ toDid, type, body });
      return { messageId: 'm1', delivered: true, buffered: false, queued: false };
    });
    const router = new CoreRouter();
    registerCommerceRoutes(router, OWNER_CAP);

    const answered = await router.handle(
      owner('/v1/commerce/trade/delivery-note', {
        counterparty_did: BUYER_DID,
        purchase_order_id: ORDER.purchase_order_id,
        supplier_order_id: 'so-1',
        lines: [{ line_id: 'l1', delivered_quantity: { value: '60', unit_code: 'each' } }],
      }),
    );
    expect(answered.status).toBe(200);
    expect((answered.body as { dispatched: boolean }).dispatched).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.toDid).toBe(BUYER_DID);
    expect(sent[0]?.type).toBe('commerce.trade');
    expect(sent[0]?.body.kind).toBe('delivery_note');

    // No transport: the document is still authored and retained — the
    // sweeps own the follow-up — and the answer says nothing left.
    setD2DSender(null);
    const undispatched = await router.handle(
      owner('/v1/commerce/trade/delivery-note', {
        counterparty_did: BUYER_DID,
        purchase_order_id: ORDER.purchase_order_id,
        supplier_order_id: 'so-1',
        lines: [{ line_id: 'l1', delivered_quantity: { value: '40', unit_code: 'each' } }],
      }),
    );
    expect(undispatched.status).toBe(200);
    expect((undispatched.body as { dispatched: boolean }).dispatched).toBe(false);
  });
});

describe('the receive leg: the REAL pipeline lands the document in the ledger', () => {
  function sealedTrade(bodyJson: string, overrides?: Partial<DinaMessage>): ReturnType<typeof sealMessage> {
    const msg: DinaMessage = {
      id: `trade-${Math.random().toString(36).slice(2)}`,
      type: 'commerce.trade',
      from: SUPPLIER_DID,
      to: BUYER_DID,
      created_time: T0,
      body: bodyJson,
      ...overrides,
    };
    return sealMessage(msg, supplierPriv, buyerPub);
  }

  /** Author a real note on the supplier, capture the wire body. */
  async function authoredWireBody(): Promise<string> {
    setNodeDID(SUPPLIER_DID);
    installNode(SUPPLIER_DID);
    let captured = '';
    setD2DSender(async (_toDid, _type, body) => {
      captured = JSON.stringify(body);
      return { messageId: 'm1', delivered: true, buffered: false, queued: false };
    });
    const router = new CoreRouter();
    registerCommerceRoutes(router, OWNER_CAP);
    const answered = await router.handle(
      owner('/v1/commerce/trade/delivery-note', {
        counterparty_did: BUYER_DID,
        purchase_order_id: ORDER.purchase_order_id,
        supplier_order_id: 'so-1',
        lines: [{ line_id: 'l1', delivered_quantity: { value: '60', unit_code: 'each' } }],
      }),
    );
    expect(answered.status).toBe(200);
    installCommerceRuntime(null);
    setD2DSender(null);
    return captured;
  }

  it('a contact’s pushed note verifies, retains with envelope evidence, and replays as duplicate', async () => {
    const wireBody = await authoredWireBody();

    // The BUYER node.
    setNodeDID(BUYER_DID);
    const buyerDocs = installNode(BUYER_DID);
    addContact(SUPPLIER_DID);

    const first = receiveD2D(sealedTrade(wireBody), buyerPub, buyerPriv, [supplierPub], 'trusted');
    expect(first.action).toBe('bypassed');
    const rows = buyerDocs.listByOrder(ORDER.purchase_order_id, 'delivery_note');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.direction).toBe('inbound');
    expect(rows[0]?.counterpartyDid).toBe(SUPPLIER_DID);
    // §4.3's stored-verified rule: the retained evidence carries the
    // signature AND the exact signed bytes.
    const evidence = JSON.parse(rows[0]?.evidenceJson ?? '{}') as {
      signature: string;
      envelope: { body: string; from: string };
    };
    expect(evidence.signature).not.toBe('');
    expect(evidence.envelope.from).toBe(SUPPLIER_DID);
    expect(evidence.envelope.body).toBe(wireBody);

    // A byte-identical replay reads as duplicate, still bypassed, still one row.
    const replay = receiveD2D(sealedTrade(wireBody), buyerPub, buyerPriv, [supplierPub], 'trusted');
    expect(replay.action).toBe('bypassed');
    expect(replay.reason).toContain('duplicate');
    expect(buyerDocs.listByOrder(ORDER.purchase_order_id, 'delivery_note')).toHaveLength(1);
  });

  it('with no active Commerce Pack the push is SPOOLED, not retained; it lands once the pack is active (§5.B1 Cut 3)', async () => {
    const wireBody = await authoredWireBody();
    setNodeDID(BUYER_DID);
    // Build the buyer's stores once so the same node can flip its money line.
    const tradeDocs = new InMemoryTradeDocumentRepository();
    const receipts = new InMemoryCommerceReceiptRepository();
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
    const spool = new InMemoryTradeSpoolRepository();
    const line = { open: false };
    installCommerceRuntime(
      nodeRuntime(BUYER_DID, receipts, tradeDocs, () => (line.open ? moneyOpen()() : moneyClosed('pack_paused')()), spool),
    );
    addContact(SUPPLIER_DID);

    // Closed: accepted for later, verified by nobody, retained nowhere.
    const closed = receiveD2D(sealedTrade(wireBody), buyerPub, buyerPriv, [supplierPub], 'trusted');
    expect(closed.action).toBe('bypassed');
    expect(closed.reason).toContain('spooled');
    expect(tradeDocs.listByOrder(ORDER.purchase_order_id, 'delivery_note')).toHaveLength(0);
    expect(spool.count()).toBe(1);

    // The pack comes back: the next ingress replays the mail through the
    // verifiers first — the retained row carries the ORIGINAL envelope evidence.
    line.open = true;
    const replayed = applyInboundTradeDocument({
      senderDid: SUPPLIER_DID,
      body: { nonsense: true },
      evidenceJson: '{}',
      nowMs: T0 + 1,
    });
    expect(replayed.outcome).toBe('unreadable'); // the trigger document itself
    expect(spool.count()).toBe(0);
    const rows = tradeDocs.listByOrder(ORDER.purchase_order_id, 'delivery_note');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.counterpartyDid).toBe(SUPPLIER_DID);
    const evidence = JSON.parse(rows[0]?.evidenceJson ?? '{}') as { envelope: { body: string; from: string } };
    expect(evidence.envelope.from).toBe(SUPPLIER_DID);
    expect(evidence.envelope.body).toBe(wireBody);
  });

  it('the inbox drains the spool too, so a resumed pack sees what waited', async () => {
    const wireBody = await authoredWireBody();
    setNodeDID(BUYER_DID);
    const tradeDocs = new InMemoryTradeDocumentRepository();
    const receipts = new InMemoryCommerceReceiptRepository();
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
    const spool = new InMemoryTradeSpoolRepository();
    const line = { open: false };
    const runtime = {
      ...nodeRuntime(BUYER_DID, receipts, tradeDocs, () => (line.open ? moneyOpen()() : moneyClosed()()), spool),
      orderDrafts: { list: () => [] },
      tenders: { listTenders: () => [] },
      pendingDecisions: { list: () => [] },
    } as unknown as CommerceRuntime;
    installCommerceRuntime(runtime);
    addContact(SUPPLIER_DID);
    receiveD2D(sealedTrade(wireBody), buyerPub, buyerPriv, [supplierPub], 'trusted');
    expect(spool.count()).toBe(1);

    line.open = true;
    const inbox = buildTradeInbox(runtime, T0 + 1);
    expect(spool.count()).toBe(0);
    expect(inbox.items.map((item) => item.kind)).toContain('unreceipted_delivery');
  });

  it('a replayed document is stamped with ITS arrival time, not the moment the pack reopened', async () => {
    const wireBody = await authoredWireBody();
    setNodeDID(BUYER_DID);
    const tradeDocs = new InMemoryTradeDocumentRepository();
    const receipts = new InMemoryCommerceReceiptRepository();
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
    const spool = new InMemoryTradeSpoolRepository();
    const ARRIVED = T0 + 5_000;
    spool.put({ senderDid: SUPPLIER_DID, bodyJson: wireBody, evidenceJson: '{}', receivedAt: ARRIVED });
    installCommerceRuntime(nodeRuntime(BUYER_DID, receipts, tradeDocs, moneyOpen(), spool));
    const line = moneyOpen()();
    if (!line.available) throw new Error('unreachable');
    // The pack reopens much later.
    drainTradeSpool(getCommerceRuntime() as CommerceRuntime, { ...line.stores, tradeDocuments: tradeDocs });
    const rows = tradeDocs.listByOrder(ORDER.purchase_order_id, 'delivery_note');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.createdAt).toBe(ARRIVED);
  });

  it('a spooled row that makes a verifier THROW is dropped, not replayed forever', async () => {
    const wireBody = await authoredWireBody();
    setNodeDID(BUYER_DID);
    const tradeDocs = new InMemoryTradeDocumentRepository();
    const receipts = new InMemoryCommerceReceiptRepository();
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
    const spool = new InMemoryTradeSpoolRepository();
    // The same well-formed note twice: the FIRST replay hits a receipt store
    // whose order reader throws (a corrupt row); the second must still land.
    spool.put({ senderDid: SUPPLIER_DID, bodyJson: wireBody, evidenceJson: '{}', receivedAt: T0 });
    spool.put({ senderDid: SUPPLIER_DID, bodyJson: wireBody, evidenceJson: '{}', receivedAt: T0 + 1 });
    let throwOnce = true;
    const poisonedReceipts = new Proxy(receipts, {
      get(target, prop, receiver) {
        if (prop === 'listByOrder') {
          return (buyerKey: string, purchaseOrderId: string) => {
            if (throwOnce) {
              throwOnce = false;
              throw new Error('corrupt receipt row');
            }
            return target.listByOrder(buyerKey, purchaseOrderId);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    installCommerceRuntime(nodeRuntime(BUYER_DID, poisonedReceipts, tradeDocs, moneyOpen(), spool));

    const line = moneyOpen()();
    if (!line.available) throw new Error('unreachable');
    const summary = drainTradeSpool(getCommerceRuntime() as CommerceRuntime, { ...line.stores, tradeDocuments: tradeDocs });
    expect(summary).toMatchObject({ replayed: 2, faulted: 1, applied: 1 });
    expect(spool.count()).toBe(0);
    expect(tradeDocs.listByOrder(ORDER.purchase_order_id, 'delivery_note')).toHaveLength(1);
  });

  it('a full spool refuses the newest document and keeps the oldest', async () => {
    const wireBody = await authoredWireBody();
    setNodeDID(BUYER_DID);
    const spool = new InMemoryTradeSpoolRepository();
    for (let i = 0; i < MAX_TRADE_SPOOL_ROWS; i++) {
      spool.put({ senderDid: SUPPLIER_DID, bodyJson: '{}', evidenceJson: '{}', receivedAt: T0 });
    }
    installCommerceRuntime(
      nodeRuntime(BUYER_DID, new InMemoryCommerceReceiptRepository(), new InMemoryTradeDocumentRepository(), moneyClosed(), spool),
    );
    addContact(SUPPLIER_DID);
    const result = receiveD2D(sealedTrade(wireBody), buyerPub, buyerPriv, [supplierPub], 'trusted');
    expect(result.action).toBe('dropped');
    expect(result.reason).toContain('spool full');
    expect(spool.count()).toBe(MAX_TRADE_SPOOL_ROWS);
  });

  it('a stranger’s push drops before any verifier runs', async () => {
    const wireBody = await authoredWireBody();
    setNodeDID(BUYER_DID);
    const buyerDocs = installNode(BUYER_DID);
    const result = receiveD2D(sealedTrade(wireBody), buyerPub, buyerPriv, [supplierPub], 'unknown');
    expect(result.action).toBe('dropped');
    expect(result.reason).toContain('not a known contact');
    expect(buyerDocs.listByOrder(ORDER.purchase_order_id, 'delivery_note')).toHaveLength(0);
  });

  it('an unreadable body and an unbindable document drop with named outcomes', async () => {
    setNodeDID(BUYER_DID);
    const buyerDocs = installNode(BUYER_DID);
    addContact(SUPPLIER_DID);

    const garbled = receiveD2D(
      sealedTrade('{"kind":"delivery_note"}'),
      buyerPub,
      buyerPriv,
      [supplierPub],
      'trusted',
    );
    expect(garbled.action).toBe('dropped');
    expect(garbled.reason).toContain('unreadable');

    // A structurally plausible note naming an order this node never
    // retained refuses at the binding check.
    const stray = receiveD2D(
      sealedTrade(
        JSON.stringify({
          kind: 'delivery_note',
          document: {
            protocol_version: '1.0',
            delivery_note_id: 'dn-stray',
            purchase_order_id: 'po-nowhere',
            order_digest: 'a'.repeat(64),
            supplier_order_id: 'so-1',
            lines: [{ line_id: 'l1', delivered_quantity: { value: '1', unit_code: 'each' } }],
            dispatched_at: '2026-08-18T09:00:00.000Z',
          },
        }),
      ),
      buyerPub,
      buyerPriv,
      [supplierPub],
      'trusted',
    );
    expect(stray.action).toBe('dropped');
    expect(buyerDocs.listByCounterparty(SUPPLIER_DID, 'delivery_note')).toHaveLength(0);
  });

  it('commerce not installed: the push drops as unavailable, nothing crashes', async () => {
    const wireBody = await authoredWireBody();
    setNodeDID(BUYER_DID);
    addContact(SUPPLIER_DID);
    // No runtime installed at all.
    const result = receiveD2D(sealedTrade(wireBody), buyerPub, buyerPriv, [supplierPub], 'trusted');
    expect(result.action).toBe('dropped');
    expect(result.reason).toContain('unavailable');
  });
});

describe('the reverse direction: a buyer payment note lands at the supplier', () => {
  it('authored on the buyer, dispatched, verified and retained on the supplier', async () => {
    // Buyer authors + dispatches.
    setNodeDID(BUYER_DID);
    installNode(BUYER_DID);
    let captured = '';
    setD2DSender(async (toDid, type, body) => {
      expect(toDid).toBe(SUPPLIER_DID);
      expect(type).toBe('commerce.trade');
      captured = JSON.stringify(body);
      return { messageId: 'm2', delivered: true, buffered: false, queued: false };
    });
    const router = new CoreRouter();
    registerCommerceRoutes(router, OWNER_CAP);
    const answered = await router.handle(
      owner('/v1/commerce/trade/payment-note', {
        supplier_did: SUPPLIER_DID,
        amount: { currency: 'INR', minor_units: '25000' },
        method: 'cash',
      }),
    );
    expect(answered.status).toBe(200);
    expect((answered.body as { dispatched: boolean }).dispatched).toBe(true);
    installCommerceRuntime(null);
    setD2DSender(null);

    // Supplier receives over the real pipeline (buyer signs this leg).
    setNodeDID(SUPPLIER_DID);
    const supplierDocs = installNode(SUPPLIER_DID);
    addContact(BUYER_DID);
    const msg: DinaMessage = {
      id: 'trade-pn-1',
      type: 'commerce.trade',
      from: BUYER_DID,
      to: SUPPLIER_DID,
      created_time: T0,
      body: captured,
    };
    const sealed = sealMessage(msg, buyerPriv, supplierPub);
    const result = receiveD2D(sealed, supplierPub, supplierPriv, [buyerPub], 'trusted');
    expect(result.action).toBe('bypassed');
    expect(supplierDocs.listByCounterparty(BUYER_DID, 'payment_note')).toHaveLength(1);
  });
});
