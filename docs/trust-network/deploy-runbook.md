# Trust Network V1 — Production Deploy Runbook

> **Audience**: operators rolling out a fresh AppView install or
> upgrading an existing one to V1.
>
> **Scope**: AppView (Ingester + Scorer + Web), Postgres,
> Jetstream wiring, the `appview_config` operator-flag table.
> Mobile-app distribution and Home Node Lite/Core/Brain are
> out of scope.
>
> **Prerequisites**: Postgres ≥ 14 (jsonb_path_ops is required;
> shipped since 9.4 — anything 14+ works), Node ≥ 22 (matches
> `.nvmrc`), a reachable Jetstream relay
> (`jetstream2.us-west.bsky.network` is the public default), the
> ability to set environment variables on the deploy target.
>
> **Failure stance**: every step here is reversible. The deploy
> sequence is "stop traffic to the old → migrate schema →
> deploy new → start daemons → smoke-check → admit traffic". A
> failure at any step has a rollback path documented inline.

---

## 1. Pre-flight — verify the deploy artifact

Before touching production:

| Check | Command | Pass criteria |
|---|---|---|
| Build is green | `npm run build` | exits 0 |
| Lint clean | `npm run lint` | exits 0 |
| Unit tests pass | `npm test` (in `appview/`) | exits 0; **all** tests passing |
| Conformance vectors green | `npm test -- trust_score_conformance` | exits 0; vectors byte-for-byte match |
| TypeScript clean against baseline | `npx tsc --noEmit` | error count ≤ documented baseline (109 as of 2026-04-29) |
| Migration plan is committed | `ls drizzle/` (after `npm run generate`) | `<YYYYMMDDHHMM>_*.sql` exists for every schema change in the diff |

**If any check fails, stop here.** Do not deploy a build that
hasn't passed the unit suite. Pre-flight failures are cheap;
an in-flight rollback is not.

---

## 2. Schema migration

The AppView's only persistent state is the Postgres schema. V1
ships **TN-DB-010** as a single consolidated migration
`<YYYYMMDDHHMM>_trust_v1.sql` (idempotent up + down). Apply it
**before** the new daemons start so they see the expected
schema.

```bash
# 1. Snapshot current state. Always.
pg_dump -h <host> -U <user> -d <db> -F c -f pre-trust-v1.dump

# 2. Apply migrations.
DATABASE_URL=postgres://… npm run migrate

# 3. Verify the post-migration state.
psql -h <host> -U <user> -d <db> -c "\dt"
# Expect to see (among others): subjects, attestations, vouches,
# endorsements, flags, replies, reactions, report_records,
# revocations, delegations, collections, media, amendments,
# verifications, review_requests, comparisons, subject_claims,
# trust_policies, notification_prefs, service_profiles,
# subject_scores, did_profiles, ingest_rejections, cosig_requests,
# trust_v1_params, appview_config.
```

**Rollback (schema)**: drizzle-kit migrations are forward-only
by design. To rollback:

1. Stop new daemons (so nothing writes the new schema).
2. `pg_restore` from the snapshot taken in step 1.
3. Re-deploy the previous AppView build.

This is destructive — any rows written between snapshot and
rollback are lost. Snapshot **immediately before** the
migration apply, not earlier.

---

## 3. Environment configuration

Required environment variables (per `src/config/env.ts`):

| Variable | Default | Production value |
|---|---|---|
| `NODE_ENV` | `production` | `production` |
| `DATABASE_URL` | required in prod | `postgres://user:pass@host:5432/dina_appview` |
| `DATABASE_POOL_MIN` | `2` | `5` (under V1 ramp load) |
| `DATABASE_POOL_MAX` | `20` | `40` |
| `JETSTREAM_URL` | required in prod | `wss://jetstream2.us-west.bsky.network/subscribe` |
| `PORT` | `3000` | `3000` (or fronted by reverse proxy) |
| `LOG_LEVEL` | `info` | `info` (drop to `debug` for incident response) |
| `RATE_LIMIT_RPM` | `60` | leave unset (per-method tiers in TN-API-007) |

**Optional flag overrides** (`appview_config` table — flip via
`dina-admin trust enable|disable`):

| Flag | Default | Operator action |
|---|---|---|
| `trust_v1_enabled` | `true` (Plan §13.10 ramp ON) | flip OFF for incident response — ingester drops, scorer skips, xRPC 503s |

**Secrets**: `DATABASE_URL` contains the password. Never log it,
never echo it, never commit it. Use whatever secret-manager
your platform provides (AWS Secrets Manager / GCP Secret Manager
/ Doppler / direct env injection from CI).

---

## 4. Daemon startup order

The AppView is **three logical daemons** sharing one Postgres
instance. They can run in one process (single-node deploy) or
three (horizontal scale). Either way, the startup ordering
matters:

```
Postgres reachable
        ↓
   1. Web      ← serves /healthz, accepts xRPC traffic
        ↓
   2. Scorer   ← starts the cron schedule (12 jobs, see §5)
        ↓
   3. Ingester ← consumes Jetstream, writes records
```

**Why this order**:
- **Web first** so load balancers see a healthy backend before
  any state changes; clients can poll `/healthz` to detect the
  ramp-up.
- **Scorer next** so when the Ingester starts producing rows,
  there's already a refresh job running to pick them up. Starting
  the Scorer AFTER the Ingester just means the first 5 minutes
  of records sit unscored.
- **Ingester last** so the moment it starts pulling from
  Jetstream, both downstream consumers (Web for queries, Scorer
  for refresh) are ready.

```bash
# Single-node (V1 default)
DATABASE_URL=… JETSTREAM_URL=… node dist/src/main.js
# multi-process — supervised by systemd / launchd / k8s

# Three-process (horizontal scale)
DATABASE_URL=… node dist/src/web/main.js
DATABASE_URL=… node dist/src/scorer/main.js
DATABASE_URL=… JETSTREAM_URL=… node dist/src/ingester/main.js
```

---

## 5. Smoke checks (post-deploy, pre-traffic)

Before opening traffic to the new build:

```bash
# 1. Web is up + DB-reachable
curl -fsS http://localhost:3000/health
# expect: {"status":"ok","db":"ok","timestamp":"..."}

# 2. xRPC dispatcher is responsive (any GET that doesn't need
#    auth — service registry methods are 60/min unauth).
curl -fsS 'http://localhost:3000/xrpc/com.dina.trust.search?q=hello'
# expect: 200, JSON body with `results` (possibly empty), no 5xx

# 3. Postgres has the post-V1 schema
psql -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('subjects','attestations','subject_scores','appview_config');"
# expect: 4

# 4. Scheduler has all 12 jobs registered
# (look in scorer logs for "scheduled job" lines, expect 12)

# 5. Ingester is connected to Jetstream
# (look in ingester logs for "Jetstream connection established",
#  followed by per-event processing logs at LOG_LEVEL=debug)

# 6. Trust V1 flag is in the desired state
psql -c "SELECT key, bool_value, text_value, updated_at FROM appview_config WHERE key='trust_v1_enabled';"
# expect: bool_value = t (default V1 ramp ON), or empty row (defaults to true)
```

**If any smoke check fails, do not admit traffic**. Roll back
per §6.

---

## 6. Rollback procedure

There are two flavors of rollback depending on what failed:

### 6.1 New build deployed but failing health checks

Old daemons should still be online (you're behind a load
balancer; you bring up the new one alongside, smoke-check, then
swap). If smoke checks fail:

1. Keep load balancer pointed at old.
2. Stop the new daemon (`systemctl stop dina-appview-new`).
3. Investigate logs (`journalctl -u dina-appview-new -n 200`).
4. Fix root cause + redeploy.

**Schema is shared between old and new**. As long as the new
schema is a strict superset (additive columns, no drops), the
old build keeps working against the migrated schema.

### 6.2 Schema migration corrupted state

```bash
# 1. Stop ALL appview daemons (ingester first — stop the writer).
systemctl stop dina-ingester dina-scorer dina-web

# 2. Restore from the pre-migration snapshot.
pg_restore -h <host> -U <user> -d <db> -c pre-trust-v1.dump

# 3. Deploy previous AppView build.
git checkout <previous-tag>
npm install && npm run build
systemctl start dina-web dina-scorer dina-ingester
```

**Cost**: any rows written between snapshot and rollback are
lost. The Jetstream firehose will replay missed events when the
ingester reconnects with its persisted cursor (NOT the live
cursor — see TN-ING-001 cursor-saving), so most of the loss is
recoverable. Side-effects already pushed downstream (cosig
notifications sent to mobile clients, scorer counters surfaced
on dashboards) are not.

### 6.3 Trust V1 disable as runtime kill switch

For incidents that don't need a full rollback (one bad ingester
path, sybil cluster mid-detection), prefer the flag flip:

```bash
npx tsx src/admin/trust-flag-cli.ts disable
```

Effect within ≤ 60s for cached readers, immediate for per-
request readers. The Ingester drops `com.dina.trust.*` events,
the Scorer skips trust jobs, the Web returns 503 for trust
xRPCs. `com.dina.service.*` traffic is untouched (provider
discovery survives). See TN-FLAG-002/003.

---

## 7. Post-deploy verification (within first hour)

After traffic is admitted to the new build:

| Metric / observation | Expected | Source |
|---|---|---|
| Ingester lag (Jetstream cursor vs head) | < 60s in steady state | scorer log: cursor save lines |
| Per-collection daily quota counters | within tier (TN-ING-002) | metrics: `ingester.rate_limit.<collection>` |
| Web 5xx rate | < 0.1% | reverse-proxy logs |
| Scorer job durations | each job under its 95th-percentile baseline | metrics: `scorer.<job>.duration_seconds` |
| `subject_scores.last_attestation_at` advancing | monotonic | psql sample |
| AppView config DB readable | yes | smoke check repeated hourly |

**If lag stays > 5 minutes for > 10 minutes**: the ingester is
not draining the firehose. Check the queue size metric, the
rate-limit counters, and the per-collection daily caps. See
the Ops Runbook (`ops-runbook.md`) §1 for resolution paths.

---

## 8. Reference: 12 scheduled scorer jobs

For sanity-checking that the scorer is actually doing what it
says it's doing (`appview/src/scorer/scheduler.ts`):

| Job | Cron | Cadence |
|---|---|---|
| `refresh-profiles` | `*/5 * * * *` | every 5 min |
| `refresh-subject-scores` | `*/5 * * * *` | every 5 min |
| `refresh-reviewer-stats` | `*/15 * * * *` | every 15 min |
| `refresh-domain-scores` | `0 * * * *` | hourly |
| `detect-coordination` | `*/30 * * * *` | every 30 min |
| `detect-sybil` | `0 */6 * * *` | every 6 hours |
| `process-tombstones` | `*/10 * * * *` | every 10 min |
| `decay-scores` | `0 3 * * *` | daily 03:00 UTC |
| `cleanup-expired` | `0 4 * * *` | daily 04:00 UTC |
| `cosig-expiry-sweep` | `30 * * * *` | hourly :30 |
| `subject-orphan-gc` | `0 5 * * 0` | weekly Sun 05:00 UTC |
| `subject-enrich-recompute` | `0 2 * * 0` | weekly Sun 02:00 UTC |

Total weekly compute is bounded — every job has a per-run cap
(documented in each job file) so a single tick cannot run
unboundedly long.

---

## 9. First deploy vs upgrade

**First deploy (greenfield)**:

1. Provision Postgres + create empty database.
2. Provision env vars per §3.
3. Run `npm run migrate` — first invocation creates the schema
   and bootstraps the seed data (`appview_config` defaults +
   `trust_v1_params` from TN-DB-004).
4. Deploy daemons per §4.
5. Smoke check per §5.

**Upgrade (existing V0 → V1)**:

1. Pre-flight per §1.
2. Snapshot the current Postgres state (§2 step 1).
3. Stop the running ingester (`systemctl stop dina-ingester`)
   so writes don't race the migration. Web + Scorer can keep
   serving from the snapshot-consistent state.
4. Apply the migration (§2 step 2) — drizzle-kit will skip
   already-applied migrations and only apply the new ones.
5. Verify post-migration state (§2 step 3).
6. Deploy the new build (§4).
7. Restart all three daemons.
8. Smoke check (§5).
9. Re-admit traffic.

**Time budget for an upgrade**: ~15 min for a small DB
(<1GB), longer for larger snapshots. The ingester downtime
is the user-visible part — Jetstream replay catches up the
cursor on restart.
