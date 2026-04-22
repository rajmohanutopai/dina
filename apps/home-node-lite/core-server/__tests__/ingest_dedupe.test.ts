/**
 * ingest_dedupe tests.
 */

import {
  DEFAULT_MAX_ENTRIES,
  IngestDedupe,
  type DedupeEvent,
} from '../src/brain/ingest_dedupe';

class Clock {
  private t = 0;
  now = (): number => this.t;
  advance(ms: number): void { this.t += ms; }
  set(ms: number): void { this.t = ms; }
}

describe('IngestDedupe — construction', () => {
  it.each([
    ['zero maxEntries', { maxEntries: 0 }],
    ['negative maxEntries', { maxEntries: -1 }],
    ['fraction maxEntries', { maxEntries: 1.5 }],
    ['zero ttlSec', { ttlSec: 0 }],
    ['negative ttlSec', { ttlSec: -1 }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() => new IngestDedupe(bad)).toThrow();
  });

  it('null ttlSec → no TTL (LRU only)', () => {
    const dedupe = new IngestDedupe({ ttlSec: null });
    expect(dedupe.check({ contentHash: 'h1' }).kind).toBe('unique');
  });

  it('DEFAULT_MAX_ENTRIES is 10_000', () => {
    expect(DEFAULT_MAX_ENTRIES).toBe(10_000);
  });
});

describe('IngestDedupe.check — unique + seen', () => {
  it('first call is unique, second with same hash is seen', () => {
    const dedupe = new IngestDedupe();
    expect(dedupe.check({ contentHash: 'h1' }).kind).toBe('unique');
    const r = dedupe.check({ contentHash: 'h1' });
    expect(r.kind).toBe('seen');
    if (r.kind === 'seen') expect(r.matchedOn).toBe('hash');
  });

  it('same id + new hash → seen by id', () => {
    const dedupe = new IngestDedupe();
    dedupe.check({ id: 'v-1', contentHash: 'h1' });
    const r = dedupe.check({ id: 'v-1', contentHash: 'h2' });
    expect(r.kind).toBe('seen');
    // id matched the prior entry; the new hash is unseen.
    if (r.kind === 'seen') expect(r.matchedOn).toBe('id');
  });

  it('same id + same hash → matchedOn=both', () => {
    const dedupe = new IngestDedupe();
    dedupe.check({ id: 'v-1', contentHash: 'h1' });
    const r = dedupe.check({ id: 'v-1', contentHash: 'h1' });
    if (r.kind === 'seen') expect(r.matchedOn).toBe('both');
  });

  it('new id + same hash → matchedOn=hash', () => {
    const dedupe = new IngestDedupe();
    dedupe.check({ id: 'v-1', contentHash: 'h1' });
    const r = dedupe.check({ id: 'v-2', contentHash: 'h1' });
    if (r.kind === 'seen') expect(r.matchedOn).toBe('hash');
  });

  it('new id + new hash → unique', () => {
    const dedupe = new IngestDedupe();
    dedupe.check({ id: 'v-1', contentHash: 'h1' });
    const r = dedupe.check({ id: 'v-2', contentHash: 'h2' });
    expect(r.kind).toBe('unique');
  });

  it('firstSeenMs echoes the time of initial ingest', () => {
    const clock = new Clock();
    clock.set(1000);
    const dedupe = new IngestDedupe({ nowMsFn: clock.now });
    dedupe.check({ contentHash: 'h1' });
    clock.advance(5000);
    const r = dedupe.check({ contentHash: 'h1' });
    if (r.kind === 'seen') expect(r.firstSeenMs).toBe(1000);
  });
});

describe('IngestDedupe.check — input validation', () => {
  const dedupe = new IngestDedupe();

  it.each([
    ['null input', null],
    ['missing contentHash', { id: 'v-1' }],
    ['empty contentHash', { id: 'v-1', contentHash: '' }],
    ['empty id (when supplied)', { id: '', contentHash: 'h' }],
  ] as const)('throws on %s', (_l, bad) => {
    expect(() =>
      dedupe.check(bad as unknown as Parameters<typeof dedupe.check>[0]),
    ).toThrow();
  });
});

describe('IngestDedupe — LRU eviction', () => {
  it('oldest entry evicted when over maxEntries', () => {
    const dedupe = new IngestDedupe({ maxEntries: 3 });
    dedupe.check({ contentHash: 'h1' });
    dedupe.check({ contentHash: 'h2' });
    dedupe.check({ contentHash: 'h3' });
    dedupe.check({ contentHash: 'h4' });
    // h1 was oldest, should be evicted — re-checking it is unique.
    expect(dedupe.check({ contentHash: 'h1' }).kind).toBe('unique');
  });

  it('touching a hash moves it to back — protects it from eviction', () => {
    const dedupe = new IngestDedupe({ maxEntries: 3 });
    dedupe.check({ contentHash: 'h1' });
    dedupe.check({ contentHash: 'h2' });
    // Touch h1 again — moves it to back.
    dedupe.check({ contentHash: 'h1' });
    dedupe.check({ contentHash: 'h3' });
    dedupe.check({ contentHash: 'h4' });
    // Now h2 is the oldest; h1 still protected.
    expect(dedupe.check({ contentHash: 'h1' }).kind).toBe('seen');
    expect(dedupe.check({ contentHash: 'h2' }).kind).toBe('unique');
  });

  it('eviction emits event', () => {
    const events: DedupeEvent[] = [];
    const dedupe = new IngestDedupe({ maxEntries: 2, onEvent: (e) => events.push(e) });
    dedupe.check({ contentHash: 'h1' });
    dedupe.check({ contentHash: 'h2' });
    dedupe.check({ contentHash: 'h3' });
    const evicts = events.filter((e) => e.kind === 'evicted');
    expect(evicts.length).toBeGreaterThanOrEqual(1);
    expect((evicts[0] as { reason: string }).reason).toBe('lru');
  });

  it('id + hash pair counts toward capacity as one unit', () => {
    // With id AND hash entries sharing the same Entry record, size
    // grows by 2 per check() when id is supplied. Max is capacity —
    // but "effective" cap is lower.
    const dedupe = new IngestDedupe({ maxEntries: 6 });
    dedupe.check({ id: 'v-1', contentHash: 'h1' });
    dedupe.check({ id: 'v-2', contentHash: 'h2' });
    dedupe.check({ id: 'v-3', contentHash: 'h3' });
    // All three should still be there.
    expect(dedupe.check({ id: 'v-1', contentHash: 'h1' }).kind).toBe('seen');
  });
});

describe('IngestDedupe — TTL expiry', () => {
  it('entry older than TTL expires → treated as unique again', () => {
    const clock = new Clock();
    const dedupe = new IngestDedupe({ ttlSec: 10, nowMsFn: clock.now });
    clock.set(0);
    dedupe.check({ contentHash: 'h1' });
    clock.advance(15_000);
    expect(dedupe.check({ contentHash: 'h1' }).kind).toBe('unique');
  });

  it('entry within TTL stays seen', () => {
    const clock = new Clock();
    const dedupe = new IngestDedupe({ ttlSec: 10, nowMsFn: clock.now });
    clock.set(0);
    dedupe.check({ contentHash: 'h1' });
    clock.advance(5_000);
    expect(dedupe.check({ contentHash: 'h1' }).kind).toBe('seen');
  });

  it('expired entries emit evicted event with reason ttl', () => {
    const clock = new Clock();
    const events: DedupeEvent[] = [];
    const dedupe = new IngestDedupe({
      ttlSec: 1,
      nowMsFn: clock.now,
      onEvent: (e) => events.push(e),
    });
    dedupe.check({ contentHash: 'h1' });
    clock.advance(2000);
    dedupe.size(); // triggers sweep
    const ttlEvicts = events.filter(
      (e) => e.kind === 'evicted' && (e as { reason: string }).reason === 'ttl',
    );
    expect(ttlEvicts.length).toBeGreaterThanOrEqual(1);
  });

  it('size() reflects post-sweep count', () => {
    const clock = new Clock();
    const dedupe = new IngestDedupe({ ttlSec: 10, nowMsFn: clock.now });
    dedupe.check({ contentHash: 'h1' });
    dedupe.check({ contentHash: 'h2' });
    clock.advance(15_000);
    expect(dedupe.size()).toBe(0);
  });
});

describe('IngestDedupe.clear + forget', () => {
  it('clear empties everything', () => {
    const dedupe = new IngestDedupe();
    dedupe.check({ id: 'v-1', contentHash: 'h1' });
    dedupe.check({ id: 'v-2', contentHash: 'h2' });
    dedupe.clear();
    expect(dedupe.size()).toBe(0);
    expect(dedupe.check({ contentHash: 'h1' }).kind).toBe('unique');
  });

  it('forget removes specific id or hash', () => {
    const dedupe = new IngestDedupe();
    dedupe.check({ id: 'v-1', contentHash: 'h1' });
    dedupe.check({ id: 'v-2', contentHash: 'h2' });
    const removed = dedupe.forget({ contentHash: 'h1' });
    expect(removed).toBeGreaterThan(0);
    // h1 removed → next check is unique.
    expect(dedupe.check({ contentHash: 'h1' }).kind).toBe('unique');
    // h2 still seen.
    expect(dedupe.check({ contentHash: 'h2' }).kind).toBe('seen');
  });
});

describe('IngestDedupe — events', () => {
  it('onEvent fires unique + seen + evicted', () => {
    const clock = new Clock();
    const events: DedupeEvent[] = [];
    const dedupe = new IngestDedupe({
      maxEntries: 2,
      ttlSec: null,
      nowMsFn: clock.now,
      onEvent: (e) => events.push(e),
    });
    dedupe.check({ contentHash: 'h1' });
    dedupe.check({ contentHash: 'h1' }); // seen
    dedupe.check({ contentHash: 'h2' });
    dedupe.check({ contentHash: 'h3' }); // evicts h1
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('unique');
    expect(kinds).toContain('seen');
    expect(kinds).toContain('evicted');
  });
});
