/**
 * Review round fixes (U6): network-specific NAT64 prefixes (RFC 6052, RFC
 * 7050), the request-header check, and the exact edges of every range.
 */
import {
  classifyAddress,
  IPV4_SPECIAL_RANGES,
  IPV6_SPECIAL_RANGES,
  isBlockedAddress,
  nat64PrefixesFrom,
  parseIPv6,
} from '../src/address';
import { bodyAllowed, requestHeadersAcceptable } from '../src/http';

const v4 = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
const v6 = (groups: number[]) => groups.map((g) => g.toString(16)).join(':');

describe('network-specific NAT64 prefixes', () => {
  type Length = 32 | 40 | 48 | 56 | 64 | 96;
  /** RFC 6052 §2.2: the IPv4 bytes' positions for each prefix length (byte 8 is the u octet, zero). */
  const POSITIONS: Record<Length, number[]> = {
    32: [4, 5, 6, 7],
    40: [5, 6, 7, 9],
    48: [6, 7, 9, 10],
    56: [7, 9, 10, 11],
    64: [9, 10, 11, 12],
    96: [12, 13, 14, 15],
  };
  /** Build the address carrying `ipv4` under `prefix` (test-side, independent of the code under test). */
  function embed(prefix: string, length: Length, ipv4: string): string {
    const bytes = (parseIPv6(prefix) as number[]).flatMap((g) => [g >> 8, g & 0xff]);
    for (let i = Math.ceil(length / 8); i < 16; i++) bytes[i] = 0;
    ipv4.split('.').forEach((o, k) => (bytes[POSITIONS[length][k] as number] = Number(o)));
    const groups = Array.from(
      { length: 8 },
      (_, k) => ((bytes[2 * k] as number) << 8) | (bytes[2 * k + 1] as number),
    );
    return v6(groups);
  }

  // RFC 6052 §2.4, Table 1: 192.0.2.33 under each prefix length.
  const RFC_TABLE: [Length, string, string][] = [
    [32, '2001:db8::', '2001:db8:c000:221::'],
    [40, '2001:db8:100::', '2001:db8:1c0:2:21::'],
    [48, '2001:db8:122::', '2001:db8:122:c000:2:2100::'],
    [56, '2001:db8:122:300::', '2001:db8:122:3c0:0:221::'],
    [64, '2001:db8:122:344::', '2001:db8:122:344:c0:2:2100:0'],
    [96, '2001:db8:122:344::', '2001:db8:122:344::c000:221'],
  ];

  it.each(RFC_TABLE)(
    'the test helper reproduces RFC 6052 Table 1 at /%i',
    (length, prefix, expected) => {
      expect(parseIPv6(embed(prefix, length, '192.0.2.33'))).toEqual(parseIPv6(expected));
    },
  );

  it.each(RFC_TABLE)(
    'discovers the /%i prefix from an ipv4only.arpa answer (RFC 7050)',
    (length, prefix) => {
      expect(nat64PrefixesFrom([embed(prefix, length, '192.0.0.170')])).toEqual([
        { groups: parseIPv6(prefix), length },
      ]);
      expect(nat64PrefixesFrom([embed(prefix, length, '192.0.0.171')])).toEqual([
        { groups: parseIPv6(prefix), length },
      ]);
    },
  );

  // A carrier prefix inside global unicast, at each length.
  const CARRIER: [Length, string][] = [
    [32, '2a00:1450::'],
    [40, '2a00:1450:6400::'],
    [48, '2a00:1450:64::'],
    [56, '2a00:1450:64:100::'],
    [64, '2a00:1450:64:1::'],
    [96, '2a00:1450:64:1::'],
  ];

  it.each(CARRIER)(
    'under a discovered /%i carrier prefix, judges each address by the IPv4 inside',
    (length, prefix) => {
      const prefixes = nat64PrefixesFrom([embed(prefix, length, '192.0.0.170')]);
      expect(prefixes).toHaveLength(1);
      for (const inner of [
        '10.0.0.1',
        '127.0.0.1',
        '169.254.169.254',
        '192.168.1.1',
        '100.64.0.1',
      ]) {
        const synthesised = embed(prefix, length, inner);
        expect(isBlockedAddress(synthesised, { nat64Prefixes: prefixes })).toBe(true);
      }
      expect(
        classifyAddress(embed(prefix, length, '10.0.0.1'), { nat64Prefixes: prefixes }),
      ).toMatchObject({
        name: 'private-in-nat64',
      });
      expect(isBlockedAddress(embed(prefix, length, '8.8.8.8'), { nat64Prefixes: prefixes })).toBe(
        false,
      );
    },
  );

  it('without discovery a carrier-synthesised private address looks like plain global unicast (why discovery is needed)', () => {
    expect(isBlockedAddress(embed('2a00:1450:64:1::', 96, '10.0.0.1'))).toBe(false);
  });

  it('finds nothing on a network without NAT64 (plain IPv4 answers) or from junk', () => {
    expect(nat64PrefixesFrom(['192.0.0.170', '192.0.0.171'])).toEqual([]);
    expect(nat64PrefixesFrom(['not-an-address', '2001:4860::1'])).toEqual([]);
  });
});

describe('request headers', () => {
  it.each([
    [
      'a token name and visible ASCII',
      { 'ucp-agent': 'profile="https://p.example/x"', 'idempotency-key': 'k' },
      true,
    ],
    ['a tab and spaces', { 'x-a': 'a\tb c' }, true],
    ['CRLF in a value', { authorization: 'Bearer a\r\nX-Injected: 1' }, false],
    ['a bare LF', { authorization: 'a\nb' }, false],
    ['NUL', { 'x-a': 'a\u0000b' }, false],
    ['non-ASCII', { 'x-a': 'café' }, false],
    ['DEL', { 'x-a': 'a\u007fb' }, false],
    ['a name with a space', { 'x a': 'v' }, false],
    ['a name with a colon', { 'x:a': 'v' }, false],
  ])('%s → %s', (_n, headers, ok) => {
    expect(requestHeadersAcceptable(headers)).toBe(ok);
  });

  it('allows a body on POST, PUT and DELETE, never on GET', () => {
    const body = new Uint8Array(1);
    expect(bodyAllowed({ method: 'GET', body })).toBe(false);
    expect(bodyAllowed({ method: 'GET' })).toBe(true);
    for (const method of ['POST', 'PUT', 'DELETE'] as const)
      expect(bodyAllowed({ method, body })).toBe(true);
  });
});

describe('the exact edges of every range', () => {
  const blockedByAnother4 = (n: number) =>
    IPV4_SPECIAL_RANGES.some(
      (r) => Math.floor(n / 2 ** (32 - r.bits)) === Math.floor(r.base / 2 ** (32 - r.bits)),
    );

  it.each(IPV4_SPECIAL_RANGES.map((r) => [r.cidr, r]))(
    'IPv4 %s: last address blocked, neighbours outside allowed',
    (_c, r) => {
      const size = 2 ** (32 - r.bits);
      expect(isBlockedAddress(v4(r.base + size - 1))).toBe(true);
      for (const n of [r.base - 1, r.base + size]) {
        if (n < 0 || n > 0xffffffff) continue;
        expect(isBlockedAddress(v4(n))).toBe(blockedByAnother4(n));
      }
    },
  );

  /** 128-bit arithmetic on 8 groups. */
  const toBig = (g: readonly number[]) => g.reduce((a, x) => (a << 16n) | BigInt(x), 0n);
  const fromBig = (n: bigint) =>
    Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(16 * (7 - i))) & 0xffffn));

  it.each(IPV6_SPECIAL_RANGES.map((r) => [r.cidr, r]))(
    'IPv6 %s: last address blocked, neighbours outside allowed',
    (_c, r) => {
      const base = toBig(r.groups);
      const size = 1n << BigInt(128 - r.bits);
      expect(isBlockedAddress(v6(fromBig(base + size - 1n)))).toBe(true);
      for (const n of [base - 1n, base + size]) {
        const addr = v6(fromBig(n));
        const inAnother = IPV6_SPECIAL_RANGES.some(
          (o) => o !== r && toBig(o.groups) >> BigInt(128 - o.bits) === n >> BigInt(128 - o.bits),
        );
        // Neighbours inside 2000::/3 and outside every listed range are ordinary global unicast.
        expect(isBlockedAddress(addr)).toBe(inAnother);
      }
    },
  );
});
