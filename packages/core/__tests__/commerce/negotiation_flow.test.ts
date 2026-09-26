/**
 * NEGOTIATION_PLAN — the buyer and supplier halves on real stores, through
 * the production seams (request, issuance, response lanes). Buyer and
 * supplier share one SQLite file with two runtimes, the round-trip test's
 * harness: every row here was written by the code under test.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  counterInFlight,
  rankTender,
  runNegotiationTick,
  sendCounterOffer,
  sendNotAwardedNotices,
  startTenderNegotiation,
} from '../../src/commerce/buyer_negotiation';
import { requestQuote } from '../../src/commerce/buyer_quote_request';
import { newBuyerOrder } from '../../src/commerce/buyer_reconciliation';
import {
  applyInboundBuyerResponse,
  REQUEST_QUOTE_CAPABILITY,
} from '../../src/commerce/buyer_response';
import { installCommerceServiceQueryDispatch } from '../../src/commerce/buyer_sender';
import {
  InMemoryCatalogDraftRepository,
  type CatalogDraft,
} from '../../src/commerce/catalog_draft_store';
import { InMemoryCatalogPointerRepository } from '../../src/commerce/catalog_pointer_store';
import { buildCatalogSnapshot } from '../../src/commerce/catalog_publisher';
import {
  admitInboundCounter,
  answerQuoteOutcomeInCore,
  makeNegotiationPriceDecisionHandler,
  replayedCounterAnswer,
} from '../../src/commerce/negotiation_supplier';
import { transformInboundOrderResult } from '../../src/commerce/order_decision';
import { publishedCatalogItems } from '../../src/commerce/published_catalog';
import {
  createCommerceRuntime,
  installCommerceRuntime,
  type CommerceRuntime,
} from '../../src/commerce/runtime';
import { answerCounterOffer, answerQuoteRequest } from '../../src/commerce/supplier_runner';
import { createTender } from '../../src/commerce/tender';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

import {
  BUYER_DID,
  SUPPLIER_DID,
  hash,
  makeAcknowledgement,
  makeProjection,
  makeRevision,
  makeSignedQuote,
} from './helpers';

import type { SupplierSettings } from '../../src/commerce/commerce_settings';
import type { SupplierNegotiationPolicy } from '../../src/commerce/negotiation_policy';
import type {
  CatalogItem,
  CounterOffer,
  OrderAcknowledgement,
  QuoteRequest,
  SignedQuote,
} from '@dina/commerce-protocol';

const NOW = Date.parse('2026-08-07T12:00:00.000Z');

let dir: string;
let adapter: NodeSQLiteAdapter;
let sent: { toDid: string; body: Record<string, unknown> }[];
/** Every runtime's clock; a test moves it to model time passing during a send. */
let clock = NOW;

function openRuntime(nodeDid: string): CommerceRuntime {
  return createCommerceRuntime({
    adapter,
    supplierDid: () => nodeDid,
    currentEpoch: () => '1',
    now: () => clock,
  });
}

beforeEach(() => {
  clock = NOW;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-negotiation-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  sent = [];
  installCommerceServiceQueryDispatch(async (args) => {
    sent.push({ toDid: args.toDid, body: args.body as unknown as Record<string, unknown> });
    return { sent: true };
  });
});

afterEach(() => {
  setWorkflowService(null);
  installCommerceServiceQueryDispatch(null);
  installCommerceRuntime(null);
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const LINES = [
  {
    lineId: 'l1',
    product: { scheme: 'gtin' as const, value: '09506000134352' },
    quantity: { value: '100', unit_code: 'each' },
  },
];

async function buyerAsks(buyer: CommerceRuntime, requestId = 'req-1'): Promise<QuoteRequest> {
  installCommerceRuntime(buyer);
  const outcome = await requestQuote({
    supplierDid: SUPPLIER_DID,
    serviceRkey: 'self',
    requestId,
    idempotencyKey: `idem-${requestId}`,
    lines: LINES,
    projection: makeProjection(),
    nowMs: NOW,
  });
  if (outcome.kind !== 'sent') throw new Error(`request not sent: ${outcome.kind}`);
  return outcome.request;
}

function supplierQuotes(
  supplier: CommerceRuntime,
  request: QuoteRequest,
  unitMinor = '500',
): SignedQuote {
  installCommerceRuntime(supplier);
  const issued = transformInboundOrderResult({
    capability: 'request_quote',
    fromDid: BUYER_DID,
    params: request,
    resultJSON: JSON.stringify({
      can_supply: true,
      lines: [
        {
          line_id: 'l1',
          unit_price: { currency: 'INR', minor_units: unitMinor },
          quantity: { value: '100', unit_code: 'each' },
        },
      ],
    }),
    nowMs: NOW,
  });
  if (issued.kind !== 'replace') throw new Error(`quote not issued: ${JSON.stringify(issued)}`);
  return JSON.parse(issued.json) as SignedQuote;
}

/** An order this buyer holds on `quote`, and a counterproposal acknowledgement bound to it. */
function heldOrderCounter(
  buyer: CommerceRuntime,
  quote: SignedQuote,
  replacement: SignedQuote,
  poId = 'po-1',
): OrderAcknowledgement {
  const orderDigest = 'a'.repeat(64);
  buyer.buyerOrders.create(SUPPLIER_DID, {
    ...newBuyerOrder(poId, {
      protocolVersion: quote.protocol_version,
      orderDigest,
      idempotencyKey: `idem-${poId}`,
      serviceRkey: 'self',
      quoteDigest: quote.quote_digest,
      quoteId: quote.quote_id,
      buyerDid: BUYER_DID,
      supplierDid: SUPPLIER_DID,
    }),
    state: 'outcome_unknown',
    nextPollAtMs: NOW - 1,
    pollCount: 1,
  });
  return makeAcknowledgement({
    purchase_order_id: poId,
    order_digest: orderDigest,
    protocol_version: quote.protocol_version,
    kind: 'counterproposal',
    replacement_quote: replacement,
  } as unknown as Parameters<typeof makeAcknowledgement>[0]);
}

describe('item 7 — the buyer keeps a supplier counterproposal', () => {
  it('the replacement quote inside a counterproposal acknowledgement lands in the buyer store', async () => {
    const buyer = openRuntime(BUYER_DID);
    const supplier = openRuntime(SUPPLIER_DID);
    const request = await buyerAsks(buyer);
    const original = supplierQuotes(supplier, request);

    installCommerceRuntime(buyer);
    expect(
      applyInboundBuyerResponse({
        supplierDid: SUPPLIER_DID,
        response: {
          capability: REQUEST_QUOTE_CAPABILITY,
          query_id: request.request_id,
          status: 'success',
          result: { quote: original },
        },
        nowMs: NOW,
      }),
    ).toBe('applied');

    const replacement = makeSignedQuote(request, {
      quote_id: 'q-counter-1',
      replaces_quote_digest: original.quote_digest,
      issued_at: '2026-08-07T11:30:00.000Z',
      valid_until: '2026-08-08T09:00:00.000Z',
    });
    const ack = heldOrderCounter(buyer, original, replacement);
    applyInboundBuyerResponse({
      supplierDid: SUPPLIER_DID,
      response: {
        capability: 'submit_order',
        query_id: 'po-1',
        status: 'success',
        result: ack,
      },
      nowMs: NOW,
    });
    expect(buyer.buyerQuotes.chain(SUPPLIER_DID, 'q-counter-1').map((q) => q.quote_digest)).toEqual(
      [replacement.quote_digest],
    );
  });

  it('a replacement addressed to someone else, or answering another request, is not kept', async () => {
    const buyer = openRuntime(BUYER_DID);
    const request = await buyerAsks(buyer);
    installCommerceRuntime(buyer);
    for (const bad of [
      makeSignedQuote(request, { quote_id: 'q-x1', buyer_did: 'did:plc:someoneelse' }),
      makeSignedQuote({ ...request, request_id: 'req-other' }, { quote_id: 'q-x2' }),
    ]) {
      applyInboundBuyerResponse({
        supplierDid: SUPPLIER_DID,
        response: {
          capability: 'submit_order',
          query_id: 'po-1',
          status: 'success',
          result: { kind: 'counterproposal', replacement_quote: bad },
        },
        nowMs: NOW,
      });
      expect(buyer.buyerQuotes.chain(SUPPLIER_DID, bad.quote_id)).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Items 2, 3, 4, 5 — the counter lane on both nodes
// ---------------------------------------------------------------------------

const GTIN = { scheme: 'gtin' as const, value: '09506000134352' };

function supplierSettings(negotiation: SupplierNegotiationPolicy): SupplierSettings {
  return {
    actingBusinessDid: SUPPLIER_DID,
    catalogSource: { kind: 'inline', lastHealthyAtIso: null },
    publicRegions: [],
    publishIndicativePrice: true,
    quoteAccess: 'anyone',
    responsePolicy: {},
    customerPricingSource: null,
    orderAcceptance: 'auto',
    listingState: 'live',
    connectors: [],
    negotiation,
  };
}

const POLICY: SupplierNegotiationPolicy = {
  enabled: true,
  maxRounds: 3,
  windowSeconds: 3_600,
  maxCountersPerBuyerPerDay: 20,
  defaultMaxDiscountBps: 1_000,
};

interface Pair {
  buyer: CommerceRuntime;
  supplier: CommerceRuntime;
  quote: SignedQuote;
  workflow: WorkflowService;
}

/** Buyer asks, supplier (with a policy) quotes 100 x 500, buyer holds it. */
async function negotiatingPair(policy: SupplierNegotiationPolicy = POLICY): Promise<Pair> {
  const buyer = openRuntime(BUYER_DID);
  const supplier = openRuntime(SUPPLIER_DID);
  const workflow = new WorkflowService({
    repository: new InMemoryWorkflowRepository(),
    nowMsFn: () => NOW,
  });
  setWorkflowService(workflow);
  expect(supplier.settings.writeSupplier(supplierSettings(policy)).ok).toBe(true);
  const request = await buyerAsks(buyer);
  const quote = supplierQuotes(supplier, request);
  installCommerceRuntime(buyer);
  expect(
    applyInboundBuyerResponse({
      supplierDid: SUPPLIER_DID,
      response: {
        capability: REQUEST_QUOTE_CAPABILITY,
        query_id: request.request_id,
        status: 'success',
        result: { quote },
      },
      nowMs: NOW,
    }),
  ).toBe('applied');
  return { buyer, supplier, quote, workflow };
}

/** The buyer counters at `targetMinor`; returns the counter that went out. */
async function buyerCounters(pair: Pair, targetMinor: string): Promise<CounterOffer> {
  installCommerceRuntime(pair.buyer);
  const head = pair.buyer.buyerQuotes
    .chain(SUPPLIER_DID, pair.quote.quote_id)
    .at(-1) as SignedQuote;
  const outcome = await sendCounterOffer({
    supplierDid: SUPPLIER_DID,
    quoteId: head.quote_id,
    serviceRkey: 'self',
    targetTotal: { currency: 'INR', minor_units: targetMinor },
    nowMs: NOW,
  });
  if (outcome.kind === 'refused') throw new Error(`counter refused: ${outcome.reason}`);
  const wire = sent.at(-1);
  expect(wire?.body.capability).toBe('com.dinakernel.commerce.counter_offer');
  expect(wire?.body.query_id).toBe(outcome.counter.counter_id);
  return outcome.counter;
}

/** The supplier's whole lane: admission, the reference runner, Core's clamp and signature. */
function supplierAnswers(
  pair: Pair,
  counter: CounterOffer,
): { json: string } | { refused: string } {
  installCommerceRuntime(pair.supplier);
  const admitted = admitInboundCounter({ params: counter, buyerDid: BUYER_DID, nowMs: NOW });
  if (admitted.kind === 'refused') return { refused: admitted.refusal };
  if (admitted.kind === 'answer') return { json: admitted.json };
  const runner = answerCounterOffer(admitted.params);
  if (!runner.ok) throw new Error(runner.error);
  const settled = transformInboundOrderResult({
    capability: 'com.dinakernel.commerce.counter_offer',
    capabilityId: 'com.dinakernel.commerce.negotiate-quote',
    fromDid: BUYER_DID,
    params: admitted.params,
    resultJSON: JSON.stringify(runner.result),
    nowMs: NOW,
  });
  if (settled.kind !== 'replace') throw new Error(`withheld: ${JSON.stringify(settled)}`);
  return { json: settled.json };
}

function buyerReceives(pair: Pair, counter: CounterOffer, json: string): string {
  installCommerceRuntime(pair.buyer);
  return applyInboundBuyerResponse({
    supplierDid: SUPPLIER_DID,
    response: {
      capability: 'com.dinakernel.commerce.counter_offer',
      query_id: counter.counter_id,
      status: 'success',
      result: JSON.parse(json),
    },
    nowMs: NOW,
  });
}

function headPrice(pair: Pair): string {
  const head = pair.buyer.buyerQuotes
    .chain(SUPPLIER_DID, pair.quote.quote_id)
    .at(-1) as SignedQuote;
  return head.lines[0]?.unit_price.minor_units ?? '';
}

describe('items 2-5 — a counter becomes revision N+1, never below the floor', () => {
  it('round 1 moves halfway to the target; round 2 at the floor holds; the buyer checks every revision', async () => {
    const pair = await negotiatingPair();
    // 100 x 500 = 50000; the buyer asks 40000 (400 each). Halfway is 450,
    // which is exactly the default 10% floor.
    const first = await buyerCounters(pair, '40000');
    const answer = supplierAnswers(pair, first);
    if (!('json' in answer)) throw new Error(answer.refused);
    expect(JSON.parse(answer.json)).toMatchObject({
      outcome: 'revised',
      quote: { quote_revision: '2', total: { minor_units: '45000' } },
    });
    expect(buyerReceives(pair, first, answer.json)).toBe('applied');
    expect(headPrice(pair)).toBe('450');
    expect(pair.buyer.buyerNegotiation.getCounter(first.counter_id)?.state).toBe('revised');

    const second = await buyerCounters(pair, '40000');
    const held = supplierAnswers(pair, second);
    if (!('json' in held)) throw new Error(held.refused);
    expect(JSON.parse(held.json)).toMatchObject({
      outcome: 'held',
      quote: { quote_revision: '2' },
    });
    expect(buyerReceives(pair, second, held.json)).toBe('no_change');
    expect(pair.buyer.buyerNegotiation.getCounter(second.counter_id)?.state).toBe('held');
    // The supplier signed exactly one revision.
    expect(pair.supplier.families.load(pair.quote.quote_id)?.headDigest).toBe(
      (JSON.parse(answer.json) as { quote: SignedQuote }).quote.quote_digest,
    );
  });

  it('below the automatic limit Core signs the limit and asks the owner; a yes lets the next round reach the floor', async () => {
    const pair = await negotiatingPair({
      ...POLICY,
      items: [{ product: GTIN, floorMinorUnits: '420', autoFloorMinorUnits: '450' }],
    });
    const first = await buyerCounters(pair, '40000');
    const r1 = supplierAnswers(pair, first) as { json: string };
    expect(buyerReceives(pair, first, r1.json)).toBe('applied');
    expect(headPrice(pair)).toBe('450');

    // Round 2: the runner aims from 450 toward 400 and wants 425 — below the
    // automatic 450, above the 420 floor.
    const second = await buyerCounters(pair, '40000');
    const r2 = supplierAnswers(pair, second) as { json: string };
    // The hold says a lower price is before the owner, and nothing about it.
    expect(JSON.parse(r2.json)).toMatchObject({ outcome: 'held', pending_owner: true });
    installCommerceRuntime(pair.supplier);
    const [question] = pair.supplier.negotiation.questionsForQuote(pair.quote.quote_id);
    expect(question).toMatchObject({ lineId: 'l1', askedMinorUnits: '425', state: 'pending' });
    const card = pair.workflow.store().getById(question?.taskId ?? '');
    expect(card?.status).toBe('pending_approval');

    makeNegotiationPriceDecisionHandler({
      runtime: () => pair.supplier,
      workflow: () => pair.workflow,
      nowMs: () => NOW,
    })({ task: card as never, decision: 'approved' });
    expect(pair.supplier.negotiation.questionsForQuote(pair.quote.quote_id)[0]?.state).toBe(
      'approved',
    );

    installCommerceRuntime(pair.buyer);
    expect(buyerReceives(pair, second, r2.json)).toBe('no_change');
    // The buyer reads the hold as "ask again", not as final.
    expect(pair.buyer.buyerNegotiation.getCounter(second.counter_id)?.state).toBe('pending');
    const third = await buyerCounters(pair, '40000');
    const r3 = supplierAnswers(pair, third) as { json: string };
    expect(JSON.parse(r3.json)).toMatchObject({
      outcome: 'revised',
      quote: { quote_revision: '3' },
    });
    expect(buyerReceives(pair, third, r3.json)).toBe('applied');
    expect(headPrice(pair)).toBe('425');
  });

  it('a runner that wants to go under the hard floor gets the owner asked about the floor, never below it', async () => {
    // Floor 420, automatic 480: the first round from 500 toward 300 wants 400.
    const pair = await negotiatingPair({
      ...POLICY,
      items: [{ product: GTIN, floorMinorUnits: '420', autoFloorMinorUnits: '480' }],
    });
    const first = await buyerCounters(pair, '30000');
    const r1 = supplierAnswers(pair, first) as { json: string };
    expect(JSON.parse(r1.json)).toMatchObject({
      outcome: 'revised',
      quote: { total: { minor_units: '48000' } },
    });
    installCommerceRuntime(pair.supplier);
    expect(pair.supplier.negotiation.questionsForQuote(pair.quote.quote_id)[0]).toMatchObject({
      askedMinorUnits: '420',
    });
  });

  it('a repeated counter id gets the answer it already got; a counter on a moved head gets the current head', async () => {
    const pair = await negotiatingPair();
    const first = await buyerCounters(pair, '40000');
    const r1 = supplierAnswers(pair, first) as { json: string };
    expect(supplierAnswers(pair, first)).toEqual(r1);
    // The same round replayed with a fresh id against the OLD head.
    const stale = { ...first, counter_id: 'ctr-stale' };
    const { counter_digest: _d, ...rest } = stale;
    const { commerceRecordDigest } = jest.requireActual(
      '@dina/commerce-protocol',
    ) as typeof import('@dina/commerce-protocol');
    const { sha256 } = jest.requireActual(
      '@noble/hashes/sha2.js',
    ) as typeof import('@noble/hashes/sha2.js');
    const resealed = {
      ...rest,
      counter_digest: commerceRecordDigest('counter', rest, (d) => sha256(d)),
    } as CounterOffer;
    const answer = supplierAnswers(pair, resealed) as { json: string };
    expect(JSON.parse(answer.json)).toMatchObject({
      outcome: 'held',
      quote: { quote_revision: '2' },
    });
  });

  it('refuses a stranger, a round past the limit, a buyer over the daily cap, a closed quote and a policy that is off', async () => {
    const pair = await negotiatingPair({ ...POLICY, maxRounds: 1, maxCountersPerBuyerPerDay: 2 });
    const first = await buyerCounters(pair, '40000');
    installCommerceRuntime(pair.supplier);
    expect(
      admitInboundCounter({ params: first, buyerDid: 'did:plc:stranger', nowMs: NOW }),
    ).toEqual({
      kind: 'refused',
      refusal: 'not_your_quote',
    });
    const r1 = supplierAnswers(pair, first) as { json: string };
    buyerReceives(pair, first, r1.json);
    const second = await buyerCounters(pair, '40000');
    expect(supplierAnswers(pair, second)).toEqual({ refused: 'round_refused' });

    // Not awarded: the quote closes, and no further counter is answered.
    installCommerceRuntime(pair.supplier);
    expect(
      answerQuoteOutcomeInCore({
        params: {
          request_id: pair.quote.request_id,
          quote_id: pair.quote.quote_id,
          outcome: 'not_awarded',
        },
        buyerDid: BUYER_DID,
        nowMs: NOW,
      }),
    ).toEqual({ ok: true, json: JSON.stringify({ recorded: true }) });
    expect(pair.supplier.negotiation.outcomeFor(BUYER_DID, pair.quote.quote_id)).not.toBeNull();
    // A stranger's notice records nothing and answers the same.
    expect(
      answerQuoteOutcomeInCore({
        params: { request_id: pair.quote.request_id, quote_id: 'q-other', outcome: 'not_awarded' },
        buyerDid: 'did:plc:stranger',
        nowMs: NOW,
      }),
    ).toEqual({ ok: true, json: JSON.stringify({ recorded: true }) });
  });

  it('with no policy a counter is declined as negotiation_off; the daily cap counts across quotes', async () => {
    const off = await negotiatingPair({ ...POLICY, enabled: false });
    const counter = await buyerCounters(off, '40000');
    expect(supplierAnswers(off, counter)).toEqual({ refused: 'negotiation_off' });
  });
});

// ---------------------------------------------------------------------------
// Item 1 — requirement lines
// ---------------------------------------------------------------------------

const CAKE = {
  scheme: 'manufacturer_sku' as const,
  value: 'CAKE-FLORAL',
  issuer_did: SUPPLIER_DID,
};

function item(over: Partial<CatalogItem>): CatalogItem {
  return {
    product: CAKE,
    supplier_did: SUPPLIER_DID,
    catalog_id: 'main',
    item_revision: 'rev-1',
    name: 'Floral celebration cake',
    description: 'Vanilla sponge with sugar flowers, serves 20',
    category_ids: ['food.bakery'],
    pack: { sell_unit: { value: '1', unit_code: 'each' } },
    fulfilment_regions: [{ scheme: 'admin_area', value: 'IN-KA' }],
    indicative_price: { currency: 'INR', minor_units: '24000' },
    freshness: { generated_at: '2026-08-07T08:00:00.000Z' },
    ...over,
  };
}

/** The supplier's runtime with a live published catalogue of `items`. */
function withCatalogue(supplier: CommerceRuntime, items: CatalogItem[]): CommerceRuntime {
  const built = buildCatalogSnapshot({
    supplierDid: SUPPLIER_DID,
    catalogId: 'main',
    protocolVersion: '1.0',
    publishedAt: '2026-08-07T08:00:00.000Z',
    items,
    previous: null,
    sha256: hash,
  });
  if (!built.ok || built.snapshot === undefined || built.pages === undefined)
    throw new Error('snapshot');
  const catalogDrafts = new InMemoryCatalogDraftRepository();
  const catalogPointers = new InMemoryCatalogPointerRepository();
  catalogDrafts.put({
    draftId: 'cdr-1',
    catalogId: 'main',
    state: 'published',
    held: { snapshot: built.snapshot, pages: built.pages, pointer: built.pointer },
    createdAtMs: NOW,
    updatedAtMs: NOW,
  } as unknown as CatalogDraft);
  catalogPointers.put({
    catalogId: 'main',
    pointer: built.pointer,
    pointerCid: 'bafy-live',
    snapshotDigest: built.snapshot.snapshot_digest,
    withdrawn: false,
    publishedAtMs: NOW,
  });
  return { ...supplier, catalogDrafts, catalogPointers };
}

async function buyerNeeds(buyer: CommerceRuntime, text: string): Promise<QuoteRequest> {
  installCommerceRuntime(buyer);
  const outcome = await requestQuote({
    supplierDid: SUPPLIER_DID,
    serviceRkey: 'self',
    requestId: 'req-need',
    idempotencyKey: 'idem-need',
    lines: [
      {
        lineId: 'l1',
        quantity: { value: '1', unit_code: 'each' },
        requirement: { text, category_id: 'food.bakery' },
      },
    ],
    projection: makeProjection(),
    nowMs: NOW,
  });
  if (outcome.kind !== 'sent') throw new Error(outcome.kind);
  return outcome.request;
}

describe("item 1 — a need answered with the supplier's own item", () => {
  it('the request goes at 1.2 with a buyer placeholder; the runner matches; Core signs the substitute; the buyer accepts it', async () => {
    const buyer = openRuntime(BUYER_DID);
    const supplier = withCatalogue(openRuntime(SUPPLIER_DID), [
      item({}),
      item({
        product: { ...CAKE, value: 'CAKE-CHOC' },
        name: 'Chocolate truffle cake',
        description: 'Dark chocolate, serves 12',
        indicative_price: { currency: 'INR', minor_units: '18000' },
      }),
    ]);
    const request = await buyerNeeds(buyer, 'Floral celebration cake, 20 servings');
    expect(request.protocol_version).toBe('1.2');
    expect(request.lines[0]).toMatchObject({
      product: { scheme: 'custom', value: 'req:l1', issuer_did: BUYER_DID },
      acceptable_substitutions: 'supplier_may_propose',
    });

    installCommerceRuntime(supplier);
    const runner = answerQuoteRequest(request, publishedCatalogItems(supplier));
    if (!runner.ok) throw new Error(runner.error);
    const issued = transformInboundOrderResult({
      capability: 'request_quote',
      fromDid: BUYER_DID,
      params: request,
      resultJSON: JSON.stringify(runner.result),
      nowMs: NOW,
    });
    if (issued.kind !== 'replace') throw new Error(JSON.stringify(issued));
    const quote = JSON.parse(issued.json) as SignedQuote;
    expect(quote.lines[0]).toMatchObject({
      offered_product: CAKE,
      unit_price: { minor_units: '24000' },
    });
    expect(quote.lines[0]?.substitution_evidence?.[0]).toMatch(
      /matched "Floral celebration cake, 20 servings" to "Floral celebration cake"/,
    );

    installCommerceRuntime(buyer);
    expect(
      applyInboundBuyerResponse({
        supplierDid: SUPPLIER_DID,
        response: {
          capability: REQUEST_QUOTE_CAPABILITY,
          query_id: request.request_id,
          status: 'success',
          result: { quote },
        },
        nowMs: NOW,
      }),
    ).toBe('applied');
  });

  it('no match declines; an unpublished substitute, one without evidence, or a bare placeholder is withheld', async () => {
    const buyer = openRuntime(BUYER_DID);
    const supplier = withCatalogue(openRuntime(SUPPLIER_DID), [item({})]);
    const request = await buyerNeeds(buyer, 'Gluten-free sourdough loaf');
    installCommerceRuntime(supplier);
    expect(answerQuoteRequest(request, publishedCatalogItems(supplier))).toEqual({
      ok: true,
      result: { can_supply: false, decline_reason: 'no_match: l1' },
    });
    const price = { currency: 'INR', minor_units: '24000' };
    const qty = { value: '1', unit_code: 'each' };
    for (const line of [
      {
        line_id: 'l1',
        unit_price: price,
        quantity: qty,
        offered_product: { ...CAKE, value: 'NOT-PUBLISHED' },
        substitution_evidence: ['x'],
      },
      { line_id: 'l1', unit_price: price, quantity: qty, offered_product: CAKE },
      { line_id: 'l1', unit_price: price, quantity: qty },
    ]) {
      const issued = transformInboundOrderResult({
        capability: 'request_quote',
        fromDid: BUYER_DID,
        params: request,
        resultJSON: JSON.stringify({ can_supply: true, lines: [line] }),
        nowMs: NOW,
      });
      expect(issued).toEqual({ kind: 'withhold', reason: 'terms_unusable' });
    }
  });

  it('a substitute on a line where the buyer allowed none is withheld', async () => {
    const buyer = openRuntime(BUYER_DID);
    const supplier = withCatalogue(openRuntime(SUPPLIER_DID), [item({})]);
    const request = await buyerAsks(buyer);
    installCommerceRuntime(supplier);
    const issued = transformInboundOrderResult({
      capability: 'request_quote',
      fromDid: BUYER_DID,
      params: request,
      resultJSON: JSON.stringify({
        can_supply: true,
        lines: [
          {
            line_id: 'l1',
            unit_price: { currency: 'INR', minor_units: '500' },
            quantity: { value: '100', unit_code: 'each' },
            offered_product: CAKE,
            substitution_evidence: ['close enough'],
          },
        ],
      }),
      nowMs: NOW,
    });
    expect(issued).toEqual({ kind: 'withhold', reason: 'terms_unusable' });
  });
});

// ---------------------------------------------------------------------------
// Items 6, 8, 9 — the tender loop, ranking, the ready notice, the notices
// ---------------------------------------------------------------------------

const SUPPLIER_B = 'did:plc:supplierbbbb';

describe('items 6, 8, 9 — two suppliers, one tender, the loop runs to ready', () => {
  it('counters both until neither can move, ranks the better one first, tells the owner once, and notifies the loser', async () => {
    const buyer = openRuntime(BUYER_DID);
    const supplierA = openRuntime(SUPPLIER_DID);
    const supplierB = openRuntime(SUPPLIER_B);
    const workflow = new WorkflowService({
      repository: new InMemoryWorkflowRepository(),
      nowMsFn: () => NOW,
    });
    setWorkflowService(workflow);
    // One settings row serves both suppliers here (they share one file).
    expect(supplierA.settings.writeSupplier(supplierSettings(POLICY)).ok).toBe(true);

    installCommerceRuntime(buyer);
    const created = await createTender({
      suppliers: [
        { supplierDid: SUPPLIER_DID, serviceRkey: 'self' },
        { supplierDid: SUPPLIER_B, serviceRkey: 'shop' },
      ],
      lines: LINES,
      projection: makeProjection(),
      currency: 'INR',
      nowMs: NOW,
    });
    if (!created.ok) throw new Error(created.refusal);
    startTenderNegotiation(
      created.tenderId,
      {
        currency: 'INR',
        targetTotalMinor: '42000',
        budgetCeilingMinor: '48000',
        maxRounds: 3,
        deadlineSeconds: 600,
      },
      NOW,
    );
    const runtimes: Record<string, CommerceRuntime> = {
      [SUPPLIER_DID]: supplierA,
      [SUPPLIER_B]: supplierB,
    };
    const unit: Record<string, string> = { [SUPPLIER_DID]: '500', [SUPPLIER_B]: '480' };

    // Each supplier answers its own request.
    for (const wire of [...sent]) {
      const supplier = runtimes[wire.toDid] as CommerceRuntime;
      installCommerceRuntime(supplier);
      const issued = transformInboundOrderResult({
        capability: 'request_quote',
        fromDid: BUYER_DID,
        params: wire.body.params,
        resultJSON: JSON.stringify({
          can_supply: true,
          lines: [
            {
              line_id: 'l1',
              unit_price: { currency: 'INR', minor_units: unit[wire.toDid] },
              quantity: { value: '100', unit_code: 'each' },
            },
          ],
        }),
        nowMs: NOW,
      });
      if (issued.kind !== 'replace') throw new Error(JSON.stringify(issued));
      installCommerceRuntime(buyer);
      expect(
        applyInboundBuyerResponse({
          supplierDid: wire.toDid,
          response: {
            capability: REQUEST_QUOTE_CAPABILITY,
            query_id: String(wire.body.query_id),
            status: 'success',
            result: JSON.parse(issued.json) as unknown,
          },
          nowMs: NOW,
        }),
      ).toBe('applied');
    }

    // Before any counter, B at 48000 is in budget and A at 50000 is not.
    installCommerceRuntime(buyer);
    const before = rankTender({ tenderId: created.tenderId, nowMs: NOW });
    expect(before.ok && before.ranking.ranked.map((r) => r.supplier_did)).toEqual([SUPPLIER_B]);
    expect(before.ok && before.ranking.excluded).toEqual([
      { supplier_did: SUPPLIER_DID, reason: 'over_budget' },
    ]);

    /** One loop pass, then every counter it sent answered by its supplier. */
    async function round(): Promise<number> {
      installCommerceRuntime(buyer);
      const mark = sent.length;
      const count = await runNegotiationTick(NOW);
      for (const wire of sent.slice(mark)) {
        const supplier = runtimes[wire.toDid] as CommerceRuntime;
        const counter = wire.body.params as CounterOffer;
        installCommerceRuntime(supplier);
        const admitted = admitInboundCounter({ params: counter, buyerDid: BUYER_DID, nowMs: NOW });
        let json: string;
        if (admitted.kind === 'answer') json = admitted.json;
        else if (admitted.kind === 'dispatch') {
          const runner = answerCounterOffer(admitted.params);
          if (!runner.ok) throw new Error(runner.error);
          const settled = transformInboundOrderResult({
            capability: 'com.dinakernel.commerce.counter_offer',
            fromDid: BUYER_DID,
            params: admitted.params,
            resultJSON: JSON.stringify(runner.result),
            nowMs: NOW,
          });
          if (settled.kind !== 'replace') throw new Error(JSON.stringify(settled));
          json = settled.json;
        } else throw new Error(admitted.refusal);
        installCommerceRuntime(buyer);
        applyInboundBuyerResponse({
          supplierDid: wire.toDid,
          response: {
            capability: 'com.dinakernel.commerce.counter_offer',
            query_id: counter.counter_id,
            status: 'success',
            result: JSON.parse(json) as unknown,
          },
          nowMs: NOW,
        });
      }
      return count;
    }

    // Target 42000 (420 each). Each round moves halfway, floors at 10% off.
    expect(await round()).toBe(2); // A 500 -> 460; B 480 -> 450
    expect(await round()).toBe(2); // A 460 -> 450 (its floor); B 450 -> 435
    expect(await round()).toBe(2); // A holds at 450; B 435 -> 432 (its floor)
    expect(await round()).toBe(0); // A held, B spent its three rounds: ready
    installCommerceRuntime(buyer);
    expect(buyer.buyerNegotiation.getTender(created.tenderId)?.state).toBe('ready');

    const ranked = rankTender({ tenderId: created.tenderId, nowMs: NOW });
    if (!ranked.ok) throw new Error(ranked.refusal);
    expect(ranked.ranking.ranked.map((r) => [r.supplier_did, r.total_minor])).toEqual([
      [SUPPLIER_B, '43200'],
      [SUPPLIER_DID, '45000'],
    ]);
    // The owner hears once.
    const card = workflow.store().getById(`tender-ready-${created.tenderId}`);
    expect(card?.status).toBe('pending_approval');
    expect(JSON.parse(card?.payload ?? '{}')).toMatchObject({
      type: 'tender_ready',
      offers: 2,
      best_total_minor: '43200',
    });

    // Award B (the route does this; here the notices alone): A is told, B is not,
    // and the notice carries no price and no winner.
    const mark = sent.length;
    const notices = await sendNotAwardedNotices({
      tenderId: created.tenderId,
      winnerDid: SUPPLIER_B,
      nowMs: NOW,
    });
    expect(notices).toEqual([{ supplier_did: SUPPLIER_DID, sent: true }]);
    const notice = sent.slice(mark)[0];
    expect(notice?.toDid).toBe(SUPPLIER_DID);
    expect(notice?.body.capability).toBe('com.dinakernel.commerce.quote_outcome');
    expect(Object.keys(notice?.body.params as object).sort()).toEqual([
      'outcome',
      'quote_id',
      'request_id',
    ]);
    // A's Core closes the quote on receipt.
    installCommerceRuntime(supplierA);
    answerQuoteOutcomeInCore({ params: notice?.body.params, buyerDid: BUYER_DID, nowMs: NOW });
    const aQuote = (notice?.body.params as { quote_id: string }).quote_id;
    expect(supplierA.negotiation.outcomeFor(BUYER_DID, aQuote)).not.toBeNull();
  });
});

describe('item 6 — a supplier that never answers', () => {
  it('is asked once more with the same counter after its window (a lost reply is replayed), then taken as silent, and the tender reaches ready', async () => {
    const buyer = openRuntime(BUYER_DID);
    const supplier = openRuntime(SUPPLIER_DID);
    const workflow = new WorkflowService({
      repository: new InMemoryWorkflowRepository(),
      nowMsFn: () => NOW,
    });
    setWorkflowService(workflow);
    installCommerceRuntime(buyer);
    const created = await createTender({
      suppliers: [{ supplierDid: SUPPLIER_DID, serviceRkey: 'self' }],
      lines: LINES,
      projection: makeProjection(),
      currency: 'INR',
      nowMs: NOW,
    });
    if (!created.ok) throw new Error(created.refusal);
    startTenderNegotiation(
      created.tenderId,
      {
        currency: 'INR',
        targetTotalMinor: '40000',
        budgetCeilingMinor: '60000',
        deadlineSeconds: 3600,
      },
      NOW,
    );
    const request = sent[0]?.body.params as QuoteRequest;
    const quote = supplierQuotes(supplier, request);
    installCommerceRuntime(buyer);
    applyInboundBuyerResponse({
      supplierDid: SUPPLIER_DID,
      response: {
        capability: REQUEST_QUOTE_CAPABILITY,
        query_id: request.request_id,
        status: 'success',
        result: { quote },
      },
      nowMs: NOW,
    });
    expect(await runNegotiationTick(NOW)).toBe(1);
    // Still inside its window: waiting, nothing new sent.
    expect(await runNegotiationTick(NOW + 30_000)).toBe(0);
    expect(buyer.buyerNegotiation.getTender(created.tenderId)?.state).toBe('negotiating');
    // Past its window with no answer: the SAME counter goes once more, so a
    // supplier that answered and lost the reply can replay it.
    const mark = sent.length;
    expect(await runNegotiationTick(NOW + 10 * 60_000)).toBe(0);
    expect(sent.slice(mark).map((w) => w.body.query_id)).toEqual([sent[mark - 1]?.body.query_id]);
    const [only] = buyer.buyerNegotiation.countersForQuote(SUPPLIER_DID, quote.quote_id);
    expect(only).toMatchObject({ attempts: 2, state: 'sent' });
    expect(buyer.buyerNegotiation.getTender(created.tenderId)?.state).toBe('negotiating');
    // The award waits on that second window too.
    expect(counterInFlight(SUPPLIER_DID, quote.quote_id, NOW + 10 * 60_000 + 1_000)).toBe(true);
    // Its second window passes: silent, not asked again, and the tender is ready.
    expect(await runNegotiationTick(NOW + 20 * 60_000)).toBe(0);
    expect(buyer.buyerNegotiation.countersForQuote(SUPPLIER_DID, quote.quote_id)).toHaveLength(1);
    expect(counterInFlight(SUPPLIER_DID, quote.quote_id, NOW + 20 * 60_000)).toBe(false);
    expect(buyer.buyerNegotiation.getTender(created.tenderId)?.state).toBe('ready');
  });
});

describe('item 6 — a retained counter that no longer checks out', () => {
  it('is never sent again: the attempt is spent, and the supplier is taken as silent', async () => {
    const buyer = openRuntime(BUYER_DID);
    const supplier = openRuntime(SUPPLIER_DID);
    setWorkflowService(
      new WorkflowService({ repository: new InMemoryWorkflowRepository(), nowMsFn: () => NOW }),
    );
    installCommerceRuntime(buyer);
    const created = await createTender({
      suppliers: [{ supplierDid: SUPPLIER_DID, serviceRkey: 'self' }],
      lines: LINES,
      projection: makeProjection(),
      currency: 'INR',
      nowMs: NOW,
    });
    if (!created.ok) throw new Error(created.refusal);
    startTenderNegotiation(
      created.tenderId,
      {
        currency: 'INR',
        targetTotalMinor: '40000',
        budgetCeilingMinor: '60000',
        deadlineSeconds: 3600,
      },
      NOW,
    );
    const request = sent[0]?.body.params as QuoteRequest;
    const quote = supplierQuotes(supplier, request);
    installCommerceRuntime(buyer);
    applyInboundBuyerResponse({
      supplierDid: SUPPLIER_DID,
      response: {
        capability: REQUEST_QUOTE_CAPABILITY,
        query_id: request.request_id,
        status: 'success',
        result: { quote },
      },
      nowMs: NOW,
    });
    expect(await runNegotiationTick(NOW)).toBe(1);
    const [stored] = buyer.buyerNegotiation.countersForQuote(SUPPLIER_DID, quote.quote_id);
    if (stored === undefined) throw new Error('no counter recorded');
    // The row is edited after writing: a lower target, the digest left as it was.
    const edited = JSON.parse(stored.counterJson) as CounterOffer;
    buyer.buyerNegotiation.putCounter({
      ...stored,
      counterJson: JSON.stringify({
        ...edited,
        target_total: { ...edited.target_total, minor_units: '1' },
      }),
    });
    const mark = sent.length;
    expect(await runNegotiationTick(NOW + 10 * 60_000)).toBe(0);
    expect(sent.length).toBe(mark);
    expect(buyer.buyerNegotiation.getCounter(stored.counterId)?.attempts).toBe(2);
    expect(await runNegotiationTick(NOW + 20 * 60_000)).toBe(0);
    expect(sent.length).toBe(mark);
    expect(buyer.buyerNegotiation.getTender(created.tenderId)?.state).toBe('ready');
  });
});

describe('review fixes — the rules the first review found loose', () => {
  it("the round limit counts the supplier's own records, whatever round number the buyer writes", async () => {
    const pair = await negotiatingPair({ ...POLICY, maxRounds: 2 });
    const { commerceRecordDigest } = jest.requireActual(
      '@dina/commerce-protocol',
    ) as typeof import('@dina/commerce-protocol');
    const { sha256 } = jest.requireActual(
      '@noble/hashes/sha2.js',
    ) as typeof import('@noble/hashes/sha2.js');
    const asRoundOne = (counter: CounterOffer): CounterOffer => {
      const { counter_digest: _d, ...rest } = { ...counter, round: '1' };
      return {
        ...rest,
        counter_digest: commerceRecordDigest('counter', rest, (d) => sha256(d)),
      } as CounterOffer;
    };
    for (let i = 0; i < 2; i += 1) {
      const counter = asRoundOne(await buyerCounters(pair, '40000'));
      const answer = supplierAnswers(pair, counter) as { json: string };
      buyerReceives(pair, { ...counter }, answer.json);
    }
    const third = asRoundOne(await buyerCounters(pair, '40000'));
    expect(supplierAnswers(pair, third)).toEqual({ refused: 'round_refused' });
  });

  it('a revision stands as long as the head it replaces did, measured from now', async () => {
    const buyer = openRuntime(BUYER_DID);
    const supplier = openRuntime(SUPPLIER_DID);
    setWorkflowService(
      new WorkflowService({ repository: new InMemoryWorkflowRepository(), nowMsFn: () => NOW }),
    );
    expect(supplier.settings.writeSupplier(supplierSettings(POLICY)).ok).toBe(true);
    const request = await buyerAsks(buyer);
    installCommerceRuntime(supplier);
    // A one-hour price, as a runner quoting perishables would.
    const issued = transformInboundOrderResult({
      capability: 'request_quote',
      fromDid: BUYER_DID,
      params: request,
      resultJSON: JSON.stringify({
        can_supply: true,
        valid_until: new Date(NOW + 60 * 60_000).toISOString(),
        lines: [
          {
            line_id: 'l1',
            unit_price: { currency: 'INR', minor_units: '500' },
            quantity: { value: '100', unit_code: 'each' },
          },
        ],
      }),
      nowMs: NOW,
    });
    if (issued.kind !== 'replace') throw new Error(JSON.stringify(issued));
    const quote = JSON.parse(issued.json) as SignedQuote;
    installCommerceRuntime(buyer);
    applyInboundBuyerResponse({
      supplierDid: SUPPLIER_DID,
      response: {
        capability: REQUEST_QUOTE_CAPABILITY,
        query_id: request.request_id,
        status: 'success',
        result: { quote },
      },
      nowMs: NOW,
    });
    const pair: Pair = {
      buyer,
      supplier,
      quote,
      workflow: new WorkflowService({
        repository: new InMemoryWorkflowRepository(),
        nowMsFn: () => NOW,
      }),
    };
    const counter = await buyerCounters(pair, '40000');
    const answer = JSON.parse((supplierAnswers(pair, counter) as { json: string }).json) as {
      quote: SignedQuote;
    };
    expect(Date.parse(answer.quote.valid_until) - Date.parse(answer.quote.issued_at)).toBe(
      60 * 60_000,
    );
  });

  it('an answer carrying a different quote than the one countered is recorded as refused', async () => {
    const pair = await negotiatingPair();
    const counter = await buyerCounters(pair, '40000');
    // A second, unrelated quote this buyer also holds from the same supplier.
    const other = await buyerAsks(pair.buyer, 'req-other');
    const otherQuote = supplierQuotes(pair.supplier, other, '600');
    installCommerceRuntime(pair.buyer);
    applyInboundBuyerResponse({
      supplierDid: SUPPLIER_DID,
      response: {
        capability: REQUEST_QUOTE_CAPABILITY,
        query_id: other.request_id,
        status: 'success',
        result: { quote: otherQuote },
      },
      nowMs: NOW,
    });
    buyerReceives(pair, counter, JSON.stringify({ quote: otherQuote, outcome: 'revised' }));
    expect(pair.buyer.buyerNegotiation.getCounter(counter.counter_id)).toMatchObject({
      state: 'refused',
      answerDigest: '',
    });
  });

  it('the loop asks a supplier whose owner is deciding again after a pause, and not before', async () => {
    const pair = await negotiatingPair({
      ...POLICY,
      items: [{ product: GTIN, floorMinorUnits: '420', autoFloorMinorUnits: '480' }],
    });
    installCommerceRuntime(pair.buyer);
    // A tender whose only member is the pair's quote.
    const tenderId = 'tnd-owner-wait';
    pair.buyer.tenders.putTender({
      tenderId,
      linesJson: '[]',
      projectionJson: '{}',
      requestedTermsJson: '{}',
      expiresAt: NOW + 3_600_000,
      createdAt: NOW,
    });
    pair.buyer.tenders.putMember({
      tenderId,
      supplierDid: SUPPLIER_DID,
      requestId: pair.quote.request_id,
      requestDigest: pair.quote.request_digest,
      quoteId: pair.quote.quote_id,
      serviceRkey: 'self',
    });
    startTenderNegotiation(
      tenderId,
      {
        currency: 'INR',
        targetTotalMinor: '30000',
        budgetCeilingMinor: '60000',
        deadlineSeconds: 3600,
      },
      NOW,
    );
    const mark = sent.length;
    expect(await runNegotiationTick(NOW)).toBe(1);
    const counter = sent[mark]?.body.params as CounterOffer;
    const answer = supplierAnswers(pair, counter) as { json: string };
    // Round 1 moved the price to the automatic 480 AND left a question open:
    // a revision, so the loop asks again straight away.
    expect(JSON.parse(answer.json)).toMatchObject({ outcome: 'revised', pending_owner: true });
    buyerReceives(pair, counter, answer.json);
    expect(pair.buyer.buyerNegotiation.getCounter(counter.counter_id)?.state).toBe('revised');
    installCommerceRuntime(pair.buyer);
    expect(await runNegotiationTick(NOW + 1_000)).toBe(1);
    // Round 2 cannot move below 480 until the owner answers: a hold that waits.
    const second = sent.at(-1)?.body.params as CounterOffer;
    const held = supplierAnswers(pair, second) as { json: string };
    expect(JSON.parse(held.json)).toMatchObject({ outcome: 'held', pending_owner: true });
    buyerReceives(pair, second, held.json);
    expect(pair.buyer.buyerNegotiation.getCounter(second.counter_id)?.state).toBe('pending');
    installCommerceRuntime(pair.buyer);
    expect(await runNegotiationTick(NOW + 5_000)).toBe(0);
    // After the pause it asks again, waiting longer each time the owner is
    // still deciding (20 s, 40 s, 80 s, 160 s) — and a round that only waited
    // did not use one up, on either side, so the owner's later yes can land.
    for (const waitMs of [20_000, 40_000, 80_000, 160_000]) {
      expect(await runNegotiationTick(NOW + waitMs - 1_000)).toBe(0);
      expect(await runNegotiationTick(NOW + waitMs)).toBe(1);
      const again = sent.at(-1)?.body.params as CounterOffer;
      const reply = supplierAnswers(pair, again) as { json: string };
      expect(JSON.parse(reply.json)).toMatchObject({ outcome: 'held', pending_owner: true });
      buyerReceives(pair, again, reply.json);
      installCommerceRuntime(pair.buyer);
    }
    // The owner says yes; the next ask reaches the floor it authorised.
    installCommerceRuntime(pair.supplier);
    const [question] = pair.supplier.negotiation.questionsForQuote(pair.quote.quote_id);
    const card = pair.workflow.store().getById(question?.taskId ?? '');
    makeNegotiationPriceDecisionHandler({
      runtime: () => pair.supplier,
      workflow: () => pair.workflow,
      nowMs: () => NOW,
    })({ task: card as never, decision: 'approved' });
    installCommerceRuntime(pair.buyer);
    // Five waits in, the loop asks at most every five minutes.
    expect(await runNegotiationTick(NOW + 299_000)).toBe(0);
    expect(await runNegotiationTick(NOW + 300_000)).toBe(1);
    const last = sent.at(-1)?.body.params as CounterOffer;
    const signed = supplierAnswers(pair, last) as { json: string };
    expect(JSON.parse(signed.json)).toMatchObject({ outcome: 'revised' });
    expect(buyerReceives(pair, last, signed.json)).toBe('applied');
    expect(headPrice(pair)).toBe('420');
  });
});

describe('dual review round 1 — pinned fixes', () => {
  it('F1: a runner that names the buyer placeholder for a requirement line is withheld', async () => {
    const buyer = openRuntime(BUYER_DID);
    const supplier = withCatalogue(openRuntime(SUPPLIER_DID), [item({})]);
    const request = await buyerNeeds(buyer, 'Floral celebration cake');
    installCommerceRuntime(supplier);
    const issued = transformInboundOrderResult({
      capability: 'request_quote',
      fromDid: BUYER_DID,
      params: request,
      resultJSON: JSON.stringify({
        can_supply: true,
        lines: [
          {
            line_id: 'l1',
            unit_price: { currency: 'INR', minor_units: '24000' },
            quantity: { value: '1', unit_code: 'each' },
            offered_product: request.lines[0]?.product,
            substitution_evidence: ['it is what you asked for'],
          },
        ],
      }),
      nowMs: NOW,
    });
    expect(issued).toEqual({ kind: 'withhold', reason: 'terms_unusable' });
  });

  it('F2: a counter for a tender that is no longer negotiating is refused before anything is written or sent', async () => {
    const pair = await negotiatingPair();
    installCommerceRuntime(pair.buyer);
    startTenderNegotiation(
      'tnd-closed',
      { currency: 'INR', targetTotalMinor: '30000', budgetCeilingMinor: '60000' },
      NOW,
    );
    pair.buyer.buyerNegotiation.moveTender('tnd-closed', 'negotiating', 'awarded', NOW, {
      supplierDid: SUPPLIER_DID,
      approvalId: 'oap-x',
    });
    const mark = sent.length;
    const outcome = await sendCounterOffer({
      supplierDid: SUPPLIER_DID,
      quoteId: pair.quote.quote_id,
      serviceRkey: 'self',
      targetTotal: { currency: 'INR', minor_units: '40000' },
      tenderId: 'tnd-closed',
      nowMs: NOW,
    });
    expect(outcome).toEqual({ kind: 'refused', reason: 'tender_closed' });
    expect(sent).toHaveLength(mark);
    expect(
      pair.buyer.buyerNegotiation.countersForQuote(SUPPLIER_DID, pair.quote.quote_id),
    ).toHaveLength(0);
  });

  it('F3: a refusal after the runner goes back as a non-disclosing refused answer, recorded and replayed; the buyer records refused', async () => {
    const pair = await negotiatingPair();
    const counter = await buyerCounters(pair, '40000');
    installCommerceRuntime(pair.supplier);
    const admitted = admitInboundCounter({ params: counter, buyerDid: BUYER_DID, nowMs: NOW });
    if (admitted.kind !== 'dispatch') throw new Error(admitted.kind);
    // The runner is slow: its answer arrives after the counter's respond_by.
    const late = Date.parse(counter.respond_by) + 1;
    const settled = transformInboundOrderResult({
      capability: 'com.dinakernel.commerce.counter_offer',
      fromDid: BUYER_DID,
      params: admitted.params,
      resultJSON: JSON.stringify({
        lines: [{ line_id: 'l1', unit_price: { currency: 'INR', minor_units: '450' } }],
      }),
      nowMs: late,
    });
    expect(settled).toEqual({ kind: 'replace', json: JSON.stringify({ outcome: 'refused' }) });
    expect(admitInboundCounter({ params: counter, buyerDid: BUYER_DID, nowMs: late })).toEqual({
      kind: 'answer',
      json: JSON.stringify({ outcome: 'refused' }),
    });
    expect(buyerReceives(pair, counter, JSON.stringify({ outcome: 'refused' }))).toBe(
      'not_an_answer',
    );
    expect(pair.buyer.buyerNegotiation.getCounter(counter.counter_id)?.state).toBe('refused');
    expect(counterInFlight(SUPPLIER_DID, pair.quote.quote_id, NOW)).toBe(false);
  });

  it('F4: counters admitted but not yet settled count toward the daily cap', async () => {
    const pair = await negotiatingPair({ ...POLICY, maxCountersPerBuyerPerDay: 1 });
    const other = await buyerAsks(pair.buyer, 'req-second');
    const otherQuote = supplierQuotes(pair.supplier, other);
    installCommerceRuntime(pair.buyer);
    applyInboundBuyerResponse({
      supplierDid: SUPPLIER_DID,
      response: {
        capability: REQUEST_QUOTE_CAPABILITY,
        query_id: other.request_id,
        status: 'success',
        result: { quote: otherQuote },
      },
      nowMs: NOW,
    });
    const first = await buyerCounters(pair, '40000');
    installCommerceRuntime(pair.buyer);
    const second = await sendCounterOffer({
      supplierDid: SUPPLIER_DID,
      quoteId: otherQuote.quote_id,
      serviceRkey: 'self',
      targetTotal: { currency: 'INR', minor_units: '40000' },
      nowMs: NOW,
    });
    if (second.kind === 'refused') throw new Error(second.reason);
    installCommerceRuntime(pair.supplier);
    expect(admitInboundCounter({ params: first, buyerDid: BUYER_DID, nowMs: NOW }).kind).toBe(
      'dispatch',
    );
    // The first has not settled; the second is still over the cap.
    expect(
      admitInboundCounter({ params: second.counter, buyerDid: BUYER_DID, nowMs: NOW }),
    ).toEqual({
      kind: 'refused',
      refusal: 'counter_limit',
    });
  });

  it('F5: after the owner raises a floor, a revision never re-signs a kept line below it', async () => {
    const buyer = openRuntime(BUYER_DID);
    const supplier = openRuntime(SUPPLIER_DID);
    setWorkflowService(
      new WorkflowService({ repository: new InMemoryWorkflowRepository(), nowMsFn: () => NOW }),
    );
    expect(supplier.settings.writeSupplier(supplierSettings(POLICY)).ok).toBe(true);
    const OTHER = { scheme: 'gtin' as const, value: '00012345678905' };
    installCommerceRuntime(buyer);
    const asked = await requestQuote({
      supplierDid: SUPPLIER_DID,
      serviceRkey: 'self',
      requestId: 'req-two',
      idempotencyKey: 'idem-two',
      lines: [
        { lineId: 'l1', product: GTIN, quantity: { value: '100', unit_code: 'each' } },
        { lineId: 'l2', product: OTHER, quantity: { value: '100', unit_code: 'each' } },
      ],
      projection: makeProjection(),
      nowMs: NOW,
    });
    if (asked.kind !== 'sent') throw new Error(asked.kind);
    installCommerceRuntime(supplier);
    const issued = transformInboundOrderResult({
      capability: 'request_quote',
      fromDid: BUYER_DID,
      params: asked.request,
      resultJSON: JSON.stringify({
        can_supply: true,
        lines: [
          {
            line_id: 'l1',
            unit_price: { currency: 'INR', minor_units: '500' },
            quantity: { value: '100', unit_code: 'each' },
          },
          {
            line_id: 'l2',
            unit_price: { currency: 'INR', minor_units: '500' },
            quantity: { value: '100', unit_code: 'each' },
          },
        ],
      }),
      nowMs: NOW,
    });
    if (issued.kind !== 'replace') throw new Error('not issued');
    const quote = JSON.parse(issued.json) as SignedQuote;
    installCommerceRuntime(buyer);
    applyInboundBuyerResponse({
      supplierDid: SUPPLIER_DID,
      response: {
        capability: REQUEST_QUOTE_CAPABILITY,
        query_id: 'req-two',
        status: 'success',
        result: { quote },
      },
      nowMs: NOW,
    });
    const pair: Pair = {
      buyer,
      supplier,
      quote,
      workflow: new WorkflowService({
        repository: new InMemoryWorkflowRepository(),
        nowMsFn: () => NOW,
      }),
    };
    // Round 1: both lines to 450 (the default 10% floor).
    const r1 = await buyerCounters(pair, '80000');
    buyerReceives(pair, r1, (supplierAnswers(pair, r1) as { json: string }).json);
    // The owner now raises l1's floor to 480; l2 may still move.
    installCommerceRuntime(supplier);
    expect(
      supplier.settings.writeSupplier(
        supplierSettings({
          ...POLICY,
          defaultMaxDiscountBps: 2_000,
          items: [{ product: GTIN, floorMinorUnits: '480' }],
        }),
      ).ok,
    ).toBe(true);
    const r2 = await buyerCounters(pair, '80000');
    const answer = JSON.parse((supplierAnswers(pair, r2) as { json: string }).json) as {
      outcome: string;
      quote: SignedQuote;
    };
    // l1 kept at 450 would be under 480: no revision is signed at all.
    expect(answer.outcome).toBe('held');
    expect(answer.quote.quote_revision).toBe('2');
  });

  it('F8: an unanswered counter holds the award only while its window is open, never after', async () => {
    const pair = await negotiatingPair();
    const counter = await buyerCounters(pair, '40000');
    installCommerceRuntime(pair.buyer);
    expect(counterInFlight(SUPPLIER_DID, pair.quote.quote_id, NOW + 60_000)).toBe(true);
    // A manual counter is never sent again: past its window it blocks nothing.
    expect(counterInFlight(SUPPLIER_DID, pair.quote.quote_id, NOW + 10 * 60_000)).toBe(false);
    expect(pair.buyer.buyerNegotiation.getCounter(counter.counter_id)?.attempts).toBe(1);
  });

  it('F10: a notice the transport did not take stays pending and the sweeper sends it later', async () => {
    const pair = await negotiatingPair();
    installCommerceRuntime(pair.buyer);
    pair.buyer.tenders.putTender({
      tenderId: 'tnd-notice',
      linesJson: '[]',
      projectionJson: '{}',
      requestedTermsJson: '{}',
      expiresAt: NOW,
      createdAt: NOW,
    });
    pair.buyer.tenders.putMember({
      tenderId: 'tnd-notice',
      supplierDid: SUPPLIER_DID,
      requestId: pair.quote.request_id,
      requestDigest: pair.quote.request_digest,
      quoteId: pair.quote.quote_id,
      serviceRkey: 'self',
    });
    installCommerceServiceQueryDispatch(async () => ({ sent: false, error: 'relay down' }));
    expect(
      await sendNotAwardedNotices({
        tenderId: 'tnd-notice',
        winnerDid: 'did:plc:winner',
        nowMs: NOW,
      }),
    ).toEqual([{ supplier_did: SUPPLIER_DID, sent: false }]);
    expect(pair.buyer.buyerNegotiation.listNotices('pending')).toHaveLength(1);
    installCommerceServiceQueryDispatch(async (args) => {
      sent.push({ toDid: args.toDid, body: args.body as unknown as Record<string, unknown> });
      return { sent: true };
    });
    await runNegotiationTick(NOW + 5_000); // too soon to retry
    expect(pair.buyer.buyerNegotiation.listNotices('pending')).toHaveLength(1);
    await runNegotiationTick(NOW + 70_000);
    expect(pair.buyer.buyerNegotiation.listNotices('pending')).toHaveLength(0);
    expect(pair.buyer.buyerNegotiation.listNotices('sent')).toHaveLength(1);
    expect(sent.at(-1)?.body.capability).toBe('com.dinakernel.commerce.quote_outcome');
  });

  it('F12: a counterproposal recovered by reconciliation keeps its replacement quote — only when the answer is about the held order', async () => {
    const buyer = openRuntime(BUYER_DID);
    const request = await buyerAsks(buyer);
    installCommerceRuntime(buyer);
    const original = makeSignedQuote(request, { quote_id: 'q-original' });
    const replacement = (quoteId: string, replaces = original.quote_digest): SignedQuote =>
      makeSignedQuote(request, {
        quote_id: quoteId,
        replaces_quote_digest: replaces,
        issued_at: '2026-08-07T11:30:00.000Z',
      });
    const reconcile = (queryId: string, acknowledgement: unknown): void => {
      applyInboundBuyerResponse({
        supplierDid: SUPPLIER_DID,
        response: {
          capability: 'order_reconcile',
          query_id: queryId,
          status: 'success',
          result: { outcome: 'received_countered', acknowledgement },
        },
        nowMs: NOW,
      });
    };
    // Bound to the held order: kept.
    reconcile('po-lost', heldOrderCounter(buyer, original, replacement('q-reconciled'), 'po-lost'));
    expect(buyer.buyerQuotes.chain(SUPPLIER_DID, 'q-reconciled')).toHaveLength(1);
    // About another order than the one asked about: not kept.
    const other = heldOrderCounter(buyer, original, replacement('q-wrong-order'), 'po-other');
    reconcile('po-lost', other);
    expect(buyer.buyerQuotes.chain(SUPPLIER_DID, 'q-wrong-order')).toHaveLength(0);
    // Lineage that does not point at the countered quote: not kept.
    reconcile(
      'po-lineage',
      heldOrderCounter(buyer, original, replacement('q-bad-lineage', 'c'.repeat(64)), 'po-lineage'),
    );
    expect(buyer.buyerQuotes.chain(SUPPLIER_DID, 'q-bad-lineage')).toHaveLength(0);
    // No order held at all, or an acknowledgement that does not validate: not kept.
    reconcile('po-none', { kind: 'counterproposal', replacement_quote: replacement('q-no-order') });
    expect(buyer.buyerQuotes.chain(SUPPLIER_DID, 'q-no-order')).toHaveLength(0);
  });

  it('F14: an offer already at the target ends the loop before any counter, even when an above-target member sorts first', async () => {
    const t = await tenderOfTwo({ [SUPPLIER_DID]: '500', [SUPPLIER_B]: '300' }, '40000');
    // Two distinct members, the above-target one listed FIRST.
    expect(t.buyer.tenders.listMembers(t.tenderId).map((m) => m.supplierDid)).toEqual([
      SUPPLIER_DID,
      SUPPLIER_B,
    ]);
    const mark = sent.length;
    expect(await runNegotiationTick(NOW)).toBe(0);
    expect(sent).toHaveLength(mark);
    expect(t.buyer.buyerNegotiation.getTender(t.tenderId)?.state).toBe('ready');
  });
});

/** A tender to two suppliers, each answering its request at its own unit price, negotiating. */
async function tenderOfTwo(
  unitBySupplier: Record<string, string>,
  targetTotalMinor: string,
  deadlineSeconds = 600,
  startMs = NOW,
): Promise<{ buyer: CommerceRuntime; tenderId: string; quotes: Record<string, SignedQuote> }> {
  const mark = sent.length;
  const buyer = openRuntime(BUYER_DID);
  const runtimes: Record<string, CommerceRuntime> = {
    [SUPPLIER_DID]: openRuntime(SUPPLIER_DID),
    [SUPPLIER_B]: openRuntime(SUPPLIER_B),
  };
  setWorkflowService(
    new WorkflowService({ repository: new InMemoryWorkflowRepository(), nowMsFn: () => NOW }),
  );
  installCommerceRuntime(buyer);
  const created = await createTender({
    suppliers: [
      { supplierDid: SUPPLIER_DID, serviceRkey: 'self' },
      { supplierDid: SUPPLIER_B, serviceRkey: 'shop' },
    ],
    lines: LINES,
    projection: makeProjection(),
    currency: 'INR',
    nowMs: NOW,
  });
  if (!created.ok) throw new Error(created.refusal);
  startTenderNegotiation(
    created.tenderId,
    { currency: 'INR', targetTotalMinor, budgetCeilingMinor: '60000', deadlineSeconds },
    startMs,
  );
  const quotes: Record<string, SignedQuote> = {};
  for (const wire of sent.slice(mark)) {
    installCommerceRuntime(runtimes[wire.toDid] as CommerceRuntime);
    const issued = transformInboundOrderResult({
      capability: 'request_quote',
      fromDid: BUYER_DID,
      params: wire.body.params,
      resultJSON: JSON.stringify({
        can_supply: true,
        lines: [
          {
            line_id: 'l1',
            unit_price: { currency: 'INR', minor_units: unitBySupplier[wire.toDid] },
            quantity: { value: '100', unit_code: 'each' },
          },
        ],
      }),
      nowMs: NOW,
    });
    if (issued.kind !== 'replace') throw new Error(JSON.stringify(issued));
    const result = JSON.parse(issued.json) as { quote?: SignedQuote } & SignedQuote;
    quotes[wire.toDid] = result.quote ?? result;
    installCommerceRuntime(buyer);
    expect(
      applyInboundBuyerResponse({
        supplierDid: wire.toDid,
        response: {
          capability: REQUEST_QUOTE_CAPABILITY,
          query_id: String(wire.body.query_id),
          status: 'success',
          result,
        },
        nowMs: NOW,
      }),
    ).toBe('applied');
  }
  return { buyer, tenderId: created.tenderId, quotes };
}

describe('dual review round 2 — pinned fixes', () => {
  it('R2-3: one counter id names one body — another body under a reserved id is refused, and only the first is signed', async () => {
    const pair = await negotiatingPair();
    const counter = await buyerCounters(pair, '40000');
    const { commerceRecordDigest } = jest.requireActual(
      '@dina/commerce-protocol',
    ) as typeof import('@dina/commerce-protocol');
    const { sha256 } = jest.requireActual(
      '@noble/hashes/sha2.js',
    ) as typeof import('@noble/hashes/sha2.js');
    const { counter_digest: _d, ...rest } = {
      ...counter,
      target_total: { currency: 'INR', minor_units: '35000' },
    };
    const other = {
      ...rest,
      counter_digest: commerceRecordDigest('counter', rest, (d) => sha256(d)),
    } as CounterOffer;

    installCommerceRuntime(pair.supplier);
    const first = admitInboundCounter({ params: counter, buyerDid: BUYER_DID, nowMs: NOW });
    if (first.kind !== 'dispatch') throw new Error(JSON.stringify(first));
    expect(admitInboundCounter({ params: other, buyerDid: BUYER_DID, nowMs: NOW })).toEqual({
      kind: 'refused',
      refusal: 'counter_invalid',
    });
    // Had the other body reached the runner, Core signs nothing for it and
    // leaves the first body's reservation as it was.
    const otherParams = { counter: other, current_quote: first.params.current_quote };
    const runner = answerCounterOffer(otherParams);
    if (!runner.ok) throw new Error(runner.error);
    const settledOther = transformInboundOrderResult({
      capability: 'com.dinakernel.commerce.counter_offer',
      capabilityId: 'com.dinakernel.commerce.negotiate-quote',
      fromDid: BUYER_DID,
      params: otherParams,
      resultJSON: JSON.stringify(runner.result),
      nowMs: NOW,
    });
    expect(settledOther.kind === 'replace' && JSON.parse(settledOther.json)).toEqual({
      outcome: 'refused',
    });
    expect(pair.supplier.negotiation.getCounter(BUYER_DID, counter.counter_id)?.answerJson).toBe(
      '',
    );
    // The first body settles into the one revision; the other replays nothing.
    const answer = supplierAnswers(pair, counter) as { json: string };
    expect((JSON.parse(answer.json) as { quote: SignedQuote }).quote.quote_revision).toBe('2');
    expect(replayedCounterAnswer({ params: counter, buyerDid: BUYER_DID })).toBe(answer.json);
    expect(replayedCounterAnswer({ params: other, buyerDid: BUYER_DID })).toBeNull();
  });

  it('R2-6: an offer that meets the target while a send awaits stops the loop before the next counter', async () => {
    const t = await tenderOfTwo({ [SUPPLIER_DID]: '500', [SUPPLIER_B]: '500' }, '42000');
    const headA = t.quotes[SUPPLIER_DID] as SignedQuote;
    const line = headA.lines[0] as SignedQuote['lines'][number];
    // While the counter to A is on its way, A's revision at 400 a unit (40000) lands.
    const revision = makeRevision(headA, {
      lines: [
        {
          ...line,
          unit_price: { currency: 'INR', minor_units: '400' },
          line_subtotal: { currency: 'INR', minor_units: '40000' },
        },
      ],
      total: { currency: 'INR', minor_units: '40000' },
      issued_at: new Date(NOW + 1_000).toISOString(),
    });
    installCommerceServiceQueryDispatch(async (args) => {
      sent.push({ toDid: args.toDid, body: args.body as unknown as Record<string, unknown> });
      if (args.toDid === SUPPLIER_DID) {
        expect(
          applyInboundBuyerResponse({
            supplierDid: SUPPLIER_DID,
            response: {
              capability: REQUEST_QUOTE_CAPABILITY,
              query_id: headA.request_id,
              status: 'success',
              result: { quote: revision },
            },
            nowMs: NOW,
          }),
        ).toBe('applied');
      }
      return { sent: true };
    });
    const mark = sent.length;
    expect(await runNegotiationTick(NOW)).toBe(1);
    expect(sent.slice(mark).map((w) => w.toDid)).toEqual([SUPPLIER_DID]);
    expect(t.buyer.buyerNegotiation.getTender(t.tenderId)?.state).toBe('ready');
  });
});

describe('dual review round 3 — pinned fixes', () => {
  it('R3-3: a deadline that passes while a send awaits stops the loop before the next counter', async () => {
    const t = await tenderOfTwo({ [SUPPLIER_DID]: '500', [SUPPLIER_B]: '500' }, '42000', 10);
    installCommerceServiceQueryDispatch(async (args) => {
      sent.push({ toDid: args.toDid, body: args.body as unknown as Record<string, unknown> });
      clock += 11_000; // the relay takes eleven seconds; the deadline was ten
      return { sent: true };
    });
    installCommerceRuntime(t.buyer);
    const mark = sent.length;
    expect(await runNegotiationTick(NOW)).toBe(1);
    expect(sent.slice(mark).map((w) => w.toDid)).toEqual([SUPPLIER_DID]);
    expect(t.buyer.buyerNegotiation.getTender(t.tenderId)?.state).toBe('ready');
  });

  it('R3-4: a revision whose replay answer cannot be written is not published', async () => {
    const pair = await negotiatingPair();
    const counter = await buyerCounters(pair, '40000');
    installCommerceRuntime(pair.supplier);
    const failing = jest
      .spyOn(pair.supplier.negotiation, 'answerReserved')
      .mockImplementation(() => {
        throw new Error('disk full');
      });
    expect(() => supplierAnswers(pair, counter)).toThrow('disk full');
    failing.mockRestore();
    // The head did not move and nothing replays: the counter is still only reserved.
    installCommerceRuntime(pair.supplier);
    const again = admitInboundCounter({ params: counter, buyerDid: BUYER_DID, nowMs: NOW });
    if (again.kind !== 'dispatch') throw new Error(JSON.stringify(again));
    expect(again.params.current_quote.quote_revision).toBe('1');
    expect(replayedCounterAnswer({ params: counter, buyerDid: BUYER_DID })).toBeNull();
    // Once the write works, the same counter gets its one revision, and it replays.
    const answer = supplierAnswers(pair, counter) as { json: string };
    expect((JSON.parse(answer.json) as { quote: SignedQuote }).quote.quote_revision).toBe('2');
    expect(replayedCounterAnswer({ params: counter, buyerDid: BUYER_DID })).toBe(answer.json);
  });
});

describe('dual review round 4 — pinned fixes', () => {
  const COUNTER_LANE = 'com.dinakernel.commerce.counter_offer';

  it("R4-3: one clock for the whole tick — a slow send in one tender counts against the next tender's deadline", async () => {
    const first = await tenderOfTwo(
      { [SUPPLIER_DID]: '500', [SUPPLIER_B]: '500' },
      '42000',
      600,
      NOW,
    );
    const second = await tenderOfTwo(
      { [SUPPLIER_DID]: '500', [SUPPLIER_B]: '500' },
      '42000',
      10,
      NOW + 1,
    );
    installCommerceServiceQueryDispatch(async (args) => {
      sent.push({ toDid: args.toDid, body: args.body as unknown as Record<string, unknown> });
      clock += 11_000;
      return { sent: true };
    });
    installCommerceRuntime(first.buyer);
    const mark = sent.length;
    await runNegotiationTick(NOW + 2);
    const countered = sent.slice(mark).filter((w) => w.body.capability === COUNTER_LANE);
    const secondQuotes = Object.values(second.quotes).map((q) => q.quote_id);
    expect(
      countered.filter((w) => secondQuotes.includes((w.body.params as CounterOffer).quote_id)),
    ).toHaveLength(0);
    expect(first.buyer.buyerNegotiation.getTender(second.tenderId)?.state).toBe('ready');
  });

  it('R4-3: a resend on a ready tender gets its full window, measured when it leaves', async () => {
    const t = await tenderOfTwo({ [SUPPLIER_DID]: '500', [SUPPLIER_B]: '500' }, '42000', 600);
    installCommerceRuntime(t.buyer);
    expect(await runNegotiationTick(NOW)).toBe(2);
    installCommerceServiceQueryDispatch(async (args) => {
      sent.push({ toDid: args.toDid, body: args.body as unknown as Record<string, unknown> });
      clock += 30_000; // each resend takes thirty seconds to leave
      return { sent: true };
    });
    await runNegotiationTick(NOW + 700_000); // past the deadline and the first windows
    expect(t.buyer.buyerNegotiation.getTender(t.tenderId)?.state).toBe('ready');
    const quoteB = (t.quotes[SUPPLIER_B] as SignedQuote).quote_id;
    const resentB = t.buyer.buyerNegotiation.countersForQuote(SUPPLIER_B, quoteB).at(-1);
    expect(resentB?.attempts).toBe(2);
    // B's resend left after A's took thirty seconds: its window starts then.
    expect(resentB?.sentAt).toBe(NOW + 700_000 + 30_000);
  });

  it("R4-4: a manual counter sent after a loop counter's window does not strand its resend, and the award frees up", async () => {
    const t = await tenderOfTwo({ [SUPPLIER_DID]: '500', [SUPPLIER_B]: '500' }, '42000', 3600);
    installCommerceRuntime(t.buyer);
    expect(await runNegotiationTick(NOW)).toBe(2);
    const quoteA = (t.quotes[SUPPLIER_DID] as SignedQuote).quote_id;
    const [loopCounter] = t.buyer.buyerNegotiation.countersForQuote(SUPPLIER_DID, quoteA);
    if (loopCounter === undefined) throw new Error('no loop counter');
    // The loop counter's window has closed; before any sweep, the owner counters by hand.
    const manual = await sendCounterOffer({
      supplierDid: SUPPLIER_DID,
      quoteId: quoteA,
      serviceRkey: 'self',
      targetTotal: { currency: 'INR', minor_units: '45000' },
      nowMs: NOW + 200_000,
    });
    expect(manual.kind).toBe('sent');
    // The sweep still asks the LOOP counter once more, though the manual one is newest.
    await runNegotiationTick(NOW + 200_001);
    expect(t.buyer.buyerNegotiation.getCounter(loopCounter.counterId)?.attempts).toBe(2);
    // Once every window has closed, nothing holds the award.
    expect(counterInFlight(SUPPLIER_DID, quoteA, NOW + 200_001 + 181_000)).toBe(false);
  });
});

describe("waiting on the supplier's owner spends nothing (NEGOTIATION_PLAN §4.3)", () => {
  const decide = (
    pair: Awaited<ReturnType<typeof negotiatingPair>>,
    decision: 'approved' | 'denied',
  ) => {
    installCommerceRuntime(pair.supplier);
    const [question] = pair.supplier.negotiation.questionsForQuote(pair.quote.quote_id);
    makeNegotiationPriceDecisionHandler({
      runtime: () => pair.supplier,
      workflow: () => pair.workflow,
      nowMs: () => NOW,
    })({ task: pair.workflow.store().getById(question?.taskId ?? '') as never, decision });
  };

  it('re-asks while the owner decides do not count toward the daily cap; the yes arrives; the next real ask does count', async () => {
    const pair = await negotiatingPair({
      ...POLICY,
      maxCountersPerBuyerPerDay: 2,
      items: [{ product: GTIN, floorMinorUnits: '420', autoFloorMinorUnits: '480' }],
    });
    // Round 1 moves to the automatic floor and asks the owner about more.
    const first = await buyerCounters(pair, '30000');
    const a1 = supplierAnswers(pair, first) as { json: string };
    expect(JSON.parse(a1.json)).toMatchObject({ outcome: 'revised', pending_owner: true });
    buyerReceives(pair, first, a1.json);
    // Round 2 is a hold that waits on the owner. Two real asks: the cap is met.
    const second = await buyerCounters(pair, '30000');
    const a2 = supplierAnswers(pair, second) as { json: string };
    expect(JSON.parse(a2.json)).toMatchObject({ outcome: 'held', pending_owner: true });
    buyerReceives(pair, second, a2.json);
    // Re-asks while the owner decides are still admitted: they ask nothing new.
    for (let i = 0; i < 3; i += 1) {
      const again = await buyerCounters(pair, '30000');
      const reply = supplierAnswers(pair, again);
      expect(reply).not.toEqual({ refused: 'counter_limit' });
      const json = (reply as { json: string }).json;
      expect(JSON.parse(json)).toMatchObject({ outcome: 'held', pending_owner: true });
      buyerReceives(pair, again, json);
    }
    // The owner says yes; the ask that carries it is free too, and signs.
    decide(pair, 'approved');
    const carrying = await buyerCounters(pair, '30000');
    const signed = supplierAnswers(pair, carrying) as { json: string };
    expect(JSON.parse(signed.json)).toMatchObject({ outcome: 'revised' });
    buyerReceives(pair, carrying, signed.json);
    // A new real ask after that counts: the cap of two is met, so it is refused.
    const beyond = await buyerCounters(pair, '30000');
    expect(supplierAnswers(pair, beyond)).toEqual({ refused: 'counter_limit' });
  });

  it('once the owner declines, a re-ask is an ordinary ask again', async () => {
    const pair = await negotiatingPair({
      ...POLICY,
      maxCountersPerBuyerPerDay: 2,
      items: [{ product: GTIN, floorMinorUnits: '420', autoFloorMinorUnits: '480' }],
    });
    const first = await buyerCounters(pair, '30000');
    buyerReceives(pair, first, (supplierAnswers(pair, first) as { json: string }).json);
    const second = await buyerCounters(pair, '30000');
    buyerReceives(pair, second, (supplierAnswers(pair, second) as { json: string }).json);
    decide(pair, 'denied');
    const after = await buyerCounters(pair, '30000');
    expect(supplierAnswers(pair, after)).toEqual({ refused: 'counter_limit' });
  });
});
