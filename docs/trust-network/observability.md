# Trust Network V1 — Observability

> **Audience**: operators wiring AppView metrics into Prometheus +
> Grafana (or equivalent) and authoring alert rules.
>
> **Scope**: the 8 alert-grade metrics that TN-OBS-001 / Plan §13.8
> requires every V1 deployment to monitor. The aggregator at
> `appview/src/shared/utils/metrics-aggregator.ts` exposes ALL the
> metrics the AppView emits via the Prometheus text format at
> `GET /metrics`, but these 8 are the "if any of these breach
> threshold, page someone" set.
>
> **Backend stance**: V1 ships dual-emission — every `metrics.incr(...)`
> / `metrics.gauge(...)` / etc. callsite lands in BOTH the structured-
> log path (Loki / CloudWatch / ELK) AND the in-memory aggregator
> (Prometheus). Operators picking one stack don't pay for the other
> instrumentation-side; they just consume the path that fits.

---

## 1. The `/metrics` endpoint

```
GET /metrics
Content-Type: text/plain; version=0.0.4
```

Returns Prometheus text exposition format (per
https://prometheus.io/docs/instrumenting/exposition_formats/).
Exempt from the rate limiter — Prometheus scrapers poll every
15-60s by default, and tripping the limiter would cause gaps in
dashboards exactly when operators need them.

Sample output:

```
# TYPE ingester.events.received counter
ingester.events.received{collection="com.dina.trust.attestation",operation="create"} 12345
# TYPE ingester.queue.depth gauge
ingester.queue.depth 42
# TYPE ingester.queue.process_duration_ms histogram
ingester.queue.process_duration_ms_count 9999
ingester.queue.process_duration_ms_sum 458231
```

**Cardinality defence**: each metric caps at 10k distinct label
sets. Beyond the cap, new label combinations are silently dropped
(with one warn log per metric per process lifetime). This bounds
memory regardless of caller bugs — an accidental high-cardinality
label like `trace_id` won't OOM the AppView. The cap is generous
(10k × ~50 active metrics ≈ ~500k entries ≈ single-digit MB of
JS-heap accounting).

---

## 2. The 8 alert-grade metrics

These are the SLO-anchor metrics. Every V1 deployment should have
alerts on these; everything else in `/metrics` is for ad-hoc
debugging.

### 2.1 `ingester.events.received` (counter)

**Purpose**: throughput.
**Labels**: `collection`, `operation` ∈ {create, update, delete}.
**Rate query**: `rate(ingester_events_received[5m])`.
**Alert**: rate drops to 0 for > 5 min when historic baseline is non-zero
→ Jetstream connection lost or trust-V1 flag flipped. Page on-call.
**Runbook**: `docs/trust-network/ops-runbook.md` §1 (ingester lag).

### 2.2 `ingester.connected` (gauge, 0 or 1)

**Purpose**: liveness — is the Jetstream WebSocket open?
**Labels**: none.
**Alert**: value = 0 for > 30s (single tick-late gives reconnect a
chance; sustained → real outage).
**Runbook**: §1 (ingester lag) — Jetstream relay flapping path.

### 2.3 `ingester.queue.depth` (gauge)

**Purpose**: backpressure — how many events queued for handler
processing?
**Labels**: none.
**Alert**: > 5000 for > 5 min (queue cap is 10000 — half-full and
holding signals downstream pressure not draining).
**Runbook**: §1 (ingester lag) — queue saturation path.

### 2.4 `ingester.rejections` (counter)

**Purpose**: rejection rate by reason.
**Labels**: `reason` ∈ {`rate_limit`, `signature_invalid`,
`schema_invalid`, `namespace_disabled`, `feature_off`}.
**Rate query**: `rate(ingester_rejections{reason="rate_limit"}[5m])`.
**Alert**:
- `rate_limit` rate > baseline + 3σ → traffic flood or coordinated
  abuse. Investigate via §5 (sybil cluster).
- `feature_off` rate non-zero → operator flipped trust-V1 disable;
  expected during incident response, page only if unintentional.
- `signature_invalid` rate non-zero (once TN-ING-003 wires up) →
  active key-rotation race or attempted forgery; page.

### 2.5 `xrpc.request_duration_ms` (histogram, count + sum)

**Purpose**: xRPC latency.
**Labels**: `method` (one of the 11 endpoint NSIDs), `status` (HTTP
code).
**Avg query**: `rate(xrpc_request_duration_ms_sum[5m]) /
rate(xrpc_request_duration_ms_count[5m])`.
**Alert**: avg > 1000ms for > 5 min on any method other than the
known-slow ones (`networkFeed` for large viewers, `subjectGet` for
heavily-attested subjects). Indicates DB pool exhaustion or query
plan regression.
**Runbook**: `docs/trust-network/ops-runbook.md` §6 (Postgres degraded).

### 2.6 `scorer.<job>.duration_seconds` (histogram, count + sum)

**Purpose**: per-scorer-job duration; how long each tick takes.
**Labels**: none (job name is part of the metric name — 12 jobs ≡
12 metrics).
**Alert**: any job's avg duration breaches 90% of its cron cadence
(e.g. `refresh-subject-scores` runs every 5 min; alert if avg
duration > 4.5 min). Indicates the per-run cap is undersized for
the inflow rate.
**Runbook**: §2 (cascade backlog) for `refresh-subject-scores`
specifically; the same shape applies to other jobs.

### 2.7 `scorer.<job>.cap_hit` (counter)

**Purpose**: signal that the per-run cap was reached.
**Labels**: none.
**Alert**: value increments for > 3 consecutive runs → the per-run
cap is undersized. See §2 for the resolution paths (more frequent
ticks vs higher cap).

### 2.8 `db.pool.in_use` (gauge)

**Purpose**: DB connection pool utilisation.
**Labels**: none.
**Alert**: in-use > 80% of `DATABASE_POOL_MAX` for > 5 min →
imminent pool exhaustion + 503s. Raise pool size or scale Web
process count.
**Runbook**: §6 (Postgres degraded) — pool-exhausted path.

---

## 3. Naming convention

All AppView metrics follow `<area>.<sub_area>.<measure>`:

- `area` ∈ {`ingester`, `scorer`, `xrpc`, `db`}.
- `sub_area` is the specific path within the area (e.g.
  `events`, `queue`, `rejections`).
- `measure` is `received`, `depth`, `duration_ms`, `cap_hit`, etc.

Reserved:
- `_count` and `_sum` suffixes are emitted by histograms; don't use
  them in counter / gauge names.
- Underscores or dots are both accepted by Prometheus; the V1
  convention is dots in the source (matches the existing
  `metrics.incr` callsites).

---

## 4. Cardinality discipline

Labels in V1 metrics are **bounded enums** by convention:

| Label | Domain | Cardinality |
|---|---|---|
| `collection` | 20 NSIDs | ≤ 20 |
| `operation` | create / update / delete | 3 |
| `reason` | RejectionReason (5-value union) | ≤ 5 |
| `method` | 11 xRPC NSIDs | ≤ 11 |
| `status` | HTTP status codes seen | ≤ 10 typical |
| `scope` | `per_collection_daily` (one value) | ≤ a few |

**Don't add UUID-typed labels (`trace_id`, `request_id`, `did`).**
The aggregator's 10k-per-metric cap defends against an accident,
but the right answer is "log the trace_id, count the metric without
it". TN-OBS-002 already pinned this — trace_id lives in structured
logs, NEVER in metric labels. Adding one labelled metric is a
schema discussion + a cardinality review.

---

## 5. Alert-rule examples (Prometheus YAML)

Operators copy these as starting points; tune thresholds to your
deployment's actual baselines.

```yaml
groups:
  - name: dina-appview-trust-v1
    rules:
      - alert: IngesterDisconnected
        expr: ingester_connected == 0
        for: 30s
        annotations:
          summary: "Ingester WebSocket disconnected from Jetstream"
          runbook: "https://internal/runbooks/dina-appview-ops#1"
      - alert: IngesterLagHigh
        expr: ingester_queue_depth > 5000
        for: 5m
        annotations:
          summary: "Ingester queue not draining"
          runbook: "https://internal/runbooks/dina-appview-ops#1"
      - alert: SignatureForgeryAttempt
        expr: increase(ingester_rejections{reason="signature_invalid"}[5m]) > 0
        for: 0s   # any non-zero is page-worthy once TN-ING-003 is live
        annotations:
          summary: "Signature-invalid rejection — possible forgery or key rotation race"
      - alert: ScorerCapHit
        expr: increase(scorer_subject_scores_cap_hit[15m]) > 2
        for: 0s
        annotations:
          summary: "refresh-subject-scores cap hit ≥ 3 ticks — backlog growing"
          runbook: "https://internal/runbooks/dina-appview-ops#2"
      - alert: DbPoolNearExhaustion
        expr: db_pool_in_use / db_pool_max > 0.8
        for: 5m
        annotations:
          summary: "DB connection pool near exhaustion"
          runbook: "https://internal/runbooks/dina-appview-ops#6"
```

---

## 6. Wiring into Grafana (TN-OBS-004)

TN-OBS-004 is file-tracked but the dashboards themselves are
operator-specific. The recommended starting set:

- **Trust V1 Overview** — top of the dashboard:
  - `ingester.connected` as a single-stat gauge
  - `rate(ingester.events.received[5m])` time series
  - `ingester.queue.depth` time series
- **Rejection breakdown** —
  `rate(ingester.rejections{}[5m]) by (reason)` stacked area chart
- **xRPC latency** — `rate(xrpc.request_duration_ms_sum[5m]) /
  rate(xrpc.request_duration_ms_count[5m])` per-method
- **Scorer health** — per-job duration p50 + cap-hit counters
- **DB pool** — in-use vs max as a stacked bar

Operators: fork a starter dashboard JSON into your repo so the
visualisation lives in code review alongside the metric changes
that drive it.
