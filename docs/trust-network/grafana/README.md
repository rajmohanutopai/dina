# Trust Network V1 — Grafana dashboards (TN-OBS-004)

## What's here

| File | Purpose |
|---|---|
| `trust-v1-overview.json` | Operator-facing health + SLO overview. 8 panels mirroring `observability.md` §2's alert-grade metric set. |

## Import

```
Grafana → Dashboards → Import → Upload JSON file → select trust-v1-overview.json
        → choose your Prometheus datasource → Import
```

The `DS_PROMETHEUS` template variable is wired so the same JSON works
against any Prometheus datasource UID — Grafana asks at import time.

## Why JSON in the repo

Dashboards are code. A PR that adds a metric should land the panel
that visualises it in the same review — keeps source-of-truth aligned
with what operators see.

## What's NOT in the JSON

- **Alert rules** — those live in Prometheus YAML (see
  `observability.md` §5). Embedding alerts in dashboard JSON couples
  alert deployment to dashboard import; keeping them separate lets
  alert rules version-control independently.
- **Datasource UIDs** — the import flow assigns them per Grafana
  instance. Hardcoding would break import on a fresh deployment.
- **Operator-specific tuning** (alert thresholds, contact-point
  rotations, custom panels) — fork into your own repo and tune
  there. The committed JSON is the *starter*, not the *final* state.

## Customisation tips

- **Add a per-method xRPC throughput panel** if your traffic shape
  warrants it: `sum(rate(xrpc_request_duration_ms_count[5m])) by (method)`.
- **Replace the `db_pool_in_use / db_pool_max` panel** with whatever
  query your Postgres-side exporter emits; the metric name is a
  V1 placeholder pending a deploy-side decision (pgbouncer-exporter,
  custom collector, etc.).
- **Keep the `trust_v1_enabled` gauge prominent** — operators flipping
  the flag mid-incident need a visible "yes the kill switch is
  engaged" indicator, otherwise dashboard-readers wonder why
  ingester throughput dropped.

## Cardinality reminder

`docs/trust-network/observability.md` §4 documents the V1 cardinality
discipline: bounded-enum labels only, no UUIDs. Forks that add
high-cardinality labels (`trace_id`, `request_id`) will hit the
aggregator's 10k/metric cap and silently drop new combinations after
the first 10k. The dashboard JSON above uses only the bounded labels
(`collection`, `reason`, `method`); follow that pattern.
