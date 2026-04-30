/**
 * Unit tests for `appview/src/shared/utils/metrics-aggregator.ts`
 * (TN-OBS-001 / Plan §13.8). Pins the aggregator's three contracts:
 *
 *   1. **Aggregation correctness** — counters monotonically sum,
 *      gauges store the latest value, histograms track count + sum.
 *   2. **Cardinality defence** — distinct label sets per metric
 *      capped at 10k; new combinations beyond the cap are silently
 *      dropped (with one warn log per metric per process lifetime).
 *   3. **Prometheus exposition format** — `# TYPE` headers, sorted
 *      labels, deterministic output (same-input → same-output),
 *      proper escaping of label values.
 *
 * Strategy: drive the aggregator directly (no DB, no HTTP), assert
 * via `serialize()`. The serialiser is the contract the `/metrics`
 * endpoint exposes, so pinning its output is what matters.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const mockLoggerWarn = vi.fn()
vi.mock('@/shared/utils/logger.js', () => ({
  logger: {
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

import { AggregatingMetrics } from '@/shared/utils/metrics-aggregator'

afterEach(() => {
  mockLoggerWarn.mockClear()
})

// ── Counter behaviour ──────────────────────────────────────────

describe('AggregatingMetrics — counters', () => {
  it('incr accumulates across calls (monotonic)', () => {
    const m = new AggregatingMetrics()
    m.incr('ingester.events.received')
    m.incr('ingester.events.received')
    m.incr('ingester.events.received')
    expect(m.serialize()).toContain('ingester.events.received 3')
  })

  it('counter() supports a custom increment value', () => {
    const m = new AggregatingMetrics()
    m.counter('scorer.batch.size', 50)
    m.counter('scorer.batch.size', 30)
    expect(m.serialize()).toContain('scorer.batch.size 80')
  })

  it('clamps negative counter values to 0 (counters never decrement)', () => {
    const m = new AggregatingMetrics()
    m.counter('weird.metric', 5)
    m.counter('weird.metric', -3) // clamped → +0
    expect(m.serialize()).toContain('weird.metric 5')
  })

  it('drops non-finite counter values silently', () => {
    const m = new AggregatingMetrics()
    m.counter('weird.metric', 5)
    m.counter('weird.metric', Number.NaN)
    m.counter('weird.metric', Number.POSITIVE_INFINITY)
    expect(m.serialize()).toContain('weird.metric 5')
  })

  it('groups by label set — same-name + different labels = independent series', () => {
    const m = new AggregatingMetrics()
    m.incr('ingester.rejections', { reason: 'rate_limit' })
    m.incr('ingester.rejections', { reason: 'rate_limit' })
    m.incr('ingester.rejections', { reason: 'schema_invalid' })
    const out = m.serialize()
    expect(out).toContain('ingester.rejections{reason="rate_limit"} 2')
    expect(out).toContain('ingester.rejections{reason="schema_invalid"} 1')
  })

  it('treats label-key insertion order as irrelevant (stable canonicalisation)', () => {
    // The aggregator MUST canonicalise label key order — otherwise
    // a callsite that passes `{a:1, b:2}` on one path and `{b:2, a:1}`
    // on another would produce two independent series for what is
    // logically the same labelset. Pinned by checking the
    // serialised count matches.
    const m = new AggregatingMetrics()
    m.incr('test.metric', { collection: 'c1', operation: 'create' })
    m.incr('test.metric', { operation: 'create', collection: 'c1' })
    expect(m.serialize()).toContain('test.metric{collection="c1",operation="create"} 2')
  })
})

// ── Gauge behaviour ────────────────────────────────────────────

describe('AggregatingMetrics — gauges', () => {
  it('stores the most-recent value (overwrites prior)', () => {
    const m = new AggregatingMetrics()
    m.gauge('ingester.queue.depth', 100)
    m.gauge('ingester.queue.depth', 250)
    m.gauge('ingester.queue.depth', 42)
    expect(m.serialize()).toContain('ingester.queue.depth 42')
  })

  it('coerces numeric strings (the existing call sites pass mixed types)', () => {
    const m = new AggregatingMetrics()
    m.gauge('ingester.connected', '1')
    expect(m.serialize()).toContain('ingester.connected 1')
  })

  it('drops non-numeric string values silently (well-formedness guard)', () => {
    const m = new AggregatingMetrics()
    m.gauge('weird.gauge', 'not-a-number')
    // No series should be emitted at all.
    expect(m.serialize()).toBe('')
  })
})

// ── Histogram behaviour ────────────────────────────────────────

describe('AggregatingMetrics — histograms (count + sum)', () => {
  it('emits _count and _sum lines', () => {
    const m = new AggregatingMetrics()
    m.histogram('xrpc.latency_ms', 100)
    m.histogram('xrpc.latency_ms', 200)
    m.histogram('xrpc.latency_ms', 300)
    const out = m.serialize()
    expect(out).toContain('# TYPE xrpc.latency_ms histogram')
    expect(out).toContain('xrpc.latency_ms_count 3')
    expect(out).toContain('xrpc.latency_ms_sum 600')
  })

  it('drops negative values silently (non-physical for durations)', () => {
    const m = new AggregatingMetrics()
    m.histogram('weird.histogram', 100)
    m.histogram('weird.histogram', -50) // dropped
    const out = m.serialize()
    expect(out).toContain('weird.histogram_count 1')
    expect(out).toContain('weird.histogram_sum 100')
  })

  it('groups by label set', () => {
    const m = new AggregatingMetrics()
    m.histogram('xrpc.latency_ms', 100, { method: 'search' })
    m.histogram('xrpc.latency_ms', 200, { method: 'search' })
    m.histogram('xrpc.latency_ms', 50, { method: 'resolve' })
    const out = m.serialize()
    expect(out).toContain('xrpc.latency_ms_count{method="search"} 2')
    expect(out).toContain('xrpc.latency_ms_sum{method="search"} 300')
    expect(out).toContain('xrpc.latency_ms_count{method="resolve"} 1')
    expect(out).toContain('xrpc.latency_ms_sum{method="resolve"} 50')
  })
})

// ── Prometheus text-format conformance ─────────────────────────

describe('AggregatingMetrics — Prometheus text-format conformance', () => {
  it('emits one # TYPE header per metric', () => {
    const m = new AggregatingMetrics()
    m.incr('counter.a')
    m.gauge('gauge.b', 1)
    m.histogram('hist.c', 1)
    const out = m.serialize()
    expect(out).toContain('# TYPE counter.a counter')
    expect(out).toContain('# TYPE gauge.b gauge')
    expect(out).toContain('# TYPE hist.c histogram')
  })

  it('sorts label keys alphabetically in the rendered form', () => {
    const m = new AggregatingMetrics()
    m.incr('test', { z: '1', a: '2', m: '3' })
    expect(m.serialize()).toContain('test{a="2",m="3",z="1"} 1')
  })

  it('escapes double-quote / backslash / newline in label values', () => {
    const m = new AggregatingMetrics()
    m.incr('test', { reason: 'has"quote' })
    m.incr('test', { reason: 'has\\backslash' })
    m.incr('test', { reason: 'has\nnewline' })
    const out = m.serialize()
    expect(out).toContain('test{reason="has\\"quote"} 1')
    expect(out).toContain('test{reason="has\\\\backslash"} 1')
    expect(out).toContain('test{reason="has\\nnewline"} 1')
  })

  it('returns empty string when no metrics have been emitted', () => {
    expect(new AggregatingMetrics().serialize()).toBe('')
  })

  it('emits a trailing newline (some scrapers are strict)', () => {
    const m = new AggregatingMetrics()
    m.incr('test')
    expect(m.serialize().endsWith('\n')).toBe(true)
  })

  it('produces deterministic output for the same input', () => {
    const m1 = new AggregatingMetrics()
    const m2 = new AggregatingMetrics()
    for (const m of [m1, m2]) {
      m.incr('a', { l: '1' })
      m.gauge('b', 5)
      m.histogram('c', 10)
    }
    expect(m1.serialize()).toBe(m2.serialize())
  })
})

// ── Cardinality defence ────────────────────────────────────────

describe('AggregatingMetrics — cardinality cap', () => {
  it('caps distinct label sets per metric at 10k (defaults to MAX_LABEL_SETS_PER_METRIC)', () => {
    const m = new AggregatingMetrics()
    // Simulate a cardinality bomb — a buggy callsite passing a
    // unique trace_id as a label.
    for (let i = 0; i < 10_500; i++) {
      m.incr('cardinality.test', { id: String(i) })
    }
    const out = m.serialize()
    // The first 10_000 entries are kept; the 10_001st onwards are
    // dropped with a single warn. We don't pin the exact count but
    // confirm the cap was enforced.
    const lines = out.split('\n').filter((l) => l.startsWith('cardinality.test{'))
    expect(lines.length).toBeLessThanOrEqual(10_000)
    expect(lines.length).toBeGreaterThan(0)
  })

  it('logs ONE warn per metric when the cap is hit (not per dropped event)', () => {
    const m = new AggregatingMetrics()
    for (let i = 0; i < 10_100; i++) {
      m.incr('cardinality.test2', { id: String(i) })
    }
    // Operator drowning is its own footgun — the warn fires once,
    // then drops are silent.
    const capWarnCalls = mockLoggerWarn.mock.calls.filter((call) => {
      const msg = call[1] as string
      return typeof msg === 'string' && msg.includes('label-set cap hit')
    })
    expect(capWarnCalls.length).toBe(1)
  })

  it('continues to update existing label sets after the cap is hit', () => {
    // The cap drops NEW combinations, but existing ones still
    // accumulate. Pinned because losing increments to known buckets
    // would make the ingest-rate metric undercount during a flood.
    const m = new AggregatingMetrics()
    m.incr('test.metric', { id: 'known' })
    for (let i = 0; i < 10_100; i++) {
      m.incr('test.metric', { id: String(i) })
    }
    // The 'known' bucket should still be 1 (the unique '0'..'10099'
    // ids include '1' but not 'known'). It should still be
    // serialised.
    expect(m.serialize()).toContain('test.metric{id="known"} 1')
  })
})

// ── Type-mismatch guard ────────────────────────────────────────

describe('AggregatingMetrics — type-mismatch defence', () => {
  it('rejects re-registration of a metric under a different type (warn + ignore)', () => {
    const m = new AggregatingMetrics()
    m.incr('was.a.counter')
    m.gauge('was.a.counter', 100) // attempted re-register as gauge
    const out = m.serialize()
    // The metric stays a counter; the gauge call is silently dropped
    // with a warn.
    expect(out).toContain('# TYPE was.a.counter counter')
    expect(out).not.toContain('# TYPE was.a.counter gauge')
    const mismatchWarn = mockLoggerWarn.mock.calls.find((call) => {
      const msg = call[1] as string
      return typeof msg === 'string' && msg.includes('type mismatch')
    })
    expect(mismatchWarn).toBeDefined()
  })
})

// ── Reset (test-only helper) ───────────────────────────────────

describe('AggregatingMetrics — reset()', () => {
  it('clears all state', () => {
    const m = new AggregatingMetrics()
    m.incr('test')
    m.gauge('g', 100)
    m.histogram('h', 50)
    expect(m.serialize()).not.toBe('')
    m.reset()
    expect(m.serialize()).toBe('')
  })
})
