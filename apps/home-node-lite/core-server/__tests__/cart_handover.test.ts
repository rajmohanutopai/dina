/**
 * cart_handover tests.
 */

import {
  CartHandoverError,
  buildCartHandover,
  type CartHandoverInput,
  type CartItem,
} from '../src/brain/cart_handover';

function item(overrides: Partial<CartItem> = {}): CartItem {
  return {
    sku: 'sku-1',
    quantity: 1,
    ...overrides,
  };
}

function input(overrides: Partial<CartHandoverInput> = {}): CartHandoverInput {
  return {
    merchant: { id: 'chairmaker.shop', baseUrl: 'https://chairmaker.shop/cart' },
    items: [item()],
    ...overrides,
  };
}

describe('buildCartHandover — merchant validation', () => {
  it.each([
    ['null merchant', { ...input(), merchant: null as unknown as CartHandoverInput['merchant'] }],
    ['missing id', { ...input(), merchant: { baseUrl: 'https://x' } as CartHandoverInput['merchant'] }],
    ['missing baseUrl', { ...input(), merchant: { id: 'x' } as CartHandoverInput['merchant'] }],
    ['empty id', { ...input(), merchant: { id: '', baseUrl: 'https://x' } }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() => buildCartHandover(bad as CartHandoverInput)).toThrow(CartHandoverError);
  });

  it('rejects non-http baseUrl', () => {
    expect(() =>
      buildCartHandover(input({ merchant: { id: 'm', baseUrl: 'ftp://x' } })),
    ).toThrow(/invalid_merchant_url/);
  });

  it('rejects malformed baseUrl', () => {
    expect(() =>
      buildCartHandover(input({ merchant: { id: 'm', baseUrl: 'not-a-url' } })),
    ).toThrow(CartHandoverError);
  });
});

describe('buildCartHandover — items validation', () => {
  it('rejects empty items array', () => {
    expect(() => buildCartHandover(input({ items: [] }))).toThrow(/empty_items/);
  });

  it.each([
    ['missing sku', { quantity: 1 }],
    ['empty sku', { sku: '', quantity: 1 }],
    ['zero quantity', { sku: 'x', quantity: 0 }],
    ['negative quantity', { sku: 'x', quantity: -1 }],
    ['fraction quantity', { sku: 'x', quantity: 1.5 }],
  ] as const)('rejects item with %s', (_l, bad) => {
    expect(() =>
      buildCartHandover(input({ items: [bad as unknown as CartItem] })),
    ).toThrow(/invalid_item/);
  });

  it('rejects unitPriceMinor without currency', () => {
    expect(() =>
      buildCartHandover(
        input({ items: [item({ unitPriceMinor: 100 })] }),
      ),
    ).toThrow(/currency/);
  });

  it('rejects negative unitPriceMinor', () => {
    expect(() =>
      buildCartHandover(
        input({ items: [item({ unitPriceMinor: -1, currency: 'USD' })] }),
      ),
    ).toThrow(/non-negative/);
  });

  it('rejects mixed currencies across items', () => {
    expect(() =>
      buildCartHandover(
        input({
          items: [
            item({ sku: 'a', unitPriceMinor: 100, currency: 'USD' }),
            item({ sku: 'b', unitPriceMinor: 200, currency: 'EUR' }),
          ],
        }),
      ),
    ).toThrow(/mixed_currencies/);
  });
});

describe('buildCartHandover — returnUrl validation', () => {
  it('rejects non-http returnUrl', () => {
    expect(() =>
      buildCartHandover(input({ returnUrl: 'javascript:alert(1)' })),
    ).toThrow(/invalid_return_url/);
  });

  it('rejects malformed returnUrl', () => {
    expect(() =>
      buildCartHandover(input({ returnUrl: 'not a url' })),
    ).toThrow(CartHandoverError);
  });
});

describe('buildCartHandover — happy path payload', () => {
  it('produces a payload with version + merchantId + items', () => {
    const r = buildCartHandover(
      input({
        items: [item({ sku: 'chair-1', quantity: 2 })],
      }),
    );
    expect(r.payload.version).toBe('1');
    expect(r.payload.merchantId).toBe('chairmaker.shop');
    expect(r.payload.items).toEqual([{ sku: 'chair-1', quantity: 2 }]);
  });

  it('echoes coupon + returnUrl + memo when supplied', () => {
    const r = buildCartHandover(
      input({
        coupon: 'SUMMER10',
        returnUrl: 'https://client.example/cart-back',
        memo: 'Dina picked these for you',
      }),
    );
    expect(r.payload.coupon).toBe('SUMMER10');
    expect(r.payload.returnUrl).toBe('https://client.example/cart-back');
    expect(r.payload.memo).toBe('Dina picked these for you');
  });

  it('optional fields are OMITTED (not undefined) when absent', () => {
    const r = buildCartHandover(input());
    expect(r.payload).not.toHaveProperty('coupon');
    expect(r.payload).not.toHaveProperty('returnUrl');
    expect(r.payload).not.toHaveProperty('memo');
  });

  it('items are defensively copied — mutating output does not affect input', () => {
    const items: CartItem[] = [item({ sku: 'a', quantity: 1 })];
    const r = buildCartHandover(input({ items }));
    r.payload.items[0]!.quantity = 99;
    expect(items[0]!.quantity).toBe(1);
  });
});

describe('buildCartHandover — URL construction', () => {
  it('URL carries dina_cart + handover_id + items params', () => {
    const r = buildCartHandover(
      input({
        items: [
          item({ sku: 'a', quantity: 2 }),
          item({ sku: 'b', quantity: 1 }),
        ],
      }),
    );
    const url = new URL(r.url);
    expect(url.searchParams.get('dina_cart')).toBe('1');
    expect(url.searchParams.get('handover_id')).toBe(r.payload.handoverId);
    expect(url.searchParams.get('items')).toBe('a:2,b:1');
  });

  it('URL preserves merchant baseUrl path + host', () => {
    const r = buildCartHandover(
      input({
        merchant: {
          id: 'm',
          baseUrl: 'https://shop.example.com/custom/cart',
        },
      }),
    );
    const url = new URL(r.url);
    expect(url.hostname).toBe('shop.example.com');
    expect(url.pathname).toBe('/custom/cart');
  });

  it('URL includes coupon when present', () => {
    const r = buildCartHandover(input({ coupon: 'SAVE10' }));
    const url = new URL(r.url);
    expect(url.searchParams.get('coupon')).toBe('SAVE10');
  });

  it('URL includes return_url when present', () => {
    const r = buildCartHandover(input({ returnUrl: 'https://back.example' }));
    const url = new URL(r.url);
    expect(url.searchParams.get('return_url')).toBe('https://back.example');
  });

  it('URL does NOT expose memo (payload only)', () => {
    const r = buildCartHandover(input({ memo: 'private memo' }));
    const url = new URL(r.url);
    expect(url.searchParams.get('memo')).toBeNull();
  });
});

describe('buildCartHandover — totals', () => {
  it('computes subtotal when every item has price', () => {
    const r = buildCartHandover(
      input({
        items: [
          item({ sku: 'a', quantity: 2, unitPriceMinor: 1000, currency: 'USD' }),
          item({ sku: 'b', quantity: 1, unitPriceMinor: 500, currency: 'USD' }),
        ],
      }),
    );
    expect(r.totals).toEqual({
      currency: 'USD',
      subtotalMinor: 2500,
      itemCount: 3,
    });
  });

  it('totals null when any item is unpriced', () => {
    const r = buildCartHandover(
      input({
        items: [
          item({ sku: 'a', quantity: 2, unitPriceMinor: 1000, currency: 'USD' }),
          item({ sku: 'b', quantity: 1 }), // no price
        ],
      }),
    );
    expect(r.totals).toBeNull();
  });

  it('totals null when no prices at all', () => {
    const r = buildCartHandover(input());
    expect(r.totals).toBeNull();
  });
});

describe('buildCartHandover — handoverId', () => {
  it('derives deterministic handoverId when not supplied', () => {
    const a = buildCartHandover(input());
    const b = buildCartHandover(input());
    expect(a.payload.handoverId).toBe(b.payload.handoverId);
    expect(a.payload.handoverId).toMatch(/^cart-[0-9a-f]{8}$/);
  });

  it('different items → different deterministic id', () => {
    const a = buildCartHandover(input({ items: [item({ sku: 'a' })] }));
    const b = buildCartHandover(input({ items: [item({ sku: 'b' })] }));
    expect(a.payload.handoverId).not.toBe(b.payload.handoverId);
  });

  it('explicit handoverId overrides derivation', () => {
    const r = buildCartHandover(input({ handoverId: 'custom-id-123' }));
    expect(r.payload.handoverId).toBe('custom-id-123');
  });

  it('empty explicit handoverId falls back to derivation', () => {
    const r = buildCartHandover(input({ handoverId: '  ' }));
    expect(r.payload.handoverId).toMatch(/^cart-[0-9a-f]{8}$/);
  });
});

describe('buildCartHandover — payload + URL symmetry', () => {
  it('URL items mirror payload items', () => {
    const r = buildCartHandover(
      input({
        items: [
          item({ sku: 'alpha', quantity: 3 }),
          item({ sku: 'beta', quantity: 2 }),
        ],
      }),
    );
    const url = new URL(r.url);
    const skuParts = url.searchParams.get('items')!.split(',');
    const payloadParts = r.payload.items.map((i) => `${i.sku}:${i.quantity}`);
    expect(skuParts).toEqual(payloadParts);
  });
});
