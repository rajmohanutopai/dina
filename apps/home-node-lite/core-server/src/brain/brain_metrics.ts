/**
 * Task 5.54 — /metrics endpoint (Prometheus text format).
 *
 * Python Brain exposes a Prometheus `/metrics` endpoint; Home Node
 * Lite Brain must expose the same so existing ops dashboards +
 * alerting rules work without changes. This primitive is the
 * in-process metric collector + text-format exporter the Fastify
 * `/metrics` route consumes.
 *
 * **Metric types** (Prometheus subset sufficient for Brain):
 *   - **Counter** — monotonically increasing (requests, errors, ask
 *     events). Only `inc(delta=1)` mutation.
 *   - **Gauge** — current value, can go up or down (in-flight asks,
 *     cached personas, queue depth). `set`, `inc`, `dec`.
 *   - **Histogram** — bucket-based distribution (request latency,
 *     LLM token usage). Fixed-bucket boundaries at construction.
 *     `observe(value)` increments the matching bucket + sum + count.
 *
 * **Labels**: each metric may declare fixed label keys at
 * registration. `counter.inc({persona: 'health'})` routes to a
 * per-label-value time series. Cardinality is the caller's problem
 * — the registry doesn't cap.
 *
 * **Text format**: `render()` emits the Prometheus text format
 * (version 0.0.4). Order: HELP + TYPE + sample lines, one metric
 * at a time, alphabetical by metric name for diff-friendliness.
 *
 * **Reserved metric names**: `^[a-zA-Z_][a-zA-Z0-9_]*$`. Labels
 * use the same rule. Violations throw at registration.
 *
 * **Not a dependency on `prom-client`** — deliberately self-contained.
 * Prom-client pulls in ~500KB of transitive deps the Home Node
 * Lite budget doesn't want; this is 300 lines of pure text
 * generation.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5g task 5.54.
 */

export type MetricType = 'counter' | 'gauge' | 'histogram';

/** Label values — arbitrary strings; registry validates key names, not values. */
export type LabelValues = Record<string, string>;

/** Common metric options used by every type. */
export interface MetricOptionsBase {
  /** Metric name. Must match `^[a-zA-Z_][a-zA-Z0-9_]*$`. */
  name: string;
  /** Human-readable help string — rendered as `# HELP`. */
  help: string;
  /**
   * Optional label-key schema. Every `inc/observe/set` call must
   * supply values for exactly these keys — no extras, no omissions.
   * Defaults to `[]` (no labels).
   */
  labels?: readonly string[];
}

export interface HistogramOptions extends MetricOptionsBase {
  /**
   * Bucket upper-bound values (inclusive). Must be sorted ascending +
   * finite. The registry auto-appends `+Inf` in the output.
   */
  buckets: readonly number[];
}

/** Guard for valid Prometheus identifier (metric + label names). */
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

interface CounterEntry {
  type: 'counter';
  name: string;
  help: string;
  labels: readonly string[];
  /** Key → accumulated value. Key is `labels-stringified` (see `labelKey`). */
  samples: Map<string, number>;
}

interface GaugeEntry {
  type: 'gauge';
  name: string;
  help: string;
  labels: readonly string[];
  samples: Map<string, number>;
}

interface HistogramEntry {
  type: 'histogram';
  name: string;
  help: string;
  labels: readonly string[];
  buckets: readonly number[];
  /** Key → per-bucket cumulative counts (length = buckets.length + 1 for +Inf). */
  bucketCounts: Map<string, number[]>;
  /** Key → sum of observations. */
  sum: Map<string, number>;
  /** Key → count of observations. */
  count: Map<string, number>;
}

type MetricEntry = CounterEntry | GaugeEntry | HistogramEntry;

/**
 * In-process metrics collector. Register metrics at boot, update
 * from call-sites, render to `/metrics` text on demand.
 */
export class BrainMetricsRegistry {
  private readonly metrics: Map<string, MetricEntry> = new Map();

  /**
   * Register a counter. Returns a typed handle the caller invokes
   * with `inc()`. Registering the same name twice throws.
   */
  counter(opts: MetricOptionsBase): CounterHandle {
    const entry = registerBase<CounterEntry>(this.metrics, opts, 'counter', {
      samples: new Map(),
    });
    return new CounterHandle(entry);
  }

  gauge(opts: MetricOptionsBase): GaugeHandle {
    const entry = registerBase<GaugeEntry>(this.metrics, opts, 'gauge', {
      samples: new Map(),
    });
    return new GaugeHandle(entry);
  }

  histogram(opts: HistogramOptions): HistogramHandle {
    validateBuckets(opts.buckets);
    const entry = registerBase<HistogramEntry>(this.metrics, opts, 'histogram', {
      buckets: [...opts.buckets],
      bucketCounts: new Map(),
      sum: new Map(),
      count: new Map(),
    });
    return new HistogramHandle(entry);
  }

  /** Lookup handle for an already-registered metric. Useful for route wiring. */
  get(name: string): CounterHandle | GaugeHandle | HistogramHandle | null {
    const entry = this.metrics.get(name);
    if (!entry) return null;
    if (entry.type === 'counter') return new CounterHandle(entry);
    if (entry.type === 'gauge') return new GaugeHandle(entry);
    return new HistogramHandle(entry);
  }

  /** True when a metric is registered under `name`. */
  has(name: string): boolean {
    return this.metrics.has(name);
  }

  /** Count of registered metrics. */
  size(): number {
    return this.metrics.size;
  }

  /**
   * Emit the full Prometheus text-format exposition. Metrics are
   * rendered alphabetically by name. Samples within a metric are
   * sorted by label-value key for diff stability.
   */
  render(): string {
    const names = Array.from(this.metrics.keys()).sort();
    const chunks: string[] = [];
    for (const name of names) {
      const entry = this.metrics.get(name)!;
      chunks.push(renderEntry(entry));
    }
    return chunks.join('\n');
  }

  /**
   * Test-only: reset every metric to zero samples. Does NOT remove
   * registrations. Useful between unit tests that share a registry
   * instance.
   */
  reset(): void {
    for (const entry of this.metrics.values()) {
      if (entry.type === 'histogram') {
        entry.bucketCounts.clear();
        entry.sum.clear();
        entry.count.clear();
      } else {
        entry.samples.clear();
      }
    }
  }
}

// ── Handles ────────────────────────────────────────────────────────────

export class CounterHandle {
  constructor(private readonly entry: CounterEntry) {}

  /** Increment by `delta` (default 1). `delta >= 0` — monotonic. */
  inc(labels: LabelValues = {}, delta = 1): void {
    if (!Number.isFinite(delta) || delta < 0) {
      throw new RangeError(
        `CounterHandle.inc: delta must be a non-negative finite number (got ${delta})`,
      );
    }
    validateLabels(this.entry.labels, labels);
    const key = labelKey(this.entry.labels, labels);
    this.entry.samples.set(key, (this.entry.samples.get(key) ?? 0) + delta);
  }

  /** Test-only: read current value for a label set. */
  value(labels: LabelValues = {}): number {
    return this.entry.samples.get(labelKey(this.entry.labels, labels)) ?? 0;
  }
}

export class GaugeHandle {
  constructor(private readonly entry: GaugeEntry) {}

  set(labels: LabelValues, value: number): void;
  set(value: number): void;
  set(a: LabelValues | number, b?: number): void {
    const [labels, value] = typeof a === 'number' ? [{}, a] : [a, b!];
    if (!Number.isFinite(value)) {
      throw new RangeError(`GaugeHandle.set: value must be finite (got ${value})`);
    }
    validateLabels(this.entry.labels, labels);
    this.entry.samples.set(labelKey(this.entry.labels, labels), value);
  }

  inc(labels: LabelValues = {}, delta = 1): void {
    if (!Number.isFinite(delta)) {
      throw new RangeError(`GaugeHandle.inc: delta must be finite`);
    }
    validateLabels(this.entry.labels, labels);
    const key = labelKey(this.entry.labels, labels);
    this.entry.samples.set(key, (this.entry.samples.get(key) ?? 0) + delta);
  }

  dec(labels: LabelValues = {}, delta = 1): void {
    this.inc(labels, -delta);
  }

  value(labels: LabelValues = {}): number {
    return this.entry.samples.get(labelKey(this.entry.labels, labels)) ?? 0;
  }
}

export class HistogramHandle {
  constructor(private readonly entry: HistogramEntry) {}

  observe(labels: LabelValues, value: number): void;
  observe(value: number): void;
  observe(a: LabelValues | number, b?: number): void {
    const [labels, value] = typeof a === 'number' ? [{}, a] : [a, b!];
    if (!Number.isFinite(value)) {
      throw new RangeError(`HistogramHandle.observe: value must be finite`);
    }
    validateLabels(this.entry.labels, labels);
    const key = labelKey(this.entry.labels, labels);
    const counts =
      this.entry.bucketCounts.get(key) ??
      new Array(this.entry.buckets.length + 1).fill(0);
    for (let i = 0; i < this.entry.buckets.length; i++) {
      if (value <= this.entry.buckets[i]!) counts[i]++;
    }
    // +Inf bucket always counts (it's cumulative — catches everything).
    counts[this.entry.buckets.length]++;
    this.entry.bucketCounts.set(key, counts);
    this.entry.sum.set(key, (this.entry.sum.get(key) ?? 0) + value);
    this.entry.count.set(key, (this.entry.count.get(key) ?? 0) + 1);
  }

  count(labels: LabelValues = {}): number {
    return this.entry.count.get(labelKey(this.entry.labels, labels)) ?? 0;
  }

  sum(labels: LabelValues = {}): number {
    return this.entry.sum.get(labelKey(this.entry.labels, labels)) ?? 0;
  }
}

// ── Internals ──────────────────────────────────────────────────────────

function registerBase<E extends MetricEntry>(
  registry: Map<string, MetricEntry>,
  opts: MetricOptionsBase,
  type: MetricType,
  extra: Omit<E, 'type' | 'name' | 'help' | 'labels'>,
): E {
  if (typeof opts?.name !== 'string' || !NAME_RE.test(opts.name)) {
    throw new TypeError(
      `BrainMetricsRegistry: metric name must match ${NAME_RE} (got "${opts?.name}")`,
    );
  }
  if (typeof opts.help !== 'string' || opts.help.trim() === '') {
    throw new TypeError(
      `BrainMetricsRegistry: metric "${opts.name}" must have a non-empty help string`,
    );
  }
  if (registry.has(opts.name)) {
    throw new Error(
      `BrainMetricsRegistry: metric "${opts.name}" already registered`,
    );
  }
  const labels = opts.labels ?? [];
  for (const lbl of labels) {
    if (typeof lbl !== 'string' || !NAME_RE.test(lbl)) {
      throw new TypeError(
        `BrainMetricsRegistry: label "${lbl}" on "${opts.name}" must match ${NAME_RE}`,
      );
    }
  }
  const entry = {
    type,
    name: opts.name,
    help: opts.help,
    labels: [...labels],
    ...extra,
  } as unknown as E;
  registry.set(opts.name, entry);
  return entry;
}

function validateBuckets(buckets: readonly number[]): void {
  if (!Array.isArray(buckets) || buckets.length === 0) {
    throw new TypeError('Histogram: buckets must be a non-empty array');
  }
  for (let i = 0; i < buckets.length; i++) {
    if (!Number.isFinite(buckets[i]!)) {
      throw new TypeError('Histogram: bucket values must be finite');
    }
    if (i > 0 && buckets[i]! <= buckets[i - 1]!) {
      throw new TypeError('Histogram: buckets must be strictly ascending');
    }
  }
}

function validateLabels(
  declared: readonly string[],
  supplied: LabelValues,
): void {
  const suppliedKeys = Object.keys(supplied);
  if (suppliedKeys.length !== declared.length) {
    throw new Error(
      `label mismatch: declared [${declared.join(',')}] got [${suppliedKeys.join(',')}]`,
    );
  }
  for (const key of declared) {
    if (!(key in supplied)) {
      throw new Error(`missing required label "${key}"`);
    }
    const v = supplied[key];
    if (typeof v !== 'string') {
      throw new TypeError(`label "${key}" value must be a string`);
    }
  }
}

/**
 * Build a stable key for a label-value set so the Map can index
 * time series. Keys are sorted so `{a:'1',b:'2'}` and
 * `{b:'2',a:'1'}` produce the same key.
 */
function labelKey(declared: readonly string[], values: LabelValues): string {
  if (declared.length === 0) return '';
  // `declared` is authoritative — order fixed at registration. The key
  // is also the Prometheus-format render output for labels so a single
  // Map stores both the series index + its rendered form.
  return declared.map((k) => `${k}="${escapeLabelValue(values[k]!)}"`).join(',');
}

/** Escape label value per Prometheus exposition format. */
function escapeLabelValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function renderEntry(entry: MetricEntry): string {
  const header = `# HELP ${entry.name} ${entry.help}\n# TYPE ${entry.name} ${entry.type}`;
  if (entry.type === 'histogram') {
    return header + '\n' + renderHistogram(entry);
  }
  return header + '\n' + renderScalar(entry);
}

function renderScalar(entry: CounterEntry | GaugeEntry): string {
  const keys = Array.from(entry.samples.keys()).sort();
  const lines: string[] = [];
  // Emit a zero sample when there are no labels + no observations so
  // scrapers don't see a hole for a freshly-registered metric.
  if (entry.labels.length === 0 && keys.length === 0) {
    lines.push(`${entry.name} 0`);
  }
  for (const key of keys) {
    const value = entry.samples.get(key)!;
    const labelBlock = key === '' ? '' : `{${key}}`;
    lines.push(`${entry.name}${labelBlock} ${formatValue(value)}`);
  }
  return lines.join('\n');
}

function renderHistogram(entry: HistogramEntry): string {
  const keys = Array.from(entry.count.keys()).sort();
  const lines: string[] = [];
  if (entry.labels.length === 0 && keys.length === 0) {
    // Empty histogram — emit zero buckets so scrapers initialise.
    for (const b of entry.buckets) {
      lines.push(`${entry.name}_bucket{le="${formatValue(b)}"} 0`);
    }
    lines.push(`${entry.name}_bucket{le="+Inf"} 0`);
    lines.push(`${entry.name}_sum 0`);
    lines.push(`${entry.name}_count 0`);
    return lines.join('\n');
  }
  for (const key of keys) {
    const counts = entry.bucketCounts.get(key)!;
    const prefix = key === '' ? '' : `${key},`;
    for (let i = 0; i < entry.buckets.length; i++) {
      lines.push(
        `${entry.name}_bucket{${prefix}le="${formatValue(entry.buckets[i]!)}"} ${counts[i]}`,
      );
    }
    lines.push(
      `${entry.name}_bucket{${prefix}le="+Inf"} ${counts[entry.buckets.length]}`,
    );
    const sumLabels = key === '' ? '' : `{${key}}`;
    lines.push(`${entry.name}_sum${sumLabels} ${formatValue(entry.sum.get(key)!)}`);
    lines.push(`${entry.name}_count${sumLabels} ${entry.count.get(key)!}`);
  }
  return lines.join('\n');
}

/** Prometheus numeric formatting — integers as-is, floats with minimal precision. */
function formatValue(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(n);
}
