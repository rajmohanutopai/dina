/**
 * COMMITMENT_KERNEL §6, §15 step 7 — a goods version resting on a shipper's
 * firm option, on the seller's node.
 *
 *   P-01  a held option whose fee saves the seller money becomes a version:
 *         the owner's share of the saving as a discount, offered until the
 *         offer's end (no later than the quote), marked as a partner run;
 *         none below minor 1.4, while a persona is closed, before the time
 *         zone is known, or when the run saves nothing;
 *   P-02  the buyer's order for that version takes the option up in the same
 *         transaction that accepts it; a replayed decision keeps the first act;
 *   P-03  a yes signed after the offer ended, or arriving after the hold:
 *         nothing binds, and the order is refused `option_lapsed`;
 *   P-04  a decision that rolls back takes nothing up;
 *   P-05  nothing is offered before the seller's owner clears the option; an
 *         ordinary alternative that happens to be named `partner_…` is no
 *         run; a second order cannot take a run another order took.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  commerceRecordDigest,
  validateCancellationRequest,
  validateSignedQuote,
  type SignedQuote,
} from '@dina/commerce-protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  SQLiteCommerceOrderRefRepository,
  SQLiteCommerceQuoteLedgerRepository,
  SQLiteCommerceReceiptRepository,
} from '../../src/commerce';
import { deliveryDayOf } from '../../src/commerce/deal_kinds';
import {
  buyerExitCancellation,
  isClearedPartnerRun,
  partnerRunAlternatives,
  retainedQuote,
  sellerOrderHoldsExit,
  takeUpForOrderInTx,
} from '../../src/commerce/partner_run';
import { priceQuoteAlternatives } from '../../src/commerce/quote_issuance';
import { createCommerceRuntime, installCommerceRuntime } from '../../src/commerce/runtime';
import { assemble } from '../../src/commitment/model_store';
import {
  getOrderFallbackStore,
  handleOptionMessage,
  installOptionStores,
} from '../../src/commitment/option_handler';
import {
  admitOptionAnswer,
  answerOptionRequest,
  askShippers,
  SellerOptionStore,
  ShipperOptionStore,
  type OptionBody,
} from '../../src/commitment/options';
import { makeReentrantTxRunner } from '../../src/run/tx';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import {
  BUYER_DID,
  SUPPLIER_DID,
  hash,
  makeAdmission,
  makeFamilies,
  makeOrder,
  makeOrders,
  makeQuoteRequest,
  makeSignedQuote,
} from './helpers';

const SHIPPER = 'did:plc:shipper';
const T_ADMIT = Date.parse('2026-08-07T12:30:00.000Z');
const RUN_AT = '2026-08-18T09:00:00Z';
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** What delivering costs on every day: the seller ₹120 itself, the shipper's run ₹50. */
const costs = (kind: string, rupees: bigint) =>
  DAYS.map((day) => ({
    id: day,
    kind,
    covers: ['delivery_day'],
    body: { type: 'choice' as const, part: 'delivery_day', option: day, rupees },
  }));
const form = { limits: {}, totals: {}, asking: {}, binding: 'card' as const };
const sellerModel = assemble('goods.seller', 1, form, costs('goods.seller', -120n));
const shipperModel = assemble('delivery.shipper', 1, form, [
  ...costs('delivery.shipper', -50n),
  {
    id: 'room',
    kind: 'delivery.shipper',
    covers: ['run'],
    body: { type: 'capacity', part: 'run', dimension: 'crates', amount: 10n },
  },
]);

let dir: string;
let adapter: NodeSQLiteAdapter;
let seller: SellerOptionStore;
let clock: { now: number };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-partner-run-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  seller = new SellerOptionStore(adapter);
  clock = { now: T_ADMIT };
});
afterEach(() => {
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const request = makeQuoteRequest({ protocol_version: '1.4' });
const base = makeSignedQuote(request);

/** The seller asks its shipper for a run for quote q-1, holds the option, and (by default) its owner clears it. */
function holdOption(clear = true): OptionBody {
  const asked = askShippers({
    store: seller,
    dealRef: base.quote_id,
    shippers: [SHIPPER],
    grant: { fields: ['postal_code'], recipientRole: 'shipper' },
    postalCode: '560001',
    serviceAt: RUN_AT,
    crates: 1,
    nowMs: T_ADMIT - 60_000,
  });
  if (!asked.ok) throw new Error(asked.reason);
  const option = answerOptionRequest({
    store: new ShipperOptionStore(adapter),
    view: { model: shipperModel, closedPersonas: [], asking: { fee: '5000' } },
    sellerDid: SUPPLIER_DID,
    request: asked.send[0]?.body as never,
    timeZone: 'UTC',
    nowMs: T_ADMIT - 60_000,
    deliveryDayOf,
  });
  expect(option.kind).toBe('option');
  expect(admitOptionAnswer({ store: seller, fromDid: SHIPPER, body: option, nowMs: T_ADMIT })).toBe(
    'held',
  );
  if (clear) seller.clear(seller.forDeal(base.quote_id)[0]?.requestId ?? '', T_ADMIT);
  return option as OptionBody;
}

const offered = (over: Partial<Parameters<typeof partnerRunAlternatives>[0]> = {}) =>
  partnerRunAlternatives({
    store: seller,
    dealRef: base.quote_id,
    seller: { model: sellerModel, closedPersonas: [] },
    protocolVersion: '1.4',
    charges: base.charges,
    currency: 'INR',
    totalMinor: BigInt(base.total.minor_units),
    validUntilMs: Date.parse(base.valid_until),
    nowMs: T_ADMIT,
    timeZone: 'UTC',
    ...over,
  });

/** The quote q-1 with its partner-run version, as the seller signs it. */
function quoteWithPartnerRun(): SignedQuote {
  const { quote_digest: _q, terms_digest: _t, ...draft } = base;
  const priced = priceQuoteAlternatives(draft, offered());
  const quote = makeSignedQuote(request, { alternatives: priced ?? [] });
  expect(validateSignedQuote(quote, hash)).toBeNull();
  return quote;
}

describe("a goods version resting on a shipper's option", () => {
  it('P-01: the version, and when there is none', () => {
    holdOption();
    const [version] = offered();
    // ₹120 own delivery against a ₹50 run: ₹70 saved, half (₹35) passed on.
    expect(version).toMatchObject({
      partner_run: true,
      estimated_delivery_at: RUN_AT,
      // The quote's validity ends before the offer's own end.
      offer_ends_at: new Date(Date.parse(base.valid_until)).toISOString(),
      charges: [
        {
          kind: 'discount',
          label: 'Delivery by a partner run',
          amount: { currency: 'INR', minor_units: '3500' },
          operation: 'subtract',
        },
      ],
    });
    expect(version?.alternative_id).toMatch(/^partner_[0-9a-f]{8}$/);
    expect(JSON.stringify(version)).not.toMatch(/5000|12000|7000/); // neither cost nor fee leaves
    expect(offered({ protocolVersion: '1.3' })).toEqual([]);
    expect(offered({ seller: { model: sellerModel, closedPersonas: ['work'] } })).toEqual([]);
    expect(offered({ timeZone: null })).toEqual([]);
    const dearRun = assemble('goods.seller', 1, form, costs('goods.seller', -40n));
    expect(offered({ seller: { model: dearRun, closedPersonas: [] } })).toEqual([]);
  });

  function admission(failGenesis = false) {
    const tx = makeReentrantTxRunner(adapter);
    return makeAdmission({
      tx,
      orders: makeOrders(new SQLiteCommerceOrderRefRepository(adapter), clock),
      families: makeFamilies(new SQLiteCommerceQuoteLedgerRepository(adapter), clock),
      receipts: new SQLiteCommerceReceiptRepository(adapter),
      supplierDid: () => SUPPLIER_DID,
      now: () => clock.now,
      decisionTimeoutMs: 60_000,
      takeUpOptionInTx: (order, nowMs) =>
        takeUpForOrderInTx({
          store: seller,
          quote: retainedQuote(new SQLiteCommerceReceiptRepository(adapter), order.quote_digest),
          order,
          nowMs,
        }),
      ...(failGenesis ? { createAcceptedGenesisInTx: () => ({ error: 'genesis failed' }) } : {}),
    });
  }

  function orderPartnerRun(
    engine: ReturnType<typeof admission>,
    quote: SignedQuote,
    submittedAt = '2026-08-07T12:00:00.000Z',
  ) {
    new SQLiteCommerceReceiptRepository(adapter).put({
      recordDigest: request.request_digest,
      domain: 'request',
      buyerDid: request.buyer_did,
      quoteId: quote.quote_id,
      purchaseOrderId: '',
      recordJson: JSON.stringify(request),
      evidenceJson: '{}',
      createdAt: clock.now,
    });
    expect(engine.registerSignedQuote(quote)).toBeNull();
    const version = quote.alternatives?.[0];
    const order = makeOrder(quote, request.delivery.projection, {
      protocol_version: '1.4',
      alternative_id: version?.alternative_id,
      approved_total: version?.total,
      accepted_terms_digest: version?.terms_digest,
      submitted_at: submittedAt,
    });
    expect(engine.admitOrder(order, BUYER_DID)).toEqual({ kind: 'reserved' });
    return order;
  }

  const accept = (engine: ReturnType<typeof admission>, poId: string) =>
    engine.decideOrder(BUYER_DID, poId, { kind: 'accepted', supplierOrderId: 'so-1' });

  it('P-02: the order and the option bind in one act', () => {
    const option = holdOption();
    const engine = admission();
    const order = orderPartnerRun(engine, quoteWithPartnerRun());
    const decided = accept(engine, order.purchase_order_id);
    expect('acknowledgement' in decided && decided.acknowledgement.kind).toBe('accepted');
    const link = seller.byOption(SHIPPER, option.option_id);
    expect(link?.state).toBe('accepted');
    expect(link?.acceptedAt).toBe(T_ADMIT);
    // A replayed decision returns the first answer and takes nothing up again.
    clock.now += 1000;
    accept(engine, order.purchase_order_id);
    expect(seller.byOption(SHIPPER, option.option_id)?.acceptedAt).toBe(T_ADMIT);
  });

  it('P-03: a yes after the offer, or after the hold: refused option_lapsed, nothing bound', () => {
    const option = holdOption();
    const quote = quoteWithPartnerRun();
    // The seller's clock is past the hold when the order arrives.
    const engine = admission();
    const order = orderPartnerRun(engine, quote);
    clock.now = Date.parse(option.hold_until);
    const decided = accept(engine, order.purchase_order_id);
    expect('acknowledgement' in decided && decided.acknowledgement).toMatchObject({
      kind: 'rejected',
      reason_code: 'option_lapsed',
    });
    expect(seller.byOption(SHIPPER, option.option_id)?.state).toBe('held');
    // Signed after the offer ended: lapsed whatever the seller's clock says.
    expect(
      takeUpForOrderInTx({
        store: seller,
        quote,
        order: {
          buyer_did: BUYER_DID,
          purchase_order_id: 'po-late',
          quote_id: quote.quote_id,
          alternative_id: quote.alternatives?.[0]?.alternative_id,
          submitted_at: new Date(Date.parse(option.hold_until) - 24 * 3600_000).toISOString(),
        },
        nowMs: T_ADMIT,
      }),
    ).toBe('lapsed');
  });

  it('P-04: a decision that rolls back takes nothing up', () => {
    const option = holdOption();
    const engine = admission(true);
    const order = orderPartnerRun(engine, quoteWithPartnerRun());
    // The status chain fails to open: the whole decision rolls back.
    expect(() => accept(engine, order.purchase_order_id)).toThrow(/status chain/);
    expect(seller.byOption(SHIPPER, option.option_id)?.state).toBe('held');
  });

  it("P-05: clearance, the quote's own mark, one order per run", () => {
    holdOption(false);
    expect(offered()).toEqual([]); // not cleared: not offered
    seller.clear(seller.forDeal(base.quote_id)[0]?.requestId ?? '', T_ADMIT);
    const quote = quoteWithPartnerRun();
    const alternativeId = quote.alternatives?.[0]?.alternative_id;
    expect(
      isClearedPartnerRun({ store: seller, quote, quoteId: quote.quote_id, alternativeId }),
    ).toBe(true);
    // A version named like a run but not marked as one is an ordinary version.
    const {
      partner_run: _p,
      offer_ends_at: _o,
      ...plain
    } = quote.alternatives?.[0] as never as Record<string, unknown>;
    const ordinary = { ...quote, alternatives: [plain] } as unknown as SignedQuote;
    const order = (po: string) => ({
      buyer_did: BUYER_DID,
      purchase_order_id: po,
      quote_id: quote.quote_id,
      alternative_id: alternativeId,
      submitted_at: '2026-08-07T12:00:00.000Z',
    });
    expect(
      takeUpForOrderInTx({ store: seller, quote: ordinary, order: order('po-1'), nowMs: T_ADMIT }),
    ).toBe('none');
    expect(takeUpForOrderInTx({ store: seller, quote, order: order('po-1'), nowMs: T_ADMIT })).toBe(
      'taken',
    );
    expect(
      takeUpForOrderInTx({ store: seller, quote, order: order('po-1'), nowMs: T_ADMIT + 1 }),
    ).toBe('taken');
    expect(takeUpForOrderInTx({ store: seller, quote, order: order('po-2'), nowMs: T_ADMIT })).toBe(
      'lapsed',
    );
  });
});

describe('§15 step 12 — the exit right on both sides', () => {
  const request = makeQuoteRequest({ protocol_version: '1.5' });
  const base = makeSignedQuote(request, { protocol_version: '1.5', valid_until: '2026-08-20T00:00:00.000Z' });
  const priced = priceQuoteAlternatives(base, [
    {
      alternative_id: 'partner_0a1b2c3d',
      charges: [],
      estimated_delivery_at: '2026-08-18T09:00:00Z',
      partner_run: true,
      offer_ends_at: '2026-08-10T09:00:00Z',
      exit_if_run_fails: true,
    },
    { alternative_id: 'partner_0a1b2c3e', charges: [], estimated_delivery_at: '2026-08-19T09:00:00Z', partner_run: true, offer_ends_at: '2026-08-10T09:00:00Z' },
  ]);
  const quote = makeSignedQuote(request, {
    protocol_version: '1.5',
    valid_until: base.valid_until,
    alternatives: priced ?? [],
  });
  const orderFor = (alternative: string) => {
    const alt = quote.alternatives?.find((a) => a.alternative_id === alternative);
    return makeOrder(quote, request.delivery.projection, {
      protocol_version: '1.5',
      alternative_id: alternative,
      approved_total: alt?.total,
      accepted_terms_digest: alt?.terms_digest,
    });
  };
  const receiptsOf = (order: ReturnType<typeof orderFor>) => {
    const rows = new Map<string, { recordJson: string }>([
      [quote.quote_digest, { recordJson: JSON.stringify(quote) }],
      [order.order_digest, { recordJson: JSON.stringify(order) }],
    ]);
    return { get: (d: string) => rows.get(d) ?? null };
  };

  it('P-06: the version’s right is signed into its terms; an order on it holds the right, one on another does not', () => {
    expect(validateSignedQuote(quote, hash)).toBeNull();
    const withRight = orderFor('partner_0a1b2c3d');
    const without = orderFor('partner_0a1b2c3e');
    for (const [order, holds] of [
      [withRight, true],
      [without, false],
    ] as const) {
      expect(
        sellerOrderHoldsExit(
          {
            orders: { load: () => ({ ref: { orderDigest: order.order_digest, quoteDigest: quote.quote_digest } }) },
            receipts: receiptsOf(order),
          },
          BUYER_DID,
          'po-1',
        ),
      ).toBe(holds);
    }
  });

  it('P-07: the buyer’s cancellation for its order is a valid request, the same each time', () => {
    const order = orderFor('partner_0a1b2c3d');
    const stores = {
      buyerOrders: { get: () => ({ orderDigest: order.order_digest }) },
      receipts: receiptsOf(order),
    };
    const one = buyerExitCancellation(stores, SUPPLIER_DID, 'po-1', Date.parse('2026-08-19T10:00:00Z'));
    expect(one).not.toBeNull();
    expect(validateCancellationRequest(one, hash)).toBeNull();
    expect(one).toMatchObject({ purchase_order_id: 'po-1', order_digest: order.order_digest, reason_code: 'partner_run_failed' });
    const again = buyerExitCancellation(stores, SUPPLIER_DID, 'po-1', Date.parse('2026-08-19T11:00:00Z'));
    expect(again?.cancellation_id).toBe(one?.cancellation_id);
    expect(buyerExitCancellation({ ...stores, buyerOrders: { get: () => null } }, SUPPLIER_DID, 'po-1', 0)).toBeNull();
  });
});

describe('§15 step 12 — the seller cancels an exit through its own records (a real runtime)', () => {
  /** A seller node that sold po-1 on a partner-run version, with or without the right, and recorded its fallback. */
  function sellerWithOrder(exitRight: boolean) {
    installOptionStores(adapter);
    const runtime = createCommerceRuntime({
      adapter,
      supplierDid: () => SUPPLIER_DID,
      currentEpoch: () => '1',
      now: () => clock.now,
    });
    installCommerceRuntime(runtime);
    holdOption();
    const asked = makeQuoteRequest({
      protocol_version: '1.5',
      onward_sharing: { fields: ['postal_code'], recipient_role: 'shipper' },
      ...(exitRight ? { exit_if_run_fails: true as const } : {}),
    });
    const head = makeSignedQuote(asked, { protocol_version: '1.5' });
    const { quote_digest: _q, terms_digest: _t, ...draft } = head;
    const priced = priceQuoteAlternatives(draft, offered({ protocolVersion: '1.5', exitRight }));
    const quote = makeSignedQuote(asked, { protocol_version: '1.5', alternatives: priced ?? [] });
    runtime.receipts.put({
      recordDigest: asked.request_digest,
      domain: 'request',
      buyerDid: asked.buyer_did,
      quoteId: quote.quote_id,
      purchaseOrderId: '',
      recordJson: JSON.stringify(asked),
      evidenceJson: '{}',
      createdAt: clock.now,
    });
    expect(runtime.admission.registerSignedQuote(quote)).toBeNull();
    const version = quote.alternatives?.[0];
    expect(version?.exit_if_run_fails).toBe(exitRight ? true : undefined);
    const order = makeOrder(quote, asked.delivery.projection, {
      protocol_version: '1.5',
      alternative_id: version?.alternative_id,
      approved_total: version?.total,
      accepted_terms_digest: version?.terms_digest,
    });
    expect(runtime.admission.admitOrder(order, BUYER_DID)).toEqual({ kind: 'reserved' });
    expect(
      'acknowledgement' in runtime.admission.decideOrder(BUYER_DID, order.purchase_order_id, {
        kind: 'accepted',
        supplierOrderId: 'so-1',
      }),
    ).toBe(true);
    // The run fell through without fault: the seller recorded the fallback.
    getOrderFallbackStore()?.record({
      buyerDid: BUYER_DID,
      purchaseOrderId: order.purchase_order_id,
      supplierDid: 'self',
      quoteId: quote.quote_id,
      alternativeId: version?.alternative_id ?? '',
      role: 'seller',
      appliedAt: clock.now,
    });
    const draftCx = {
      protocol_version: '1.5',
      cancellation_id: 'exit-1',
      purchase_order_id: order.purchase_order_id,
      order_digest: order.order_digest,
      reason_code: 'partner_run_failed',
      idempotency_key: 'exit-1',
      issued_at: new Date(clock.now).toISOString(),
    };
    const cancellation = { ...draftCx, cancellation_digest: commerceRecordDigest('cancellation', draftCx, hash) };
    return { runtime, order, cancellation };
  }
  afterEach(() => {
    installCommerceRuntime(null);
    installOptionStores(null);
  });

  it('P-08: an order that holds the right is cancelled, with no runner asked; a resend gets the same', async () => {
    const { runtime, order, cancellation } = sellerWithOrder(true);
    const exit = { v: 1, kind: 'exit', cancellation };
    expect(await handleOptionMessage(BUYER_DID, exit, clock.now)).toBe('kept');
    expect(runtime.chains.load(BUYER_DID, order.purchase_order_id).head.state).toBe('cancelled');
    expect(await handleOptionMessage(BUYER_DID, exit, clock.now + 1_000)).toBe('kept');
    expect(runtime.chains.load(BUYER_DID, order.purchase_order_id).head.state).toBe('cancelled');
  });

  it('P-09: dispatch already won the race: the order stands', async () => {
    const { runtime, order, cancellation } = sellerWithOrder(true);
    expect(
      'error' in
        runtime.lifecycle.signStatusUpdate(BUYER_DID, order.purchase_order_id, {
          state: 'dispatched',
          lines: [{ lineId: 'l1', fulfilledQuantity: { value: '100', unitCode: 'each' } }],
        }),
    ).toBe(false);
    expect(await handleOptionMessage(BUYER_DID, { v: 1, kind: 'exit', cancellation }, clock.now)).toBe('kept');
    expect(runtime.chains.load(BUYER_DID, order.purchase_order_id).head.state).toBe('dispatched');
  });

  it('P-10: an order on a version without the right is not cancelled this way', async () => {
    const { runtime, order, cancellation } = sellerWithOrder(false);
    expect(await handleOptionMessage(BUYER_DID, { v: 1, kind: 'exit', cancellation }, clock.now)).toBe(
      'refused',
    );
    expect(runtime.chains.load(BUYER_DID, order.purchase_order_id).head.state).toBe('accepted');
  });
});
