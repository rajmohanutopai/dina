/**
 * The special-use address classifier (UCP plan §3.3).
 *
 * UCP says implementations "MUST reject URLs that resolve to special-use IP
 * addresses" (overview/index.md:2296-2304). This refuses every range in the
 * IANA IPv4 and IPv6 Special-Purpose Address Registries, plus IPv4 multicast,
 * and allows IPv6 only inside global unicast (2000::/3). Addresses that carry
 * an IPv4 address inside them are judged by that address: IPv4-mapped
 * (::ffff:0:0/96), the well-known NAT64 prefix (64:ff9b::/96, which iOS
 * synthesises on IPv6-only networks), 6to4 (2002::/16), and any
 * network-specific NAT64 prefix the caller discovered (`nat64PrefixesFrom`).
 *
 * It is the one classifier for every outbound fetch (UCP, A2A, catalogue
 * feeds), on the server socket and the phone's native transport alike. It
 * judges the address actually connected to, so it fails closed: anything it
 * cannot parse is blocked.
 */

export type AddressVerdict =
  | { blocked: false; family: 4 | 6 }
  | { blocked: true; range: string; name: string };

interface Range4 {
  base: number;
  bits: number;
  cidr: string;
  name: string;
}

function range4(cidr: string, name: string): Range4 {
  const [addr, bits] = cidr.split('/') as [string, string];
  const base = parseIPv4(addr);
  if (base === null) throw new Error(`net-policy: bad range ${cidr}`);
  return { base, bits: Number(bits), cidr, name };
}

/**
 * IANA IPv4 Special-Purpose Address Registry (every entry, whatever its
 * "globally reachable" column says: no merchant or agent endpoint lives in
 * them), plus multicast (224.0.0.0/4), which has its own registry.
 */
export const IPV4_SPECIAL_RANGES: readonly Range4[] = [
  range4('0.0.0.0/8', 'this-network'),
  range4('10.0.0.0/8', 'private'),
  range4('100.64.0.0/10', 'shared-address-space'),
  range4('127.0.0.0/8', 'loopback'),
  range4('169.254.0.0/16', 'link-local'),
  range4('172.16.0.0/12', 'private'),
  range4('192.0.0.0/24', 'ietf-protocol-assignments'),
  range4('192.0.2.0/24', 'documentation'),
  range4('192.31.196.0/24', 'as112'),
  range4('192.52.193.0/24', 'amt'),
  range4('192.88.99.0/24', '6to4-relay-anycast'),
  range4('192.168.0.0/16', 'private'),
  range4('192.175.48.0/24', 'as112-direct-delegation'),
  range4('198.18.0.0/15', 'benchmarking'),
  range4('198.51.100.0/24', 'documentation'),
  range4('203.0.113.0/24', 'documentation'),
  range4('224.0.0.0/4', 'multicast'),
  // Most specific first: the broadcast address sits inside 240.0.0.0/4.
  range4('255.255.255.255/32', 'broadcast'),
  range4('240.0.0.0/4', 'reserved'),
];

/** Strict dotted-quad decimal, no leading zeros; the address as an unsigned 32-bit number. */
export function parseIPv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function inRange4(addr: number, r: Range4): boolean {
  if (r.bits === 0) return true;
  const size = 2 ** (32 - r.bits);
  return Math.floor(addr / size) === Math.floor(r.base / size);
}

function classify4(addr: number): AddressVerdict {
  for (const r of IPV4_SPECIAL_RANGES) {
    if (inRange4(addr, r)) return { blocked: true, range: r.cidr, name: r.name };
  }
  return { blocked: false, family: 4 };
}

/**
 * RFC 4291 §2.2 text forms (full, `::`-compressed, and with a trailing dotted
 * quad) into 8 groups of 16 bits. A zone id (`%eth0`) is refused: it names a
 * link, never a global address.
 */
export function parseIPv6(text: string): number[] | null {
  if (text.includes('%')) return null;
  let head = text;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (lastColon >= 0 && text.slice(lastColon + 1).includes('.')) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [Math.floor(v4 / 65536), v4 % 65536];
    head = text.slice(0, lastColon + 1);
    // `::1.2.3.4` leaves head `::`; `a::1.2.3.4` leaves `a::`; `a:b:1.2.3.4` leaves `a:b:`.
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1);
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const group = (g: string): number | null =>
    /^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : null;
  const parseList = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      const v = group(g);
      if (v === null) return null;
      out.push(v);
    }
    return out;
  };
  const left = parseList(halves[0] as string);
  if (left === null) return null;
  if (halves.length === 1) {
    const groups = [...left, ...tail];
    return groups.length === 8 ? groups : null;
  }
  const right = parseList(halves[1] as string);
  if (right === null) return null;
  const fill = 8 - left.length - right.length - tail.length;
  // `::` stands for at least one group of zeros.
  if (fill < 1) return null;
  return [...left, ...new Array<number>(fill).fill(0), ...right, ...tail];
}

interface Range6 {
  groups: number[];
  bits: number;
  cidr: string;
  name: string;
}

function range6(cidr: string, name: string): Range6 {
  const [addr, bits] = cidr.split('/') as [string, string];
  const groups = parseIPv6(addr);
  if (groups === null) throw new Error(`net-policy: bad range ${cidr}`);
  return { groups, bits: Number(bits), cidr, name };
}

function inRange6(addr: readonly number[], r: Range6): boolean {
  let bits = r.bits;
  for (let i = 0; i < 8 && bits > 0; i++) {
    const take = Math.min(16, bits);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if (((addr[i] as number) & mask) !== ((r.groups[i] as number) & mask)) return false;
    bits -= take;
  }
  return true;
}

/**
 * IANA IPv6 Special-Purpose Address Registry entries inside global unicast
 * (2000::/3); everything outside 2000::/3 is refused before these are read,
 * except the three forms that carry an IPv4 address (below). The whole IETF
 * protocol-assignment block 2001::/23 is refused, Teredo (2001::/32) included:
 * a Teredo address names a tunnel relay, not a server.
 */
export const IPV6_SPECIAL_RANGES: readonly Range6[] = [
  range6('2001::/23', 'ietf-protocol-assignments'),
  range6('2001:db8::/32', 'documentation'),
  range6('2620:4f:8000::/48', 'as112-direct-delegation'),
  range6('3fff::/20', 'documentation'),
];

const GLOBAL_UNICAST = range6('2000::/3', 'global-unicast');
const IPV4_MAPPED = range6('::ffff:0:0/96', 'ipv4-mapped');
const NAT64_WELL_KNOWN = range6('64:ff9b::/96', 'nat64');
const NAT64_LOCAL = range6('64:ff9b:1::/48', 'nat64-local-use');
const SIX_TO_FOUR = range6('2002::/16', '6to4');

function v4From(hi: number, lo: number): number {
  return hi * 65536 + lo;
}

// ------------------------------------------------------------ NAT64 (RFC 6052, RFC 7050)

/** A network's NAT64 prefix, as RFC 7050 discovery finds it: the first `length` bits of `groups`. */
export interface Nat64Prefix {
  groups: readonly number[];
  length: 32 | 40 | 48 | 56 | 64 | 96;
}

/** RFC 6052 §2.2: where the four IPv4 bytes sit for each prefix length (byte 8 is the u octet). */
const EMBEDDED_V4_BYTES: Readonly<Record<Nat64Prefix['length'], readonly number[]>> = {
  32: [4, 5, 6, 7],
  40: [5, 6, 7, 9],
  48: [6, 7, 9, 10],
  56: [7, 9, 10, 11],
  64: [9, 10, 11, 12],
  96: [12, 13, 14, 15],
};
const NAT64_LENGTHS = [96, 64, 56, 48, 40, 32] as const;

function bytesOf(groups: readonly number[]): number[] {
  return groups.flatMap((g) => [g >> 8, g & 0xff]);
}

function embeddedV4(groups: readonly number[], length: Nat64Prefix['length']): number {
  const b = bytesOf(groups);
  return (EMBEDDED_V4_BYTES[length] as number[]).reduce(
    (acc, i) => acc * 256 + (b[i] as number),
    0,
  );
}

function underPrefix(groups: readonly number[], prefix: Nat64Prefix): boolean {
  return inRange6(groups, { groups: [...prefix.groups], bits: prefix.length, cidr: '', name: '' });
}

/** 192.0.0.170 and 192.0.0.171, the well-known IPv4-only addresses of `ipv4only.arpa` (RFC 7050 §2.2). */
const IPV4ONLY = new Set([0xc00000aa, 0xc00000ab]);

/**
 * The NAT64 prefixes behind the answers a resolver gave for `ipv4only.arpa`
 * (RFC 7050 §3): each IPv6 answer that embeds 192.0.0.170 or .171 at an RFC
 * 6052 position reveals a prefix of that length. On a network without NAT64
 * the answers are plain IPv4 and nothing is found.
 */
export function nat64PrefixesFrom(ipv4onlyAnswers: readonly string[]): Nat64Prefix[] {
  const out: Nat64Prefix[] = [];
  for (const answer of ipv4onlyAnswers) {
    const groups = parseIPv6(answer.trim());
    if (groups === null) continue;
    for (const length of NAT64_LENGTHS) {
      if (!IPV4ONLY.has(embeddedV4(groups, length))) continue;
      const kept = groups.map((g, i) => {
        const bits = Math.max(0, Math.min(16, length - i * 16));
        return g & ((0xffff << (16 - bits)) & 0xffff);
      });
      if (!out.some((p) => p.length === length && p.groups.every((g, i) => g === kept[i]))) {
        out.push({ groups: kept, length });
      }
      break;
    }
  }
  return out;
}

export interface ClassifyOptions {
  /**
   * The network's own NAT64 prefixes (`nat64PrefixesFrom`). An address under
   * one is judged by the IPv4 it carries: RFC 6052 §3.1 keeps non-global IPv4
   * out of the well-known prefix only, so a network-specific prefix may
   * lawfully reach the carrier's private space.
   */
  nat64Prefixes?: readonly Nat64Prefix[];
}

function classify6(g: readonly number[], options: ClassifyOptions): AddressVerdict {
  // Forms that carry an IPv4 address are judged by it.
  if (inRange6(g, IPV4_MAPPED) || inRange6(g, NAT64_WELL_KNOWN)) {
    const inner = classify4(v4From(g[6] as number, g[7] as number));
    return inner.blocked
      ? { ...inner, name: `${inner.name}-in-ipv6` }
      : { blocked: false, family: 6 };
  }
  for (const prefix of options.nat64Prefixes ?? []) {
    if (!underPrefix(g, prefix)) continue;
    const inner = classify4(embeddedV4(g, prefix.length));
    return inner.blocked
      ? { ...inner, name: `${inner.name}-in-nat64` }
      : { blocked: false, family: 6 };
  }
  if (inRange6(g, NAT64_LOCAL))
    return { blocked: true, range: NAT64_LOCAL.cidr, name: NAT64_LOCAL.name };
  if (!inRange6(g, GLOBAL_UNICAST))
    return { blocked: true, range: '!2000::/3', name: 'not-global-unicast' };
  if (inRange6(g, SIX_TO_FOUR)) {
    const inner = classify4(v4From(g[1] as number, g[2] as number));
    return inner.blocked
      ? { ...inner, name: `${inner.name}-in-6to4` }
      : { blocked: false, family: 6 };
  }
  for (const r of IPV6_SPECIAL_RANGES) {
    if (inRange6(g, r)) return { blocked: true, range: r.cidr, name: r.name };
  }
  return { blocked: false, family: 6 };
}

/** Classify an address as a resolver or socket reports it. Unparseable input is blocked. */
export function classifyAddress(address: string, options: ClassifyOptions = {}): AddressVerdict {
  let text = address.trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (text.includes(':')) {
    const groups = parseIPv6(text);
    return groups === null
      ? { blocked: true, range: '', name: 'unparseable' }
      : classify6(groups, options);
  }
  const v4 = parseIPv4(text);
  return v4 === null ? { blocked: true, range: '', name: 'unparseable' } : classify4(v4);
}

export function isBlockedAddress(address: string, options: ClassifyOptions = {}): boolean {
  return classifyAddress(address, options).blocked;
}
