/**
 * metrics_aggregator tests.
 */

import {
  MetricsAggregator,
  MetricsError,
} from '../src/brain/metrics_aggregator';

describe('MetricsAggregator — validation', () => {
  const m = new MetricsAggregator();

  it.each([
    ['empty name', ''],
    ['starts with digit', '1abc'],
    ['has spaces', 'bad name'],
    ['uppercase', 'BadName'],
    ['has dot', 'a.b'],
  ] as const)('rejects name: %s', (_l, name) => {
    expect(() => m.inc(name)).toThrow(MetricsError);
  });

  it.each([
    ['non-object labels', 'x'],
    ['array labels', []],
  ] as const)('rejects labels: %s', (_l, bad) => {
    expect(() => m.inc('ok', bad as unknown as Record<string, string>)).toThrow(/invalid_labels/);
  });

  it('rejects invalid label key', () => {
    expect(() => m.inc('ok', { 'bad-key': 'v' })).toThrow(/invalid_labels/);
  });

  it('rejects empty label value', () => {
    expect(() => m.inc('ok', { k: '' })).toThrow(/invalid_labels/);
  });

  it('rejects negative counter delta', () => {
    expect(() => m.inc('ok', {}, -1)).toThrow(/invalid_value/);
  });

  it('rejects non-finite gauge value', () => {
    expect(() => m.set('ok', Number.NaN)).toThrow(/invalid_value/);
    expect(() => m.set('ok', Number.POSITIVE_INFINITY)).toThrow(/invalid_value/);
  });

  it('rejects non-finite observe value', () => {
    expect(() => m.observe('ok', Number.NaN)).toThrow(/invalid_value/);
  });
});

describe('MetricsAggregator — counters', () => {
  it('inc defaults to +1', () => {
    const m = new MetricsAggregator();
    m.inc('requests_total');
    m.inc('requests_total');
    expect(m.getCounter('requests_total')).toBe(2);
  });

  it('inc with delta', () => {
    const m = new MetricsAggregator();
    m.inc('bytes', {}, 100);
    m.inc('bytes', {}, 250);
    expect(m.getCounter('bytes')).toBe(350);
  });

  it('inc with delta=0 is a no-op-ish', () => {
    const m = new MetricsAggregator();
    m.inc('x', {}, 0);
    expect(m.getCounter('x')).toBe(0);
  });

  it('labels partition series', () => {
    const m = new MetricsAggregator();
    m.inc('req', { method: 'GET' });
    m.inc('req', { method: 'POST' });
    m.inc('req', { method: 'GET' });
    expect(m.getCounter('req', { method: 'GET' })).toBe(2);
    expect(m.getCounter('req', { method: 'POST' })).toBe(1);
  });

  it('getCounter on unseen key returns 0', () => {
    const m = new MetricsAggregator();
    expect(m.getCounter('unseen')).toBe(0);
  });
});

describe('MetricsAggregator — gauges', () => {
  it('set + get', () => {
    const m = new MetricsAggregator();
    m.set('open_connections', 5);
    m.set('open_connections', 7);
    expect(m.getGauge('open_connections')).toBe(7);
  });

  it('add goes up and down', () => {
    const m = new MetricsAggregator();
    m.set('balance', 100);
    m.add('balance', -30);
    m.add('balance', 10);
    expect(m.getGauge('balance')).toBe(80);
  });

  it('labels partition gauge series', () => {
    const m = new MetricsAggregator();
    m.set('queue_depth', 5, { queue: 'a' });
    m.set('queue_depth', 12, { queue: 'b' });
    expect(m.getGauge('queue_depth', { queue: 'a' })).toBe(5);
    expect(m.getGauge('queue_depth', { queue: 'b' })).toBe(12);
  });
});

describe('MetricsAggregator — summaries', () => {
  it('observe tracks count/sum/min/max/avg', () => {
    const m = new MetricsAggregator();
    m.observe('latency', 10);
    m.observe('latency', 20);
    m.observe('latency', 30);
    const s = m.getSummary('latency');
    expect(s).toEqual({
      name: 'latency',
      labels: {},
      count: 3,
      sum: 60,
      min: 10,
      max: 30,
      avg: 20,
    });
  });

  it('single-observation summary', () => {
    const m = new MetricsAggregator();
    m.observe('x', 42);
    const s = m.getSummary('x')!;
    expect(s.count).toBe(1);
    expect(s.min).toBe(42);
    expect(s.max).toBe(42);
    expect(s.avg).toBe(42);
  });

  it('unobserved summary → null', () => {
    const m = new MetricsAggregator();
    expect(m.getSummary('x')).toBeNull();
  });

  it('negative observations supported', () => {
    const m = new MetricsAggregator();
    m.observe('delta', -5);
    m.observe('delta', 10);
    const s = m.getSummary('delta')!;
    expect(s.min).toBe(-5);
    expect(s.max).toBe(10);
    expect(s.avg).toBe(2.5);
  });

  it('labels partition summary series', () => {
    const m = new MetricsAggregator();
    m.observe('latency', 10, { route: 'a' });
    m.observe('latency', 100, { route: 'b' });
    expect(m.getSummary('latency', { route: 'a' })!.sum).toBe(10);
    expect(m.getSummary('latency', { route: 'b' })!.sum).toBe(100);
  });
});

describe('MetricsAggregator — label canonicalisation', () => {
  it('different label order = same series', () => {
    const m = new MetricsAggregator();
    m.inc('x', { a: '1', b: '2' });
    m.inc('x', { b: '2', a: '1' });
    expect(m.getCounter('x', { a: '1', b: '2' })).toBe(2);
    expect(m.size()).toBe(1);
  });

  it('snapshot labels are frozen', () => {
    const m = new MetricsAggregator();
    m.inc('x', { k: 'v' });
    const snap = m.snapshot();
    const labels = snap.counters[0]!.labels;
    // Attempting to mutate a frozen object in strict mode throws.
    expect(() => {
      (labels as unknown as Record<string, string>).k = 'tampered';
    }).toThrow();
  });
});

describe('MetricsAggregator — snapshot', () => {
  it('returns counters + gauges + summaries', () => {
    const m = new MetricsAggregator();
    m.inc('c1');
    m.set('g1', 5);
    m.observe('s1', 10);
    const snap = m.snapshot();
    expect(snap.counters).toHaveLength(1);
    expect(snap.gauges).toHaveLength(1);
    expect(snap.summaries).toHaveLength(1);
  });

  it('snapshot arrays sorted by name then labels (JSON-string lex)', () => {
    const m = new MetricsAggregator();
    m.inc('zebra');
    m.inc('apple');
    m.inc('apple', { region: 'us' });
    m.inc('apple', { region: 'eu' });
    const snap = m.snapshot();
    // Primary sort: by name (apple before zebra).
    // Secondary sort: JSON.stringify of labels — `{"region":"eu"}` and
    // `{"region":"us"}` lex-sort BEFORE `{}` because `"` < `}`.
    const seen = snap.counters.map((c) => [c.name, c.labels]);
    expect(seen[0]![0]).toBe('apple');
    expect(seen[1]![0]).toBe('apple');
    expect(seen[2]![0]).toBe('apple');
    expect(seen[3]![0]).toBe('zebra');
    // All 3 apple series present.
    const appleRegions = seen.slice(0, 3).map((r) => (r[1] as Record<string, string>).region ?? '(none)');
    expect(appleRegions.sort()).toEqual(['(none)', 'eu', 'us']);
  });

  it('empty snapshot', () => {
    const m = new MetricsAggregator();
    expect(m.snapshot()).toEqual({ counters: [], gauges: [], summaries: [] });
  });
});

describe('MetricsAggregator — reset', () => {
  it('reset clears everything', () => {
    const m = new MetricsAggregator();
    m.inc('c');
    m.set('g', 5);
    m.observe('s', 10);
    m.reset();
    expect(m.size()).toBe(0);
    expect(m.snapshot()).toEqual({ counters: [], gauges: [], summaries: [] });
  });
});

describe('MetricsAggregator — counter + gauge + summary under same name (OK: different maps)', () => {
  it('same name in different types coexists', () => {
    const m = new MetricsAggregator();
    m.inc('x');
    m.set('x', 5);
    m.observe('x', 10);
    expect(m.getCounter('x')).toBe(1);
    expect(m.getGauge('x')).toBe(5);
    expect(m.getSummary('x')!.count).toBe(1);
  });
});
