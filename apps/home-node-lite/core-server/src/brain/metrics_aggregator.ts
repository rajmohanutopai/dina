/**
 * Metrics aggregator — in-memory counters + gauges with labels.
 *
 * Brain-server surface area is small enough that a full prom-client
 * dep is overkill. This primitive provides the essentials:
 *
 *   - `counter(name, labels?)` — monotonically increasing.
 *   - `gauge(name, labels?)` — settable up/down value.
 *   - `observe(name, value, labels?)` — summary-style, tracks
 *     count/sum/min/max/avg without full histogram buckets.
 *
 * **Labels** — `{region: 'us-west-2', method: 'POST'}`. Each distinct
 * label set is its own tracked series. Labels are canonicalised by
 * sorting keys so `{a: 1, b: 2}` and `{b: 2, a: 1}` dedupe.
 *
 * **Snapshot** — `snapshot()` returns plain-object JSON ready for
 * `/metrics` endpoints or log lines. No locking needed; brain is
 * single-threaded.
 *
 * **Validation** — metric names `[a-z][a-z0-9_]*`, label keys same
 * pattern, label values non-empty strings.
 *
 * **Pure state** — no IO, no timers. Caller wires `/metrics` route
 * + renders snapshot on demand.
 */

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export type Labels = Readonly<Record<string, string>>;

export interface CounterSnapshot {
  name: string;
  labels: Labels;
  value: number;
}

export interface GaugeSnapshot {
  name: string;
  labels: Labels;
  value: number;
}

export interface SummarySnapshot {
  name: string;
  labels: Labels;
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
}

export interface MetricsSnapshot {
  counters: CounterSnapshot[];
  gauges: GaugeSnapshot[];
  summaries: SummarySnapshot[];
}

export class MetricsError extends Error {
  constructor(
    public readonly code: 'invalid_name' | 'invalid_labels' | 'invalid_value',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'MetricsError';
  }
}

interface SummaryState {
  count: number;
  sum: number;
  min: number;
  max: number;
}

export class MetricsAggregator {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly summaries = new Map<string, SummaryState>();
  private readonly seriesKeys = new Map<string, { name: string; labels: Labels }>();

  size(): number {
    return this.counters.size + this.gauges.size + this.summaries.size;
  }

  /** Increment a counter by `delta` (default 1). */
  inc(name: string, labels: Labels = {}, delta = 1): void {
    validateName(name);
    validateLabels(labels);
    if (!Number.isFinite(delta) || delta < 0) {
      throw new MetricsError('invalid_value', 'counter delta must be non-negative finite');
    }
    const key = this.keyFor(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + delta);
  }

  /** Set a gauge to `value`. */
  set(name: string, value: number, labels: Labels = {}): void {
    validateName(name);
    validateLabels(labels);
    if (!Number.isFinite(value)) {
      throw new MetricsError('invalid_value', 'gauge value must be finite');
    }
    const key = this.keyFor(name, labels);
    this.gauges.set(key, value);
  }

  /** Add `delta` (may be negative) to a gauge. */
  add(name: string, delta: number, labels: Labels = {}): void {
    validateName(name);
    validateLabels(labels);
    if (!Number.isFinite(delta)) {
      throw new MetricsError('invalid_value', 'gauge delta must be finite');
    }
    const key = this.keyFor(name, labels);
    this.gauges.set(key, (this.gauges.get(key) ?? 0) + delta);
  }

  /** Observe a value in a summary-style metric. */
  observe(name: string, value: number, labels: Labels = {}): void {
    validateName(name);
    validateLabels(labels);
    if (!Number.isFinite(value)) {
      throw new MetricsError('invalid_value', 'observed value must be finite');
    }
    const key = this.keyFor(name, labels);
    const existing = this.summaries.get(key);
    if (!existing) {
      this.summaries.set(key, { count: 1, sum: value, min: value, max: value });
    } else {
      existing.count += 1;
      existing.sum += value;
      if (value < existing.min) existing.min = value;
      if (value > existing.max) existing.max = value;
    }
  }

  /** Read a counter's current value. Zero when never incremented. */
  getCounter(name: string, labels: Labels = {}): number {
    const key = this.keyFor(name, labels);
    return this.counters.get(key) ?? 0;
  }

  /** Read a gauge's current value. Zero when never set. */
  getGauge(name: string, labels: Labels = {}): number {
    const key = this.keyFor(name, labels);
    return this.gauges.get(key) ?? 0;
  }

  /** Read a summary's current snapshot. `null` when never observed. */
  getSummary(name: string, labels: Labels = {}): SummarySnapshot | null {
    const key = this.keyFor(name, labels);
    const s = this.summaries.get(key);
    if (!s) return null;
    const descriptor = this.seriesKeys.get(key)!;
    return toSummarySnapshot(descriptor, s);
  }

  snapshot(): MetricsSnapshot {
    const counters: CounterSnapshot[] = [];
    for (const [key, value] of this.counters) {
      const d = this.seriesKeys.get(key)!;
      counters.push({ name: d.name, labels: d.labels, value });
    }
    const gauges: GaugeSnapshot[] = [];
    for (const [key, value] of this.gauges) {
      const d = this.seriesKeys.get(key)!;
      gauges.push({ name: d.name, labels: d.labels, value });
    }
    const summaries: SummarySnapshot[] = [];
    for (const [key, s] of this.summaries) {
      const d = this.seriesKeys.get(key)!;
      summaries.push(toSummarySnapshot(d, s));
    }
    counters.sort(snapshotSort);
    gauges.sort(snapshotSort);
    summaries.sort(snapshotSort);
    return { counters, gauges, summaries };
  }

  /** Drop all metrics. */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.summaries.clear();
    this.seriesKeys.clear();
  }

  // ── Internals ────────────────────────────────────────────────────────

  private keyFor(name: string, labels: Labels): string {
    const entries = Object.entries(labels).sort((a, b) => a[0].localeCompare(b[0]));
    const parts = entries.map(([k, v]) => `${k}=${v}`).join(',');
    const key = `${name}{${parts}}`;
    if (!this.seriesKeys.has(key)) {
      // Freeze a canonical-order labels object for snapshots.
      const canonical: Record<string, string> = {};
      for (const [k, v] of entries) canonical[k] = v;
      this.seriesKeys.set(key, { name, labels: Object.freeze(canonical) });
    }
    return key;
  }
}

// ── Internals ──────────────────────────────────────────────────────────

function validateName(name: string): void {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new MetricsError('invalid_name', `name must match ${NAME_PATTERN.source}`);
  }
}

function validateLabels(labels: Labels): void {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
    throw new MetricsError('invalid_labels', 'labels must be a plain object');
  }
  for (const [k, v] of Object.entries(labels)) {
    if (!NAME_PATTERN.test(k)) {
      throw new MetricsError('invalid_labels', `label key "${k}" must match ${NAME_PATTERN.source}`);
    }
    if (typeof v !== 'string' || v === '') {
      throw new MetricsError('invalid_labels', `label "${k}" value must be non-empty string`);
    }
  }
}

function toSummarySnapshot(
  d: { name: string; labels: Labels },
  s: SummaryState,
): SummarySnapshot {
  return {
    name: d.name,
    labels: d.labels,
    count: s.count,
    sum: s.sum,
    min: s.min,
    max: s.max,
    avg: s.count > 0 ? s.sum / s.count : 0,
  };
}

function snapshotSort(
  a: { name: string; labels: Labels },
  b: { name: string; labels: Labels },
): number {
  if (a.name !== b.name) return a.name.localeCompare(b.name);
  const aKey = JSON.stringify(a.labels);
  const bKey = JSON.stringify(b.labels);
  return aKey.localeCompare(bKey);
}
