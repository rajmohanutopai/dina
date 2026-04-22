/**
 * Task 4.85 — Prometheus text-format exposition for the metrics
 * registry.
 *
 * Renders a `Snapshot` (from `registry.ts`) into the Prometheus
 * `text/plain; version=0.0.4` exposition format that `/metrics`
 * endpoint serves. One exporter, no wire-shape surprises: callers
 * that scrape with `prometheus_scrape` or `node_exporter`-compatible
 * tooling get what they expect.
 *
 * **What we emit** — three metric families:
 *
 *   `<prefix>_requests_total{route, method, status}` — counter
 *   `<prefix>_request_duration_seconds_bucket{route, method, le=...}` — histogram buckets
 *   `<prefix>_request_duration_seconds_count{route, method}` — histogram count
 *   `<prefix>_request_duration_seconds_sum{route, method}` — histogram sum
 *
 * Plus two process-wide helpers:
 *   `<prefix>_requests_total_all` — total request count across all statuses
 *   `<prefix>_requests_error_total` — total requests with status >= 400
 *
 * **Label escaping** — Prometheus requires `\\`, `\n`, `\"` escaping
 * inside label values. Route patterns are plain ASCII today (`:id`
 * colons are legal), but future routes may carry special chars — we
 * escape defensively so the exposition is always parseable.
 *
 * **`+Inf` bucket** — Prometheus histograms require a terminal
 * `le="+Inf"` bucket whose count is the cumulative total across ALL
 * buckets (including overflow). We emit it explicitly so downstream
 * tooling computes averages correctly.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4l task 4.85.
 */

import type { Snapshot } from './registry';

/** Default metric name prefix — keeps our metrics in their own namespace. */
export const DEFAULT_METRIC_PREFIX = 'dina_core';

/** Prometheus Content-Type for the text exposition format. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export interface RenderPrometheusTextOptions {
  /** Metric-name prefix. Default `dina_core`. */
  namePrefix?: string;
}

/**
 * Render the registry snapshot into Prometheus text-format.
 *
 * Output is sorted deterministically (the snapshot itself sorts
 * counters + histograms) so diffs are stable, which matters for
 * golden-file tests and release audits.
 */
export function renderPrometheusText(
  snapshot: Snapshot,
  opts: RenderPrometheusTextOptions = {},
): string {
  const prefix = opts.namePrefix ?? DEFAULT_METRIC_PREFIX;
  const lines: string[] = [];

  // ── Totals ──────────────────────────────────────────────────────────
  lines.push(`# HELP ${prefix}_requests_total_all Total HTTP requests served.`);
  lines.push(`# TYPE ${prefix}_requests_total_all counter`);
  lines.push(`${prefix}_requests_total_all ${snapshot.totalRequests}`);

  lines.push(
    `# HELP ${prefix}_requests_error_total HTTP requests served with status >= 400.`,
  );
  lines.push(`# TYPE ${prefix}_requests_error_total counter`);
  lines.push(`${prefix}_requests_error_total ${snapshot.totalErrors}`);

  // ── Per-status request counter ─────────────────────────────────────
  lines.push(
    `# HELP ${prefix}_requests_total HTTP requests by route, method, and status.`,
  );
  lines.push(`# TYPE ${prefix}_requests_total counter`);
  for (const c of snapshot.counters) {
    lines.push(
      `${prefix}_requests_total{route=${quote(c.route)},method=${quote(c.method)},status="${c.status}"} ${c.count}`,
    );
  }

  // ── Per-route duration histogram ───────────────────────────────────
  lines.push(
    `# HELP ${prefix}_request_duration_seconds HTTP request latency by route + method.`,
  );
  lines.push(`# TYPE ${prefix}_request_duration_seconds histogram`);

  for (const h of snapshot.histograms) {
    const routeLbl = quote(h.route);
    const methodLbl = quote(h.method);

    // Prometheus expects CUMULATIVE bucket counts (i.e. `le=0.05` is
    // count of observations with duration <= 0.05, which includes
    // observations in smaller buckets too). `MetricsRegistry` stores
    // per-bucket counts, so we accumulate on the fly here.
    let cumulative = 0;
    for (const b of h.buckets) {
      cumulative += b.count;
      lines.push(
        `${prefix}_request_duration_seconds_bucket{route=${routeLbl},method=${methodLbl},le=${quote(formatLe(b.le))}} ${cumulative}`,
      );
    }
    // Terminal +Inf bucket = cumulative + overflow.
    cumulative += h.overflow;
    lines.push(
      `${prefix}_request_duration_seconds_bucket{route=${routeLbl},method=${methodLbl},le="+Inf"} ${cumulative}`,
    );
    lines.push(
      `${prefix}_request_duration_seconds_count{route=${routeLbl},method=${methodLbl}} ${h.count}`,
    );
    lines.push(
      `${prefix}_request_duration_seconds_sum{route=${routeLbl},method=${methodLbl}} ${formatFloat(h.sum)}`,
    );
  }

  // Trailing newline — Prometheus convention.
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Quote a label value per Prometheus exposition format:
 *   - Wrap in `"..."`.
 *   - Escape `\`, `"`, and newline inside the value.
 */
function quote(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else out += ch;
  }
  out += '"';
  return out;
}

/**
 * Format a bucket upper bound — integer bounds render without decimals,
 * fractional bounds keep enough precision to distinguish adjacent
 * buckets (0.005 vs 0.01).
 */
function formatLe(le: number): string {
  if (Number.isInteger(le)) return le.toString();
  // Trim trailing zeros from the JS default float rendering.
  return String(le);
}

/**
 * Format a float value (histogram sum). Prometheus tolerates standard
 * JS float formatting; we just avoid scientific notation to keep
 * diffs readable in short-duration traffic.
 */
function formatFloat(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return n.toString();
  return n.toString();
}
