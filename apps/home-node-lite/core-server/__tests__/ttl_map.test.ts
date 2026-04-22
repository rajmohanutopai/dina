/**
 * ttl_map tests.
 */

import { TtlMap } from '../src/brain/ttl_map';

class Clock {
  private t = 0;
  now = (): number => this.t;
  set(ms: number): void { this.t = ms; }
  advance(ms: number): void { this.t += ms; }
}

describe('TtlMap — construction', () => {
  it.each([
    ['null opts', null],
    ['zero ttl', { defaultTtlMs: 0 }],
    ['NaN ttl', { defaultTtlMs: Number.NaN }],
    ['negative ttl', { defaultTtlMs: -1 }],
    ['zero maxEntries', { defaultTtlMs: 1000, maxEntries: 0 }],
    ['fraction maxEntries', { defaultTtlMs: 1000, maxEntries: 1.5 }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() =>
      new TtlMap(bad as unknown as ConstructorParameters<typeof TtlMap>[0]),
    ).toThrow();
  });

  it('empty on construction', () => {
    const m = new TtlMap<string, number>({ defaultTtlMs: 1000 });
    expect(m.size()).toBe(0);
  });
});

describe('TtlMap — set / get / has', () => {
  it('set + get within TTL returns value', () => {
    const clock = new Clock();
    const m = new TtlMap<string, number>({ defaultTtlMs: 1000, nowMsFn: clock.now });
    clock.set(0);
    m.set('a', 42);
    clock.advance(500);
    expect(m.get('a')).toBe(42);
    expect(m.has('a')).toBe(true);
  });

  it('get after TTL returns undefined', () => {
    const clock = new Clock();
    const m = new TtlMap<string, number>({ defaultTtlMs: 1000, nowMsFn: clock.now });
    m.set('a', 42);
    clock.advance(1500);
    expect(m.get('a')).toBeUndefined();
    expect(m.has('a')).toBe(false);
  });

  it('per-key TTL override', () => {
    const clock = new Clock();
    const m = new TtlMap<string, number>({ defaultTtlMs: 1000, nowMsFn: clock.now });
    m.set('short', 1, { ttlMs: 100 });
    m.set('long', 2, { ttlMs: 5000 });
    clock.advance(500);
    expect(m.get('short')).toBeUndefined();
    expect(m.get('long')).toBe(2);
  });

  it('set on invalid ttlMs throws', () => {
    const m = new TtlMap<string, number>({ defaultTtlMs: 1000 });
    expect(() => m.set('a', 1, { ttlMs: 0 })).toThrow(/ttlMs/);
    expect(() => m.set('a', 1, { ttlMs: -1 })).toThrow(/ttlMs/);
  });

  it('re-set refreshes expiry', () => {
    const clock = new Clock();
    const m = new TtlMap<string, number>({ defaultTtlMs: 1000, nowMsFn: clock.now });
    m.set('a', 1);
    clock.advance(600);
    m.set('a', 2);
    clock.advance(600);
    // First set would have expired (1200 > 1000), but second set at
    // t=600 runs until 1600; now at 1200 it's still live.
    expect(m.get('a')).toBe(2);
  });
});

describe('TtlMap — expiresAt', () => {
  it('returns expiry timestamp for live key', () => {
    const clock = new Clock();
    clock.set(500);
    const m = new TtlMap<string, number>({ defaultTtlMs: 1000, nowMsFn: clock.now });
    m.set('a', 1);
    expect(m.expiresAt('a')).toBe(1500);
  });

  it('returns undefined for missing key', () => {
    const m = new TtlMap<string, number>({ defaultTtlMs: 1000 });
    expect(m.expiresAt('missing')).toBeUndefined();
  });

  it('returns undefined for expired key', () => {
    const clock = new Clock();
    const m = new TtlMap<string, number>({ defaultTtlMs: 1000, nowMsFn: clock.now });
    m.set('a', 1);
    clock.advance(1500);
    expect(m.expiresAt('a')).toBeUndefined();
  });
});

describe('TtlMap — delete / clear', () => {
  it('delete returns true when key existed', () => {
    const m = new TtlMap<string, number>({ defaultTtlMs: 1000 });
    m.set('a', 1);
    expect(m.delete('a')).toBe(true);
    expect(m.delete('a')).toBe(false);
  });

  it('clear empties everything', () => {
    const m = new TtlMap<string, number>({ defaultTtlMs: 1000 });
    m.set('a', 1);
    m.set('b', 2);
    m.clear();
    expect(m.size()).toBe(0);
  });
});

describe('TtlMap — iteration', () => {
  it('entriesSnapshot is insertion-order + live-only', () => {
    const clock = new Clock();
    const m = new TtlMap<string, number>({ defaultTtlMs: 1000, nowMsFn: clock.now });
    m.set('a', 1);
    m.set('b', 2, { ttlMs: 100 });
    m.set('c', 3);
    clock.advance(500); // 'b' expires
    expect(m.entriesSnapshot()).toEqual([['a', 1], ['c', 3]]);
  });

  it('for...of yields live entries in insertion order', () => {
    const m = new TtlMap<string, number>({ defaultTtlMs: 1000 });
    m.set('first', 1);
    m.set('second', 2);
    const out: Array<[string, number]> = [];
    for (const [k, v] of m) out.push([k, v]);
    expect(out).toEqual([['first', 1], ['second', 2]]);
  });

  it('snapshot is a defensive copy', () => {
    const m = new TtlMap<string, number>({ defaultTtlMs: 1000 });
    m.set('a', 1);
    const snap = m.entriesSnapshot();
    snap.push(['hacked', 999]);
    expect(m.entriesSnapshot()).toEqual([['a', 1]]);
  });
});

describe('TtlMap — sweep + events', () => {
  it('sweepExpired returns count dropped', () => {
    const clock = new Clock();
    const m = new TtlMap<string, number>({ defaultTtlMs: 1000, nowMsFn: clock.now });
    m.set('a', 1);
    m.set('b', 2);
    clock.advance(1500);
    expect(m.sweepExpired()).toBe(2);
    expect(m.size()).toBe(0);
  });

  it('onExpire fires for TTL drop with reason=ttl', () => {
    const clock = new Clock();
    const events: Array<[string, string]> = [];
    const m = new TtlMap<string, number>({
      defaultTtlMs: 1000,
      nowMsFn: clock.now,
      onExpire: (k, r) => events.push([k, r]),
    });
    m.set('a', 1);
    clock.advance(1500);
    m.sweepExpired();
    expect(events).toEqual([['a', 'ttl']]);
  });

  it('onExpire fires for capacity eviction with reason=capacity', () => {
    const events: Array<[string, string]> = [];
    const m = new TtlMap<string, number>({
      defaultTtlMs: 1000,
      maxEntries: 2,
      onExpire: (k, r) => events.push([k, r]),
    });
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    expect(events).toEqual([['a', 'capacity']]);
    expect(m.size()).toBe(2);
  });

  it('get auto-sweeps before returning', () => {
    const clock = new Clock();
    const events: string[] = [];
    const m = new TtlMap<string, number>({
      defaultTtlMs: 1000,
      nowMsFn: clock.now,
      onExpire: (k) => events.push(k),
    });
    m.set('a', 1);
    clock.advance(1500);
    // Trigger auto-sweep by querying.
    expect(m.get('a')).toBeUndefined();
    expect(events).toEqual(['a']);
  });
});

describe('TtlMap — capacity eviction', () => {
  it('maxEntries evicts FIFO', () => {
    const m = new TtlMap<string, number>({ defaultTtlMs: 1000, maxEntries: 3 });
    for (let i = 0; i < 5; i++) m.set(`k${i}`, i);
    expect(m.size()).toBe(3);
    expect(m.entriesSnapshot().map(([k]) => k)).toEqual(['k2', 'k3', 'k4']);
  });

  it('re-set moves key to back of insertion order', () => {
    const m = new TtlMap<string, number>({ defaultTtlMs: 1000, maxEntries: 3 });
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    m.set('a', 10); // refresh → moves to back
    m.set('d', 4);  // now 'b' is oldest → evict b
    expect(m.has('a')).toBe(true);
    expect(m.has('b')).toBe(false);
  });
});
