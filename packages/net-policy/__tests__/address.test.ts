import {
  classifyAddress,
  IPV4_SPECIAL_RANGES,
  IPV6_SPECIAL_RANGES,
  isBlockedAddress,
  parseIPv4,
  parseIPv6,
} from '../src/address';

const v4 = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');

describe('IPv4 special-purpose registry', () => {
  it.each(IPV4_SPECIAL_RANGES.map((r) => [r.cidr, r]))(
    '%s: first and last address blocked',
    (_c, r) => {
      const size = 2 ** (32 - r.bits);
      expect(classifyAddress(v4(r.base))).toMatchObject({ blocked: true, range: r.cidr });
      // The last address may fall in a more specific nested entry
      // (255.255.255.255 inside 240.0.0.0/4).
      expect(classifyAddress(v4(r.base + size - 1))).toMatchObject({ blocked: true });
    },
  );

  it.each([
    ['198.17.255.255', false],
    ['198.18.0.0', true],
    ['198.19.255.255', true],
    ['198.20.0.0', false],
    ['100.63.255.255', false],
    ['100.128.0.0', false],
    ['172.15.255.255', false],
    ['172.32.0.0', false],
    ['192.0.1.255', false],
    ['192.0.3.0', false],
    ['223.255.255.255', false],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
  ])('neighbour %s blocked=%s', (addr, blocked) => {
    expect(isBlockedAddress(addr)).toBe(blocked);
  });

  it('blocks the plan-named gaps in the old filter', () => {
    for (const a of [
      '198.18.0.1',
      '198.51.100.7',
      '203.0.113.9',
      '2001:2::1',
      '2001:db8::1',
      '2002:7f00:1::1',
    ]) {
      expect(isBlockedAddress(a)).toBe(true);
    }
  });
});

describe('IPv6', () => {
  it.each(IPV6_SPECIAL_RANGES.map((r) => [r.cidr, r]))('%s blocked', (_c, r) => {
    expect(classifyAddress(r.cidr.split('/')[0] as string)).toMatchObject({ blocked: true });
  });

  it.each([
    ['::', 'not-global-unicast'],
    ['::1', 'not-global-unicast'],
    ['fe80::1', 'not-global-unicast'],
    ['fc00::1', 'not-global-unicast'],
    ['fd12:3456::1', 'not-global-unicast'],
    ['ff02::1', 'not-global-unicast'],
    ['100::1', 'not-global-unicast'],
    ['5f00::1', 'not-global-unicast'],
    ['fec0::1', 'not-global-unicast'],
    ['::127.0.0.1', 'not-global-unicast'],
    ['2001::1', 'ietf-protocol-assignments'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'ietf-protocol-assignments'],
    ['64:ff9b:1::a00:1', 'nat64-local-use'],
  ])('%s is %s', (addr, name) => {
    expect(classifyAddress(addr)).toMatchObject({ blocked: true, name });
  });

  it('allows ordinary global unicast', () => {
    for (const a of [
      '2606:4700:4700::1111',
      '2a00:1450:4001:81b::200e',
      '2400:cb00::1',
      '[2606:4700::1]',
    ]) {
      expect(classifyAddress(a)).toEqual({ blocked: false, family: 6 });
    }
  });

  it('judges IPv4-mapped, NAT64 and 6to4 addresses by the IPv4 inside', () => {
    expect(classifyAddress('::ffff:127.0.0.1')).toMatchObject({
      blocked: true,
      name: 'loopback-in-ipv6',
    });
    expect(classifyAddress('::ffff:7f00:1')).toMatchObject({
      blocked: true,
      name: 'loopback-in-ipv6',
    });
    expect(classifyAddress('::ffff:169.254.169.254')).toMatchObject({
      blocked: true,
      name: 'link-local-in-ipv6',
    });
    expect(classifyAddress('::ffff:8.8.8.8')).toEqual({ blocked: false, family: 6 });
    expect(classifyAddress('64:ff9b::10.0.0.1')).toMatchObject({
      blocked: true,
      name: 'private-in-ipv6',
    });
    expect(classifyAddress('64:ff9b::808:808')).toEqual({ blocked: false, family: 6 });
    expect(classifyAddress('2002:7f00:1::1')).toMatchObject({
      blocked: true,
      name: 'loopback-in-6to4',
    });
    expect(classifyAddress('2002:c612:1::1')).toMatchObject({
      blocked: true,
      name: 'benchmarking-in-6to4',
    });
    expect(classifyAddress('2002:808:808::1')).toEqual({ blocked: false, family: 6 });
  });
});

describe('parsing fails closed', () => {
  it.each([
    '',
    'localhost',
    '1.2.3',
    '1.2.3.4.5',
    '01.2.3.4',
    '1.2.3.256',
    '0x7f.0.0.1',
    '2130706433',
    ' 1.2.3.4x',
    '1:2:3:4:5:6:7:8:9',
    '1::2::3',
    '12345::1',
    'fe80::1%en0',
    '::ffff:1.2.3',
    '2001:db8::g',
    '1:2:3:4:5:6:7:8::',
  ])('blocks %p', (addr) => {
    expect(classifyAddress(addr)).toMatchObject({ blocked: true });
  });

  it('parses the RFC 4291 text forms', () => {
    expect(parseIPv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6('1::')).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6('1:2:3:4:5:6:1.2.3.4')).toEqual([1, 2, 3, 4, 5, 6, 0x0102, 0x0304]);
    expect(parseIPv6('2001:DB8:0:0:0:0:0:1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv4('255.255.255.255')).toBe(0xffffffff);
  });
});
