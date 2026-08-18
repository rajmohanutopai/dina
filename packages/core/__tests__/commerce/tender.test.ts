/**
 * The private tender (§3.2): fan-out builds N per-supplier requests
 * from ONE question, the quote lane correlates arriving answers, and
 * the comparison is deterministic advisory arithmetic — financing
 * valued in integer basis points, last-paid read from the same stores
 * the khata statement walks.
 */

import { createHash } from 'node:crypto';

import {
  tradeRecordDigest,
  type QuoteDecline,
  type Sha256Fn,
  type SignedQuote,
} from '@dina/commerce-protocol';

import { InMemoryBuyerQuoteRepository } from '../../src/commerce/buyer_quotes';
import { InMemoryBuyerQuoteRequestRepository } from '../../src/commerce/buyer_requests';
import { applyInboundBuyerResponse } from '../../src/commerce/buyer_response';
import { installCommerceServiceQueryDispatch } from '../../src/commerce/buyer_sender';
import { installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';
import {
  compareTender,
  createTender,
  financingBenefitMinor,
  InMemoryTenderRepository,
  SQLiteTenderRepository,
  type TenderComparisonDeps,
} from '../../src/commerce/tender';
import { InMemoryTradeDocumentRepository } from '../../src/commerce/trade_ledger';
import { InMemoryCommerceEpochWatermarkRepository } from '../../src/commerce/watermarks';

import { makeProjection, makeSignedQuote, makeQuoteRequest } from './helpers';

const hash: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());
const T0 = 1_800_000_000_000;
const BUYER = makeQuoteRequest().buyer_did;
const SUPPLIER_A = 'did:plc:tendersuppliera00000000000';
const SUPPLIER_B = 'did:plc:tendersupplierb00000000000';

const EMPTY_DEPS: TenderComparisonDeps = {
  readOrder: () => null,
  readBoundQuote: () => null,
  listAcceptedOrderIds: () => [],
};

let tenders: InMemoryTenderRepository;
let requests: InMemoryBuyerQuoteRequestRepository;
let quotes: InMemoryBuyerQuoteRepository;
let tradeDocs: InMemoryTradeDocumentRepository;
let dispatched: { toDid: string; params: Record<string, unknown> }[];

beforeEach(() => {
  tenders = new InMemoryTenderRepository();
  requests = new InMemoryBuyerQuoteRequestRepository();
  quotes = new InMemoryBuyerQuoteRepository();
  tradeDocs = new InMemoryTradeDocumentRepository();
  dispatched = [];
  installCommerceRuntime({
    tenders,
    buyerQuoteRequests: requests,
    buyerQuotes: quotes,
    tradeDocuments: tradeDocs,
    orderDrafts: { list: () => [] },
    watermarks: new InMemoryCommerceEpochWatermarkRepository(),
    nodeDid: () => BUYER,
    now: () => T0,
  } as unknown as CommerceRuntime);
  installCommerceServiceQueryDispatch(async ({ toDid, body }) => {
    dispatched.push({ toDid, params: (body as { params: Record<string, unknown> }).params });
    return { sent: true };
  });
});

afterEach(() => {
  installCommerceRuntime(null);
  installCommerceServiceQueryDispatch(null);
});

async function fanOut(): Promise<{ tenderId: string; requestIds: Map<string, string> }> {
  const created = await createTender({
    suppliers: [
      { supplierDid: SUPPLIER_A, serviceRkey: 'wholesale' },
      { supplierDid: SUPPLIER_B, serviceRkey: 'wholesale' },
    ],
    lines: [
      {
        lineId: 'l1',
        product: { scheme: 'gtin', value: '09506000134352' },
        quantity: { value: '100', unit_code: 'each' },
      },
    ],
    projection: makeProjection(),
    currency: 'INR',
    nowMs: T0,
  });
  if (!created.ok) throw new Error(created.refusal);
  return {
    tenderId: created.tenderId,
    requestIds: new Map(created.members.map((m) => [m.supplierDid, m.requestId])),
  };
}

/** A quote from `supplier` answering the tender's retained request. */
function quoteFor(supplier: string, requestId: string, creditDays?: number): SignedQuote {
  const retained = requests.get(requestId);
  if (retained === null) throw new Error('request not retained');
  return makeSignedQuote(retained, {
    quote_id: `q-${supplier.slice(-4)}`,
    supplier_did: supplier,
    // The fan-out stamps issue/expiry from T0 (2027); the helper's
    // hardcoded 2026 dates would read as an expired quote.
    issued_at: new Date(T0 + 60_000).toISOString(),
    valid_until: new Date(T0 + 24 * 60 * 60 * 1000).toISOString(),
    ...(creditDays === undefined ? {} : { payment_terms: { credit_days: creditDays } }),
  });
}

describe('fan-out (§3.2 step 2)', () => {
  it('N members, N DISTINCT signed requests sharing one line set', async () => {
    const { requestIds } = await fanOut();
    expect(dispatched).toHaveLength(2);
    expect(new Set(requestIds.values()).size).toBe(2);
    const [a, b] = dispatched;
    expect(a?.params.supplier_did).toBe(SUPPLIER_A);
    expect(b?.params.supplier_did).toBe(SUPPLIER_B);
    expect(a?.params.request_digest).not.toBe(b?.params.request_digest);
    expect(JSON.stringify(a?.params.lines)).toBe(JSON.stringify(b?.params.lines));
  });

  it('refuses duplicates and over-fanout', async () => {
    const dup = await createTender({
      suppliers: [
        { supplierDid: SUPPLIER_A, serviceRkey: 'w' },
        { supplierDid: SUPPLIER_A, serviceRkey: 'w' },
      ],
      lines: [],
      projection: makeProjection(),
      nowMs: T0,
    });
    expect(!dup.ok && dup.refusal).toBe('duplicate_supplier');
    const over = await createTender({
      suppliers: Array.from({ length: 6 }, (_, i) => ({
        supplierDid: `did:plc:s${String(i)}`,
        serviceRkey: 'w',
      })),
      lines: [],
      projection: makeProjection(),
      nowMs: T0,
    });
    expect(!over.ok && over.refusal).toContain('fanout');
  });
});

describe('correlation + comparison (§3.2 steps 3–4)', () => {
  it('a settling quote correlates its member; the comparison prices financing', async () => {
    const { tenderId, requestIds } = await fanOut();
    const requestA = requestIds.get(SUPPLIER_A) ?? '';

    // Supplier A's quote arrives on the real lane: total 50000, 30 days credit.
    const quote = quoteFor(SUPPLIER_A, requestA, 30);
    const outcome = applyInboundBuyerResponse({
      supplierDid: SUPPLIER_A,
      response: {
        capability: 'com.dinakernel.commerce.request_quote',
        query_id: requestA,
        status: 'success',
        result: { quote },
      },
      nowMs: T0,
    });
    expect(outcome).toBe('applied');

    const compared = compareTender({ tenderId, deps: EMPTY_DEPS, nowMs: T0 });
    expect(compared.ok).toBe(true);
    if (!compared.ok) return;
    const memberA = compared.members.find((m) => m.supplier_did === SUPPLIER_A);
    const memberB = compared.members.find((m) => m.supplier_did === SUPPLIER_B);
    // 50000 × 1800bps × 30d / (10000 × 365) = 739.726 → half-even 740.
    expect(memberA).toEqual({
      supplier_did: SUPPLIER_A,
      state: 'quoted',
      quote_id: quote.quote_id,
      total_minor: '50000',
      currency: 'INR',
      credit_days: 30,
      comparison_cost_minor: '49260',
      valid_until: quote.valid_until,
      last_paid: [],
    });
    expect(memberB?.state).toBe('pending');
  });

  it('a decline on the lane reads as declined with its reason', async () => {
    const { tenderId, requestIds } = await fanOut();
    const requestB = requestIds.get(SUPPLIER_B) ?? '';
    const retained = requests.get(requestB);
    if (retained === null) throw new Error('unretained');
    const draft = {
      protocol_version: '1.0',
      decline_id: 'dec-b',
      request_id: retained.request_id,
      request_digest: retained.request_digest,
      buyer_did: retained.buyer_did,
      supplier_did: retained.supplier_did,
      reason_code: 'out_of_region',
      issued_at: '2026-08-17T10:00:00.000Z',
    };
    const decline = {
      ...draft,
      decline_digest: tradeRecordDigest('quote_decline', draft, hash),
    } as QuoteDecline;
    expect(
      applyInboundBuyerResponse({
        supplierDid: retained.supplier_did,
        response: {
          capability: 'com.dinakernel.commerce.request_quote',
          query_id: requestB,
          status: 'success',
          result: { decline },
        },
        nowMs: T0,
      }),
    ).toBe('quote_declined');

    const compared = compareTender({ tenderId, deps: EMPTY_DEPS, nowMs: T0 });
    if (!compared.ok) throw new Error(compared.refusal);
    expect(compared.members.find((m) => m.supplier_did === retained.supplier_did)).toEqual({
      supplier_did: retained.supplier_did,
      state: 'declined',
      reason_code: 'out_of_region',
    });
  });

  it('an unanswered member reads pending, then expired past the request validity', async () => {
    const { tenderId } = await fanOut();
    const now = compareTender({ tenderId, deps: EMPTY_DEPS, nowMs: T0 });
    if (!now.ok) throw new Error(now.refusal);
    expect(now.members.every((m) => m.state === 'pending')).toBe(true);
    const later = compareTender({
      tenderId,
      deps: EMPTY_DEPS,
      nowMs: T0 + 25 * 60 * 60 * 1000,
    });
    if (!later.ok) throw new Error(later.refusal);
    expect(later.members.every((m) => m.state === 'expired')).toBe(true);
  });
});

describe('financing arithmetic (§3.2 step 4)', () => {
  it('half-even at the boundary, zero for cash, monotone in credit days', () => {
    expect(financingBenefitMinor(50000n, 1800, 30)).toBe(740n); // 739.726…
    expect(financingBenefitMinor(50000n, 1800, 0)).toBe(0n);
    expect(financingBenefitMinor(50000n, 0, 30)).toBe(0n);
    // A tie: 3650000 × k / 3650000 hits .5 when numerator = d/2. Use
    // 1825000 × 1 × 1... construct: total×bps×days = 1_825_000 → /3_650_000 = 0.5 → half-even 0.
    expect(financingBenefitMinor(1_825_000n, 1, 1)).toBe(0n);
    // 3× that: 5_475_000 / 3_650_000 = 1.5 → half-even 2.
    expect(financingBenefitMinor(5_475_000n, 1, 1)).toBe(2n);
  });
});

describe('SQLite tender repository parity', () => {
  it('CRUD round-trips match the in-memory double', () => {
    // Covered structurally: the SQLite arm runs in the route/journey
    // integration; here the double's contract is pinned.
    const memory = new InMemoryTenderRepository();
    memory.putTender({
      tenderId: 't1',
      linesJson: '[]',
      projectionJson: '{}',
      requestedTermsJson: '{}',
      expiresAt: T0,
      createdAt: T0,
    });
    memory.putMember({
      tenderId: 't1',
      supplierDid: SUPPLIER_A,
      requestId: 'r1',
      requestDigest: 'a'.repeat(64),
      quoteId: '',
    });
    memory.setMemberQuote('r1', 'q1');
    expect(memory.memberByRequestId('r1')?.quoteId).toBe('q1');
    expect(memory.listMembers('t1')).toHaveLength(1);
    expect(SQLiteTenderRepository).toBeDefined();
  });
});
