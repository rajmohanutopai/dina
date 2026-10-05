/**
 * The plan-named gaps in the old filter (UCP plan §3.3), checked against the
 * isBlockedAddress every Core consumer imports (the catalogue fetcher, the
 * A2A server transport): it is now @dina/net-policy's classifier.
 */
import { isBlockedAddress } from '../../../src/commerce/catalog_feed_policy';

describe("Core's isBlockedAddress", () => {
  it.each([
    ['benchmarking', '198.18.0.1'],
    ['documentation (TEST-NET-2)', '198.51.100.7'],
    ['documentation (TEST-NET-3)', '203.0.113.9'],
    ['IETF protocol assignments (benchmarking v6)', '2001:2::1'],
    ['IPv6 documentation', '2001:db8::1'],
    ['6to4 wrapping loopback', '2002:7f00:1::1'],
  ])('refuses %s (%s), which the old filter let through', (_n, address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });
  it('still allows ordinary public addresses', () => {
    for (const a of ['8.8.8.8', '203.0.114.10', '2606:4700:4700::1111'])
      expect(isBlockedAddress(a)).toBe(false);
  });
});
