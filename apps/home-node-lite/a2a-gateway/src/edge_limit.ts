/**
 * The gateway's edge limit: calls per minute per client, before any call
 * reaches Core (design §4.1). A fixed one-minute window per client.
 *
 * A client is an IPv4 address, or an IPv6 /64: one subscriber usually holds
 * a whole /64, so keying on the full address would let one client spend a
 * fresh minute from each of its addresses. An IPv4-mapped IPv6 address is
 * the IPv4 client it maps.
 *
 * The table is bounded. Its order is window start, oldest first: windows
 * that ended are dropped from the front, and when it is full of live ones
 * the oldest goes, so a spray of clients can neither grow the table nor
 * shut out a client the table has no room for (the client whose window went
 * starts a fresh one).
 */

import { isIPv4, isIPv6 } from 'node:net';

interface Window {
  start: number;
  count: number;
}

/** Clients tracked at once. */
export const EDGE_LIMIT_MAX_TRACKED = 50_000;

const WINDOW_MS = 60_000;

/** The client an address belongs to, for limits: an IPv4 address, or an IPv6 address's /64 (or the IPv4 address it maps). */
export function clientKeyOf(address: string): string {
  if (isIPv4(address)) return address;
  // A zone index (`fe80::1%eth0`) names the interface, not the client.
  const bare = address.split('%')[0] ?? address;
  if (!isIPv6(bare)) return address;
  const groups = ipv6Groups(bare);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address (`isIPv6`), `::` and an IPv4 tail expanded. */
function ipv6Groups(address: string): number[] {
  let text = address;
  const tail: number[] = [];
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4 !== null) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    tail.push((a << 8) | b, (c << 8) | d);
    text = text.slice(0, v4.index);
    // `::ffff:1.2.3.4` leaves `::ffff:`; `::1.2.3.4` leaves `::`.
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }
  const [head = '', rest] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const fill = rest === undefined ? 0 : 8 - tail.length - left.length - right.length;
  return [...left, ...Array<string>(fill).fill('0'), ...right].map((g) => parseInt(g, 16)).concat(tail);
}

export class EdgeLimiter {
  /** Each client's window, oldest start first. */
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly maxTracked: number = EDGE_LIMIT_MAX_TRACKED,
  ) {}

  /** Charge one call to the client at `address`; false when its minute is spent. */
  allow(address: string): boolean {
    const key = clientKeyOf(address);
    const now = this.now();
    let w = this.windows.get(key);
    if (w === undefined || now - w.start >= WINDOW_MS) {
      this.windows.delete(key);
      this.makeRoom(now);
      w = { start: now, count: 0 };
      // Set last: the map's order stays window start, oldest first.
      this.windows.set(key, w);
    }
    if (w.count >= this.perMinute) return false;
    w.count += 1;
    return true;
  }

  /** Clients tracked now. */
  get size(): number {
    return this.windows.size;
  }

  /** Drop the windows that ended, oldest first; when the table is still full, the oldest live one. */
  private makeRoom(now: number): void {
    for (const [key, w] of this.windows) {
      if (now - w.start < WINDOW_MS) break;
      this.windows.delete(key);
    }
    while (this.windows.size >= this.maxTracked) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}
