import { buildCreateCartBody, buildUpdateCartBody, readCart } from '../src/cart';
import {
  buildGetProductRequest,
  buildLookupRequest,
  buildSearchRequest,
  readProductList,
  SEARCH_PAGE_LIMIT,
} from '../src/catalog';
import {
  buildUpdateCheckoutBody,
  checkSelection,
  effectiveExpiry,
  isTerminalStatus,
  readCheckout,
  type Checkout,
} from '../src/checkout';
import { readDiscounts } from '../src/discount';
import { readFulfillment } from '../src/fulfillment';
import { buildCreateCheckoutBody, checkUpdateFitsIntent, type CheckoutIntent } from '../src/intent';
import {
  absorbOrder,
  emptyOrderRecord,
  linesSettled,
  orderRecordFromJson,
  orderRecordToJson,
  readOrder,
  type Order,
} from '../src/order';
import { readLinks, readTimestamp } from '../src/resource';

import fixture from './fixtures/spec_examples.json';
import { must } from './helpers';

const V = '2026-08-25';
const example = (source: string): Record<string, unknown> =>
  structuredClone(
    must(
      (fixture.examples as { source: string; value: Record<string, unknown> }[]).find(
        (e) => e.source === source,
      ),
    ).value,
  );
const scaffold = (name: string) => example(`scaffolds/${name}`);
/** The product of the spec's get_product example. */
const specProduct = () =>
  example('shopping/catalog/index.md:148').product as Record<string, unknown>;

function checkoutAnswer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ucp: { version: V, status: 'success' },
    id: 'chk_1',
    status: 'incomplete',
    currency: 'USD',
    line_items: [
      {
        id: 'li_1',
        item: { id: 'v1', title: 'Tea', price: 500 },
        quantity: 2,
        totals: [{ type: 'subtotal', amount: 1000 }],
      },
    ],
    totals: [
      { type: 'subtotal', amount: 1000 },
      { type: 'fulfillment', amount: 300, display_text: 'Shipping' },
      { type: 'total', amount: 1300 },
    ],
    links: [{ type: 'terms_of_service', url: 'https://shop.example/terms' }],
    fulfillment: {
      methods: [
        {
          id: 'm1',
          type: 'shipping',
          line_item_ids: ['li_1'],
          groups: [
            {
              id: 'g1',
              line_item_ids: ['li_1'],
              options: [{ id: 'std', title: 'Standard', totals: [{ type: 'total', amount: 300 }] }],
            },
          ],
        },
        {
          id: 'm2',
          type: 'pickup',
          line_item_ids: ['li_1'],
          destinations: [{ id: 'loc_1', type: 'business_location', name: 'Main St' }],
        },
      ],
    },
    ...over,
  };
}

function read(over: Record<string, unknown> = {}): Checkout {
  const r = readCheckout(checkoutAnswer(over));
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}

describe('checkout reader', () => {
  it('reads lines, totals in order, links, fulfillment', () => {
    const c = read();
    expect(c.lineItems[0]).toMatchObject({
      id: 'li_1',
      itemId: 'v1',
      unitPrice: 500n,
      quantity: 2n,
    });
    expect(c.totals.map((t) => t.type)).toEqual(['subtotal', 'fulfillment', 'total']);
    expect(c.totalsConsistent).toBe(true);
    expect(must(c.fulfillment[1]).destinations).toEqual([
      { id: 'loc_1', type: 'business_location', name: 'Main St' },
    ]);
  });
  it('flags totals that do not add up, and still reads them as given', () => {
    const c = read({
      totals: [
        { type: 'subtotal', amount: 1000 },
        { type: 'total', amount: 900 },
      ],
    });
    expect(c.totalsConsistent).toBe(false);
    expect(must(c.totals[1]).amount).toBe(900n);
  });
  it('keeps an unknown status as written, never terminal', () => {
    const c = read({ status: 'on_hold' });
    expect(c.status).toEqual({ unknown: 'on_hold' });
    expect(isTerminalStatus(c.status)).toBe(false);
    expect(isTerminalStatus(read({ status: 'canceled' }).status)).toBe(true);
  });
  it('reads the order confirmation of a completed checkout, and refuses one without it', () => {
    const c = read({
      status: 'completed',
      order: { id: 'ord_1', permalink_url: 'https://shop.example/o/1' },
    });
    expect(c.order).toEqual({ id: 'ord_1', permalinkUrl: 'https://shop.example/o/1' });
    expect(readCheckout(checkoutAnswer({ status: 'completed' }))).toEqual({
      ok: false,
      reason: 'completed_without_order',
    });
    expect(
      readCheckout(checkoutAnswer({ order: { id: 'o', permalink_url: 'http://shop.example/o' } })),
    ).toEqual({ ok: false, reason: 'order' });
  });
  it('drops a continue_url or link that is not https', () => {
    const c = read({
      continue_url: 'javascript:alert(1)',
      links: [{ type: 'faq', url: 'http://shop.example/faq' }],
    });
    expect(c.continueUrl).toBeUndefined();
    expect(c.links).toEqual([]);
  });
  it.each([
    ['a lower-case currency', { currency: 'usd' }, 'currency'],
    ['no id', { id: '' }, 'id'],
    [
      'two subtotals',
      {
        totals: [
          { type: 'subtotal', amount: 1 },
          { type: 'subtotal', amount: 1 },
          { type: 'total', amount: 2 },
        ],
      },
      'subtotal_count',
    ],
    [
      'a fractional quantity',
      {
        line_items: [
          { id: 'l', item: { id: 'v', title: 't', price: 1 }, quantity: 1.5, totals: [] },
        ],
      },
      'line_item_quantity',
    ],
    [
      'a price past 2^53-1',
      {
        line_items: [
          { id: 'l', item: { id: 'v', title: 't', price: 2 ** 53 }, quantity: 1, totals: [] },
        ],
      },
      'line_item_price',
    ],
    [
      'duplicate line ids',
      {
        line_items: [
          { id: 'l', item: { id: 'v', title: 't', price: 1 }, quantity: 1, totals: [] },
          { id: 'l', item: { id: 'w', title: 't', price: 1 }, quantity: 1, totals: [] },
        ],
      },
      'line_item_duplicate_id',
    ],
    ['a bad expires_at', { expires_at: 'tomorrow' }, 'expires_at'],
  ])('refuses %s', (_n, over, reason) => {
    expect(readCheckout(checkoutAnswer(over))).toEqual({ ok: false, reason });
  });
  it('computes the effective expiry: expires_at, else creation + 6 h', () => {
    expect(effectiveExpiry(read({ expires_at: '2026-10-04T12:00:00Z' }), 0)).toBe(
      Date.parse('2026-10-04T12:00:00Z'),
    );
    expect(effectiveExpiry(read(), 1_000)).toBe(1_000 + 6 * 3600 * 1000);
  });
});

describe('update bodies built for the intent pass the dispatch check', () => {
  const intent: CheckoutIntent = {
    merchantOrigin: 'https://shop.example',
    version: V,
    transport: 'rest',
    endpoint: 'https://shop.example/ucp',
    capabilities: { 'dev.ucp.shopping.checkout': V, 'dev.ucp.shopping.fulfillment': V },
    lines: [{ itemId: 'v1', quantity: 2n }],
    discountCodes: [],
    context: { address_country: 'US' },
  };
  const raw = checkoutAnswer();
  const last = read();

  it('choosing a shipping option', () => {
    const body = buildUpdateCheckoutBody(intent, last, { methodId: 'm1', options: { g1: 'std' } });
    expect(body).toEqual({
      line_items: [
        {
          id: 'li_1',
          item: { id: 'v1', quantity_unit: { unit: 'C62', scale: 0, display_text: 'each' } },
          quantity: 2,
        },
      ],
      context: { address_country: 'US' },
      fulfillment: {
        methods: [
          {
            id: 'm1',
            type: 'shipping',
            line_item_ids: ['li_1'],
            groups: [{ id: 'g1', selected_option_id: 'std' }],
          },
        ],
      },
    });
    expect(checkUpdateFitsIntent(intent, raw, body)).toEqual({ ok: true });
  });
  it('choosing a pickup location', () => {
    const body = buildUpdateCheckoutBody(intent, last, { methodId: 'm2', destinationId: 'loc_1' });
    expect(checkUpdateFitsIntent(intent, raw, body)).toEqual({ ok: true });
  });
  describe('an approved address is never dropped by an update', () => {
    const shipping = { street_address: '1 Road', address_country: 'US' };
    const withAddress = { ...intent, shippingAddress: shipping };

    it('without a selection, it is resent on the merchant shipping method, with its type', () => {
      const body = buildUpdateCheckoutBody(withAddress, last);
      expect(body.fulfillment).toEqual({
        methods: [
          { id: 'm1', type: 'shipping', line_item_ids: ['li_1'], destinations: [shipping] },
        ],
      });
      expect(checkUpdateFitsIntent(withAddress, raw, body)).toEqual({ ok: true });
    });

    it("before the merchant lists a shipping method, it is resent in the create's shape", () => {
      const bare = readCheckout(checkoutAnswer({ fulfillment: undefined }));
      if (!bare.ok) throw new Error(bare.reason);
      const body = buildUpdateCheckoutBody(withAddress, bare.value);
      expect(body.fulfillment).toEqual({
        methods: [{ type: 'shipping', line_item_ids: ['li_1'], destinations: [shipping] }],
      });
      expect(
        checkUpdateFitsIntent(withAddress, checkoutAnswer({ fulfillment: undefined }), body),
      ).toEqual({
        ok: true,
      });
    });

    it('a pickup choice would drop it, so it is refused', () => {
      expect(() =>
        buildUpdateCheckoutBody(withAddress, last, { methodId: 'm2', destinationId: 'loc_1' }),
      ).toThrow('address_needs_shipping');
    });
  });

  it('chooses only a business location on a pickup method', () => {
    const raw2 = checkoutAnswer();
    const methods = (raw2.fulfillment as { methods: Record<string, unknown>[] }).methods;
    must(methods[1]).destinations = [
      { id: 'loc_1', type: 'business_location', name: 'Main St' },
      { id: 'saved_9', type: 'shipping_address', street_address: '9 Elsewhere' },
    ];
    const read2 = readCheckout(raw2);
    if (!read2.ok) throw new Error(read2.reason);
    expect(() =>
      buildUpdateCheckoutBody(intent, read2.value, { methodId: 'm2', destinationId: 'saved_9' }),
    ).toThrow('destination_not_offered');
    const body = buildUpdateCheckoutBody(intent, read2.value, {
      methodId: 'm2',
      destinationId: 'loc_1',
    });
    expect(checkUpdateFitsIntent(intent, raw2, body)).toEqual({ ok: true });
  });

  describe('shipping to the approved address', () => {
    const shipping = { street_address: '1 Road', address_country: 'US' };
    const withAddress = { ...intent, shippingAddress: shipping };
    const echoRaw = (address: Record<string, string>) => {
      const r = checkoutAnswer();
      const methods = (r.fulfillment as { methods: Record<string, unknown>[] }).methods;
      must(methods[0]).destinations = [{ id: 'dest_1', type: 'shipping_address', ...address }];
      return r;
    };

    it('creates with the bare address, then selects the id the merchant gave it', () => {
      expect(buildCreateCheckoutBody(withAddress).fulfillment).toEqual({
        methods: [{ type: 'shipping', destinations: [shipping] }],
      });
      const raw2 = echoRaw(shipping);
      const read2 = readCheckout(raw2);
      if (!read2.ok) throw new Error(read2.reason);
      const body = buildUpdateCheckoutBody(withAddress, read2.value, {
        methodId: 'm1',
        destinationId: 'dest_1',
        options: { g1: 'std' },
      });
      expect(must((body.fulfillment as { methods: unknown[] }).methods[0])).toMatchObject({
        destinations: [{ id: 'dest_1', ...shipping }],
        selected_destination_id: 'dest_1',
      });
      expect(checkUpdateFitsIntent(withAddress, raw2, body)).toEqual({ ok: true });
    });

    it('a merchant that rewrote the address gets it bare again and no selection', () => {
      const raw2 = echoRaw({ ...shipping, street_address: '1 ROAD' });
      const read2 = readCheckout(raw2);
      if (!read2.ok) throw new Error(read2.reason);
      expect(() =>
        buildUpdateCheckoutBody(withAddress, read2.value, {
          methodId: 'm1',
          destinationId: 'dest_1',
        }),
      ).toThrow('destination_not_offered');
      const body = buildUpdateCheckoutBody(withAddress, read2.value, { methodId: 'm1' });
      expect(must((body.fulfillment as { methods: unknown[] }).methods[0])).toMatchObject({
        destinations: [shipping],
      });
      expect(checkUpdateFitsIntent(withAddress, raw2, body)).toEqual({ ok: true });
    });
  });

  it('refuses to build a choice the merchant never offered', () => {
    expect(() => buildUpdateCheckoutBody(intent, last, { methodId: 'm9' })).toThrow(
      'method_not_offered',
    );
    expect(() =>
      buildUpdateCheckoutBody(intent, last, { methodId: 'm2', destinationId: 'loc_9' }),
    ).toThrow('destination_not_offered');
    // No shipping destination can be selected when no address was approved.
    expect(() =>
      buildUpdateCheckoutBody(intent, last, { methodId: 'm1', destinationId: 'dest_1' }),
    ).toThrow('destination_not_offered');
    // The same answers, as a check a caller makes first on a choice Brain proposed.
    expect(checkSelection(intent, last, { methodId: 'm9' })).toEqual({
      ok: false,
      reason: 'method_not_offered',
    });
    expect(checkSelection(intent, last, { methodId: 'm2', destinationId: 'loc_9' })).toEqual({
      ok: false,
      reason: 'destination_not_offered',
    });
    expect(checkSelection(intent, last, { methodId: 'm2' })).toEqual({ ok: true });
  });
});

describe('fulfillment and discounts', () => {
  it('reads an absent fulfillment as no methods, and refuses a malformed one', () => {
    expect(readFulfillment(undefined)).toEqual({ ok: true, value: [] });
    expect(readFulfillment({ methods: [{ id: 'm', type: 'shipping' }] })).toEqual({
      ok: false,
      reason: 'method_line_item_ids',
    });
  });
  it('reads applied discounts, marking provisional ones', () => {
    expect(
      readDiscounts({
        codes: ['SAVE'],
        applied: [{ title: '10% off', amount: 100, code: 'SAVE', provisional: true }],
      }),
    ).toEqual({
      ok: true,
      value: {
        codes: ['SAVE'],
        applied: [
          { title: '10% off', amount: 100n, code: 'SAVE', automatic: false, provisional: true },
        ],
      },
    });
    expect(readDiscounts({ applied: [{ title: 'x', amount: -5 }] })).toEqual({
      ok: false,
      reason: 'applied_discount_amount',
    });
  });
});

describe('carts', () => {
  it('carry items, quantities, units and context only', () => {
    expect(buildCreateCartBody([{ itemId: 'v1', quantity: 1n }], { language: 'en' })).toEqual({
      line_items: [
        {
          item: { id: 'v1', quantity_unit: { unit: 'C62', scale: 0, display_text: 'each' } },
          quantity: 1,
        },
      ],
      context: { language: 'en' },
    });
  });
  it('update as a whole, reusing the merchant line ids', () => {
    const cart = readCart(scaffold('shopping_cart_response.json'));
    if (!cart.ok) throw new Error(cart.reason);
    const itemId = must(cart.value.lineItems[0]).itemId;
    expect(
      buildUpdateCartBody(
        [
          { itemId, quantity: 3n },
          { itemId: 'new', quantity: 1n },
        ],
        {},
        cart.value,
      ),
    ).toEqual({
      line_items: [
        {
          id: must(cart.value.lineItems[0]).id,
          item: { id: itemId, quantity_unit: { unit: 'C62', scale: 0, display_text: 'each' } },
          quantity: 3,
        },
        {
          item: { id: 'new', quantity_unit: { unit: 'C62', scale: 0, display_text: 'each' } },
          quantity: 1,
        },
      ],
    });
  });
  it('refuse an empty cart, a zero quantity, and two lines for one variant', () => {
    expect(() => buildCreateCartBody([], {})).toThrow('no lines');
    expect(() => buildCreateCartBody([{ itemId: 'v', quantity: 0n }], {})).toThrow('bad line');
    expect(() =>
      buildCreateCartBody(
        [
          { itemId: 'v', quantity: 1n },
          { itemId: 'v', quantity: 2n },
        ],
        {},
      ),
    ).toThrow('duplicate item');
  });
});

describe('catalog', () => {
  it('builds a search with Dina page size, context and no signals', () => {
    expect(buildSearchRequest({ query: 'green tea', context: { address_country: 'IN' } })).toEqual({
      query: 'green tea',
      pagination: { limit: SEARCH_PAGE_LIMIT },
      context: { address_country: 'IN' },
    });
    expect(() => buildSearchRequest({ query: '  ', context: {} })).toThrow();
    expect(buildLookupRequest(['a', 'b'], {})).toEqual({ ids: ['a', 'b'] });
    expect(buildGetProductRequest('p', {})).toEqual({ id: 'p' });
  });
  it('drops and counts an unreadable product, keeps the rest, and reads the next cursor', () => {
    const good = specProduct();
    const list = readProductList({
      ucp: { version: V },
      products: [good, { id: 'bad' }],
      pagination: { has_next_page: true, cursor: 'c2' },
    });
    expect(list).toMatchObject({ ok: true, value: { unreadable: 1, nextCursor: 'c2' } });
    if (list.ok) expect(list.value.products).toHaveLength(1);
  });
  it('refuses a price range whose min exceeds its max', () => {
    const p = specProduct();
    p.price_range = { min: { amount: 10, currency: 'USD' }, max: { amount: 5, currency: 'USD' } };
    expect(readProductList({ products: [p] })).toMatchObject({
      ok: true,
      value: { unreadable: 1 },
    });
  });
});

describe('orders', () => {
  function order(over: Record<string, unknown> = {}): Order {
    const base = scaffold('shopping_order_response.json');
    const r = readOrder({ ...base, ...over });
    if (!r.ok) throw new Error(r.reason);
    return r.value;
  }
  const event = (id: string, type: string) => ({
    id,
    type,
    occurred_at: '2026-10-01T10:00:00Z',
    line_items: [{ id: 'li_scaffold', quantity: 1 }],
  });
  const adj = (id: string, type: string, status: string) => ({
    id,
    type,
    status,
    occurred_at: '2026-10-02T10:00:00Z',
  });

  it('reads the scaffold', () => {
    expect(order().lines[0]).toMatchObject({
      id: 'li_scaffold',
      status: 'processing',
      quantity: { total: 1n, fulfilled: 0n, original: 1n },
    });
  });

  it('a shipment stays in the record when a later answer leaves events out; a new pending dispute interrupts once', () => {
    let { record, interruptions } = absorbOrder(
      emptyOrderRecord(),
      order({ fulfillment: { events: [event('e1', 'shipped')] } }),
    );
    expect(interruptions).toEqual([]);
    ({ record, interruptions } = absorbOrder(
      record,
      order({ fulfillment: { events: [] }, adjustments: [adj('a1', 'dispute', 'pending')] }),
    ));
    expect(Object.keys(record.events)).toEqual(['e1']);
    expect(interruptions).toEqual([
      { kind: 'adjustment', id: 'a1', type: 'dispute', reason: 'new' },
    ]);
    ({ interruptions } = absorbOrder(
      record,
      order({ fulfillment: {}, adjustments: [adj('a1', 'dispute', 'pending')] }),
    ));
    expect(interruptions).toEqual([]);
  });

  it('a dispute settling interrupts once; a refund completing does not', () => {
    let { record } = absorbOrder(
      emptyOrderRecord(),
      order({ adjustments: [adj('d', 'dispute', 'pending'), adj('r', 'refund', 'pending')] }),
    );
    let interruptions;
    ({ record, interruptions } = absorbOrder(
      record,
      order({ adjustments: [adj('d', 'dispute', 'completed'), adj('r', 'refund', 'completed')] }),
    ));
    expect(interruptions).toEqual([
      { kind: 'adjustment', id: 'd', type: 'dispute', reason: 'settled' },
    ]);
    ({ interruptions } = absorbOrder(
      record,
      order({ adjustments: [adj('d', 'dispute', 'completed')] }),
    ));
    expect(interruptions).toEqual([]);
  });

  it('a first failure of any adjustment interrupts; a dispute or cancellation first seen settled or failed is named so, once', () => {
    const first = absorbOrder(
      emptyOrderRecord(),
      order({
        adjustments: [
          adj('r', 'refund', 'failed'),
          adj('d', 'dispute', 'completed'),
          adj('c', 'cancellation', 'failed'),
        ],
      }),
    );
    expect(first.interruptions).toEqual([
      { kind: 'adjustment', id: 'r', type: 'refund', reason: 'failed' },
      { kind: 'adjustment', id: 'd', type: 'dispute', reason: 'settled' },
      { kind: 'adjustment', id: 'c', type: 'cancellation', reason: 'failed' },
    ]);
    // The same answer again: nothing more.
    expect(
      absorbOrder(
        first.record,
        order({
          adjustments: [
            adj('r', 'refund', 'failed'),
            adj('d', 'dispute', 'completed'),
            adj('c', 'cancellation', 'failed'),
          ],
        }),
      ).interruptions,
    ).toEqual([]);
  });

  it('only a new failing event interrupts; a replayed body adds nothing', () => {
    const body = order({
      fulfillment: { events: [event('e1', 'shipped'), event('e2', 'failed_attempt')] },
    });
    const first = absorbOrder(emptyOrderRecord(), body);
    expect(first.interruptions).toEqual([{ kind: 'event', id: 'e2', type: 'failed_attempt' }]);
    expect(absorbOrder(first.record, body).interruptions).toEqual([]);
  });

  it('ids named after Object.prototype members are ordinary keys', () => {
    const r = absorbOrder(
      emptyOrderRecord(),
      order({
        fulfillment: { events: [event('toString', 'canceled')] },
        adjustments: [
          adj('__proto__', 'dispute', 'pending'),
          adj('constructor', 'cancellation', 'pending'),
        ],
      }),
    );
    expect(r.interruptions).toEqual([
      { kind: 'event', id: 'toString', type: 'canceled' },
      { kind: 'adjustment', id: '__proto__', type: 'dispute', reason: 'new' },
      { kind: 'adjustment', id: 'constructor', type: 'cancellation', reason: 'new' },
    ]);
    expect(Object.keys(r.record.adjustments)).toEqual(['__proto__', 'constructor']);
    // The pending '__proto__' adjustment still holds the closed rule open.
    const done = order({
      line_items: (
        scaffold('shopping_order_response.json').line_items as Record<string, unknown>[]
      ).map((l) => ({ ...l, status: 'fulfilled' })),
    });
    expect(linesSettled(done, r.record)).toBe(false);
    // And it survives a JSON round trip, as the stored record will.
    const restored = JSON.parse(JSON.stringify(r.record)) as typeof r.record;
    expect(
      absorbOrder(restored, order({ adjustments: [adj('__proto__', 'dispute', 'pending')] }))
        .interruptions,
    ).toEqual([]);
  });

  it('a first failed status interrupts in either delivery order', () => {
    const completedFirst = absorbOrder(
      emptyOrderRecord(),
      order({ adjustments: [adj('r', 'refund', 'completed')] }),
    );
    expect(completedFirst.interruptions).toEqual([]);
    expect(
      absorbOrder(completedFirst.record, order({ adjustments: [adj('r', 'refund', 'failed')] }))
        .interruptions,
    ).toEqual([{ kind: 'adjustment', id: 'r', type: 'refund', reason: 'failed' }]);
    const failedFirst = absorbOrder(
      emptyOrderRecord(),
      order({ adjustments: [adj('r', 'refund', 'failed')] }),
    );
    expect(failedFirst.interruptions).toEqual([
      { kind: 'adjustment', id: 'r', type: 'refund', reason: 'failed' },
    ]);
    expect(
      absorbOrder(failedFirst.record, order({ adjustments: [adj('r', 'refund', 'completed')] }))
        .interruptions,
    ).toEqual([]);
  });

  it('a re-typed adjustment keeps its first type: a dispute sent later as a refund still interrupts on settling', () => {
    const { record } = absorbOrder(
      emptyOrderRecord(),
      order({ adjustments: [adj('d', 'dispute', 'pending')] }),
    );
    expect(
      absorbOrder(record, order({ adjustments: [adj('d', 'refund', 'completed')] })).interruptions,
    ).toEqual([{ kind: 'adjustment', id: 'd', type: 'dispute', reason: 'settled' }]);
    const refund = absorbOrder(
      emptyOrderRecord(),
      order({ adjustments: [adj('r', 'refund', 'pending')] }),
    ).record;
    expect(
      absorbOrder(refund, order({ adjustments: [adj('r', 'dispute', 'completed')] })).interruptions,
    ).toEqual([]);
  });

  it('keeps only each event type for good, not tracking details', () => {
    const tracked = {
      ...event('e1', 'shipped'),
      tracking_number: 'TRK1',
      tracking_url: 'https://c.example/TRK1',
      description: 'Left at door',
    };
    const { record } = absorbOrder(
      emptyOrderRecord(),
      order({ fulfillment: { events: [tracked] } }),
    );
    expect(JSON.parse(JSON.stringify(record.events))).toEqual({ e1: { type: 'shipped' } });
  });

  it('settles lines only when every line is fulfilled or removed and no adjustment is pending', () => {
    const lines = (status: string) =>
      (scaffold('shopping_order_response.json').line_items as Record<string, unknown>[]).map(
        (l) => ({ ...l, status }),
      );
    const done = order({ line_items: lines('fulfilled') });
    expect(linesSettled(done, emptyOrderRecord())).toBe(true);
    expect(linesSettled(order(), emptyOrderRecord())).toBe(false);
    const pending = absorbOrder(
      emptyOrderRecord(),
      order({ adjustments: [adj('r', 'refund', 'pending')] }),
    ).record;
    expect(linesSettled(done, pending)).toBe(false);
  });

  it.each([
    ['an http permalink', { permalink_url: 'http://x.example/o' }, 'permalink_url'],
    ['no permalink', { permalink_url: undefined }, 'permalink_url'],
    [
      'an unknown adjustment status',
      {
        adjustments: [
          { id: 'a', type: 'refund', status: 'lost', occurred_at: '2026-10-02T10:00:00Z' },
        ],
      },
      'adjustment_status',
    ],
    [
      'an unknown line status',
      {
        line_items: [
          {
            id: 'l',
            item: { id: 'v', title: 't', price: 1 },
            quantity: { total: 1, fulfilled: 0 },
            totals: [],
            status: 'lost',
          },
        ],
      },
      'line_status',
    ],
    [
      'duplicate event ids',
      {
        fulfillment: {
          events: [
            { id: 'e', type: 't', occurred_at: '2026-10-01T00:00:00Z', line_items: [] },
            { id: 'e', type: 't', occurred_at: '2026-10-01T00:00:00Z', line_items: [] },
          ],
        },
      },
      'events_duplicate_id',
    ],
    ['no fulfillment object', { fulfillment: undefined }, 'fulfillment'],
  ])('refuses an order with %s', (_n, over, reason) => {
    expect(readOrder({ ...scaffold('shopping_order_response.json'), ...over })).toEqual({
      ok: false,
      reason,
    });
  });
});

describe('the kept order record, stored', () => {
  it('round-trips, ids named like Object members included, and keeps no prototype', () => {
    const order = readOrder({
      ...scaffold('shopping_order_response.json'),
      fulfillment: {
        events: [
          { id: '__proto__', type: 'shipped', occurred_at: '2026-10-01T00:00:00Z', line_items: [] },
        ],
      },
      adjustments: [
        { id: 'toString', type: 'refund', status: 'pending', occurred_at: '2026-10-01T00:00:00Z' },
      ],
    });
    if (!order.ok) throw new Error(order.reason);
    const { record } = absorbOrder(emptyOrderRecord(), order.value);
    const back = orderRecordFromJson(orderRecordToJson(record));
    expect(back).not.toBeNull();
    expect(Object.getPrototypeOf(back?.events)).toBeNull();
    expect(Object.keys(back?.events ?? {})).toEqual(['__proto__']);
    expect(Object.keys(back?.adjustments ?? {})).toEqual(['toString']);
    expect(orderRecordToJson(back ?? emptyOrderRecord())).toBe(orderRecordToJson(record));
  });

  it.each([
    ['not JSON', '{'],
    ['no maps', '{}'],
    ['an event with no type', '{"events":{"e":{}},"adjustments":{}}'],
    [
      'an adjustment with an unknown status',
      '{"events":{},"adjustments":{"a":{"type":"refund","status":"done","seenCompleted":false,"seenFailed":false}}}',
    ],
  ])('refuses %s', (_n, text) => {
    expect(orderRecordFromJson(text)).toBeNull();
  });
});

describe('shared readers', () => {
  it('reads RFC 3339 times with a zone only', () => {
    expect(readTimestamp('2026-10-04T12:00:00.5+05:30')).toBe(Date.parse('2026-10-04T06:30:00.5Z'));
    expect(readTimestamp('2026-10-04 12:00:00')).toBeNull();
    expect(readTimestamp('2026-10-04T12:00:00')).toBeNull();
  });
  it('keeps https links with their title', () => {
    expect(
      readLinks([
        { type: 'faq', url: 'https://s.example/faq', title: 'Help' },
        { type: 'x', url: 'ftp://s.example' },
      ]),
    ).toEqual([{ type: 'faq', url: 'https://s.example/faq', title: 'Help' }]);
  });
});
