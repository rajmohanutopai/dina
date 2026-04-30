# Trust Network V1 — Operations Runbook

> **Audience**: on-call operators responding to incidents in a
> running AppView deployment.
>
> **Scope**: ingester lag, cascade backlog, cache flush,
> enrichment-job catch-up, plus the trust-V1 kill switch and
> targeted recovery paths. Greenfield deploys + upgrades are in
> `deploy-runbook.md`.
>
> **Posture**: every section starts with a one-line trigger
> ("you'll see this on the dashboard / page / alert"), then the
> diagnostic flow, then the resolution path. Skip the prose and
> jump to the trigger that matches your alert.
>
> **Kill switch first**. If you don't know what's happening and
> users are complaining, flip the trust-V1 flag to **disable**
> while you investigate. It's the equivalent of pulling a fire
> alarm — disruptive but safe (Plan §13.10). Re-enable when the
> incident is resolved.
> ```bash
> npx tsx src/admin/trust-flag-cli.ts disable
> # …
> npx tsx src/admin/trust-flag-cli.ts enable
> ```

---

## 1. Ingester lag — Jetstream cursor falling behind

**Trigger**: ingester lag metric > 5 min for > 10 min, OR mobile
clients reporting their just-published records are stuck in
`pending` state for longer than expected.

### 1.1 Diagnose

| Check | Command / source | What it tells you |
|---|---|---|
| Cursor age | scorer log: `cursor save` lines (timestamp delta vs now) | how far behind we are |
| Queue depth | metric `ingester.queue.size` | upstream pressure |
| Rate-limit hits | metric `ingester.rate_limit.{collection}` | per-collection caps firing |
| Schema-invalid count | metric `ingester.rejections{reason="schema_invalid"}` | malformed firehose entries |
| Trust-flag state | `psql -c "SELECT bool_value FROM appview_config WHERE key='trust_v1_enabled'"` | is the flag accidentally off? |
| Postgres health | `psql -c "SELECT 1"` | DB reachable? |
| Jetstream connectivity | ingester log: `Jetstream connection established` recent | WS reachable? |

### 1.2 Resolve

**Common cause: queue saturation.** The ingester's bounded
queue (TN-ING-006) caps at 10k events. Sustained backpressure
means downstream writes (Postgres) can't keep up.

- Check Postgres CPU + IOPS. If saturated → scale up the DB
  instance OR raise `DATABASE_POOL_MAX` (default 20, tested up
  to 40).
- If the slow path is a specific handler, the per-handler
  duration metrics (`ingester.handler.<collection>.duration_ms`)
  surface it. Most likely culprit: `attestation` handler when
  language detection (`detectLanguage` from TN-ING-008) is
  hitting franc-min on a flood of long-text attestations. Each
  call is ~1–2ms; a sustained 1k events/sec attestation rate
  would mean 1–2s of pure detection cost per second of traffic
  (effectively 100% CPU on a single core). The mitigation is
  horizontal scale — run a second ingester process against a
  different Jetstream slice, OR temporarily disable the
  language-detect path (it's pure additive; subjects + scorer
  function without `language` populated).

**Common cause: Jetstream relay flapping.** If
`Jetstream connection closed` log lines are appearing, the
WebSocket is reconnecting. The ingester has exponential backoff
(TN-ING-001 cursor-saving + reconnect logic) and replays from
the last saved cursor on reconnect. Wait 30s; if still
flapping, switch JETSTREAM_URL to a backup relay and restart.

**Common cause: trust-flag accidentally disabled.** Every event
path checks `readBoolFlag(db, 'trust_v1_enabled')`. If the flag
flipped (operator action OR pg blip leaving the row in an
unexpected state), the ingester drops events. Re-enable:
```bash
npx tsx src/admin/trust-flag-cli.ts enable
```

### 1.3 Escalate

If the ingester catches up but the lag returns within an hour:
this is a sustained-load issue, not a spike. File a capacity
ticket — V1 sizing assumed Plan §13.6 traffic shapes, breaches
need explicit re-sizing.

---

## 2. Cascade backlog — dirty-flag table growing unbounded

**Trigger**: `subject_dirty_flags` row count > 10k AND not
draining. Surfaces as scorer job durations creeping up
(`refresh-subject-scores` in particular).

### 2.1 Diagnose

```sql
SELECT count(*) FROM subject_dirty_flags;
SELECT min(created_at), max(created_at) FROM subject_dirty_flags;
-- if max - min > 1 hour, refresh-subject-scores isn't draining
```

The dirty-flag table is the cascade buffer (TN-SCORE-008): every
attestation insert flips a row, and `refresh-subject-scores`
drains the flags every 5 minutes by recomputing the subject
score then deleting the flag. Backlog = drain rate < flip rate.

### 2.2 Resolve

**Per-run cap is hit.** TN-SCORE-008 caps `refresh-subject-scores`
at 1000 subjects per tick (cap-hit metric `scorer.subject_scores.cap_hit`).
At 5-minute cadence that's 12k/hour drain. If sustained inflow
is > 12k/hour you need either:

- More frequent ticks: edit the cron in `scorer/scheduler.ts`
  from `*/5 * * * *` to `*/2 * * * *` and redeploy.
- Higher cap: raise `MAX_SUBJECTS_PER_RUN` from 1000 to 5000
  in `scorer/jobs/refresh-subject-scores.ts`. Each subject's
  recompute is ~1ms so 5k = 5s per tick — still well under
  the 5-minute cadence headroom.

**Stuck flags from a poison row.** If a single subject's
recompute throws and the surrounding code doesn't isolate it,
the whole tick rolls back and the flag stays. Check scorer
error logs for `refresh-subject-scores` failures. The job's
per-row try/catch should surface this as a counter
`scorer.subject_scores.errors`.

### 2.3 Escalate

If the inflow rate is sustained > 30k/hour even after
re-tuning, the V1 sizing assumption is breached. Cap-hit
metric on `scorer.subject_scores.cap_hit` will be persistently
non-zero — escalate to capacity planning.

---

## 3. Cache flush — DID-doc cache stale after key rotation

**Trigger**: a user rotated their namespace key but signatures
are still validating against the old key (TN-AUTH-003 5-minute
TTL window). User complaint or self-monitor.

### 3.1 Diagnose

The DID-doc cache lives in-memory on the AppView Web process.
There is no V1 admin endpoint to flush it. The TTL is 5 minutes.

### 3.2 Resolve

**Wait it out** (preferred): 5 minutes max. The cache is per-DID;
only the affected DID's signatures are validating against stale
state. Other users are unaffected.

**Force flush** (incident response): restart the Web process.
This evicts every cached DID doc. Cost: a brief reconnect blip
for in-flight WS clients (which the mobile app already handles
gracefully — see `apps/mobile/src/trust/outbox.ts` reconnect
semantics).

```bash
systemctl restart dina-web
```

### 3.3 V2 follow-up

A `dina-admin trust flush-doc-cache <did>` CLI is V2 work. The
V1 stance is "wait or restart". Don't add ad-hoc admin endpoints
in V1 — V2 plans the auth model for these cleanly.

---

## 4. Enrichment-job catch-up — heuristic table updated, subjects need re-classification

**Trigger**: a curator added a new entry to `host_category.ts`,
`known_orgs.ts`, or `category_keywords.ts`. Existing subjects
referencing that domain/org are still mis-classified until the
weekly recompute fires.

### 4.1 Diagnose

The weekly batch `subject-enrich-recompute` runs Sundays 02:00
UTC (TN-ENRICH-006). Re-runs `enrichSubject()` over subjects
where `enriched_at IS NULL OR enriched_at < (now - 7d)`. Per-
run cap = 10k subjects.

If the curator wants the change to propagate **now** (e.g.
imminent demo, urgent re-categorisation), there are two paths:

### 4.2 Resolve

**Path A — kick the weekly job manually.**

```bash
npx tsx src/scorer/jobs/subject-enrich-recompute.ts
```

Runs one tick, processes up to 10k stale subjects. If more
than 10k are stale, run twice (the cap is per-tick, not
per-run; consecutive ticks each get the next 10k batch).
Cap-hit metric: `scorer.enrich_recompute.cap_hit`.

**Path B — single-subject force.**

```bash
npx tsx src/admin/trust-enrich-cli.ts --subject-id <id>
```

(TN-ENRICH-007.) Re-enriches one subject. Useful when
operations want a known-affected subject visibly correct
before the full batch runs. Exit 0 = updated; exit 2 = not
found (distinguishable from log-only success).

### 4.3 Sanity-check after re-enrich

```sql
SELECT id, name, category, language, enriched_at
FROM subjects
WHERE id = '<subject-id>';
-- expect: enriched_at = recent NOW(), category reflects the
--         new heuristic.
```

---

## 5. Sybil cluster detected — coordinated abuse pattern

**Trigger**: anomaly-detection or sybil-detection flags a
cluster (`scorer.detect_sybil.flagged` metric spikes). Could
also be operator observation.

### 5.1 Triage

| Question | Answer source |
|---|---|
| How big is the cluster? | `psql` query against the flagged DIDs |
| Same PDS host? | `did_profiles.handle` (if stored) or DID resolution |
| Recent attestation surge? | `attestations.created_at` filter for the cluster |
| Which subjects are the targets? | aggregate by `attestations.subject_id` |

### 5.2 Resolve

**Per-PDS suspension** (V1 — TN-OPS-003 CLI + schema landed; ingester gate wires up in a follow-up):

```bash
# Add a host to the suspension list. Idempotent — re-suspending
# replaces the prior row's reason + suspended_at.
npx tsx src/admin/trust-suspend-pds-cli.ts add <host> <reason>

# List current suspensions (sorted by most-recent first).
npx tsx src/admin/trust-suspend-pds-cli.ts list

# Remove a suspension. Exit 2 if the host wasn't in the list
# (distinguishable no-op).
npx tsx src/admin/trust-suspend-pds-cli.ts remove <host>
```

Effect: the suspension list is operator-managed in V1; the
ingester gate that consults the list during event processing
wires up in a separate task. Until the gate is wired, abuse
mitigation is twofold — (a) build the suspension list now via
the CLI so it's curator-maintained ahead of the gate; (b) for
active incidents, the global kill switch (TN-FLAG-002 below) is
the real V1 abuse-response. Existing records the cluster
already published are untouched — they're public on the
firehose; the AppView is choosing not to index further from this
source once the gate ships.

**Per-DID quarantine** (V1 — no per-DID flag CLI yet):

There is no `dina-admin trust flag-did` in V1. The closest
existing path is the namespace-disable rejection (TN-ING-003,
which lands when namespace-key signature verification ships).
Until then, the only DID-targeted abuse-response is the
**global** kill switch (next paragraph) plus the per-PDS
suspension above when the cluster shares a host.

**Last resort: full kill switch.** If the abuse is severe + the
cluster is fast-rotating PDS hosts:

```bash
npx tsx src/admin/trust-flag-cli.ts disable
```

This globally pauses the trust namespace. Use only if
per-cluster suspension can't keep up — it's user-visible.

### 5.3 Forensics

Before suspending, dump the cluster's records for post-incident
analysis:

```sql
COPY (
  SELECT * FROM attestations
  WHERE author_did IN ('did:plc:...', 'did:plc:...')
  AND created_at > NOW() - INTERVAL '7 days'
) TO '/tmp/sybil-cluster-2026-04-29.csv' WITH CSV HEADER;
```

The data stays on the Postgres host; ship it to an analysis
environment manually.

---

## 6. Postgres degraded — db connection failures, slow queries

**Trigger**: AppView 5xx rate > 1%, OR `psql -c "SELECT 1"`
hanging.

### 6.1 Triage in priority order

1. Is Postgres up? (`pg_isready`, `systemctl status postgres`)
2. Is the AppView pool exhausted? (metric `db.pool.in_use`
   approaching `DATABASE_POOL_MAX`)
3. Is replication lag (if applicable) > 30s?
4. Is the disk full? (`df -h` on the Postgres host)
5. Is there a long-running blocker?
   ```sql
   SELECT pid, state, wait_event, query, age(now(), query_start)
   FROM pg_stat_activity
   WHERE state != 'idle' ORDER BY query_start LIMIT 10;
   ```

### 6.2 Resolve

**Pool exhausted**: raise `DATABASE_POOL_MAX` and restart Web.
Each Web process has its own pool — sized for "expected
concurrent xRPC calls + scheduler tick spikes".

**Disk full**: most common culprit is `ingest_rejections`
growing without bound. There's no V1 cleanup job for this
table (rejections are kept indefinitely for audit). Manual
prune:

```sql
DELETE FROM ingest_rejections
WHERE rejected_at < NOW() - INTERVAL '30 days';
VACUUM ANALYZE ingest_rejections;
```

**Long-running blocker**: identify with the
`pg_stat_activity` query above. If it's a stuck scorer job:
```sql
SELECT pg_cancel_backend(<pid>);  -- graceful
SELECT pg_terminate_backend(<pid>);  -- if cancel doesn't take
```

### 6.3 Escalate

If you've exhausted the diagnostic flow + the DB is still
degraded, page the database owner. The AppView is stateless
above Postgres; there's nothing else to recover from on the
AppView side.

---

## 7. Cosig inbox flooded — abuse via mass-cosig requests

**Trigger**: a user reports their cosig inbox has 100s of
spam requests, OR `cosig_requests` row count grows orders of
magnitude faster than `attestations`.

### 7.1 Diagnose

```sql
SELECT recipient_did, count(*)
FROM cosig_requests
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY 1
ORDER BY 2 DESC
LIMIT 20;
-- the top recipient(s) are the spam targets
```

```sql
SELECT requester_did, count(*)
FROM cosig_requests
WHERE created_at > NOW() - INTERVAL '24 hours'
AND recipient_did = '<target>'
GROUP BY 1
ORDER BY 2 DESC;
-- the top requester(s) are the spammers
```

### 7.2 Resolve

**Per-DID rate-limit at the cosig layer** is V1 work landed
under TN-API-007 (60/IP/min on `cosigList`). This caps reading
the inbox; it does NOT cap publishing cosig requests (that's
the firehose-side rate-limit + per-collection daily cap, which
caps the spammer at the daily collection quota — typically
1000 records/day).

**If the spammer is bypassing rate limit** (rotating IPs +
DIDs):
- Per-PDS suspension (§5.2) if they share a host — TN-OPS-003
  CLI (`trust-suspend-pds add`) builds the curator list now;
  ingester gate wires up follow-up.
- Last resort: global kill switch (`dina-admin trust disable`)
  while you investigate the rotation pattern.

**Help the victim**: the cosig-expiry-sweep runs hourly :30
and removes expired requests. Spam requests with short TTLs
auto-clean in ≤ 1 hour. Long-TTL spam requires manual
deletion:

```sql
DELETE FROM cosig_requests
WHERE recipient_did = '<victim>'
AND requester_did = '<spammer>';
```

---

## 8. Health-check failure on `/healthz`

**Trigger**: load balancer marking a Web instance unhealthy.

### 8.1 Diagnose

The `/health` endpoint returns:
```json
{"status":"ok|fail","db":"ok|fail","timestamp":"..."}
```

`db: "fail"` means Postgres is unreachable from this Web
process. `status: "fail"` means at least one critical
sub-system is fail.

### 8.2 Resolve

`db: "fail"` → §6 (Postgres degraded).

`status: "fail"` with `db: "ok"` → likely an in-process
crash or unhandled rejection. Check process logs, restart the
Web instance:

```bash
systemctl restart dina-web
```

Restart is safe — Web is stateless; the Scorer + Ingester
keep running.

---

## 9. Emergency contact info

**Replace this section with your operator-specific paging
config when forking this runbook.** The deploy team owns the
runbook; the on-call rotation owns the response.

```
Primary on-call:  <pagerduty / opsgenie schedule URL>
Secondary:         <…>
DB owner:          <…>
Network owner:     <…>  (for Jetstream relay issues)
Escalation policy: <…>
```

---

## 10. Reference: closed rejection-reason taxonomy

When debugging, the ingester's `RejectionReason` is one of
**five values** (TN-DB-005 / `appview/src/ingester/rejection-writer.ts`):

| Reason | Meaning |
|---|---|
| `rate_limit` | per-DID OR per-collection daily cap (TN-ING-002) |
| `signature_invalid` | namespace-key signature mismatch (TN-ING-003 — wired in V1.x; not all paths V1) |
| `schema_invalid` | record fails Zod validation (`record-validator.ts`) |
| `namespace_disabled` | namespace fragment present but not in author DID doc's `assertionMethod` |
| `feature_off` | `trust_v1_enabled` flag is `false` |

Adding a new reason is a schema migration + a TS union
expansion + a metric-cardinality review. Keep this list short
on purpose — high-cardinality reason labels poison Prometheus.
