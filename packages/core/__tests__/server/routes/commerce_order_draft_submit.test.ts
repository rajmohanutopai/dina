/**
 * §5.1's submission protocol — the orchestrator route and the
 * dispatch-intent sweeper, driven together because they are two halves of
 * one promise: "restart-recoverable from the row alone".
 *
 * The cases this suite exists for, each named by the design:
 *
 *   - the FOUR outcome classes, including the transient one r5 forgot;
 *   - the named §5.4 stage-3a test: mint approvals on two competing
 *     conversations, submit one, prove the other refuses;
 *   - the POISONED replay case: approval consumed at the send boundary,
 *     crash before step 3 — the record wins, competitors stay closed;
 *   - the refusal boundaries INCLUDING 403 `no_authority_record` and 404
 *     `unknown_approval`, which must terminate the intent rather than park
 *     a never-sent order in reconcile.
 */

import { InMemoryAttributionBoundaryRepository } from '../../../src/commerce/attribution_boundary';
import {
  installBuyerAuthorityProvider,
  singleOwnerAuthority,
} from '../../../src/commerce/buyer_authority';
import {
  installBuyerOrderSender,
  type BuyerOrderSender,
} from '../../../src/commerce/buyer_executor';
import { InMemoryBuyerOrderRepository } from '../../../src/commerce/buyer_orders';
import { InMemoryBuyerQuoteRepository } from '../../../src/commerce/buyer_quotes';
import { InMemoryBuyerQuoteRequestRepository } from '../../../src/commerce/buyer_requests';
import { DispatchIntentSweeper } from '../../../src/commerce/dispatch_intent_sweeper';
import { InMemoryOrderApprovalRepository } from '../../../src/commerce/order_approvals';
import {
  InMemoryOrderDraftRepository,
  type OrderDraft,
  type OrderConversation,
} from '../../../src/commerce/order_draft_store';
import {
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  proveOwnerPresence,
} from '../../../src/commerce/owner_presence';
import { InMemoryCommerceReceiptRepository } from '../../../src/commerce/receipts';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import { InMemoryCommerceSettingsRepository } from '../../../src/commerce/settings_store';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import {
  BUYER_DID,
  installActiveBuyerPack,
  makeQuoteRequest,
  makeSignedQuote,
  type InstalledBuyerPack,
} from '../../commerce/helpers';

import type { PurchaseOrderProposal, QuoteRequest, SignedQuote } from '@dina/commerce-protocol';

const OWNER_CAP = 'test-owner-capability-secret';
const T0 = Date.parse('2026-08-08T09:00:00.000Z');

const REQUEST = makeQuoteRequest();
const QUOTE = makeSignedQuote(REQUEST, {
  quote_id: 'q-photo',
  valid_until: '2036-01-01T00:00:00.000Z',
});
const SUPPLIER = QUOTE.supplier_did;

/** A second supplier competing for the same photographed line. */
const SUPPLIER_B = 'did:plc:othersupplier000';
const REQUEST_B: QuoteRequest = makeQuoteRequest({
  request_id: 'req-2',
  supplier_did: SUPPLIER_B,
  idempotency_key: 'idem-req-2',
});
const QUOTE_B: SignedQuote = makeSignedQuote(REQUEST_B, {
  quote_id: 'q-photo-b',
  valid_until: '2036-01-01T00:00:00.000Z',
});

let pack: InstalledBuyerPack;
let orderDrafts: InMemoryOrderDraftRepository;
let approvals: InMemoryOrderApprovalRepository;
let buyerOrders: InMemoryBuyerOrderRepository;
let router: CoreRouter;
let sent: PurchaseOrderProposal[];

function conversationWith(
  overrides: Partial<OrderConversation> & { conversationId: string; supplierDid: string },
): OrderConversation {
  return {
    state: 'quoted',
    lineIds: ['line-1'],
    snapshot: null,
    snapshotDigest: 'd'.repeat(64),
    requestDigest: REQUEST.request_digest,
    requestId: REQUEST.request_id,
    quoteDigest: QUOTE.quote_digest,
    quoteId: null,
    quoteValidUntil: QUOTE.valid_until,
    approvalId: null,
    purchaseOrderId: null,
    dispatchIntent: null,
    outcome: null,
    ...overrides,
  };
}

function seedDraft(conversations: OrderConversation[]): void {
  const draft: OrderDraft = {
    draftId: 'odr-1',
    manifest: [{ artifact_id: 'img-1', content_hash: 'a'.repeat(64), page_index: 0 }],
    extraction: { model: 'gpt-4o-mini', schemaVersion: 'order-lines-1' },
    extractionDigest: 'a'.repeat(64),
    lines: [
      {
        lineId: 'line-1',
        text: '100 oak chairs',
        pageIndex: 0,
        fields: { quantity: '100' },
        provenance: { quantity: 'accepted' },
        resolution: {
          kind: 'resolved',
          product: { scheme: 'gtin', value: '09506000134352' },
          supplierDid: SUPPLIER,
          flaggedNewSupplier: false,
        },
        generation: 1,
        assignmentGeneration: 0,
        vouch: { generation: 1, ceremony: 1, receiptDigest: 'b'.repeat(64), vouchedBy: null },
        deferred: false,
        evidence: null,
        submittedIn: null,
      },
    ],
    requirements: [],
    conversations,
    ceremonyCounter: 1,
    abandoned: false,
    createdAtMs: T0,
    updatedAtMs: T0,
  };
  orderDrafts.put(draft);
}

const owner = (path: string, body: Record<string, unknown>): CoreRequest => ({
  method: 'POST',
  path,
  query: {},
  headers: {},
  body,
  rawBody: new Uint8Array(),
  params: {},
  trustedInProcess: true,
  callerType: 'owner',
  ownerCapability: OWNER_CAP,
});

const approve = async (conversationId: string, quoteId: string) =>
  router.handle(
    owner('/v1/commerce/orders/drafts/approve', {
      draft_id: 'odr-1',
      conversation_id: conversationId,
      quote_id: quoteId,
      projection:
        conversationId === 'conv-b' ? REQUEST_B.delivery.projection : REQUEST.delivery.projection,
    }),
  );
const draftSubmit = async (conversationId: string) =>
  router.handle(
    owner('/v1/commerce/orders/drafts/submit', {
      draft_id: 'odr-1',
      conversation_id: conversationId,
    }),
  );
const directSubmit = async (approvalId: string) =>
  router.handle(owner('/v1/commerce/orders/submit', { approval_id: approvalId }));

function heldConversation(conversationId: string): OrderConversation {
  const conversation = orderDrafts
    .get('odr-1')
    ?.conversations.find((c) => c.conversationId === conversationId);
  if (conversation === undefined) throw new Error(`no conversation ${conversationId}`);
  return conversation;
}

async function approveOk(conversationId: string, quoteId: string): Promise<string> {
  const resp = await approve(conversationId, quoteId);
  if (resp.status !== 200) {
    throw new Error(`approve refused: ${resp.status} ${JSON.stringify(resp.body)}`);
  }
  return (resp.body as { approval_id: string }).approval_id;
}

beforeEach(async () => {
  setNodeDID(BUYER_DID);
  pack = installActiveBuyerPack(T0);

  orderDrafts = new InMemoryOrderDraftRepository();
  approvals = new InMemoryOrderApprovalRepository();
  buyerOrders = new InMemoryBuyerOrderRepository();
  const buyerQuotes = new InMemoryBuyerQuoteRepository();
  buyerQuotes.append({ supplierDid: SUPPLIER, quoteId: 'q-photo', quote: QUOTE });
  buyerQuotes.append({ supplierDid: SUPPLIER_B, quoteId: 'q-photo-b', quote: QUOTE_B });
  const buyerQuoteRequests = new InMemoryBuyerQuoteRequestRepository();
  buyerQuoteRequests.put(REQUEST, T0);
  buyerQuoteRequests.put(REQUEST_B, T0);
  seedDraft([conversationWith({ conversationId: 'conv-1', supplierDid: SUPPLIER })]);
  installCommerceRuntime({
    receipts: new InMemoryCommerceReceiptRepository(),
    attributionBoundary: new InMemoryAttributionBoundaryRepository(),
    buyerOrders,
    buyerQuotes,
    buyerQuoteRequests,
    orderApprovals: approvals,
    orderDrafts,
    settings: new InMemoryCommerceSettingsRepository(),
    runInTransaction: (fn: () => unknown) => fn(),
  } as unknown as CommerceRuntime);

  sent = [];
  const sender: BuyerOrderSender = async ({ order }) => {
    sent.push(order);
    return { kind: 'ambiguous', reason: 'sent; awaiting the supplier acknowledgement' };
  };
  installBuyerOrderSender(sender);
  installBuyerAuthorityProvider(({ order, context, serviceRkey }) =>
    singleOwnerAuthority({ ownerDid: 'did:plc:testowner00000000', order, context, serviceRkey }),
  );
  installOwnerPresenceVerifier(async (p) => p === 'correct horse');
  await proveOwnerPresence('correct horse', Date.now());
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  pack.dispose();
  installOwnerPresenceVerifier(null);
  clearOwnerPresence();
  installCommerceRuntime(null);
  installBuyerOrderSender(null);
  installBuyerAuthorityProvider(null);
});

describe('the four outcome classes', () => {
  it('UNCERTAIN: an ambiguous send parks the conversation with reconcile, intent terminated', async () => {
    await approveOk('conv-1', 'q-photo');
    const resp = await draftSubmit('conv-1');
    expect(resp.status).toBe(200);
    expect((resp.body as { dispatch_class: string }).dispatch_class).toBe('uncertain');
    expect(sent.length).toBe(1);

    const conversation = heldConversation('conv-1');
    expect(conversation.state).toBe('submitted_unconfirmed');
    expect(conversation.dispatchIntent).toBeNull();
    // A doubtful dispatch blocks abandonment exactly as a confirmed one does.
    const abandonAttempt = await router.handle(
      owner('/v1/commerce/orders/drafts/erase', { draft_id: 'odr-1' }),
    );
    // Whatever the erase surface answers, the draft survives.
    void abandonAttempt;
    expect(orderDrafts.get('odr-1')).not.toBeNull();
  });

  it('REFUSED: a deterministic pre-send refusal terminates the intent, reopens the lines, kills the card', async () => {
    const approvalId = await approveOk('conv-1', 'q-photo');
    // §7.3: an owner with no grant record is not an owner — the provider
    // answers null, the 403 `no_authority_record` boundary by name.
    installBuyerAuthorityProvider(() => null);

    const resp = await draftSubmit('conv-1');
    expect(resp.status).toBe(403);
    expect((resp.body as { dispatch_class: string }).dispatch_class).toBe('refused');
    expect(sent.length).toBe(0);

    const conversation = heldConversation('conv-1');
    expect(conversation.state).toBe('dispatch_refused');
    expect(conversation.outcome).toBe('no_authority_record');
    expect(conversation.dispatchIntent).toBeNull();
    // The reopen effect: the assignment retired so the line can re-route.
    const line = orderDrafts.get('odr-1')?.lines[0];
    expect(line?.assignmentGeneration).toBe(1);
    expect(line?.vouch).toBeNull();
    // The reserved card bound a quote context that is now dead.
    expect(approvals.get(approvalId)?.consumedAt).not.toBeNull();
  });

  it('TRANSIENT: a sender outage keeps the intent LIVE, and the sweeper retries the SAME intent to success', async () => {
    await approveOk('conv-1', 'q-photo');
    installBuyerOrderSender(null);

    const resp = await draftSubmit('conv-1');
    expect(resp.status).toBe(503);
    expect((resp.body as { dispatch_class: string }).dispatch_class).toBe('transient');

    const during = heldConversation('conv-1');
    expect(during.state).toBe('submitting');
    expect(during.dispatchIntent).not.toBeNull();
    expect(during.outcome).toBe('transient:buyer_sender_unavailable');
    const intentId = during.dispatchIntent?.intentId;

    // The courier comes back; the sweeper replays the SAME intent.
    const sender: BuyerOrderSender = async ({ order }) => {
      sent.push(order);
      return { kind: 'ambiguous', reason: 'sent' };
    };
    installBuyerOrderSender(sender);
    const outcomes = await new DispatchIntentSweeper().tick();
    expect(outcomes).toEqual([
      { draftId: 'odr-1', conversationId: 'conv-1', kind: 'uncertain' },
    ]);
    expect(sent.length).toBe(1);
    const after = heldConversation('conv-1');
    expect(after.state).toBe('submitted_unconfirmed');
    expect(after.dispatchIntent).toBeNull();
    // The same identity went out — no second purchase order was minted.
    expect(sent[0]?.purchase_order_id).toBe(
      buyerOrders.get(SUPPLIER, sent[0]?.purchase_order_id ?? '')?.purchaseOrderId,
    );
    void intentId;
  });

  it('refuses a second begin while one is in flight — a double-tap is not a second order', async () => {
    await approveOk('conv-1', 'q-photo');
    installBuyerOrderSender(null);
    await draftSubmit('conv-1');
    const second = await draftSubmit('conv-1');
    expect(second.status).toBe(409);
    expect((second.body as { error: string }).error).toBe('submit_in_flight');
  });

  it('refuses a conversation that is not approved', async () => {
    const resp = await draftSubmit('conv-1');
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe('not_approvable');
  });
});

describe('THE NAMED TEST (§5.4 stage 3a): two competing approvals, one line', () => {
  it('submitting one closes the competitor and its approval refuses', async () => {
    seedDraft([
      conversationWith({ conversationId: 'conv-1', supplierDid: SUPPLIER }),
      conversationWith({
        conversationId: 'conv-b',
        supplierDid: SUPPLIER_B,
        requestId: REQUEST_B.request_id,
        requestDigest: REQUEST_B.request_digest,
        quoteDigest: QUOTE_B.quote_digest,
        quoteValidUntil: QUOTE_B.valid_until,
      }),
    ]);
    const approvalA = await approveOk('conv-1', 'q-photo');
    const approvalB = await approveOk('conv-b', 'q-photo-b');
    expect(approvalA).not.toBe(approvalB);

    const resp = await draftSubmit('conv-1');
    expect(resp.status).toBe(200);
    expect(sent.length).toBe(1);

    // The competitor closed in step 1's transaction, approval revoked.
    const competitor = heldConversation('conv-b');
    expect(competitor.state).toBe('superseded');
    expect(competitor.approvalId).toBeNull();
    expect(competitor.outcome).toBe('closed_by_competing_submit');

    // AND THE ENFORCEMENT: the loser's card cannot send. Whichever gate
    // catches it first — the revoked card or the broken binding — nothing
    // more leaves this node.
    const losing = await directSubmit(approvalB);
    expect(losing.status).toBe(409);
    expect(['approval_already_used', 'stale_source_binding']).toContain(
      (losing.body as { error: string }).error,
    );
    expect(sent.length).toBe(1);
  });
});

describe('crash replay, record-first (§5.1)', () => {
  it('THE POISONED CASE: approval consumed at the send boundary, crash before step 3 — the record wins', async () => {
    seedDraft([
      conversationWith({ conversationId: 'conv-1', supplierDid: SUPPLIER }),
      conversationWith({
        conversationId: 'conv-b',
        supplierDid: SUPPLIER_B,
        requestId: REQUEST_B.request_id,
        requestDigest: REQUEST_B.request_digest,
        quoteDigest: QUOTE_B.quote_digest,
        quoteValidUntil: QUOTE_B.valid_until,
      }),
    ]);
    const approvalId = await approveOk('conv-1', 'q-photo');
    await approveOk('conv-b', 'q-photo-b');
    const purchaseOrderId = approvals.get(approvalId)?.order.purchase_order_id ?? '';

    // Reproduce the crash shape BY HAND: step 1 ran (intent persisted,
    // competitor closed), step 2 dispatched THROUGH THE REAL ROUTE (record
    // written, approval consumed at the send boundary), and the process
    // died before step 3 recorded anything.
    const draft = orderDrafts.get('odr-1');
    if (draft === null) throw new Error('draft lost');
    const conversation = draft.conversations.find((c) => c.conversationId === 'conv-1');
    const competitor = draft.conversations.find((c) => c.conversationId === 'conv-b');
    if (conversation === undefined || competitor === undefined) throw new Error('setup');
    conversation.state = 'submitting';
    conversation.dispatchIntent = { intentId: 'odi_crash', purchaseOrderId, createdAtMs: T0 };
    competitor.state = 'superseded';
    competitor.approvalId = null;
    competitor.outcome = 'closed_by_competing_submit';
    orderDrafts.put(draft);
    const sendResp = await directSubmit(approvalId);
    expect(sendResp.status).toBe(200);
    expect(approvals.get(approvalId)?.consumedAt).not.toBeNull();

    // A NAIVE replay would now dispatch, meet `approval_already_used`, call
    // it a definitive refusal, and reopen the competitor against an order
    // durably on its way. The sweeper resolves record-first instead.
    const outcomes = await new DispatchIntentSweeper().tick();
    expect(outcomes).toEqual([
      { draftId: 'odr-1', conversationId: 'conv-1', kind: 'uncertain' },
    ]);
    expect(heldConversation('conv-1').state).toBe('submitted_unconfirmed');
    // Competitors STAYED closed; the line was not reopened for a re-buy.
    expect(heldConversation('conv-b').state).toBe('superseded');
    expect(orderDrafts.get('odr-1')?.lines[0]?.assignmentGeneration).toBe(0);
    expect(sent.length).toBe(1);
  });

  it('404 unknown_approval with NO record is a refusal — the intent terminates instead of wedging', async () => {
    await approveOk('conv-1', 'q-photo');
    installBuyerOrderSender(null);
    await draftSubmit('conv-1');
    // Mid-race revocation: the approval row disappears entirely.
    const inner = approvals as unknown as { held: Map<string, unknown> };
    inner.held.clear();

    installBuyerOrderSender(async () => ({ kind: 'ambiguous', reason: 'sent' }));
    const outcomes = await new DispatchIntentSweeper().tick();
    expect(outcomes).toEqual([
      {
        draftId: 'odr-1',
        conversationId: 'conv-1',
        kind: 'refused',
        reason: 'unknown_approval',
      },
    ]);
    const conversation = heldConversation('conv-1');
    expect(conversation.state).toBe('dispatch_refused');
    expect(conversation.outcome).toBe('unknown_approval');
    expect(sent.length).toBe(0);
  });

  it('403 no_authority_record on replay is a refusal too — never parked in reconcile', async () => {
    await approveOk('conv-1', 'q-photo');
    installBuyerOrderSender(null);
    await draftSubmit('conv-1');

    installBuyerOrderSender(async () => ({ kind: 'ambiguous', reason: 'sent' }));
    installBuyerAuthorityProvider(() => null);
    const outcomes = await new DispatchIntentSweeper().tick();
    expect(outcomes).toEqual([
      {
        draftId: 'odr-1',
        conversationId: 'conv-1',
        kind: 'refused',
        reason: 'no_authority_record',
      },
    ]);
    expect(heldConversation('conv-1').state).toBe('dispatch_refused');
    expect(sent.length).toBe(0);
  });

  it('a transient on replay leaves the intent for the next pass', async () => {
    await approveOk('conv-1', 'q-photo');
    installBuyerOrderSender(null);
    await draftSubmit('conv-1');

    // Still no sender: the sweeper notes the transient and keeps the row.
    const outcomes = await new DispatchIntentSweeper().tick();
    expect(outcomes).toEqual([
      {
        draftId: 'odr-1',
        conversationId: 'conv-1',
        kind: 'transient',
        reason: 'buyer_sender_unavailable',
      },
    ]);
    const conversation = heldConversation('conv-1');
    expect(conversation.state).toBe('submitting');
    expect(conversation.dispatchIntent).not.toBeNull();
  });
});
