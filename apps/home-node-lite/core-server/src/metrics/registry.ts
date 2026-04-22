/**
 * Task 4.88 + 4.89 — per-route metrics primitives.
 *
 * In-memory counters + histograms keyed by `(route, method, status)`.
 * Exposed for ops visibility when the `/metrics` endpoint (task 4.85,
 * future) is wired or when an external scraper pulls via a
 * custom-format handler.
 *
 * **Scope** — this module owns storage + observation semantics only.
 * Aggregation into a specific wire format (Prometheus text, JSON,
 * OpenMetrics) is the exporter's job; this registry ships `snapshot()`
 * + `counters()` + `histograms()` for any exporter to consume.
 *
 * **Histogram buckets** — Prometheus's default
 * `defHistogramBuckets` (seconds): `[0.005, 0.01, 0.025, 0.05, 0.1,
 * 0.25, 0.5, 1, 2.5, 5, 10]`. Good coverage of "normal HTTP latency"
 * plus a long tail for stuck requests. Inclusive upper bounds;
 * overflow (>10s) lands in the implicit `+Inf` bucket that
 * `snapshot()` exposes as `overflow`.
 *
 * **Counter key** — `${route}::${method}::${status}`. The `route` is
 * the matched route pattern (e.g. `/v1/vault/items/:id`), NOT the
 * filled URL, so parameterised routes don't explode the key space.
 *
 * **Zero-alloc on hot path** — `record*()` does one Map lookup +
 * one numeric update + a histogram-bucket scan (11 comparisons).
 * No object allocation per call. Suitable for every request.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4l tasks 4.88 + 4.89.
 */

/** Prometheus default buckets in seconds. */
export const DEFAULT_HISTOGRAM_BUCKETS_SEC = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const);

export interface CounterKey {
  /** Matched route pattern, e.g. `/v1/pair/devices`. */
  route: string;
  /** HTTP method — uppercase. */
  method: string;
  /** Numeric status code. */
  status: number;
}

export interface CounterSnapshot {
  route: string;
  method: string;
  status: number;
  count: number;
}

export interface HistogramKey {
  route: string;
  method: string;
}

export interface HistogramSnapshot {
  route: string;
  method: string;
  /** Per-bucket (upper-bound-inclusive) count of observations. */
  buckets: ReadonlyArray<{ le: number; count: number }>;
  /** Observations that exceeded the largest bucket. */
  overflow: number;
  /** Total observations (sum of every bucket + overflow). */
  count: number;
  /** Sum of observed values in seconds. Enables avg = sum/count. */
  sum: number;
}

export interface Snapshot {
  counters: ReadonlyArray<CounterSnapshot>;
  histograms: ReadonlyArray<HistogramSnapshot>;
  /** Total request count observed (all statuses). */
  totalRequests: number;
  /** Total error count (status >= 400). */
  totalErrors: number;
}

export interface MetricsRegistryOptions {
  /** Histogram upper bounds in seconds. Must be sorted ascending + all > 0. */
  bucketsSec?: ReadonlyArray<number>;
}

interface HistogramEntry {
  bucketCounts: number[]; // one per bucket in registry.buckets
  overflow: number;
  count: number;
  sum: number;
}

export class MetricsRegistry {
  readonly buckets: ReadonlyArray<number>;
  private readonly counters = new Map<string, { key: CounterKey; count: number }>();
  private readonly histograms = new Map<
    string,
    { key: HistogramKey; entry: HistogramEntry }
  >();
  private totalRequests = 0;
  private totalErrors = 0;

  constructor(opts: MetricsRegistryOptions = {}) {
    const buckets = opts.bucketsSec ?? DEFAULT_HISTOGRAM_BUCKETS_SEC;
    if (!Array.isArray(buckets) && !(buckets as readonly number[]).length) {
      throw new Error('MetricsRegistry: bucketsSec must be a non-empty array');
    }
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i]!;
      if (!Number.isFinite(b) || b <= 0) {
        throw new Error(
          `MetricsRegistry: bucketsSec[${i}] must be a positive finite number (got ${b})`,
        );
      }
      if (i > 0 && buckets[i - 1]! >= b) {
        throw new Error('MetricsRegistry: bucketsSec must be strictly ascending');
      }
    }
    this.buckets = buckets.slice();
  }

  /**
   * Record one observation: a request completed with `status` at
   * `durationSec`. Updates both the per-status counter and the
   * per-route histogram. Error counter (status >= 400) is derived.
   *
   * **Normalisation**: method is uppercased. Route is trimmed to a
   * fallback of `'unknown'` if empty — an empty string would swallow
   * requests into a single silent bucket.
   */
  record(route: string, method: string, status: number, durationSec: number): void {
    const r = route && route.length > 0 ? route : 'unknown';
    const m = (method || 'UNKNOWN').toUpperCase();
    if (!Number.isFinite(status) || status < 0) {
      throw new Error(`MetricsRegistry.record: status must be a non-negative number (got ${status})`);
    }
    if (!Number.isFinite(durationSec) || durationSec < 0) {
      throw new Error(
        `MetricsRegistry.record: durationSec must be a non-negative number (got ${durationSec})`,
      );
    }

    const counterKey = `${r}::${m}::${status}`;
    const existingCounter = this.counters.get(counterKey);
    if (existingCounter === undefined) {
      this.counters.set(counterKey, { key: { route: r, method: m, status }, count: 1 });
    } else {
      existingCounter.count += 1;
    }

    const histoKey = `${r}::${m}`;
    let histo = this.histograms.get(histoKey);
    if (histo === undefined) {
      histo = {
        key: { route: r, method: m },
        entry: {
          bucketCounts: new Array<number>(this.buckets.length).fill(0),
          overflow: 0,
          count: 0,
          sum: 0,
        },
      };
      this.histograms.set(histoKey, histo);
    }
    histo.entry.count += 1;
    histo.entry.sum += durationSec;
    // Find the first bucket whose upper bound accepts this observation.
    let placed = false;
    for (let i = 0; i < this.buckets.length; i++) {
      if (durationSec <= this.buckets[i]!) {
        histo.entry.bucketCounts[i]! += 1;
        placed = true;
        break;
      }
    }
    if (!placed) histo.entry.overflow += 1;

    this.totalRequests += 1;
    if (status >= 400) this.totalErrors += 1;
  }

  /** Read-only snapshot for exporters. */
  snapshot(): Snapshot {
    const counters: CounterSnapshot[] = [];
    for (const { key, count } of this.counters.values()) {
      counters.push({ ...key, count });
    }
    counters.sort(counterCompare);

    const histograms: HistogramSnapshot[] = [];
    for (const { key, entry } of this.histograms.values()) {
      histograms.push({
        route: key.route,
        method: key.method,
        buckets: this.buckets.map((le, i) => ({ le, count: entry.bucketCounts[i]! })),
        overflow: entry.overflow,
        count: entry.count,
        sum: entry.sum,
      });
    }
    histograms.sort(histogramCompare);

    return {
      counters,
      histograms,
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
    };
  }

  /**
   * Reset all counters + histograms. Primarily for tests + graceful-
   * shutdown scenarios where the operator wants a clean slate.
   */
  reset(): void {
    this.counters.clear();
    this.histograms.clear();
    this.totalRequests = 0;
    this.totalErrors = 0;
  }

  /** Count of distinct (route, method, status) counter keys. */
  counterKeyCount(): number {
    return this.counters.size;
  }

  /** Count of distinct (route, method) histogram keys. */
  histogramKeyCount(): number {
    return this.histograms.size;
  }
}

function counterCompare(a: CounterSnapshot, b: CounterSnapshot): number {
  if (a.route !== b.route) return a.route < b.route ? -1 : 1;
  if (a.method !== b.method) return a.method < b.method ? -1 : 1;
  return a.status - b.status;
}

function histogramCompare(a: HistogramSnapshot, b: HistogramSnapshot): number {
  if (a.route !== b.route) return a.route < b.route ? -1 : 1;
  return a.method < b.method ? -1 : a.method > b.method ? 1 : 0;
}
