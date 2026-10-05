import { buildPermalink, itemIdToken } from '../src/permalink';

describe('permalinks', () => {
  it('uses a raw token when the id fits, and ~base64url otherwise (the spec example)', () => {
    expect(itemIdToken('sku_123')).toBe('sku_123');
    expect(itemIdToken('gid://shopify/ProductVariant/70881412')).toBe(
      '~Z2lkOi8vc2hvcGlmeS9Qcm9kdWN0VmFyaWFudC83MDg4MTQxMg',
    );
    for (const id of ['a/b', 'a:b', 'a,b', 'a%2F', 'a~b', 'a b', 'café'])
      expect(itemIdToken(id).startsWith('~')).toBe(true);
  });
  it('builds endpoint/{id:qty,...} with no query and no personal data', () => {
    expect(
      buildPermalink('https://merchant.example/buy', [
        { itemId: 'sku_123', quantity: 2n },
        { itemId: 'gid://shopify/ProductVariant/70881412', quantity: 1n },
      ]),
    ).toEqual({
      ok: true,
      url: 'https://merchant.example/buy/sku_123:2,~Z2lkOi8vc2hvcGlmeS9Qcm9kdWN0VmFyaWFudC83MDg4MTQxMg:1',
    });
  });
  it.each([
    ['trailing slash', 'https://m.example/buy/'],
    ['query', 'https://m.example/buy?x=1'],
    ['userinfo', 'https://u@m.example/buy'],
    ['http', 'http://m.example/buy'],
    ['fragment', 'https://m.example/buy#x'],
  ])('refuses an endpoint with %s', (_n, endpoint) => {
    expect(buildPermalink(endpoint, [{ itemId: 'a', quantity: 1n }])).toEqual({
      ok: false,
      reason: 'bad_endpoint',
    });
  });
  it('refuses no lines, a zero quantity, an empty id, and a link over 2,048 bytes', () => {
    const ep = 'https://m.example/buy';
    expect(buildPermalink(ep, [])).toEqual({ ok: false, reason: 'no_lines' });
    expect(buildPermalink(ep, [{ itemId: 'a', quantity: 0n }])).toEqual({
      ok: false,
      reason: 'bad_quantity',
    });
    expect(buildPermalink(ep, [{ itemId: '', quantity: 1n }])).toEqual({
      ok: false,
      reason: 'empty_id',
    });
    const many = Array.from({ length: 200 }, (_, i) => ({
      itemId: `sku_${i}_long_identifier`,
      quantity: 1n,
    }));
    expect(buildPermalink(ep, many)).toEqual({ ok: false, reason: 'too_long' });
  });
});
