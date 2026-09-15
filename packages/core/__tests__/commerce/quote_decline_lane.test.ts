/**
 * §3.4 (TRADE_FIRST_STRATEGY) — the QuoteDecline riding the existing
 * request-quote response lane. A supplier may answer a tender member
 * with a signed decline instead of a quote; it verifies against the
 * RETAINED request, lands in the trade ledger, and every refusal maps
 * onto the lane's existing outcome vocabulary.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { tradeRecordDigest, type QuoteDecline, type Sha256Fn } from '@dina/commerce-protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { InMemoryBuyerQuoteRequestRepository } from '../../src/commerce/buyer_requests';
import { applyInboundBuyerResponse } from '../../src/commerce/buyer_response';
import { InMemoryDeclineDocumentRepository } from '../../src/commerce/decline_documents';
import { transformInboundOrderResult } from '../../src/commerce/order_decision';
import { createCommerceRuntime, installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';
import { InMemoryTenderRepository } from '../../src/commerce/tender';
import { InMemoryCommerceEpochWatermarkRepository } from '../../src/commerce/watermarks';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import { makeQuoteRequest, moneyClosed } from './helpers';

const hash: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());
const T0 = 1_800_000_000_000;

const REQUEST = makeQuoteRequest();
const BUYER = REQUEST.buyer_did;
const SUPPLIER = REQUEST.supplier_did;

let declineDocs: InMemoryDeclineDocumentRepository;
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
  declineDocs = new InMemoryDeclineDocumentRepository();
  requests = new InMemoryBuyerQuoteRequestRepository();
  requests.put(REQUEST, T0);
  installCommerceRuntime({
    // The money line CLOSED: the decline slice is kernel-side and money-free (§5.B1).
    money: moneyClosed(),
    declineDocuments: declineDocs,
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
  const held = declineDocs.answersTo(REQUEST.request_digest);
  expect(held).toHaveLength(1);
  expect(held[0]?.recordDigest).toBe(decline.decline_digest);
  // Idempotent: the replay reads as declined too, and stores once.
  expect(inbound({ decline })).toBe('quote_declined');
  expect(declineDocs.answersTo(REQUEST.request_digest)).toHaveLength(1);
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
  expect(declineDocs.answersTo(REQUEST.request_digest)).toHaveLength(0);
});

it('a CONFLICTING second decline reads as declined and the held one stands', () => {
  expect(inbound({ decline: sealedDecline() })).toBe('quote_declined');
  const second = sealedDecline({ reason_code: 'policy' });
  expect(inbound({ decline: second })).toBe('quote_declined');
  const held = declineDocs.answersTo(REQUEST.request_digest);
  expect(held).toHaveLength(1);
  expect(JSON.parse(held[0]?.recordJson ?? '{}').reason_code).toBe('capacity');
});

it('garbage that is neither quote nor decline stays unreadable', () => {
  expect(inbound({ nonsense: true })).toBe('unreadable');
});

describe('the supplier’s sealed decline reaches the buyer (§3.4, no money plugin on either side)', () => {
  it('runner declines → supplier Core seals → buyer applies it on the quote lane → tender reads declined', () => {
    // SUPPLIER side: a real runtime, the money line closed, the runner says no.
    const dir = mkdtempSync(path.join(tmpdir(), 'decline-supplier-'));
    const adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    installCommerceRuntime(
      createCommerceRuntime({ adapter, supplierDid: () => SUPPLIER, currentEpoch: () => '1', now: () => T0 }),
    );
    let wireJson: string;
    try {
      const decision = transformInboundOrderResult({
        capability: 'request_quote',
        fromDid: BUYER,
        params: REQUEST,
        resultJSON: JSON.stringify({ can_supply: false, decline_reason: 'capacity' }),
      });
      expect(decision.kind).toBe('replace');
      wireJson = (decision as { kind: 'replace'; json: string }).json;
    } finally {
      installCommerceRuntime(null);
      adapter.close();
      rmSync(dir, { recursive: true, force: true });
    }

    // BUYER side: the lane's ingress reads exactly what the supplier put on the wire.
    declineDocs = new InMemoryDeclineDocumentRepository();
    requests = new InMemoryBuyerQuoteRequestRepository();
    requests.put(REQUEST, T0);
    const tenders = new InMemoryTenderRepository();
    installCommerceRuntime({
      money: moneyClosed(),
      declineDocuments: declineDocs,
      buyerQuoteRequests: requests,
      tenders,
      watermarks: new InMemoryCommerceEpochWatermarkRepository(),
      nodeDid: () => BUYER,
      now: () => T0,
    } as unknown as CommerceRuntime);
    expect(inbound(JSON.parse(wireJson))).toBe('quote_declined');
    const held = declineDocs.answersTo(REQUEST.request_digest);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ direction: 'inbound', counterpartyDid: SUPPLIER });
    expect(JSON.parse(held[0]?.recordJson ?? '{}').reason_code).toBe('capacity');
  });
});
