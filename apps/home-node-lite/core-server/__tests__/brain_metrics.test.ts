/**
 * Task 5.54 — BrainMetricsRegistry tests.
 */

import { BrainMetricsRegistry } from '../src/brain/brain_metrics';

describe('BrainMetricsRegistry — registration (task 5.54)', () => {
  it.each([
    ['invalid name (empty)', ''],
    ['invalid name (leading digit)', '1bad'],
    ['invalid name (hyphen)', 'bad-name'],
    ['invalid name (space)', 'bad name'],
  ])('rejects counter with %s', (_label, name) => {
    const r = new BrainMetricsRegistry();
    expect(() => r.counter({ name, help: 'x' })).toThrow();
  });

  it('rejects empty help', () => {
    const r = new BrainMetricsRegistry();
    expect(() => r.counter({ name: 'ok', help: '' })).toThrow(/help/);
  });

  it('rejects duplicate name', () => {
    const r = new BrainMetricsRegistry();
    r.counter({ name: 'x', help: 'y' });
    expect(() => r.counter({ name: 'x', help: 'z' })).toThrow(/already/);
    expect(() => r.gauge({ name: 'x', help: 'z' })).toThrow(/already/);
  });

  it('rejects invalid label names', () => {
    const r = new BrainMetricsRegistry();
    expect(() =>
      r.counter({ name: 'x', help: 'y', labels: ['bad-label'] }),
    ).toThrow();
  });

  it('has + size + get work', () => {
    const r = new BrainMetricsRegistry();
    expect(r.has('x')).toBe(false);
    r.counter({ name: 'x', help: 'y' });
    expect(r.has('x')).toBe(true);
    expect(r.size()).toBe(1);
    expect(r.get('x')).not.toBeNull();
    expect(r.get('missing')).toBeNull();
  });
});

describe('Counter', () => {
  it('starts at 0 + increments', () => {
    const r = new BrainMetricsRegistry();
    const c = r.counter({ name: 'reqs', help: 'Requests' });
    expect(c.value()).toBe(0);
    c.inc();
    c.inc();
    c.inc({}, 5);
    expect(c.value()).toBe(7);
  });

  it('rejects negative delta', () => {
    const r = new BrainMetricsRegistry();
    const c = r.counter({ name: 'x', help: 'y' });
    expect(() => c.inc({}, -1)).toThrow(/non-negative/);
  });

  it('labels partition time series', () => {
    const r = new BrainMetricsRegistry();
    const c = r.counter({ name: 'reqs', help: 'x', labels: ['persona', 'status'] });
    c.inc({ persona: 'work', status: '200' });
    c.inc({ persona: 'work', status: '200' });
    c.inc({ persona: 'health', status: '500' });
    expect(c.value({ persona: 'work', status: '200' })).toBe(2);
    expect(c.value({ persona: 'health', status: '500' })).toBe(1);
    expect(c.value({ persona: 'work', status: '500' })).toBe(0);
  });

  it('label mismatch throws', () => {
    const r = new BrainMetricsRegistry();
    const c = r.counter({ name: 'x', help: 'y', labels: ['a'] });
    expect(() => c.inc({})).toThrow(/label mismatch/);
    expect(() => c.inc({ a: '1', b: '2' })).toThrow(/label mismatch/);
    expect(() => c.inc({ a: 1 } as unknown as Record<string, string>)).toThrow(/string/);
  });
});

describe('Gauge', () => {
  it('set/inc/dec/value', () => {
    const r = new BrainMetricsRegistry();
    const g = r.gauge({ name: 'inflight', help: 'In-flight requests' });
    g.set(5);
    expect(g.value()).toBe(5);
    g.inc();
    expect(g.value()).toBe(6);
    g.dec({}, 2);
    expect(g.value()).toBe(4);
  });

  it('rejects non-finite values', () => {
    const r = new BrainMetricsRegistry();
    const g = r.gauge({ name: 'x', help: 'y' });
    expect(() => g.set(NaN)).toThrow();
    expect(() => g.set(Infinity)).toThrow();
  });

  it('can go negative (unlike counter)', () => {
    const r = new BrainMetricsRegistry();
    const g = r.gauge({ name: 'x', help: 'y' });
    g.dec({}, 5);
    expect(g.value()).toBe(-5);
  });

  it('labelled gauge partitions', () => {
    const r = new BrainMetricsRegistry();
    const g = r.gauge({ name: 'tasks', help: 'x', labels: ['kind'] });
    g.set({ kind: 'guardian' }, 3);
    g.set({ kind: 'msgbox' }, 7);
    expect(g.value({ kind: 'guardian' })).toBe(3);
    expect(g.value({ kind: 'msgbox' })).toBe(7);
  });
});

describe('Histogram', () => {
  it('observes into buckets + sum + count', () => {
    const r = new BrainMetricsRegistry();
    const h = r.histogram({
      name: 'latency_ms',
      help: 'Latency',
      buckets: [10, 50, 100, 500],
    });
    h.observe(5);
    h.observe(30);
    h.observe(200);
    expect(h.count()).toBe(3);
    expect(h.sum()).toBe(235);
  });

  it('rejects empty buckets', () => {
    const r = new BrainMetricsRegistry();
    expect(() =>
      r.histogram({ name: 'x', help: 'y', buckets: [] }),
    ).toThrow(/non-empty/);
  });

  it('rejects non-ascending buckets', () => {
    const r = new BrainMetricsRegistry();
    expect(() =>
      r.histogram({ name: 'x', help: 'y', buckets: [10, 5, 20] }),
    ).toThrow(/ascending/);
  });

  it('rejects non-finite buckets', () => {
    const r = new BrainMetricsRegistry();
    expect(() =>
      r.histogram({ name: 'x', help: 'y', buckets: [10, NaN] }),
    ).toThrow(/finite/);
  });

  it('labelled histogram partitions', () => {
    const r = new BrainMetricsRegistry();
    const h = r.histogram({
      name: 'latency_ms',
      help: 'Latency',
      buckets: [10, 100],
      labels: ['endpoint'],
    });
    h.observe({ endpoint: '/ask' }, 50);
    h.observe({ endpoint: '/ask' }, 200);
    h.observe({ endpoint: '/reason' }, 5);
    expect(h.count({ endpoint: '/ask' })).toBe(2);
    expect(h.count({ endpoint: '/reason' })).toBe(1);
    expect(h.sum({ endpoint: '/ask' })).toBe(250);
  });
});

describe('render — Prometheus text format', () => {
  it('emits HELP + TYPE + sample for a simple counter', () => {
    const r = new BrainMetricsRegistry();
    const c = r.counter({ name: 'reqs', help: 'Total requests.' });
    c.inc({}, 3);
    const text = r.render();
    expect(text).toContain('# HELP reqs Total requests.');
    expect(text).toContain('# TYPE reqs counter');
    expect(text).toContain('reqs 3');
  });

  it('emits zero sample for a freshly-registered metric with no labels', () => {
    const r = new BrainMetricsRegistry();
    r.counter({ name: 'reqs', help: 'Total requests.' });
    expect(r.render()).toContain('reqs 0');
  });

  it('metrics rendered alphabetically', () => {
    const r = new BrainMetricsRegistry();
    r.counter({ name: 'zeta', help: 'z' });
    r.counter({ name: 'alpha', help: 'a' });
    r.counter({ name: 'mu', help: 'm' });
    const text = r.render();
    const alphaPos = text.indexOf('alpha');
    const muPos = text.indexOf('mu');
    const zetaPos = text.indexOf('zeta');
    expect(alphaPos).toBeLessThan(muPos);
    expect(muPos).toBeLessThan(zetaPos);
  });

  it('counters with labels render one sample per label set', () => {
    const r = new BrainMetricsRegistry();
    const c = r.counter({ name: 'reqs', help: 'x', labels: ['status'] });
    c.inc({ status: '200' }, 5);
    c.inc({ status: '500' }, 2);
    const text = r.render();
    expect(text).toContain('reqs{status="200"} 5');
    expect(text).toContain('reqs{status="500"} 2');
  });

  it('escapes label values', () => {
    const r = new BrainMetricsRegistry();
    const c = r.counter({ name: 'x', help: 'y', labels: ['path'] });
    c.inc({ path: 'a"b\\c\nd' }, 1);
    const text = r.render();
    expect(text).toContain('path="a\\"b\\\\c\\nd"');
  });

  it('histogram renders _bucket + _sum + _count', () => {
    const r = new BrainMetricsRegistry();
    const h = r.histogram({
      name: 'lat',
      help: 'latency',
      buckets: [10, 50, 100],
    });
    h.observe(5);
    h.observe(75);
    const text = r.render();
    expect(text).toContain('lat_bucket{le="10"} 1');
    expect(text).toContain('lat_bucket{le="50"} 1');
    expect(text).toContain('lat_bucket{le="100"} 2');
    expect(text).toContain('lat_bucket{le="+Inf"} 2');
    expect(text).toContain('lat_sum 80');
    expect(text).toContain('lat_count 2');
  });

  it('empty histogram emits zero buckets (initialise scrapers)', () => {
    const r = new BrainMetricsRegistry();
    r.histogram({ name: 'h', help: 'h', buckets: [10, 20] });
    const text = r.render();
    expect(text).toContain('h_bucket{le="10"} 0');
    expect(text).toContain('h_bucket{le="20"} 0');
    expect(text).toContain('h_bucket{le="+Inf"} 0');
    expect(text).toContain('h_sum 0');
    expect(text).toContain('h_count 0');
  });

  it('gauge with labels', () => {
    const r = new BrainMetricsRegistry();
    const g = r.gauge({ name: 'queue', help: 'x', labels: ['kind'] });
    g.set({ kind: 'guardian' }, 3);
    g.set({ kind: 'msgbox' }, 7);
    const text = r.render();
    expect(text).toContain('queue{kind="guardian"} 3');
    expect(text).toContain('queue{kind="msgbox"} 7');
  });

  it('label-value key is canonical (same order regardless of input order)', () => {
    const r = new BrainMetricsRegistry();
    const c = r.counter({ name: 'x', help: 'y', labels: ['a', 'b'] });
    c.inc({ a: '1', b: '2' });
    c.inc({ b: '2', a: '1' }); // same logical key — should land in the same series
    expect(c.value({ a: '1', b: '2' })).toBe(2);
  });
});

describe('reset', () => {
  it('zeroes every sample but keeps registrations', () => {
    const r = new BrainMetricsRegistry();
    const c = r.counter({ name: 'x', help: 'y' });
    const h = r.histogram({ name: 'h', help: 'z', buckets: [1] });
    c.inc({}, 10);
    h.observe(0.5);
    r.reset();
    expect(c.value()).toBe(0);
    expect(h.count()).toBe(0);
    // Registration preserved — can still use after reset.
    c.inc({}, 1);
    expect(c.value()).toBe(1);
  });
});

describe('realistic brain metric wiring', () => {
  it('reports /ask activity + LLM latency + in-flight gauge', () => {
    const r = new BrainMetricsRegistry();
    const askTotal = r.counter({
      name: 'brain_ask_total',
      help: 'Total /ask requests.',
      labels: ['outcome'],
    });
    const askLatency = r.histogram({
      name: 'brain_ask_latency_ms',
      help: 'End-to-end /ask latency in ms.',
      buckets: [50, 100, 500, 1000, 5000],
    });
    const inflight = r.gauge({
      name: 'brain_ask_inflight',
      help: 'In-flight /ask requests.',
    });
    inflight.set(0);
    inflight.inc();
    askTotal.inc({ outcome: 'ok' });
    askLatency.observe(42);
    inflight.dec();

    const text = r.render();
    expect(text).toContain('brain_ask_total{outcome="ok"} 1');
    expect(text).toContain('brain_ask_latency_ms_count 1');
    expect(text).toContain('brain_ask_latency_ms_sum 42');
    expect(text).toContain('brain_ask_inflight 0');
  });
});
