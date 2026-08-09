/**
 * Catalog feed fetch policy (§10.3).
 *
 * The feed URL is supplier-controlled input aimed at our own network stack, so
 * these tests are mostly an attacker's list: every address form that reaches
 * somewhere it should not, and every way to make a fetcher do unbounded work.
 */

import {
  CATALOG_FEED_LIMITS,
  checkCatalogFeedContentType,
  checkCatalogFeedDecompression,
  checkCatalogFeedRedirect,
  checkCatalogFeedUrl,
  isBlockedAddress,
} from '../../src/commerce/catalog_feed_policy';

describe('feed URL policy', () => {
  it('accepts a plain HTTPS URL to a public host', () => {
    expect(checkCatalogFeedUrl('https://catalog.chairmaker.example/v1/snapshot.json')).toBeNull();
  });

  it.each([
    ['http', 'http://catalog.example/feed.json'],
    ['file', 'file:///etc/passwd'],
    ['ftp', 'ftp://catalog.example/feed.json'],
    ['gopher', 'gopher://catalog.example/1'],
    ['data', 'data:application/json,{}'],
  ])('refuses the %s scheme', (_label, url) => {
    // An allow-list of one scheme, not a deny-list: every other scheme is a
    // way to make a fetcher read something it should not.
    expect(checkCatalogFeedUrl(url)).toBe('not_https');
  });

  it('refuses credentials embedded in the URL', () => {
    expect(checkCatalogFeedUrl('https://user:secret@catalog.example/feed.json')).toBe(
      'credentials_in_url',
    );
  });

  it('refuses a malformed URL', () => {
    expect(checkCatalogFeedUrl('not a url')).toBe('unresolvable_shape');
  });

  it.each([
    ['loopback', 'https://127.0.0.1/feed.json'],
    ['loopback, decimal form', 'https://2130706433/feed.json'],
    ['private 10/8', 'https://10.0.0.5/feed.json'],
    ['private 172.16/12', 'https://172.20.1.1/feed.json'],
    ['private 192.168/16', 'https://192.168.1.1/feed.json'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['carrier-grade NAT', 'https://100.100.0.1/feed.json'],
    ['IPv6 loopback', 'https://[::1]/feed.json'],
    ['IPv6 unique-local', 'https://[fd00::1]/feed.json'],
    ['IPv6 link-local', 'https://[fe80::1]/feed.json'],
    ['IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]/feed.json'],
  ])('refuses a literal address in %s', (_label, url) => {
    expect(checkCatalogFeedUrl(url)).toBe('blocked_address');
  });

  it('cannot judge a NAME, which is why the connect-time check exists', () => {
    // `internal.corp` may resolve anywhere. The URL check passes it because a
    // name carries no address; a fetcher that stopped here would be wide open
    // to DNS rebinding.
    expect(checkCatalogFeedUrl('https://internal.corp/feed.json')).toBeNull();
    expect(isBlockedAddress('10.1.2.3')).toBe(true);
  });
});

describe('blocked addresses, checked against what was actually connected to', () => {
  it.each([
    '0.0.0.0',
    '127.0.0.1',
    '127.1.1.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.0.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:169.254.169.254',
    // What a real URL parser produces for `[::ffff:127.0.0.1]` — it
    // normalises the dotted tail to hex, so the mapped-form unwrap never
    // sees it and the conservative fallback is what blocks it. Worth pinning
    // separately: the two forms are caught by different code.
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '192.169.0.1', '2606:4700::1111'])(
    'allows the public address %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it('blocks anything it cannot parse rather than guessing', () => {
    // Fail closed: an address form we do not understand is not evidence that
    // it is safe to connect to.
    for (const junk of ['', '  ', 'not-an-address', '1.2.3', '1.2.3.4.5', '999.1.1.1']) {
      expect(isBlockedAddress(junk)).toBe(true);
    }
  });
});

describe('redirects', () => {
  it('validates the target exactly as the original URL', () => {
    // The whole attack: an allow-listed first URL that bounces to metadata.
    expect(checkCatalogFeedRedirect('https://169.254.169.254/latest/meta-data/', 0)).toBe(
      'blocked_address',
    );
    expect(checkCatalogFeedRedirect('http://catalog.example/feed.json', 0)).toBe('not_https');
  });

  it('accepts a legitimate hop under the cap', () => {
    expect(checkCatalogFeedRedirect('https://cdn.chairmaker.example/feed.json', 1)).toBeNull();
  });

  it('stops at the hop cap', () => {
    expect(
      checkCatalogFeedRedirect(
        'https://cdn.chairmaker.example/feed.json',
        CATALOG_FEED_LIMITS.maxRedirects,
      ),
    ).toBe('too_many_redirects');
  });
});

describe('content type', () => {
  it.each([
    ['application/json', true],
    ['application/json; charset=utf-8', true],
    ['APPLICATION/JSON', true],
    ['application/octet-stream', true],
    ['text/html', false],
    ['image/svg+xml', false],
    ['', false],
  ])('%s -> %s', (header, expected) => {
    expect(checkCatalogFeedContentType(header)).toBe(expected);
  });

  it('refuses a missing content type', () => {
    expect(checkCatalogFeedContentType(null)).toBe(false);
  });
});

describe('decompression bounds', () => {
  it('allows an ordinary compression ratio', () => {
    expect(checkCatalogFeedDecompression(1_000, 10_000)).toBeNull();
  });

  it('catches a bomb: small on the wire, vast in memory', () => {
    expect(checkCatalogFeedDecompression(1_000, 1_000_000)).toBe('ratio_exceeded');
  });

  it('catches a large archive that expands merely a lot', () => {
    // Ratio 2 is unremarkable; the absolute size is the problem. Both limits
    // are needed and neither implies the other.
    const big = CATALOG_FEED_LIMITS.maxDecompressedBytes + 1;
    expect(checkCatalogFeedDecompression(big, big * 2)).toBe('decompressed_cap_exceeded');
  });

  it('treats output from zero input as an infinite ratio', () => {
    expect(checkCatalogFeedDecompression(0, 1)).toBe('ratio_exceeded');
    expect(checkCatalogFeedDecompression(0, 0)).toBeNull();
  });

  it('is exact at the ratio boundary', () => {
    const ratio = CATALOG_FEED_LIMITS.maxDecompressionRatio;
    expect(checkCatalogFeedDecompression(100, 100 * ratio)).toBeNull();
    expect(checkCatalogFeedDecompression(100, 100 * ratio + 1)).toBe('ratio_exceeded');
  });
});
