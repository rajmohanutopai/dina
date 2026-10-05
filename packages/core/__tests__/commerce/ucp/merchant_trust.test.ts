/**
 * A UCP shop's PeerLens trust and the comparison order (UCP plan §3.7,
 * §4.2 U1): one reading for the owner's card (through Core) and Brain's tool.
 */

import {
  bestFirst,
  installUcpMerchantTrust,
  lookupMerchantTrust,
  merchantTrust,
  merchantTrustSubject,
  readMerchantTrust,
  type ResolveAnswer,
} from '../../../src/commerce/ucp/merchant_trust';

const A = 'https://a-shop.example';
const B = 'https://b-shop.example';

const answer = (recommendation: string, total: number): ResolveAnswer => ({
  trustLevel: 'x',
  recommendation,
  attestationSummary: total > 0 ? { total } : null,
});

afterEach(() => installUcpMerchantTrust(null));

describe('reading a shop’s trust', () => {
  it('rated, unrated (no reviews) and unavailable (an error, no answer, a stand-in’s no_data) are told apart', () => {
    expect(readMerchantTrust(answer('proceed', 3))).toEqual({
      state: 'rated',
      recommendation: 'proceed',
      level: 'x',
      reviews: 3,
    });
    expect(readMerchantTrust(answer('verify', 0))).toEqual({ state: 'unrated' });
    for (const none of [answer('error', 0), answer('no_data', 0), null]) {
      expect(readMerchantTrust(none)).toEqual({ state: 'unavailable' });
    }
    // An answer that does not read is no trust at all.
    expect(readMerchantTrust({ trustLevel: 1, recommendation: 7 })).toEqual({
      state: 'unavailable',
    });
  });

  it('advised against with no reviews (a removed or flagged shop) is never unrated', () => {
    expect(readMerchantTrust(answer('avoid', 0))).toEqual({
      state: 'rated',
      recommendation: 'avoid',
      level: 'x',
      reviews: 0,
    });
  });

  it('a lookup asks for the shop as an organization; one that fails or hangs is unavailable', async () => {
    const asked: string[] = [];
    expect(
      await lookupMerchantTrust(async (subject) => {
        asked.push(subject);
        return answer('caution', 2);
      }, A),
    ).toMatchObject({ state: 'rated', recommendation: 'caution' });
    expect(asked).toEqual([merchantTrustSubject(A)]);
    expect(JSON.parse(asked[0] as string)).toEqual({ type: 'organization', uri: A });
    expect(await lookupMerchantTrust(async () => Promise.reject(new Error('down')), A)).toEqual({
      state: 'unavailable',
    });
    expect(await lookupMerchantTrust(() => new Promise(() => undefined), A, 20)).toEqual({
      state: 'unavailable',
    });
  });

  it('with no lookup installed every shop is unavailable; installed, each shop once', async () => {
    expect(await merchantTrust([A, B])).toEqual(
      new Map([
        [A, { state: 'unavailable' }],
        [B, { state: 'unavailable' }],
      ]),
    );
    const asked: string[] = [];
    installUcpMerchantTrust(async (subject) => {
      asked.push(JSON.parse(subject).uri);
      return JSON.parse(subject).uri === A ? answer('proceed', 5) : answer('verify', 0);
    });
    const trust = await merchantTrust([A, B, A]);
    expect(asked).toEqual([A, B]);
    expect(trust.get(A)).toMatchObject({ state: 'rated', reviews: 5 });
    expect(trust.get(B)).toEqual({ state: 'unrated' });
  });
});

describe('the order', () => {
  it('best-trusted shop first; a shop advised against below shops with no rating; cheapest within a currency; a malformed price keeps the shop’s order', () => {
    const items = [
      { id: 'a', shop: 'bad', price: { amount: '100', currency: 'EUR' } },
      { id: 'b', shop: 'new', price: { amount: '12.5', currency: 'EUR' } },
      { id: 'c', shop: 'new', price: { amount: '300', currency: 'EUR' } },
      { id: 'd', shop: 'good', price: { amount: '900', currency: 'EUR' } },
      { id: 'e', shop: 'good', price: { amount: '50', currency: 'JPY' } },
      { id: 'f', shop: 'good', price: { amount: '400', currency: 'EUR' } },
    ];
    const trustOf = (shop: string) =>
      shop === 'good'
        ? ({ state: 'rated', recommendation: 'proceed', level: 'x', reviews: 4 } as const)
        : shop === 'bad'
          ? ({ state: 'rated', recommendation: 'avoid', level: 'x', reviews: 9 } as const)
          : ({ state: 'unrated' } as const);
    expect(
      bestFirst(
        items,
        (i) => i.shop,
        (i) => i.price,
        trustOf,
      ).map((i) => i.id),
    ).toEqual(['f', 'd', 'e', 'b', 'c', 'a']);
  });
});
