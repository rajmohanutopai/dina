/**
 * In-memory metrics aggregator that exposes a Prometheus-text-format
 * serialiser (TN-OBS-001 / Plan §13.8).
 *
 * The existing `LoggingMetrics` (in `metrics.ts`) emits each event
 * as a structured log line — useful for log-aggregator dashboards
 * (Loki / CloudWatch / ELK) but invisible to a Prometheus scraper.
 * `AggregatingMetrics` keeps a running tally per (name, sorted-label-
 * set) so the AppView's `/metrics` HTTP endpoint can emit the
 * Prometheus exposition format.
 *
 * **Why both** (structured logs + aggregator) — see
 * `CompositeMetrics` in `metrics.ts`. Operators picking Loki for
 * everything keep the log path; operators picking Prometheus +
 * Grafana scrape `/metrics`. Each path is the source of truth for
 * its own consumer; we don't try to reconcile them.
 *
 * **Cardinality defence**: each metric has a hard cap on the number
 * of distinct label sets it tracks (`MAX_LABEL_SETS_PER_METRIC =
 * 10000`). When the cap is hit, additional label combinations are
 * silently dropped (with a single warning log line per metric per
 * process lifetime — drowning operators in cap warnings is its own
 * footgun). This bounds memory regardless of what callers pass; an
 * accidental high-cardinality label like `trace_id` won't OOM the
 * AppView. The cap is generous (10k × 8 metrics ≈ 80k entries ≈
 * single-digit MB) so legitimate label combinations stay under
 * indefinitely.
 *
 * **Histogram approximation**: V1 stores count + sum only (Prometheus
 * "summary"-style — emitted as `<name>_count` and `<name>_sum`).
 * Full histograms with bucket boundaries are V2 work; the current
 * shape supports the operationally-relevant queries
 * (rate, average) without the complexity of bucket-boundary
 * configuration.
 */

import { logger } from './logger.js'
import type { Metrics } from './metrics.js'

/** Hard cap on distinct label sets per metric — defends against
 *  accidental high-cardinality labels. */
const MAX_LABEL_SETS_PER_METRIC = 10_000

/** Prometheus metric type emitted in `# TYPE` headers. */
type PromType = 'counter' | 'gauge' | 'histogram'

interface MetricSeries {
  type: PromType
  /** Map from `labelKey` (sorted joined string) → value. */
  values: Map<string, number>
  /** Map from `labelKey` → original parsed labels (so the serialiser
   *  can rebuild `name{k="v"}` form). */
  labels: Map<string, Record<string, string>>
  /** Histogram-only: per-labelset running sum. */
  histogramSum: Map<string, number>
  /** Histogram-only: per-labelset count. */
  histogramCount: Map<string, number>
  capWarned: boolean
}

/**
 * Stable label-key encoding: sort by key, join `k="v"` with commas.
 * Two calls with `{a: '1', b: '2'}` and `{b: '2', a: '1'}` produce
 * the same key — pinned by test.
 *
 * The encoding doesn't escape Prometheus text-format reserved chars
 * (backslash, double-quote, newline) — see `escapeLabelValue` for
 * the per-value escaping at serialisation time. Keys are control-
 * char-free in the calling code (label keys are static strings in
 * the source); we don't validate at runtime.
 */
function labelKey(labels?: Record<string, string>): string {
  if (!labels) return ''
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return ''
  const parts: string[] = []
  for (const k of keys) {
    parts.push(`${k}=${labels[k]}`)
  }
  return parts.join(',')
}

/** Escape a label value for Prometheus text format. Backslashes,
 *  double quotes, and newlines must be escaped per the spec. */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/** Render a label set in Prometheus text-format `{k="v",k2="v2"}`
 *  form, with sorted keys for deterministic output. */
function renderLabels(labels?: Record<string, string>): string {
  if (!labels) return ''
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return ''
  const parts: string[] = []
  for (const k of keys) {
    parts.push(`${k}="${escapeLabelValue(labels[k])}"`)
  }
  return `{${parts.join(',')}}`
}

export class AggregatingMetrics implements Metrics {
  private readonly series = new Map<string, MetricSeries>()

  private getOrInit(name: string, type: PromType): MetricSeries {
    let s = this.series.get(name)
    if (s !== undefined) {
      // Type-mismatch guard: a metric that was registered as a counter
      // must not be re-registered as a gauge mid-process. Drop the
      // re-registration silently with a warn — the operator dashboard
      // would show inconsistent series otherwise.
      if (s.type !== type) {
        logger.warn(
          { metric: name, existingType: s.type, attemptedType: type },
          'metrics aggregator: type mismatch — keeping existing type',
        )
      }
      return s
    }
    s = {
      type,
      values: new Map(),
      labels: new Map(),
      histogramSum: new Map(),
      histogramCount: new Map(),
      capWarned: false,
    }
    this.series.set(name, s)
    return s
  }

  /**
   * Bump a counter by 1 (or initialise to 1 if first sighting).
   * Counters are monotonically increasing — we never decrement.
   */
  incr(name: string, tags?: Record<string, string>): void {
    this.counter(name, 1, tags)
  }

  /**
   * Bump a counter by a specific value. Negative values are silently
   * clamped to 0 (a counter that goes backwards is a bug; clamping
   * is preferable to crashing the metric path).
   */
  counter(name: string, value: number, tags?: Record<string, string>): void {
    if (!Number.isFinite(value)) return
    const delta = Math.max(0, value)
    const s = this.getOrInit(name, 'counter')
    const key = labelKey(tags)
    if (!s.values.has(key) && s.values.size >= MAX_LABEL_SETS_PER_METRIC) {
      if (!s.capWarned) {
        logger.warn(
          { metric: name, cap: MAX_LABEL_SETS_PER_METRIC },
          'metrics aggregator: label-set cap hit — dropping new combinations',
        )
        s.capWarned = true
      }
      return
    }
    s.values.set(key, (s.values.get(key) ?? 0) + delta)
    if (tags && !s.labels.has(key)) s.labels.set(key, { ...tags })
  }

  /**
   * Set a gauge to the supplied value. Drizzle accepts strings (e.g.
   * for size-with-suffix metrics like `'10kb'`), but we only track
   * numeric values — non-numeric inputs are silently dropped to keep
   * the Prometheus output well-formed.
   */
  gauge(
    name: string,
    value: number | string,
    tags?: Record<string, string>,
  ): void {
    const num = typeof value === 'number' ? value : Number.parseFloat(value)
    if (!Number.isFinite(num)) return
    const s = this.getOrInit(name, 'gauge')
    const key = labelKey(tags)
    if (!s.values.has(key) && s.values.size >= MAX_LABEL_SETS_PER_METRIC) {
      if (!s.capWarned) {
        logger.warn(
          { metric: name, cap: MAX_LABEL_SETS_PER_METRIC },
          'metrics aggregator: label-set cap hit — dropping new combinations',
        )
        s.capWarned = true
      }
      return
    }
    s.values.set(key, num)
    if (tags && !s.labels.has(key)) s.labels.set(key, { ...tags })
  }

  /**
   * Record a single observation in a histogram-style metric. V1 keeps
   * count + sum only (summary-style). Negative values are silently
   * dropped (durations / sizes / counts shouldn't be negative — a
   * caller bug, not a metric to expose). Non-finite values dropped
   * for the same well-formedness reason as gauge.
   */
  histogram(
    name: string,
    value: number,
    tags?: Record<string, string>,
  ): void {
    if (!Number.isFinite(value) || value < 0) return
    const s = this.getOrInit(name, 'histogram')
    const key = labelKey(tags)
    if (!s.histogramCount.has(key) && s.histogramCount.size >= MAX_LABEL_SETS_PER_METRIC) {
      if (!s.capWarned) {
        logger.warn(
          { metric: name, cap: MAX_LABEL_SETS_PER_METRIC },
          'metrics aggregator: label-set cap hit — dropping new combinations',
        )
        s.capWarned = true
      }
      return
    }
    s.histogramSum.set(key, (s.histogramSum.get(key) ?? 0) + value)
    s.histogramCount.set(key, (s.histogramCount.get(key) ?? 0) + 1)
    if (tags && !s.labels.has(key)) s.labels.set(key, { ...tags })
  }

  /**
   * Serialise to Prometheus text exposition format (per
   * https://prometheus.io/docs/instrumenting/exposition_formats/).
   *
   * Output shape:
   *   # TYPE <name> <type>
   *   <name>{k="v",k2="v2"} <value>
   *   <name>{k="v",k3="v3"} <value>
   *
   * Histograms emit two lines per labelset:
   *   <name>_count{...} <count>
   *   <name>_sum{...} <sum>
   *
   * Metric names are emitted in insertion order; label keys within a
   * labelset are sorted (deterministic — same-input → same-output,
   * regression-pinned by test).
   */
  serialize(): string {
    const lines: string[] = []
    for (const [name, s] of this.series.entries()) {
      // # TYPE header — Prometheus uses `histogram` for our summary-
      // style emission too; the text-format spec accepts emitting
      // `_count` and `_sum` alone, so the histogram type header is
      // technically the right choice. Pinned by test.
      lines.push(`# TYPE ${name} ${s.type}`)
      if (s.type === 'histogram') {
        for (const [key, count] of s.histogramCount.entries()) {
          const labelStr = renderLabels(s.labels.get(key))
          const sum = s.histogramSum.get(key) ?? 0
          lines.push(`${name}_count${labelStr} ${count}`)
          lines.push(`${name}_sum${labelStr} ${sum}`)
        }
      } else {
        for (const [key, value] of s.values.entries()) {
          const labelStr = renderLabels(s.labels.get(key))
          lines.push(`${name}${labelStr} ${value}`)
        }
      }
    }
    // Trailing newline per Prometheus convention (some scrapers are
    // strict about it).
    return lines.length === 0 ? '' : lines.join('\n') + '\n'
  }

  /** Test-only helper: clear all state. Production callers never
   *  need this (the aggregator is process-lifetime). */
  reset(): void {
    this.series.clear()
  }
}
