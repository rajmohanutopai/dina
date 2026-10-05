import { sha256 } from '@noble/hashes/sha2.js';

import {
  buildCreateCheckoutBody,
  checkIntentDrift,
  checkoutIntentHash,
  checkUpdateFitsIntent,
  merchantOriginOf,
  validateIntent,
  type CheckoutIntent,
  type NegotiatedState,
} from '../src/intent';
import { filterProfile, intersectCapabilities } from '../src/negotiate';
import { parseMerchantProfile } from '../src/profile';

import { must } from './helpers';

const V = '2026-08-25';
const CAPS = {
  'dev.ucp.shopping.checkout': V,
  'dev.ucp.shopping.fulfillment': V,
  'dev.ucp.shopping.discount': V,
};
/**
 * The default intent's hash, frozen. Also computed by an independent script
 * (Python: json.dumps(sort_keys=True, separators=(',', ':')) over the same
 * canonical object, then SHA-256), not copied from this code.
 */
const FROZEN_INTENT_HASH = '85c24ad6ad4ab5f828046da9ff500d3e5df045b487911dd9bdfbfcae95f81860';
const KG = { unit: 'KGM', scale: 3, displayText: 'kg', increment: 250 };

function intent(over: Partial<CheckoutIntent> = {}): CheckoutIntent {
  return {
    merchantOrigin: 'https://shop.example',
    version: V,
    transport: 'mcp',
    endpoint: 'https://shop.example/api/ucp/mcp',
    capabilities: CAPS,
    lines: [
      { itemId: 'gid://shopify/ProductVariant/1', quantity: 2n },
      { itemId: 'apples', quantity: 1500n, unit: KG },
    ],
    discountCodes: ['SAVE10'],
    context: { address_country: 'IN', language: 'en' },
    ...over,
  };
}

/** A merchant answer to the create, with the ids the merchant chose. */
const last = {
  ucp: { version: V },
  id: 'chk_1',
  status: 'incomplete',
  line_items: [
    { id: 'li_1', item: { id: 'gid://shopify/ProductVariant/1' }, quantity: 2 },
    { id: 'li_2', item: { id: 'apples' }, quantity: 1500 },
  ],
  fulfillment: {
    methods: [
      {
        id: 'm_ship',
        type: 'shipping',
        line_item_ids: ['li_1', 'li_2'],
        groups: [
          {
            id: 'g_1',
            line_item_ids: ['li_1', 'li_2'],
            options: [{ id: 'std' }, { id: 'express' }],
          },
        ],
      },
      {
        id: 'm_pick',
        type: 'pickup',
        line_item_ids: ['li_1', 'li_2'],
        destinations: [{ id: 'store_9', type: 'business_location' }],
      },
    ],
  },
};

function update(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const body = buildCreateCheckoutBody(intent());
  const lines = (body.line_items as Record<string, unknown>[]).map((l, i) => ({
    id: `li_${i + 1}`,
    ...l,
  }));
  return { ...body, line_items: lines, ...extra };
}

describe('the checkout intent', () => {
  it('builds the create body from the intent only: no cart_id, no buyer, every unit asserted', () => {
    expect(buildCreateCheckoutBody(intent())).toEqual({
      line_items: [
        // Each is sent too: an omitted unit asserts nothing (checkout/index.md:90-99).
        {
          item: {
            id: 'gid://shopify/ProductVariant/1',
            quantity_unit: { unit: 'C62', scale: 0, display_text: 'each' },
          },
          quantity: 2,
        },
        {
          item: { id: 'apples', quantity_unit: { unit: 'KGM', scale: 3, display_text: 'kg' } },
          quantity: 1500,
        },
      ],
      discounts: { codes: ['SAVE10'] },
      context: { address_country: 'IN', language: 'en' },
    });
  });

  it('writes an opted-in shipping address as the one platform-authored destination', () => {
    const body = buildCreateCheckoutBody(
      intent({ shippingAddress: { street_address: '1 Road', address_country: 'IN' } }),
    );
    expect(body.fulfillment).toEqual({
      methods: [
        {
          type: 'shipping',
          // Postal fields only: in a request an id names an address the
          // merchant already holds (fulfillment.md:270-289).
          destinations: [{ street_address: '1 Road', address_country: 'IN' }],
        },
      ],
    });
  });

  it('hashes stably whatever order keys arrive in', () => {
    const h = checkoutIntentHash(intent(), sha256);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    const reversed = Object.fromEntries(Object.entries(CAPS).reverse());
    expect(Object.keys(reversed)).not.toEqual(Object.keys(CAPS));
    expect(
      checkoutIntentHash(
        intent({ capabilities: reversed, context: { language: 'en', address_country: 'IN' } }),
        sha256,
      ),
    ).toBe(h);
    const addr = { street_address: '1 Road', address_country: 'IN' };
    expect(checkoutIntentHash(intent({ shippingAddress: addr }), sha256)).toBe(
      checkoutIntentHash(
        intent({ shippingAddress: { address_country: 'IN', street_address: '1 Road' } }),
        sha256,
      ),
    );
  });

  it('is frozen for the default intent (a change to the canonical form must be deliberate)', () => {
    expect(checkoutIntentHash(intent(), sha256)).toBe(FROZEN_INTENT_HASH);
  });

  it('binds every approved detail', () => {
    const h = checkoutIntentHash(intent(), sha256);
    const addr = { street_address: '1 Road', address_country: 'IN' };
    const withAddr = checkoutIntentHash(intent({ shippingAddress: addr }), sha256);
    expect(withAddr).not.toBe(h);
    expect(
      checkoutIntentHash(
        intent({ shippingAddress: { ...addr, street_address: '2 Road' } }),
        sha256,
      ),
    ).not.toBe(withAddr);
    const kgLine = (scale: number) => ({
      itemId: 'apples',
      quantity: 1500n,
      unit: { ...KG, scale },
    });
    for (const over of [
      { lines: [{ itemId: 'gid://shopify/ProductVariant/1', quantity: 3n }] },
      { lines: [{ itemId: 'gid://shopify/ProductVariant/1', quantity: 2n }, kgLine(2)] },
      {
        lines: [
          { itemId: 'gid://shopify/ProductVariant/1', quantity: 2n },
          { ...kgLine(3), unit: { ...KG, unit: 'GRM' } },
        ],
      },
      { discountCodes: [] },
      { endpoint: 'https://shop.example/other' },
      { merchantOrigin: 'https://other.example' },
      { transport: 'rest' as const },
      { version: '2026-09-01' },
      { buyer: { email: 'a@b.example' } },
      { context: { address_country: 'IN' } },
      { credential: { ref: 'c1', revision: 2 } },
      { capabilities: { 'dev.ucp.shopping.checkout': V } },
    ] as Partial<CheckoutIntent>[]) {
      expect(checkoutIntentHash(intent(over), sha256)).not.toBe(h);
    }
  });

  it.each([
    ['no lines', { lines: [] }, 'no_lines'],
    ['a zero quantity', { lines: [{ itemId: 'a', quantity: 0n }] }, 'bad_quantity'],
    ['a quantity past 2^53-1', { lines: [{ itemId: 'a', quantity: 2n ** 53n }] }, 'bad_quantity'],
    [
      'two lines for one variant',
      {
        lines: [
          { itemId: 'a', quantity: 1n },
          { itemId: 'a', quantity: 1n },
        ],
      },
      'duplicate_item',
    ],
    [
      'codes without discount',
      { capabilities: { 'dev.ucp.shopping.checkout': V } },
      'discount_not_negotiated',
    ],
    [
      'an address without fulfillment',
      {
        shippingAddress: { street_address: '1 Road', address_country: 'IN' },
        capabilities: { 'dev.ucp.shopping.checkout': V, 'dev.ucp.shopping.discount': V },
      },
      'fulfillment_not_negotiated',
    ],
    [
      'no checkout capability',
      { capabilities: { 'dev.ucp.shopping.discount': V } },
      'checkout_not_negotiated',
    ],
  ])('refuses an intent with %s', (_n, over, reason) => {
    expect(validateIntent(intent(over as Partial<CheckoutIntent>))).toEqual({ ok: false, reason });
  });
});

describe('the update check', () => {
  it('admits the approved lines with the merchant line ids and a merchant-offered option', () => {
    expect(
      checkUpdateFitsIntent(
        intent(),
        last,
        update({
          fulfillment: {
            methods: [
              {
                id: 'm_ship',
                line_item_ids: ['li_1', 'li_2'],
                groups: [{ id: 'g_1', selected_option_id: 'express' }],
              },
            ],
          },
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('admits a pickup location the merchant listed', () => {
    expect(
      checkUpdateFitsIntent(
        intent(),
        last,
        update({
          fulfillment: {
            methods: [
              { id: 'm_pick', line_item_ids: ['li_1'], selected_destination_id: 'store_9' },
            ],
          },
        }),
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    [
      'a changed quantity',
      () => {
        const u = update() as { line_items: { quantity: number }[] };
        must(u.line_items[0]).quantity = 3;
        return u;
      },
      'lines_changed',
    ],
    [
      'an added line',
      () => {
        const u = update() as { line_items: unknown[] };
        u.line_items.push({ item: { id: 'x' }, quantity: 1 });
        return u;
      },
      'lines_changed',
    ],
    [
      'a changed unit',
      () => {
        const u = update() as { line_items: { item: Record<string, unknown> }[] };
        must(u.line_items[1]).item.quantity_unit = { unit: 'GRM', scale: 0, display_text: 'g' };
        return u;
      },
      'lines_changed',
    ],
    [
      'a line id the merchant gave another item',
      () => {
        const u = update() as { line_items: { id: string }[] };
        must(u.line_items[0]).id = 'li_2';
        return u;
      },
      'line_id_not_offered',
    ],
    ['a dropped code', () => update({ discounts: { codes: [] } }), 'codes_changed'],
    ['a new code', () => update({ discounts: { codes: ['SAVE10', 'FREE'] } }), 'codes_changed'],
    ['personal data', () => update({ buyer: { email: 'a@b.example' } }), 'personal_data_changed'],
    [
      'finer context',
      () => update({ context: { address_country: 'IN', language: 'en', postal_code: '560001' } }),
      'context_changed',
    ],
    ['payment', () => update({ payment: {} }), 'field_not_allowed'],
    ['cart_id', () => update({ cart_id: 'c' }), 'field_not_allowed'],
    [
      'an option the merchant never offered',
      () =>
        update({
          fulfillment: {
            methods: [
              {
                id: 'm_ship',
                line_item_ids: ['li_1'],
                groups: [{ id: 'g_1', selected_option_id: 'teleport' }],
              },
            ],
          },
        }),
      'option_not_offered',
    ],
    [
      'an unknown group',
      () =>
        update({
          fulfillment: {
            methods: [
              {
                id: 'm_ship',
                line_item_ids: ['li_1'],
                groups: [{ id: 'g_9', selected_option_id: 'std' }],
              },
            ],
          },
        }),
      'group_not_offered',
    ],
    [
      'an unknown method',
      () => update({ fulfillment: { methods: [{ id: 'm_drone', line_item_ids: ['li_1'] }] } }),
      'method_not_offered',
    ],
    [
      'a method with a different type',
      () =>
        update({
          fulfillment: { methods: [{ id: 'm_pick', type: 'shipping', line_item_ids: ['li_1'] }] },
        }),
      'method_not_offered',
    ],
    [
      'a location the merchant never listed',
      () =>
        update({
          fulfillment: {
            methods: [
              { id: 'm_pick', line_item_ids: ['li_1'], selected_destination_id: 'evil_store' },
            ],
          },
        }),
      'destination_not_offered',
    ],
    [
      'an address never approved',
      () =>
        update({
          fulfillment: {
            methods: [
              {
                id: 'm_ship',
                type: 'shipping',
                line_item_ids: ['li_1'],
                destinations: [
                  { id: 'x', type: 'shipping_address', street_address: '9 Elsewhere' },
                ],
              },
            ],
          },
        }),
      'personal_data_changed',
    ],
    [
      'an unknown line id in a method',
      () => update({ fulfillment: { methods: [{ id: 'm_ship', line_item_ids: ['li_7'] }] } }),
      'line_id_not_offered',
    ],
    [
      'an option written inside the group',
      () =>
        update({
          fulfillment: {
            methods: [
              {
                id: 'm_ship',
                line_item_ids: ['li_1'],
                groups: [{ id: 'g_1', options: [{ id: 'free' }] }],
              },
            ],
          },
        }),
      'fulfillment_shape',
    ],
  ])('refuses an update with %s', (_n, make, reason) => {
    expect(checkUpdateFitsIntent(intent(), last, make())).toEqual({ ok: false, reason });
  });

  describe('the approved shipping address', () => {
    const shipping = { street_address: '1 Road', address_country: 'IN' };
    const i = intent({ shippingAddress: shipping });
    /** The merchant's answer after the create: it echoed the address as dest_1 and lists a saved one. */
    const echoed = structuredClone(last) as typeof last & {
      fulfillment: { methods: Record<string, unknown>[] };
    };
    (must(echoed.fulfillment.methods[0]) as Record<string, unknown>).destinations = [
      { id: 'dest_1', type: 'shipping_address', ...shipping },
      {
        id: 'saved_9',
        type: 'shipping_address',
        street_address: '9 Elsewhere',
        address_country: 'IN',
      },
      // A saved address that shares the approved fields and adds one.
      { id: 'saved_sup', type: 'shipping_address', ...shipping, extended_address: 'Apt 9' },
    ];
    const withMethod = (m: Record<string, unknown>) => ({
      ...update(),
      fulfillment: {
        methods: [{ id: 'm_ship', type: 'shipping', line_item_ids: ['li_1', 'li_2'], ...m }],
      },
    });

    it('is admitted under the merchant id it was given, and selected', () => {
      expect(
        checkUpdateFitsIntent(
          i,
          echoed,
          withMethod({
            destinations: [{ id: 'dest_1', ...shipping }],
            selected_destination_id: 'dest_1',
          }),
        ),
      ).toEqual({ ok: true });
    });
    it('is admitted bare, before the merchant has echoed it', () => {
      expect(checkUpdateFitsIntent(i, last, withMethod({ destinations: [shipping] }))).toEqual({
        ok: true,
      });
    });
    it.each([
      [
        'a saved address the merchant lists',
        { selected_destination_id: 'saved_9' },
        'destination_not_offered',
      ],
      [
        'an address id the merchant never gave',
        { destinations: [{ id: 'dest_7', ...shipping }] },
        'destination_not_offered',
      ],
      [
        'the saved address id on the approved fields',
        { destinations: [{ id: 'saved_9', ...shipping }] },
        'destination_not_offered',
      ],
      [
        'a changed street',
        { destinations: [{ ...shipping, street_address: '2 Road' }] },
        'personal_data_changed',
      ],
      [
        'an added field',
        { destinations: [{ ...shipping, phone_number: '+911234' }] },
        'personal_data_changed',
      ],
      ['two addresses', { destinations: [shipping, shipping] }, 'personal_data_changed'],
    ])('refuses %s', (_n, m, reason) => {
      expect(checkUpdateFitsIntent(i, echoed, withMethod(m))).toEqual({ ok: false, reason });
    });
    it('refuses a saved address that adds a field to the approved ones', () => {
      expect(
        checkUpdateFitsIntent(
          i,
          echoed,
          withMethod({
            destinations: [{ id: 'dest_1', ...shipping }],
            selected_destination_id: 'saved_sup',
          }),
        ),
      ).toEqual({ ok: false, reason: 'destination_not_offered' });
      expect(
        checkUpdateFitsIntent(
          i,
          echoed,
          withMethod({ destinations: [{ id: 'saved_sup', ...shipping }] }),
        ),
      ).toEqual({ ok: false, reason: 'destination_not_offered' });
    });
    it('refuses destinations written without the method type (fulfillment_method.json)', () => {
      const body = {
        ...update(),
        fulfillment: {
          methods: [{ id: 'm_ship', line_item_ids: ['li_1'], destinations: [shipping] }],
        },
      };
      expect(checkUpdateFitsIntent(i, echoed, body)).toEqual({
        ok: false,
        reason: 'fulfillment_shape',
      });
    });
    it('refuses an update that would erase the approved address (a full replacement)', () => {
      expect(checkUpdateFitsIntent(i, echoed, update())).toEqual({
        ok: false,
        reason: 'personal_data_changed',
      });
      const pickupOnly = {
        ...update(),
        fulfillment: {
          methods: [
            {
              id: 'm_pick',
              type: 'pickup',
              line_item_ids: ['li_1'],
              selected_destination_id: 'store_9',
            },
          ],
        },
      };
      expect(checkUpdateFitsIntent(i, echoed, pickupOnly)).toEqual({
        ok: false,
        reason: 'personal_data_changed',
      });
    });
    it("admits the create's own shape before the merchant lists a shipping method, and nothing more", () => {
      const createShape = {
        type: 'shipping',
        line_item_ids: ['li_1', 'li_2'],
        destinations: [shipping],
      };
      const body = (m: Record<string, unknown>) => ({ ...update(), fulfillment: { methods: [m] } });
      expect(checkUpdateFitsIntent(i, last, body(createShape))).toEqual({ ok: true });
      expect(
        checkUpdateFitsIntent(i, last, body({ ...createShape, selected_destination_id: 'x' })),
      ).toEqual({
        ok: false,
        reason: 'method_not_offered',
      });
      expect(checkUpdateFitsIntent(intent(), last, body(createShape))).toEqual({
        ok: false,
        reason: 'method_not_offered',
      });
    });
    it('refuses a shipping selection when no address was approved', () => {
      expect(
        checkUpdateFitsIntent(intent(), echoed, withMethod({ selected_destination_id: 'dest_1' })),
      ).toEqual({
        ok: false,
        reason: 'destination_not_offered',
      });
    });
  });
});

describe('selecting a destination on a method other than shipping', () => {
  const withMethods = (methods: Record<string, unknown>[]) => ({
    ...last,
    fulfillment: { methods },
  });
  const body = (m: Record<string, unknown>) => ({
    ...update(),
    fulfillment: { methods: [{ line_item_ids: ['li_1'], ...m }] },
  });
  it('refuses a custom method type, whatever it lists (only pickup may choose)', () => {
    const offered = withMethods([
      {
        id: 'm_locker',
        type: 'locker',
        line_item_ids: ['li_1'],
        destinations: [{ id: 'saved_x', type: 'shipping_address', street_address: '9 Elsewhere' }],
      },
    ]);
    expect(
      checkUpdateFitsIntent(
        intent(),
        offered,
        body({ id: 'm_locker', selected_destination_id: 'saved_x' }),
      ),
    ).toEqual({ ok: false, reason: 'destination_not_offered' });
  });
  it('refuses a pickup method choosing anything but a business location', () => {
    const offered = withMethods([
      {
        id: 'm_pick',
        type: 'pickup',
        line_item_ids: ['li_1'],
        destinations: [
          { id: 'store_9', type: 'business_location' },
          { id: 'saved_x', type: 'shipping_address', street_address: '9 Elsewhere' },
        ],
      },
    ]);
    expect(
      checkUpdateFitsIntent(
        intent(),
        offered,
        body({ id: 'm_pick', selected_destination_id: 'saved_x' }),
      ),
    ).toEqual({ ok: false, reason: 'destination_not_offered' });
    expect(
      checkUpdateFitsIntent(
        intent(),
        offered,
        body({ id: 'm_pick', selected_destination_id: 'store_9' }),
      ),
    ).toEqual({ ok: true });
  });
});

describe('drift', () => {
  /** A merchant profile: the negotiation Dina derives from it is what the permit binds. */
  const profile = (over: { keys?: unknown[]; endpoint?: string; links?: unknown } = {}) => ({
    ucp: {
      version: V,
      services: {
        'dev.ucp.shopping': [
          {
            version: V,
            transport: 'mcp',
            endpoint: over.endpoint ?? 'https://shop.example/api/ucp/mcp',
          },
        ],
      },
      capabilities: {
        'dev.ucp.shopping.checkout': [
          { version: V, schema: `https://ucp.dev/${V}/schemas/shopping/checkout.json` },
        ],
        'dev.ucp.shopping.fulfillment': [
          {
            version: V,
            schema: `https://ucp.dev/${V}/schemas/shopping/fulfillment.json`,
            extends: 'dev.ucp.shopping.checkout',
          },
        ],
        'dev.ucp.shopping.discount': [
          {
            version: V,
            schema: `https://ucp.dev/${V}/schemas/shopping/discount.json`,
            extends: 'dev.ucp.shopping.checkout',
          },
        ],
      },
      payment_handlers: {},
      ...(over.links !== undefined ? { links: over.links } : {}),
    },
    keys: over.keys ?? [{ kid: 'k1', kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }],
  });
  function negotiated(value: unknown): NegotiatedState {
    const parsed = parseMerchantProfile(value);
    if (!parsed.ok) throw new Error(parsed.reason);
    const filtered = filterProfile(parsed.profile);
    const caps = intersectCapabilities(filtered.capabilities);
    return {
      version: parsed.profile.version,
      transport: 'mcp',
      endpoint: must(filtered.endpoints.mcp),
      capabilities: Object.fromEntries([...caps.values()].map((c) => [c.name, c.version])),
    };
  }

  it('a key rotation (and a new policy link) alone keeps the permit (§3.7 vector)', () => {
    const before = negotiated(profile());
    const i = intent({ capabilities: before.capabilities });
    expect(checkIntentDrift(i, before)).toEqual({ ok: true });
    const rotated = negotiated(
      profile({
        keys: [{ kid: 'k2', kty: 'EC', crv: 'P-256', x: 'c', y: 'd' }],
        links: [{ type: 'faq', url: 'https://shop.example/faq' }],
      }),
    );
    expect(checkIntentDrift(i, rotated)).toEqual({ ok: true });
    expect(
      checkIntentDrift(i, negotiated(profile({ endpoint: 'https://shop.example/mcp2' }))),
    ).toEqual({
      ok: false,
      reason: 'endpoint_changed',
    });
  });

  const state = {
    version: V,
    transport: 'mcp' as const,
    endpoint: 'https://shop.example/api/ucp/mcp',
    capabilities: { ...CAPS },
  };
  it.each([
    ['endpoint', { endpoint: 'https://shop.example/mcp2' }, 'endpoint_changed'],
    ['transport', { transport: 'rest' as const }, 'transport_changed'],
    ['version', { version: '2026-09-01' }, 'version_changed'],
    ['capabilities', { capabilities: { 'dev.ucp.shopping.checkout': V } }, 'capabilities_changed'],
  ])('a moved %s voids it', (_n, over, reason) => {
    expect(checkIntentDrift(intent(), { ...state, ...over })).toEqual({ ok: false, reason });
  });
});

describe('merchant identity', () => {
  it('is the origin of the root profile URL', () => {
    expect(merchantOriginOf('https://Shop.Example:443/.well-known/ucp')).toBe(
      'https://shop.example',
    );
    expect(merchantOriginOf('http://shop.example/.well-known/ucp')).toBeNull();
    expect(merchantOriginOf('https://u:p@shop.example/')).toBeNull();
  });
});
