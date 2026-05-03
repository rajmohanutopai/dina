# Trust Network V1 — Load Tests (TN-TEST-081)

k6 scripts pinning the V1 capacity targets per
`docs/TRUST_NETWORK_V1_PLAN.md` §13.6.

## Capacity targets (Plan §13.6)

| Metric | Target | Pinned by |
|---|---|---|
| Attestations stored | 1M | seed step (manual; see "Seeding" below) |
| Reviewer DIDs scored | 50k | seed step |
| Subjects | 200k | seed step |
| Search p95 latency | ≤ 250 ms | `search.k6.js` |
| Search throughput | 50 RPS sustained | `search.k6.js` (vus + duration) |
| Nightly batch wall-clock | ≤ 30 min for full scorer sweep | covered by scorer-job test runner, not here |

The Plan §22 entry for this task (line 1269) reads:

> Load — `tests/load/trust_network/` (k6) — Phase 0 capacity targets:
> 1M attestations indexed in ≤ 30 min; search 50 RPS p95 ≤ 250 ms;
> nightly batch ≤ 30 min wall-clock

The 1M-indexed-in-30-min target is a write-side ingester throughput
target, NOT something k6 measures directly — k6 would need to drive
Jetstream. That target is exercised by the `tests/load/.../seed.ts`
helper and observed via the AppView `/metrics` Prometheus endpoint
(`ingester.processed_total` rate). The k6 scripts here pin the
**read-side** targets (search / getProfile / networkFeed), which are
the SLAs operators actually report to users.

## Layout

```
tests/load/trust_network/
├── README.md                  This file.
├── search.k6.js               Search xRPC at 50 RPS sustained, p95 ≤ 250ms.
├── get-profile.k6.js          Profile xRPC at 30 RPS, p95 ≤ 250ms.
├── network-feed.k6.js         Network-feed xRPC at 20 RPS, p95 ≤ 400ms (1-hop graph traversal).
├── lib/
│   ├── config.js              Shared base URL + DID fixtures.
│   └── queries.js              Shared query-string distributions.
└── run.sh                     Wrapper that detects k6 and runs all scripts.
```

## Running

```bash
# 1. Bring up AppView (production stack OR test-stack).
docker compose up -d   # or: cd appview && npm start

# 2. Confirm /health returns 200.
curl -s http://localhost:3000/health   # → {"status":"ok"}

# 3. Seed corpus (one-shot — see "Seeding" below for the seed script).
#    Skipped here when running against an already-populated AppView.

# 4. Run the load suite.
./tests/load/trust_network/run.sh

# Or individual scripts:
APPVIEW_URL=http://localhost:3000 k6 run tests/load/trust_network/search.k6.js
```

If `k6` is not installed, `run.sh` exits with a friendly skip message
(`tests/load/` is part of the manifest but not a hard CI gate yet —
load tests run on a dedicated cadence, not on every PR).

## Thresholds

Each script declares thresholds via `options.thresholds`. A
threshold breach **fails the k6 run** (exit code != 0). The full
target list lives at the top of each script in a comment block and
maps 1:1 to the Plan §13.6 row. If a target moves, update both
the comment AND the threshold so the load test stays the
canonical truth source.

The k6 metric `http_req_duration{status:200}` is preferred over
the un-tagged version because a 500-fast response would otherwise
hide a SLA breach inside a fast error path.

## Seeding

`appview/tests/load/seed.ts` generates a power-law-distributed
trust corpus via direct Drizzle bulk INSERTs. Runs from the
appview directory because the script depends on `pg` (resolved
via appview's `node_modules`).

```bash
# Smoke mode — 1k attestations / 200 subjects / 50 DIDs (~1s).
# Validates the script + schema without committing to a full seed.
cd appview && DATABASE_URL=postgresql://dina:dina@localhost:5433/dina_trust \
  npx tsx tests/load/seed.ts --smoke

# Full mode — 1M attestations / 200k subjects / 50k DIDs (~minutes
# to ~tens-of-minutes per local M-series Mac vs CI box).
cd appview && DATABASE_URL=postgresql://dina:dina@localhost:5433/dina_trust \
  npx tsx tests/load/seed.ts
```

What it generates:
- Attestations across subjects authored by DIDs with **Zipf
  distribution** (alpha 1.07 for subjects, 1.15 for authors) — most
  subjects get 1–3 attestations; a long tail reaches 100s. Matches
  production shape so the search workload exercises realistic FTS
  rank ordering, not the uniform-distribution best-case where
  every row sorts at rank ≈ 1.0.
- Subject metadata populated with alternating US/GB regions for the
  RANK-001 viewer-region predicate.
- Languages spread across 5 BCP-47 codes (`en` / `es` / `fr` /
  `pt-BR` / `ja`) for the language-filter predicate.
- DID profiles seeded with deterministic trust scores and zero
  attestation counts (the scorer batch fills `total_attestations_*`
  columns; the seeder leaves them at 0 so the `refresh-profiles`
  job has work to do — that's intentional, since refresh-profiles
  is itself part of the V1 capacity targets).

**Idempotency**: re-running with the same seed (default 0)
produces deterministic IDs. If the corpus already meets target
counts, the script exits as a no-op. Partial corpus → truncate +
refill. To force a fresh seed, truncate the three tables manually
or change the `--rng-seed` (forthcoming flag — V1 ships with
fixed seed 0).

**Direct DB writes (skip ingester chain)**: 1M HTTP round-trips
through the test-inject xRPC would take hours. The seeder writes
into the same destination tables with the same column shapes; a
column rename in `appview/src/db/schema/` will surface here as a
runtime INSERT failure on the first batch — the loud failure
mode this seeder wants. The Plan §13.6 write-side throughput
target ("1M indexed in ≤ 30 min via Jetstream") is exercised by
a separate test driving a synthetic relay; that's a different
piece of infrastructure (TN-TEST-WRITE-LOAD, not yet on the
backlog).

Seed runs are intentionally NOT triggered by `run.sh` — operators
seed once per fixture generation, then run k6 against the warmed
corpus repeatedly until thresholds pass.

## Capacity assumptions

The targets assume:
- Postgres 14+, M.2 NVMe storage, 16+ CPU cores
- AppView served by a single Node process per pod, ≥ 2 GB RAM
- Default rate limits in `RATE_LIMIT_RPM` env (override to 100000
  during load tests so the limiter doesn't crowbar the run)

A regression below these targets points at a query-plan or
index regression — read the Postgres `EXPLAIN (ANALYZE, BUFFERS)`
output for the failing path and compare against the indexes
declared in `appview/src/db/schema/`.

## Honest scope-narrowing

Read-side scripts (search / getProfile / networkFeed) + runner +
seeder all ship in V1. The **write-side capacity target** from
Plan §13.6 ("1M attestations indexed in ≤ 30 min" through the
Jetstream → ingester pipeline) is NOT exercised here — the
seeder writes directly via Drizzle bulk INSERT, skipping the
ingester chain. That separate capacity target needs a synthetic
Jetstream relay driving fixtures into the firehose, which is its
own infrastructure piece (TN-TEST-WRITE-LOAD, not yet on the
backlog). The Plan's read-side targets — search 50 RPS @ p95 ≤
250ms, profile / feed at lower throughput — are what operators
actually report to users, and those land here.
