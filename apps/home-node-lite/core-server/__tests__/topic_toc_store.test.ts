/**
 * topic_toc_store tests.
 */

import {
  DEFAULT_LONG_HALF_LIFE_MS,
  DEFAULT_MAX_TOPICS,
  DEFAULT_SHORT_HALF_LIFE_MS,
  TopicTocStore,
} from '../src/brain/topic_toc_store';

/** Fakeable clock for deterministic tests. */
class Clock {
  private t = 0;
  now = (): number => this.t;
  set(ms: number): void { this.t = ms; }
  advance(ms: number): void { this.t += ms; }
}

function newStore(
  clock: Clock,
  opts: { shortHalfLifeMs?: number; longHalfLifeMs?: number; maxTopics?: number } = {},
): TopicTocStore {
  return new TopicTocStore({
    nowMsFn: clock.now,
    shortHalfLifeMs: opts.shortHalfLifeMs ?? 60_000, // 1 min for test speed
    longHalfLifeMs: opts.longHalfLifeMs ?? 3_600_000, // 1h for test speed
    ...(opts.maxTopics !== undefined ? { maxTopics: opts.maxTopics } : {}),
  });
}

describe('TopicTocStore construction', () => {
  it('defaults are documented', () => {
    expect(DEFAULT_SHORT_HALF_LIFE_MS).toBe(60 * 60 * 1000);
    expect(DEFAULT_LONG_HALF_LIFE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(DEFAULT_MAX_TOPICS).toBe(500);
  });

  it.each([
    ['shortHalfLifeMs zero', { shortHalfLifeMs: 0 }, /shortHalfLifeMs/],
    ['shortHalfLifeMs negative', { shortHalfLifeMs: -1 }, /shortHalfLifeMs/],
    ['longHalfLifeMs zero', { longHalfLifeMs: 0 }, /longHalfLifeMs/],
    ['longHalfLifeMs negative', { longHalfLifeMs: -1 }, /longHalfLifeMs/],
    [
      'short >= long',
      { shortHalfLifeMs: 1_000_000, longHalfLifeMs: 1_000 },
      /short.*less than long/i,
    ],
    ['maxTopics zero', { maxTopics: 0 }, /maxTopics/],
    ['maxTopics fraction', { maxTopics: 1.5 }, /maxTopics/],
  ] as const)('rejects bad %s', (_label, bad, regex) => {
    expect(() => new TopicTocStore(bad)).toThrow(regex);
  });
});

describe('observe + snapshot', () => {
  it('empty store → empty snapshot', () => {
    const clock = new Clock();
    const store = newStore(clock);
    expect(store.snapshot()).toEqual([]);
    expect(store.size()).toBe(0);
  });

  it('single observation → single entry with weight on both tracks', () => {
    const clock = new Clock();
    clock.set(1000);
    const store = newStore(clock);
    store.observe([{ label: 'meeting', weight: 1 }]);
    const snap = store.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.label).toBe('meeting');
    expect(snap[0]!.short).toBeCloseTo(1, 10);
    expect(snap[0]!.long).toBeCloseTo(1, 10);
    expect(snap[0]!.observations).toBe(1);
    expect(snap[0]!.lastSeenMs).toBe(1000);
  });

  it('multiple topics tracked independently', () => {
    const clock = new Clock();
    const store = newStore(clock);
    store.observe([
      { label: 'a', weight: 2 },
      { label: 'b', weight: 1 },
      { label: 'c', weight: 3 },
    ]);
    expect(store.size()).toBe(3);
    const snap = store.snapshot();
    expect(snap.map((e) => e.label)).toEqual(['c', 'a', 'b']); // ordered by score desc
  });

  it('skips non-string labels + non-positive weights', () => {
    const clock = new Clock();
    const store = newStore(clock);
    store.observe([
      { label: '', weight: 1 },
      { label: 'ok', weight: 1 },
      { label: 'zero', weight: 0 },
      { label: 'neg', weight: -1 },
      { label: 'nan', weight: Number.NaN },
    ]);
    expect(store.size()).toBe(1);
    expect(store.snapshot()[0]!.label).toBe('ok');
  });

  it('repeated observations accumulate with decay applied between', () => {
    const clock = new Clock();
    const store = newStore(clock, { shortHalfLifeMs: 60_000 });
    clock.set(0);
    store.observe([{ label: 'x', weight: 1 }]);
    // Advance one short half-life → short weight halves before the
    // next weight is added.
    clock.advance(60_000);
    store.observe([{ label: 'x', weight: 1 }]);
    const entry = store.rawEntry('x')!;
    // short: 1 * 0.5 + 1 = 1.5
    expect(entry.short).toBeCloseTo(1.5, 6);
    expect(entry.observations).toBe(2);
  });
});

describe('decay math', () => {
  it('half-life exactly halves short weight', () => {
    const clock = new Clock();
    const store = newStore(clock, { shortHalfLifeMs: 1000, longHalfLifeMs: 1_000_000 });
    clock.set(0);
    store.observe([{ label: 't', weight: 1 }]);
    clock.advance(1000); // one short half-life
    const snap = store.snapshot();
    expect(snap[0]!.short).toBeCloseTo(0.5, 4);
    // long half-life is 1M ms — 1000ms decay is ~0.999
    expect(snap[0]!.long).toBeCloseTo(1 * Math.exp(-1000 / (1_000_000 / Math.LN2)), 4);
  });

  it('long-track decays much slower than short', () => {
    const clock = new Clock();
    const store = newStore(clock, { shortHalfLifeMs: 60_000, longHalfLifeMs: 86_400_000 });
    clock.set(0);
    store.observe([{ label: 't', weight: 1 }]);
    clock.advance(3_600_000); // 1 hour → 60 short half-lives, tiny fraction of long half-life
    const snap = store.snapshot();
    expect(snap[0]!.short).toBeLessThan(0.01);
    expect(snap[0]!.long).toBeGreaterThan(0.9);
  });

  it('decayToNow() decays in-place without adding weight', () => {
    const clock = new Clock();
    const store = newStore(clock, { shortHalfLifeMs: 1000 });
    clock.set(0);
    store.observe([{ label: 't', weight: 1 }]);
    clock.advance(1000);
    store.decayToNow();
    const raw = store.rawEntry('t')!;
    expect(raw.short).toBeCloseTo(0.5, 4);
    expect(raw.lastSeenMs).toBe(1000);
  });
});

describe('snapshot options', () => {
  it('limit caps the result', () => {
    const clock = new Clock();
    const store = newStore(clock);
    for (let i = 0; i < 10; i++) {
      store.observe([{ label: `t${i}`, weight: i + 1 }]);
    }
    const snap = store.snapshot({ limit: 3 });
    expect(snap).toHaveLength(3);
  });

  it('custom score combinator (short only)', () => {
    const clock = new Clock();
    const store = newStore(clock, { shortHalfLifeMs: 60_000 });
    clock.set(0);
    store.observe([{ label: 'old-but-steady', weight: 1 }]);
    clock.advance(3 * 60_000); // 3 short half-lives → short drops to ~0.125
    store.observe([{ label: 'recent-spike', weight: 1 }]);
    const byShort = store.snapshot({ score: (e) => e.short });
    expect(byShort[0]!.label).toBe('recent-spike');
  });

  it('minScore filters low-weight entries', () => {
    const clock = new Clock();
    const store = newStore(clock, { shortHalfLifeMs: 1000 });
    clock.set(0);
    store.observe([{ label: 'faded', weight: 0.1 }]);
    clock.advance(10_000); // many half-lives
    const snap = store.snapshot({ minScore: 0.5 });
    expect(snap).toEqual([]);
  });

  it('orders by score desc with alphabetic tiebreak', () => {
    const clock = new Clock();
    const store = newStore(clock);
    store.observe([
      { label: 'zzz', weight: 1 },
      { label: 'aaa', weight: 1 },
      { label: 'mmm', weight: 1 },
    ]);
    expect(store.snapshot().map((e) => e.label)).toEqual(['aaa', 'mmm', 'zzz']);
  });
});

describe('eviction', () => {
  it('drops lowest-long-weight when over maxTopics', () => {
    const clock = new Clock();
    const store = newStore(clock, { maxTopics: 3 });
    clock.set(0);
    store.observe([{ label: 'long-standing', weight: 5 }]);
    clock.advance(1000);
    store.observe([{ label: 'medium', weight: 2 }]);
    store.observe([{ label: 'small', weight: 0.5 }]);
    store.observe([{ label: 'overflow', weight: 1 }]);
    expect(store.size()).toBe(3);
    const labels = store.snapshot().map((e) => e.label);
    // 'small' had the lowest long weight → evicted.
    expect(labels).not.toContain('small');
    expect(labels).toContain('long-standing');
  });

  it('short spikes do not evict long-standing interests', () => {
    const clock = new Clock();
    const store = newStore(clock, { maxTopics: 2 });
    // Build long-standing high-long interest.
    clock.set(0);
    for (let i = 0; i < 5; i++) {
      store.observe([{ label: 'classic', weight: 1 }]);
      clock.advance(100);
    }
    // One short spike + one more short observation — both new.
    store.observe([{ label: 'spike-a', weight: 2 }]);
    store.observe([{ label: 'spike-b', weight: 2 }]);
    expect(store.size()).toBe(2);
    const labels = store.snapshot().map((e) => e.label);
    expect(labels).toContain('classic');
  });
});

describe('reset', () => {
  it('clears all entries', () => {
    const clock = new Clock();
    const store = newStore(clock);
    store.observe([{ label: 'x', weight: 1 }]);
    expect(store.size()).toBe(1);
    store.reset();
    expect(store.size()).toBe(0);
    expect(store.snapshot()).toEqual([]);
  });
});

describe('rawEntry', () => {
  it('returns a copy — external mutation is safe', () => {
    const clock = new Clock();
    const store = newStore(clock);
    store.observe([{ label: 'x', weight: 1 }]);
    const raw = store.rawEntry('x')!;
    raw.short = 999;
    expect(store.rawEntry('x')!.short).not.toBe(999);
  });

  it('returns undefined for unknown label', () => {
    const store = newStore(new Clock());
    expect(store.rawEntry('nope')).toBeUndefined();
  });
});
