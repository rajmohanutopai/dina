/**
 * §3.4 (TRADE_FIRST_STRATEGY) — the QuoteDecline riding the existing
 * request-quote response lane. A supplier may answer a tender member
 * with a signed decline instead of a quote; it verifies against the
 * RETAINED request, lands in the trade ledger, and every refusal maps
 * onto the lane's existing outcome vocabulary.
 */

import { createHash } from 'node:crypto';

import { tradeRecordDigest, type QuoteDecline, type Sha256Fn } from '@dina/commerce-protocol';

import { InMemoryBuyerQuoteRequestRepository } from '../../src/commerce/buyer_requests';
import { applyInboundBuyerResponse } from '../../src/commerce/buyer_response';
import { installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';
import { InMemoryTradeDocumentRepository } from '../../src/commerce/trade_ledger';
import { InMemoryCommerceEpochWatermarkRepository } from '../../src/commerce/watermarks';

import { makeQuoteRequest } from './helpers';

const hash: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());
const T0 = 1_800_000_000_000;

const REQUEST = makeQuoteRequest();
const BUYER = REQUEST.buyer_did;
const SUPPLIER = REQUEST.supplier_did;

let tradeDocs: InMemoryTradeDocumentRepository;
let requests: InMemoryBuyerQuoteRequestRepository;

function sealedDecline(overrides: Partial<QuoteDecline> = {}): QuoteDecline {
  const draft = {
    protocol_version: REQUEST.protocol_version,
    decline_id: 'dec-1',
    request_id: REQUEST.request_id,
    request_digest: REQUEST.request_digest,
    buyer_did: BUYER,
    supplier_did: SUPPLIER,
    reason_code: 'capacity',
    issued_at: '2026-08-17T10:00:00.000Z',
    ...overrides,
  };
  return {
    ...draft,
    decline_digest: tradeRecordDigest('quote_decline', draft, hash),
  } as QuoteDecline;
}

function inbound(result: unknown, senderDid = SUPPLIER) {
  return applyInboundBuyerResponse({
    supplierDid: senderDid,
    response: {
      capability: 'com.dinakernel.commerce.request_quote',
      query_id: 'req-1',
      status: 'success',
      result,
    },
    nowMs: T0,
  });
}

beforeEach(() => {
  tradeDocs = new InMemoryTradeDocumentRepository();
  requests = new InMemoryBuyerQuoteRequestRepository();
  requests.put(REQUEST, T0);
  installCommerceRuntime({
    tradeDocuments: tradeDocs,
    buyerQuoteRequests: requests,
    watermarks: new InMemoryCommerceEpochWatermarkRepository(),
    nodeDid: () => BUYER,
  } as unknown as CommerceRuntime);
});

afterEach(() => {
  installCommerceRuntime(null);
});

it('a signed decline on the quote lane applies and lands in the ledger', () => {
  const decline = sealedDecline();
  expect(inbound({ decline })).toBe('quote_declined');
  const held = tradeDocs.answersTo(REQUEST.request_digest, 'quote_decline');
  expect(held).toHaveLength(1);
  expect(held[0]?.direction).toBe('inbound');
  // Idempotent: the replay reads as declined too, and stores once.
  expect(inbound({ decline })).toBe('quote_declined');
  expect(tradeDocs.answersTo(REQUEST.request_digest, 'quote_decline')).toHaveLength(1);
});

it('a bare decline (no wrapper) is recognised as well', () => {
  expect(inbound(sealedDecline())).toBe('quote_declined');
});

it('a decline for a request this node never sent is unsolicited', () => {
  const stray = sealedDecline({ request_id: 'req-unknown' });
  expect(inbound({ decline: stray })).toBe('unsolicited_quote');
});

it('a decline from the wrong sender maps to quote_fork, nothing stored', () => {
  expect(inbound({ decline: sealedDecline() }, BUYER)).toBe('quote_fork');
  expect(tradeDocs.answersTo(REQUEST.request_digest, 'quote_decline')).toHaveLength(0);
});

it('a CONFLICTING second decline reads as declined and the held one stands', () => {
  expect(inbound({ decline: sealedDecline() })).toBe('quote_declined');
  const second = sealedDecline({ reason_code: 'policy' });
  expect(inbound({ decline: second })).toBe('quote_declined');
  const held = tradeDocs.answersTo(REQUEST.request_digest, 'quote_decline');
  expect(held).toHaveLength(1);
  expect(JSON.parse(held[0]?.recordJson ?? '{}').reason_code).toBe('capacity');
});

it('garbage that is neither quote nor decline stays unreadable', () => {
  expect(inbound({ nonsense: true })).toBe('unreadable');
});
