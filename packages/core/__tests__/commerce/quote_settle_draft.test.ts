/**
 * §5.4 stage 2's SETTLE (PC-7) — a verified inbound quote advances the
 * photo draft's conversation, driven through the REAL inbound seam
 * (`applyInboundBuyerResponse`), because the settle is downstream of every
 * §9.8 verification and a hand-called unit would skip the very gates that
 * make "quoted" mean something.
 */

import { InMemoryBuyerQuoteRepository } from '../../src/commerce/buyer_quotes';
import { InMemoryBuyerQuoteRequestRepository } from '../../src/commerce/buyer_requests';
import { applyInboundBuyerResponse } from '../../src/commerce/buyer_response';
import { InMemoryOrderApprovalRepository } from '../../src/commerce/order_approvals';
import {
  InMemoryOrderDraftRepository,
  type OrderDraft,
  type OrderConversation,
} from '../../src/commerce/order_draft_store';
import { installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';
import { InMemoryTenderRepository } from '../../src/commerce/tender';
import { InMemoryCommerceEpochWatermarkRepository } from '../../src/commerce/watermarks';
import { BUYER_DID, makeQuoteRequest, makeRevision, makeSignedQuote } from './helpers';

import type { SignedQuote } from '@dina/commerce-protocol';

const T0 = Date.parse('2026-08-08T09:00:00.000Z');

const REQUEST = makeQuoteRequest();
const QUOTE = makeSignedQuote(REQUEST, {
  quote_id: 'q-photo',
  valid_until: '2036-01-01T00:00:00.000Z',
});
const SUPPLIER = QUOTE.supplier_did;

let orderDrafts: InMemoryOrderDraftRepository;
let buyerQuotes: InMemoryBuyerQuoteRepository;

function seedDraft(conversation: Partial<OrderConversation> = {}): void {
  const base: OrderConversation = {
    conversationId: 'conv-1',
    supplierDid: SUPPLIER,
    state: 'sent',
    lineIds: ['line-1'],
    snapshot: null,
    snapshotDigest: 'd'.repeat(64),
    requestDigest: REQUEST.request_digest,
    requestId: REQUEST.request_id,
    quoteDigest: null,
    quoteId: null,
    quoteValidUntil: null,
    approvalId: null,
    purchaseOrderId: null,
    dispatchIntent: null,
    outcome: null,
  };
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
    conversations: [{ ...base, ...conversation }],
    ceremonyCounter: 1,
    abandoned: false,
    createdAtMs: T0,
    updatedAtMs: T0,
  };
  orderDrafts.put(draft);
}

const deliver = (quote: SignedQuote, supplierDid = SUPPLIER) =>
  applyInboundBuyerResponse({
    supplierDid,
    response: {
      capability: 'request_quote',
      query_id: quote.request_id,
      status: 'success',
      result: { quote },
    },
    nowMs: T0,
  });

function held(): OrderConversation {
  const conversation = orderDrafts.get('odr-1')?.conversations[0];
  if (conversation === undefined) throw new Error('conversation lost');
  return conversation;
}

beforeEach(() => {
  orderDrafts = new InMemoryOrderDraftRepository();
  buyerQuotes = new InMemoryBuyerQuoteRepository();
  const buyerQuoteRequests = new InMemoryBuyerQuoteRequestRepository();
  buyerQuoteRequests.put(REQUEST, T0);
  installCommerceRuntime({
      tenders: new InMemoryTenderRepository(),
    nodeDid: () => BUYER_DID,
    watermarks: new InMemoryCommerceEpochWatermarkRepository(),
    buyerQuotes,
    buyerQuoteRequests,
    orderDrafts,
    orderApprovals: new InMemoryOrderApprovalRepository(),
    runInTransaction: (fn: () => unknown) => fn(),
  } as unknown as CommerceRuntime);
});

afterEach(() => {
  installCommerceRuntime(null);
});

it('a verified quote answering the conversation SETTLES it: sent → quoted, exact digest', () => {
  seedDraft();
  expect(deliver(QUOTE)).toBe('applied');
  const conversation = held();
  expect(conversation.state).toBe('quoted');
  expect(conversation.quoteDigest).toBe(QUOTE.quote_digest);
  expect(conversation.quoteValidUntil).toBe(QUOTE.valid_until);
});

it('a DUPLICATE redelivery heals a crash between the quote landing and the conversation moving', () => {
  seedDraft();
  expect(deliver(QUOTE)).toBe('applied');
  // The crash shape: the quote is durably in the verified store, but the
  // conversation never advanced. The store keeps the quote; only the draft
  // row is rewound.
  seedDraft();
  expect(deliver(QUOTE)).toBe('no_change');
  expect(held().state).toBe('quoted');
  expect(held().quoteDigest).toBe(QUOTE.quote_digest);
});

it('a NEW REVISION against an approved conversation is §5.5 counterproposal: approval dies, re-approval required', () => {
  seedDraft({ state: 'approved', quoteDigest: QUOTE.quote_digest, approvalId: 'oap_stale' });
  buyerQuotes.append({ supplierDid: SUPPLIER, quoteId: QUOTE.quote_id, quote: QUOTE });
  const revision = makeRevision(QUOTE);
  expect(deliver(revision)).toBe('applied');
  const conversation = held();
  expect(conversation.state).toBe('quoted');
  expect(conversation.approvalId).toBeNull();
  expect(conversation.quoteDigest).toBe(revision.quote_digest);
});

it('a TERMINAL conversation does not move — the late quote is history, never approvable (§5.4 stage 3a)', () => {
  seedDraft({ state: 'superseded', outcome: 'closed_by_competing_submit' });
  expect(deliver(QUOTE)).toBe('applied');
  const conversation = held();
  expect(conversation.state).toBe('superseded');
  expect(conversation.quoteDigest).toBeNull();
  // The verified store keeps it as supplier history all the same.
  expect(buyerQuotes.chain(SUPPLIER, QUOTE.quote_id)).toHaveLength(1);
});

it('a quote that FAILS verification moves nothing: recorded invalid, never shown as approvable', () => {
  seedDraft();
  // The authenticated sender is not the quote's supplier. The watermark
  // fence refuses it before the quote lane even reads it — a peer naming a
  // third party's records is an attempt to poison that party's fence.
  expect(deliver(QUOTE, 'did:plc:impostor00000000')).toBe('foreign_supplier');
  expect(held().state).toBe('sent');
  expect(held().quoteDigest).toBeNull();
  expect(buyerQuotes.chain(SUPPLIER, QUOTE.quote_id)).toHaveLength(0);
});
