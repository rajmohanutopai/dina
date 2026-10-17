/**
 * COMMITMENT_KERNEL §10 "Where the agent decides alone", §15 step 10 — the
 * goods runner's binding terms pass the floors a counter passes, measured
 * from what the owner approved, and every version it states passes the
 * seller's never-rules.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  computeLineSubtotal,
  validateSignedQuote,
  type SignedQuote,
} from '@dina/commerce-protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { negotiationPolicyFindings } from '../../src/commerce/negotiation_policy';
import {
  settleInboundOrderDecision,
  transformInboundOrderResult,
} from '../../src/commerce/order_decision';
import {
  approvedLineFloors,
  atOrAboveFloor,
  checkRunnerTerms,
  sellerRulesRefuse,
  type ApprovedPrices,
  type BoundsLine,
} from '../../src/commerce/runner_bounds';
import {
  createCommerceRuntime,
  installCommerceRuntime,
  type CommerceRuntime,
} from '../../src/commerce/runtime';
import { InMemoryCommerceSettingsRepository } from '../../src/commerce/settings_store';
import { ValueModelStore } from '../../src/commitment/model_store';
import { setOwnerTimeZone } from '../../src/settings/owner_settings';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import {
  BUYER_DID,
  REQUEST_GTIN,
  SUPPLIER_DID,
  catalogItem,
  hash,
  makeQuoteRequest,
  makeSignedQuote,
  withPublishedCatalogue,
} from './helpers';

import type { SupplierSettings } from '../../src/commerce/commerce_settings';
import type { SupplierNegotiationPolicy } from '../../src/commerce/negotiation_policy';

const NOW = Date.parse('2026-08-10T09:00:00.000Z');

const POLICY: SupplierNegotiationPolicy = {
  enabled: true,
  maxRounds: 3,
  windowSeconds: 3_600,
  maxCountersPerBuyerPerDay: 20,
  defaultMaxDiscountBps: 1_000,
};

function settings(negotiation?: SupplierNegotiationPolicy): SupplierSettings {
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
    tradingCurrency: 'INR',
    ...(negotiation === undefined ? {} : { negotiation }),
  };
}

describe('approvedLineFloors: what the owner approved', () => {
  const at = (minor: string, over = {}) => [
    catalogItem({ indicative_price: { currency: 'INR', minor_units: minor }, ...over }),
  ];
  const ownFloors = (hard: string, auto: string, unitCode?: string) => ({
    ...POLICY,
    items: [
      {
        product: REQUEST_GTIN,
        floorMinorUnits: hard,
        autoFloorMinorUnits: auto,
        ...(unitCode === undefined ? {} : { unitCode }),
      },
    ],
  });
  const floors = (
    approved: Partial<ApprovedPrices> = {},
    line: Partial<Parameters<typeof approvedLineFloors>[1]> = {},
  ) =>
    approvedLineFloors(
      { items: at('500'), policy: undefined, tradingCurrency: undefined, ...approved },
      { product: REQUEST_GTIN, unitCode: 'each', currency: 'INR', ...line },
    );

  it('with no policy the catalogue price is both floors: no discount', () => {
    expect(floors()).toEqual({ hardFloor: 500n, autoFloor: 500n });
  });

  it('with a policy, the discount is taken off the catalogue price', () => {
    expect(floors({ policy: POLICY })).toEqual({ hardFloor: 450n, autoFloor: 450n });
  });

  it("the item's own floors stand as set, even above a lower published price", () => {
    expect(floors({ policy: ownFloors('600', '650') })).toEqual({
      hardFloor: 600n,
      autoFloor: 650n,
    });
  });

  it("without a published price the item's own floors hold only in the trading currency and their own unit", () => {
    const policy = ownFloors('400', '420', 'each');
    expect(floors({ items: [], policy, tradingCurrency: 'INR' })).toEqual({
      hardFloor: 400n,
      autoFloor: 420n,
    });
    expect(floors({ items: [], policy })).toBeNull();
    expect(floors({ items: [], policy, tradingCurrency: 'INR' }, { currency: 'USD' })).toBeNull();
    // A floor per each says nothing about a price per kilogram.
    expect(floors({ items: [], policy, tradingCurrency: 'INR' }, { unitCode: 'kg' })).toBeNull();
    // A floor naming no unit, with no published price to name one, approves nothing.
    expect(
      floors({ items: [], policy: ownFloors('400', '420'), tradingCurrency: 'INR' }),
    ).toBeNull();
  });

  it('a floor that names its unit never holds for another, published price or not', () => {
    expect(floors({ policy: ownFloors('400', '420', 'kg') })).toBeNull();
    expect(floors({ policy: ownFloors('400', '420', 'each') })).toEqual({
      hardFloor: 400n,
      autoFloor: 420n,
    });
  });

  it('settings that do not validate approve nothing, never "no policy"', () => {
    expect(floors({ unreadable: true })).toBeNull();
  });

  it('a policy naming an unknown unit is refused when it is written', () => {
    expect(
      negotiationPolicyFindings({
        ...POLICY,
        items: [{ product: REQUEST_GTIN, floorMinorUnits: '400', unitCode: 'kgs' }],
      }).map((f) => f.field),
    ).toEqual(['negotiation.items[0].unitCode']);
    expect(
      negotiationPolicyFindings({
        ...POLICY,
        items: [{ product: REQUEST_GTIN, floorMinorUnits: '400', unitCode: 'kg' }],
      }),
    ).toEqual([]);
  });

  it('no catalogue price and no floor of its own: nothing the owner approved', () => {
    expect(floors({ items: [] })).toBeNull();
    expect(floors({ items: [], policy: POLICY, tradingCurrency: 'INR' })).toBeNull();
  });

  it("a price published in another currency or unit approves nothing, and the item's own floors do not stand in", () => {
    expect(floors({}, { currency: 'USD' })).toBeNull();
    expect(floors({}, { unitCode: 'case' })).toBeNull();
    expect(
      floors({ policy: ownFloors('400', '420'), tradingCurrency: 'USD' }, { currency: 'USD' }),
    ).toBeNull();
    expect(
      floors({ items: at('500', { pack: { sell_unit: { value: '6', unit_code: 'each' } } }) }),
    ).toBeNull();
  });

  it('never above a price the buyer already holds', () => {
    expect(floors({}, { capMinor: 480n })).toEqual({ hardFloor: 480n, autoFloor: 480n });
  });
});

describe('checkRunnerTerms', () => {
  const line = (over: Partial<BoundsLine> = {}): BoundsLine => ({
    line_id: 'l1',
    product: REQUEST_GTIN,
    unit_price: { currency: 'INR', minor_units: '500' },
    quantity: { value: '100', unit_code: 'each' },
    price_basis: { value: '1', unit_code: 'each' },
    ...over,
  });
  const approved: ApprovedPrices = {
    items: [catalogItem()],
    policy: undefined,
    tradingCurrency: undefined,
  };
  const total = (minor: string) => ({ total: { currency: 'INR', minor_units: minor } });
  const check = (args: Partial<Parameters<typeof checkRunnerTerms>[0]>) =>
    checkRunnerTerms({
      approved,
      lines: [line()],
      versions: [total('50000')],
      seller: null,
      timeZone: 'UTC',
      ...args,
    });
  const refusal = (r: ReturnType<typeof checkRunnerTerms>) => (r.ok ? null : r.refusal);

  it('a price on any basis but one of its own unit is not compared, so not signed', () => {
    // 500 per 100 each is 5 paise each: far under the 500 floor.
    const per100 = line({ price_basis: { value: '100', unit_code: 'each' } });
    expect(refusal(check({ lines: [per100], versions: [total('500')] }))).toBe(
      'price_not_approved',
    );
  });

  it('a price held on the countered quote lowers the floor only for the same product, currency and unit', () => {
    const cheap = { scheme: 'gtin' as const, value: '00000000000017' };
    const held = [line({ product: cheap, unit_price: { currency: 'INR', minor_units: '100' } })];
    // The same line id, now the 500 item at 100: the cheap item's price does not carry over.
    const swapped = line({ unit_price: { currency: 'INR', minor_units: '100' } });
    expect(refusal(check({ lines: [swapped], versions: [total('10000')], held }))).toBe(
      'below_floor',
    );
    const same = [line({ unit_price: { currency: 'INR', minor_units: '450' } })];
    const at450 = line({ unit_price: { currency: 'INR', minor_units: '450' } });
    expect(check({ lines: [at450], versions: [total('45000')], held: same })).toEqual({
      ok: true,
      floorGoodsMinor: 45000n,
    });
  });

  it('returns the goods at their floors, for versions Core makes itself', () => {
    expect(check({ versions: [total('60000')] })).toEqual({ ok: true, floorGoodsMinor: 50000n });
    expect(atOrAboveFloor([total('49999'), total('50000')], 50000n)).toEqual([total('50000')]);
  });

  describe('a never-rule is judged on each version, an unreadable day ruled out', () => {
    const neverTuesday = {
      model: {
        never: [{ id: 'n', label: 'not Tuesdays', all: [{ part: 'delivery_day', choice: 'tue' }] }],
      },
      closedPersonas: [],
    } as unknown as Parameters<typeof checkRunnerTerms>[0]['seller'];
    const onDay = (estimatedDeliveryAt: string | undefined, timeZone: string | null) =>
      refusal(
        check({
          versions: [
            {
              ...(estimatedDeliveryAt === undefined ? {} : { estimatedDeliveryAt }),
              ...total('50000'),
            },
          ],
          seller: neverTuesday,
          timeZone,
        }),
      );

    it('a Tuesday is ruled out, a Friday is not', () => {
      expect(onDay('2030-08-13T10:00:00Z', 'UTC')).toBe('ruled_out');
      expect(onDay('2030-08-16T10:00:00Z', 'UTC')).toBeNull();
    });

    it('no delivery date, or no time zone, matches a rule on the day', () => {
      expect(onDay(undefined, 'UTC')).toBe('ruled_out');
      expect(onDay('2030-08-16T10:00:00Z', null)).toBe('ruled_out');
    });

    it('rules that cannot be read refuse, as a closed persona does', () => {
      expect(
        refusal(check({ seller: { model: null, closedPersonas: [], unreadable: true } })),
      ).toBe('persona_closed');
      expect(refusal(check({ seller: { model: null, closedPersonas: ['health'] } }))).toBe(
        'persona_closed',
      );
      expect(sellerRulesRefuse(null, [total('50000')], 'UTC')).toBeNull();
    });

    it('a rule on the share passed on does not hold for a runner version', () => {
      const shareRule = {
        model: {
          never: [{ id: 'n', label: 'never most', all: [{ part: 'saving_share', present: true }] }],
        },
        closedPersonas: [],
      } as unknown as Parameters<typeof checkRunnerTerms>[0]['seller'];
      expect(refusal(check({ seller: shareRule }))).toBeNull();
    });
  });
});

describe('a first quote on the production seam (§15 step 10)', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  let runtime: CommerceRuntime;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-runner-bounds-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    runtime = withPublishedCatalogue(
      createCommerceRuntime({
        adapter,
        supplierDid: () => SUPPLIER_DID,
        currentEpoch: () => '1',
        now: () => NOW,
      }),
    );
    installCommerceRuntime(runtime);
    await setOwnerTimeZone('UTC');
  });

  afterEach(() => {
    installCommerceRuntime(null);
    adapter.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let asked = 0;
  /** The runner answers a fresh request: 100 each at `unit` paise, with any other terms. */
  function quote(unit: string, extra: Record<string, unknown> = {}, protocol = '1.0') {
    asked += 1;
    return transformInboundOrderResult({
      capability: 'request_quote',
      fromDid: BUYER_DID,
      params: makeQuoteRequest({
        protocol_version: protocol,
        request_id: `req-${String(asked)}`,
        idempotency_key: `idem-${String(asked)}`,
      }),
      resultJSON: JSON.stringify({
        can_supply: true,
        lines: [
          {
            line_id: 'l1',
            unit_price: { currency: 'INR', minor_units: unit },
            quantity: { value: '100', unit_code: 'each' },
          },
        ],
        ...extra,
      }),
      nowMs: NOW,
    });
  }
  const signed = (decision: ReturnType<typeof quote>): SignedQuote => {
    if (decision.kind !== 'replace') throw new Error(JSON.stringify(decision));
    const parsed = JSON.parse(decision.json) as SignedQuote;
    expect(validateSignedQuote(parsed, hash)).toBeNull();
    return parsed;
  };
  const charge = (minor: string, operation: 'add' | 'subtract', kind = 'delivery') => ({
    kind,
    label: kind,
    amount: { currency: 'INR', minor_units: minor },
    operation,
  });

  it('at or above the catalogue price it is signed; below it, with no policy, nothing goes out', () => {
    expect(signed(quote('500')).total.minor_units).toBe('50000');
    expect(signed(quote('600')).total.minor_units).toBe('60000');
    expect(quote('499')).toEqual({ kind: 'withhold', reason: 'below_floor' });
  });

  it('with a policy the runner may discount down to the automatic floor, no further', () => {
    expect(runtime.settings.writeSupplier(settings(POLICY)).ok).toBe(true);
    expect(quote('449')).toEqual({ kind: 'withhold', reason: 'below_floor' });
    expect(signed(quote('450')).total.minor_units).toBe('45000');
  });

  it('an item the owner never priced is not quoted', () => {
    withPublishedCatalogue(runtime, []);
    expect(quote('500')).toEqual({ kind: 'withhold', reason: 'price_not_approved' });
    // Its own floors in the policy are a price the owner approved.
    expect(
      runtime.settings.writeSupplier(
        settings({
          ...POLICY,
          items: [
            {
              product: REQUEST_GTIN,
              floorMinorUnits: '300',
              autoFloorMinorUnits: '350',
              unitCode: 'each',
            },
          ],
        }),
      ).ok,
    ).toBe(true);
    expect(signed(quote('350')).total.minor_units).toBe('35000');
  });

  it('rules the runtime cannot read withhold the quote', () => {
    // A stored entry that does not decode: the real runtime read fails.
    adapter.execute(
      `INSERT INTO commitment_value_entries (kind, entry_id, entry_json, created_at) VALUES (?, ?, ?, ?)`,
      ['goods.seller', 'broken', '{not json', NOW],
    );
    expect(runtime.goodsSellerModel?.()).toMatchObject({ unreadable: true });
    expect(quote('500')).toEqual({ kind: 'withhold', reason: 'persona_closed' });
  });

  it('stored settings that do not validate withhold the quote', () => {
    runtime.settings.readSupplier = () => ({ ok: false, absent: false, findings: [] });
    expect(quote('600')).toEqual({ kind: 'withhold', reason: 'price_not_approved' });
  });

  it("the item's own floors stand above a lower published price", () => {
    expect(
      runtime.settings.writeSupplier(
        settings({
          ...POLICY,
          items: [{ product: REQUEST_GTIN, floorMinorUnits: '600', autoFloorMinorUnits: '650' }],
        }),
      ).ok,
    ).toBe(true);
    expect(quote('500')).toEqual({ kind: 'withhold', reason: 'below_floor' });
    expect(signed(quote('650')).total.minor_units).toBe('65000');
  });

  it('a cheaper day Core makes is dropped when its discount would take the goods under their floors', () => {
    const model = new ValueModelStore(adapter);
    for (const [day, rupees] of [
      ['fri', -120n],
      ['tue', -40n],
    ] as const)
      model.putEntry(
        {
          id: day,
          kind: 'goods.seller',
          covers: ['delivery_day'],
          body: { type: 'choice', part: 'delivery_day', option: day, rupees },
        },
        NOW,
      );
    const friday = '2030-08-16T10:00:00Z';
    // At the catalogue price with no delivery charge: ₹40 off would be under the floor.
    const bare = signed(quote('500', { estimated_delivery_at: friday }, '1.3'));
    expect(bare.alternatives).toBeUndefined();
    // With a ₹150 delivery charge the saving comes out of delivery: offered.
    const withDelivery = signed(
      quote('500', { estimated_delivery_at: friday, charges: [charge('15000', 'add')] }, '1.3'),
    );
    expect(withDelivery.alternatives?.map((a) => a.alternative_id)).toEqual(['tue']);
  });

  it('a discount written as a charge is a price too; delivery may pay for one', () => {
    expect(quote('500', { charges: [charge('100', 'subtract', 'discount')] })).toEqual({
      kind: 'withhold',
      reason: 'below_floor',
    });
    const freeDelivery = signed(
      quote('500', { charges: [charge('4000', 'add'), charge('4000', 'subtract', 'discount')] }),
    );
    expect(freeDelivery.total.minor_units).toBe('50000');
  });

  it("a runner's version on a day the seller's never-rule refuses withholds the quote", () => {
    new ValueModelStore(adapter).putEntry(
      {
        id: 'n1',
        kind: 'goods.seller',
        covers: ['delivery_day'],
        body: {
          type: 'never',
          label: 'no Tuesday runs',
          all: [{ part: 'delivery_day', choice: 'tue' }],
        },
      },
      NOW,
    );
    const friday = '2030-08-16T10:00:00Z';
    const tuesday = '2030-08-13T10:00:00Z';
    expect(
      quote(
        '500',
        {
          estimated_delivery_at: friday,
          alternatives: [{ alternative_id: 'tue', charges: [], estimated_delivery_at: tuesday }],
        },
        '1.3',
      ),
    ).toEqual({ kind: 'withhold', reason: 'ruled_out' });
  });

  it("the quote's own day is judged too", () => {
    new ValueModelStore(adapter).putEntry(
      {
        id: 'n1',
        kind: 'goods.seller',
        covers: ['delivery_day'],
        body: {
          type: 'never',
          label: 'no Tuesday runs',
          all: [{ part: 'delivery_day', choice: 'tue' }],
        },
      },
      NOW,
    );
    expect(quote('500', { estimated_delivery_at: '2030-08-13T10:00:00Z' })).toEqual({
      kind: 'withhold',
      reason: 'ruled_out',
    });
  });
});

describe("the runner's replacement quote with an order decision (§15 step 10)", () => {
  const request = makeQuoteRequest();
  /** A quote of 100 each at `unit`, with its own id and lineage. */
  function quoteAt(unit: string, over: Partial<SignedQuote> = {}): SignedQuote {
    const base = makeSignedQuote(request);
    const line = base.lines[0];
    if (line === undefined) throw new Error('fixture');
    const unitPrice = { currency: 'INR', minor_units: unit };
    const subtotal = computeLineSubtotal(unitPrice, line.quantity, line.price_basis);
    if (subtotal.error || !subtotal.value) throw new Error('fixture');
    return makeSignedQuote(request, {
      lines: [{ ...line, unit_price: unitPrice, line_subtotal: subtotal.value }],
      total: subtotal.value,
      ...over,
    });
  }
  const countered = quoteAt('500');
  let seen: unknown[];

  beforeEach(() => {
    seen = [];
    const stub = {
      admission: {
        decideOrder: (_buyer: string, _po: string, decision: unknown) => {
          seen.push(decision);
          return { acknowledgement: { kind: 'countered' } };
        },
      },
      settings: new InMemoryCommerceSettingsRepository(),
      orders: { load: () => ({ ref: { quoteDigest: countered.quote_digest } }) },
      receipts: {
        get: (digest: string) =>
          digest === countered.quote_digest ? { recordJson: JSON.stringify(countered) } : null,
      },
      nodeDid: () => SUPPLIER_DID,
    } as unknown as CommerceRuntime;
    installCommerceRuntime(
      withPublishedCatalogue(stub, [
        catalogItem({ indicative_price: { currency: 'INR', minor_units: '600' } }),
      ]),
    );
  });
  afterEach(() => installCommerceRuntime(null));

  const decide = (replacement: SignedQuote) =>
    settleInboundOrderDecision({
      buyerDid: BUYER_DID,
      purchaseOrderId: 'po-1',
      runnerResultJson: JSON.stringify({ kind: 'counterproposal', replacement_quote: replacement }),
    });

  it('below the floor it is refused, and the order is left undecided', () => {
    // The catalogue says 600 with no discount, but the buyer already holds
    // 500 on the countered quote: the floor is 500.
    const result = decide(
      quoteAt('499', { quote_id: 'q-2', replaces_quote_digest: countered.quote_digest }),
    );
    expect(result).toEqual({
      ok: false,
      refusal: 'counter_out_of_bounds',
      error: expect.any(String),
    });
    expect(seen).toEqual([]);
  });

  it('at the price the buyer holds, or above, it goes to admission', () => {
    expect(
      decide(quoteAt('500', { quote_id: 'q-2', replaces_quote_digest: countered.quote_digest })).ok,
    ).toBe(true);
    expect(
      decide(quoteAt('650', { quote_id: 'q-3', replaces_quote_digest: countered.quote_digest })).ok,
    ).toBe(true);
    expect(seen).toHaveLength(2);
  });
});
