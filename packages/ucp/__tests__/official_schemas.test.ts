/**
 * Cross-check against the official `@ucp-js/sdk` Zod schemas (0.5.x =
 * v2026-08-25; a test-only dev dependency, plan §3.6 and §3.19 step 1):
 * every body Dina builds, Dina's own profile, and every harvested spec fixture
 * that Dina reads must pass the official schemas too. The two checks are
 * independent: Dina's readers are hand-written, the SDK is generated from the
 * spec's JSON Schemas.
 */
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as sdk from '@ucp-js/sdk';

import { buildCreateCartBody, buildUpdateCartBody, readCart } from '../src/cart';
import { buildGetProductRequest, buildLookupRequest, buildSearchRequest } from '../src/catalog';
import { buildUpdateCheckoutBody, readCheckout } from '../src/checkout';
import { buildCreateCheckoutBody, type CheckoutIntent } from '../src/intent';
import { es256PublicJwk } from '../src/jwk';
import { buildBuyerProfile } from '../src/profile';

import { classify, SPEC_EXAMPLES, type SpecExample } from './spec_fixture';

interface Schema {
  safeParse(v: unknown): { success: boolean; error?: { issues: unknown[] } };
}

function expectValid(schema: Schema, value: unknown): void {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(JSON.stringify(r.error?.issues.slice(0, 3)));
}

const V = '2026-08-25';
const intent: CheckoutIntent = {
  merchantOrigin: 'https://shop.example',
  version: V,
  transport: 'mcp',
  endpoint: 'https://shop.example/mcp',
  capabilities: {
    'dev.ucp.shopping.checkout': V,
    'dev.ucp.shopping.fulfillment': V,
    'dev.ucp.shopping.discount': V,
  },
  lines: [
    { itemId: 'gid://shopify/ProductVariant/1', quantity: 2n },
    {
      itemId: 'apples',
      quantity: 1500n,
      unit: { unit: 'KGM', scale: 3, displayText: 'kg', increment: 1 },
    },
  ],
  discountCodes: ['SAVE10'],
  context: { address_country: 'US', address_region: 'CA', language: 'en' },
  buyer: { email: 'a@b.example' },
  shippingAddress: {
    street_address: '1 Main St',
    address_locality: 'Springfield',
    address_country: 'US',
    postal_code: '12345',
  },
};

/** The body without `fulfillment`, which the SDK cannot check (below). */
function withoutFulfillment(body: Record<string, unknown>): Record<string, unknown> {
  const { fulfillment: _f, ...rest } = body;
  return rest;
}

describe('the SDK cannot check fulfillment requests (a known 0.5.1 defect)', () => {
  // The SDK's generator ignores the `ucp_request` annotations inside the
  // fulfillment types: its create and update method schemas are the response
  // shape (id and line_item_ids required), and it merged the destination type
  // with binding.json's reverse-domain pattern. The spec's own platform request
  // examples fail it. Dina follows the JSON Schemas and those examples; this
  // test fails if a later SDK fixes the defect, so the check can be restored.
  it("rejects the spec's own pickup request example (fulfillment.md:318)", () => {
    const specExample = {
      type: 'pickup',
      line_item_ids: ['shirt', 'pants'],
      selected_destination_id: 'loc_downtown',
    };
    expect(sdk.FulfillmentMethodCreateRequestSchema.safeParse(specExample).success).toBe(false);
  });
  it('rejects a well-known destination type', () => {
    expect(
      sdk.DestinationElementSchema.safeParse({ id: 'd', type: 'shipping_address' }).success,
    ).toBe(false);
  });
});

describe('requests Dina builds pass the official request schemas', () => {
  it('create_checkout, with discount (fulfillment checked by Dina against the spec, above)', () => {
    const body = buildCreateCheckoutBody(intent);
    expect(body.fulfillment).toBeDefined();
    expectValid(sdk.CheckoutCreateRequestSchema, withoutFulfillment(body));
    expectValid(sdk.CheckoutWithDiscountCreateRequestSchema, withoutFulfillment(body));
  });

  it('update_checkout, choosing an option', () => {
    const last = readCheckout({
      ucp: { version: V },
      id: 'c',
      status: 'incomplete',
      currency: 'USD',
      line_items: [
        {
          id: 'l1',
          item: { id: 'gid://shopify/ProductVariant/1', title: 'T', price: 1 },
          quantity: 2,
          totals: [],
        },
        { id: 'l2', item: { id: 'apples', title: 'A', price: 1 }, quantity: 1500, totals: [] },
      ],
      totals: [
        { type: 'subtotal', amount: 2 },
        { type: 'total', amount: 2 },
      ],
      fulfillment: {
        methods: [
          {
            id: 'm',
            type: 'shipping',
            line_item_ids: ['l1', 'l2'],
            groups: [
              {
                id: 'g',
                line_item_ids: ['l1', 'l2'],
                options: [{ id: 'o', title: 'Std', totals: [] }],
              },
            ],
          },
        ],
      },
    });
    if (!last.ok) throw new Error(last.reason);
    const body = buildUpdateCheckoutBody(intent, last.value, {
      methodId: 'm',
      options: { g: 'o' },
    });
    expect(body.fulfillment).toBeDefined();
    expectValid(sdk.CheckoutUpdateRequestSchema, withoutFulfillment(body));
    expectValid(sdk.CheckoutWithDiscountUpdateRequestSchema, withoutFulfillment(body));
  });

  it('create_cart and update_cart', () => {
    expectValid(sdk.CartCreateRequestSchema, buildCreateCartBody(intent.lines, intent.context));
    const cart = readCart(
      SPEC_EXAMPLES.find((e) => e.source === 'scaffolds/shopping_cart_response.json')?.value,
    );
    if (!cart.ok) throw new Error(cart.reason);
    expectValid(
      sdk.CartUpdateRequestSchema,
      buildUpdateCartBody(intent.lines, intent.context, cart.value),
    );
  });

  it('search, lookup and get_product', () => {
    expectValid(
      sdk.SearchRequestSchema,
      buildSearchRequest({ query: 'tea', context: intent.context, cursor: 'c1' }),
    );
    expectValid(sdk.LookupRequestSchema, buildLookupRequest(['a', 'b'], intent.context));
    expectValid(sdk.GetProductRequestSchema, buildGetProductRequest('p', intent.context));
  });
});

describe("Dina's profile passes the official profile schema", () => {
  it('as a platform profile document', () => {
    const point = p256.getPublicKey(new Uint8Array(32).fill(3), false);
    const profile = buildBuyerProfile({
      keys: [es256PublicJwk(point, sha256)],
      webhookUrl: 'https://abcdefghijklmnopqrstuvwxyz.ucp.dinakernel.com/webhooks/orders',
    });
    expectValid(sdk.UcpProfileDocumentSchema, profile);
  });
});

/** The official schema for a fixture of each kind Dina reads. */
function sdkSchemaFor(e: SpecExample): string | null {
  switch (classify(e)) {
    case 'checkout':
      return 'CheckoutResponseSchema';
    case 'cart':
      return 'CartResponseSchema';
    case 'order':
      return 'OrderSchema';
    case 'product_detail':
      return 'GetProductResponseSchema';
    case 'error_response':
      return 'ErrorResponseSchema';
    case 'profile':
      return 'UcpProfileDocumentSchema';
    case 'product_list':
      return /search/.test(`${e.source} ${JSON.stringify(e.annotation ?? {})}`)
        ? 'SearchResponseSchema'
        : 'LookupResponseSchema';
    default:
      return null;
  }
}

/**
 * Fixtures the SDK 0.5.1 wrongly refuses, each with the spec text that shows
 * the SDK is the one in error. The test fails if one starts passing, so the
 * list cannot outlive the defect.
 */
const SDK_KNOWN_FAILURES: Record<string, string> = {
  // ucp.json $defs/map_order is an object of string arrays; the SDK types it as a string.
  'scaffolds/profile_response.json': 'map_order',
};

describe('every fixture Dina reads passes the official response schemas', () => {
  const checked = SPEC_EXAMPLES.flatMap((e) => {
    const schema = sdkSchemaFor(e);
    return schema === null ? [] : [[e.source, schema, e] as const];
  });

  it('covers every readable fixture (not a sample)', () => {
    expect(checked.length).toBeGreaterThanOrEqual(80);
  });

  it.each(checked)('%s → %s', (source, schema, e) => {
    const result = (sdk as unknown as Record<string, Schema>)[schema]?.safeParse(e.value);
    if (SDK_KNOWN_FAILURES[source] !== undefined) {
      expect(result?.success).toBe(false);
      expect(JSON.stringify(result?.error?.issues)).toContain(SDK_KNOWN_FAILURES[source]);
    } else {
      expectValid((sdk as unknown as Record<string, Schema>)[schema] as Schema, e.value);
    }
  });
});
