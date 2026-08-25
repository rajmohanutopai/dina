/**
 * §5.4 stage 4 — the draft-scoped APPROVE, where the photo lane meets the
 * §15.2 approval machinery. What these cases exist to prove:
 *
 * - CORE BUILDS THE ORDER. The caller names a draft, a conversation, a
 *   quote id and a delivery projection — never an order, never a context,
 *   never an install. Everything bound into the card is Core's own fact:
 *   the accepted revision from the verified quote store, the active buyer
 *   pack from the install registry, the source binding from the draft's
 *   current generations.
 * - The presence gate is UNCONDITIONAL here. A node with no verifier can
 *   still run the legacy prepare path; a photo-derived order it cannot
 *   approve at all, and says so.
 * - The minted approval SUBMITS through the real `/orders/submit`, and the
 *   submit-time source-binding check kills it the moment the draft moves.
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
import { InMemoryOrderApprovalRepository } from '../../../src/commerce/order_approvals';
import {
  InMemoryOrderDraftRepository,
  type OrderDraft,
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
  makeProjection,
  makeQuoteRequest,
  makeSignedQuote,
  type InstalledBuyerPack,
} from '../../commerce/helpers';

import type { ApprovalSourceBinding, PurchaseOrderProposal } from '@dina/commerce-protocol';

const OWNER_CAP = 'test-owner-capability-secret';
const T0 = Date.parse('2026-08-08T09:00:00.000Z');

/** The request THIS NODE sent (retained) and the revision it accepted.
 *  `valid_until` sits far in the future because the submit leg revalidates
 *  expiry against the wall clock, and an expired fixture would turn every
 *  happy path into a `quote_expired` refusal years from now. */
const REQUEST = makeQuoteRequest();
const QUOTE = makeSignedQuote(REQUEST, {
  quote_id: 'q-photo',
  valid_until: '2036-01-01T00:00:00.000Z',
});
const SUPPLIER = QUOTE.supplier_did;

let pack: InstalledBuyerPack;
let orderDrafts: InMemoryOrderDraftRepository;
let approvals: InMemoryOrderApprovalRepository;
let router: CoreRouter;
let sent: PurchaseOrderProposal[];

function quotedDraft(overrides: Partial<OrderDraft> = {}): OrderDraft {
  return {
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
    requirements: [
      {
        key: 'required_by',
        kind: 'transmitted',
        value: '2026-08-21T00:00:00.000Z',
        omitted: false,
        provenance: 'accepted',
        generation: 1,
        vouch: { generation: 1, ceremony: 1, receiptDigest: 'b'.repeat(64), vouchedBy: null },
      },
    ],
    conversations: [
      {
        conversationId: 'conv-1',
        supplierDid: SUPPLIER,
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
      },
    ],
    ceremonyCounter: 1,
    abandoned: false,
    createdAtMs: T0,
    updatedAtMs: T0,
    ...overrides,
  };
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

function approveBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    draft_id: 'odr-1',
    conversation_id: 'conv-1',
    quote_id: 'q-photo',
    projection: REQUEST.delivery.projection,
    ...over,
  };
}

const approve = async (over: Record<string, unknown> = {}) =>
  router.handle(owner('/v1/commerce/orders/drafts/approve', approveBody(over)));
const submit = async (body: Record<string, unknown>) =>
  router.handle(owner('/v1/commerce/orders/submit', body));

/** The owner is present unless a case says otherwise. */
async function provePresence(): Promise<void> {
  installOwnerPresenceVerifier(async (p) => p === 'correct horse');
  await proveOwnerPresence('correct horse', Date.now());
}

beforeEach(() => {
  setNodeDID(BUYER_DID);
  pack = installActiveBuyerPack(T0);

  orderDrafts = new InMemoryOrderDraftRepository();
  approvals = new InMemoryOrderApprovalRepository();
  const buyerQuotes = new InMemoryBuyerQuoteRepository();
  buyerQuotes.append({ supplierDid: SUPPLIER, quoteId: 'q-photo', quote: QUOTE });
  const buyerQuoteRequests = new InMemoryBuyerQuoteRequestRepository();
  buyerQuoteRequests.put(REQUEST, T0);
  orderDrafts.put(quotedDraft());
  installCommerceRuntime({
    receipts: new InMemoryCommerceReceiptRepository(),
    attributionBoundary: new InMemoryAttributionBoundaryRepository(),
    buyerOrders: new InMemoryBuyerOrderRepository(),
    buyerQuotes,
    buyerQuoteRequests,
    orderApprovals: approvals,
    orderDrafts,
    settings: new InMemoryCommerceSettingsRepository(),
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

describe('the UNCONDITIONAL presence gate', () => {
  it('a node with no verifier cannot approve a photo-derived order AT ALL', async () => {
    // No verifier installed. The legacy prepare path documents this as
    // convenience mode and proceeds; here the same deployment is refused,
    // because provenance is Core-known on this route.
    const resp = await approve();
    expect(resp.status).toBe(503);
    expect((resp.body as { error: string }).error).toBe('presence_unavailable');
  });

  it('a verifier with no live proof refuses: the owner capability is not the owner', async () => {
    installOwnerPresenceVerifier(async (p) => p === 'correct horse');
    const resp = await approve();
    expect(resp.status).toBe(403);
    expect((resp.body as { error: string }).error).toBe('no_user_presence');
  });
});

describe('approving, then sending, through the REAL machinery', () => {
  it('approves against the PRICED projection when the surface omits one (§9.9 default)', async () => {
    // The buyer surface clears its ask-time region once the RFQ goes out,
    // so approve sends no projection; Core defaults to the retained
    // (priced) request rather than refusing as order_quote_mismatch.
    await provePresence();
    const resp = await approve({ projection: undefined });
    expect(resp.status).toBe(200);
    expect(orderDrafts.get('odr-1')?.conversations[0]?.state).toBe('approved');
  });

  it('mints a SOURCE-BOUND approval from Core-held facts and submits under it', async () => {
    await provePresence();
    const resp = await approve();
    expect(resp.status).toBe(200);
    const body = resp.body as {
      approval_id: string;
      purchase_order_id: string;
      approved: { source?: ApprovalSourceBinding; orderDigest: string };
    };
    expect(body.approval_id).toMatch(/^oap_[0-9a-f]{32}$/);

    // The payload's binding names the draft, the conversation, and the
    // generations THE DRAFT holds right now — Core's derivation, since the
    // request carried none of it.
    expect(body.approved.source).toMatchObject({
      origin: 'photo_order_draft',
      draft_id: 'odr-1',
      conversation_id: 'conv-1',
      assignment_generations: [{ line_id: 'line-1', generation: 0 }],
      requirement_generations: [{ key: 'required_by', generation: 1 }],
      snapshot_digest: 'd'.repeat(64),
    });

    // The conversation advanced, durably, and remembers which card it minted.
    const held = orderDrafts.get('odr-1');
    expect(held?.conversations[0]?.state).toBe('approved');
    expect(held?.conversations[0]?.approvalId).toBe(body.approval_id);

    // §5.5 — the divergence column rides ON the card's response. This line
    // retained no evidence, so the badge is the honest "no reference price"
    // — stated, never guessed. The comparable arithmetic is pinned by the
    // golden vectors in `price_divergence.test.ts`.
    expect((resp.body as { divergence: unknown }).divergence).toEqual([
      { line_id: 'l1', verdict: { kind: 'no_reference_price' } },
    ]);

    // And the card ANSWERS: the real submit route sends exactly the order
    // Core built — bound to the accepted revision, all-or-none over its
    // line set, the quote's own total.
    const sendResp = await submit({ approval_id: body.approval_id });
    expect(sendResp.status).toBe(200);
    expect((sendResp.body as { ok: boolean }).ok).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0]?.purchase_order_id).toBe(body.purchase_order_id);
    expect(sent[0]?.quote_digest).toBe(QUOTE.quote_digest);
    expect(sent[0]?.approved_total).toEqual(QUOTE.total);
  });

  it('a draft that MOVED after approval dies at submit, not in a cleanup race', async () => {
    await provePresence();
    const body = (await approve()).body as { approval_id: string };

    // The owner re-repairs the line: its assignment generation advances.
    const held = orderDrafts.get('odr-1');
    if (held?.lines[0] === undefined) throw new Error('draft lost');
    held.lines[0].assignmentGeneration += 1;
    orderDrafts.put(held);

    const resp = await submit({ approval_id: body.approval_id });
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe('stale_source_binding');
    expect(sent.length).toBe(0);
  });
});

describe('what the route refuses', () => {
  beforeEach(async () => {
    await provePresence();
  });

  it('a conversation holding no accepted quote', async () => {
    const draft = quotedDraft();
    if (draft.conversations[0]) {
      draft.conversations[0].quoteDigest = null;
      draft.conversations[0].state = 'sent';
    }
    orderDrafts.put(draft);
    const resp = await approve();
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe('no_accepted_quote');
  });

  it('an accepted digest the verified store does not hold', async () => {
    const draft = quotedDraft();
    if (draft.conversations[0]) draft.conversations[0].quoteDigest = 'e'.repeat(64);
    orderDrafts.put(draft);
    const resp = await approve();
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe('quote_not_held');
  });

  it('a held quote answering a DIFFERENT request than this conversation asked', async () => {
    const draft = quotedDraft();
    if (draft.conversations[0]) draft.conversations[0].requestId = 'req-other';
    orderDrafts.put(draft);
    const resp = await approve();
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe('quote_answers_foreign_request');
  });

  it('a projection that CONTRADICTS what the quote priced (§9.9 extends-only)', async () => {
    // Well-formed, self-consistent digest — but a different region than the
    // one the supplier priced. Extending may add fields; it may not change.
    const resp = await approve({
      projection: makeProjection({ region: { scheme: 'postal_area', value: '560001' } }),
    });
    expect(resp.status).toBe(409);
    const body = resp.body as { error: string; detail: string };
    expect(body.error).toBe('order_quote_mismatch');
    expect(body.detail).toContain('projection_mismatch');
  });

  it('a projection that cannot even describe itself', async () => {
    const resp = await approve({
      projection: { ...REQUEST.delivery.projection, projection_digest: 'f'.repeat(64) },
    });
    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toBe('invalid_projection');
  });

  it('a draft or conversation that does not exist', async () => {
    expect((await approve({ draft_id: 'odr-none' })).status).toBe(404);
    expect((await approve({ conversation_id: 'conv-none' })).status).toBe(404);
  });
});
