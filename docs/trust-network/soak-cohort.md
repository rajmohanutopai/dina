# Trust Network V1 — Soak-Cohort Onboarding

> **Audience**: operators running the V1 ramp — bringing the first
> wave of users onto a deployed AppView before opening the gates
> to general availability.
>
> **Scope**: how to onboard early users (the "soak cohort"), what
> signals to monitor, when to ramp wider, when to roll back. The
> V1 ramp posture is **observe + iterate** — collect feedback from
> a small group, fix what breaks, then expand. The flag-gated
> architecture (TN-FLAG-001/002/003/005) makes this safe by default.
>
> **Companion docs**:
> - `docs/trust-network/deploy-runbook.md` — production deploy
>   procedure (TN-OPS-001).
> - `docs/trust-network/ops-runbook.md` — incident response for
>   the soak window (TN-OPS-002).
> - `docs/trust-network/observability.md` — what to watch (TN-OBS-001).
> - `docs/trust-network/threat-model.md` — what V1 doesn't promise
>   (TN-DOCS-002).

---

## 1. The shape of a V1 ramp

```
   Phase 1 (soak)         Phase 2 (gradual)        Phase 3 (GA)
  ────────────           ─────────────────        ──────────────
  10–50 users   →   100–1,000 users    →    open enrolment
  hand-curated      invitation-led            self-serve
  2–4 weeks         2–4 weeks                 ongoing
  high-touch        medium-touch              best-effort support
```

The soak cohort is **Phase 1**. This document covers Phase 1 only;
gate-opening into Phase 2 + 3 is a deployment-specific decision
that gets its own document at the time.

---

## 2. Pre-ramp checklist

Before naming the soak cohort:

| Check | Owner | Pass criteria |
|---|---|---|
| AppView deployed + green | Ops | `/health` reports ok; `/metrics` returns; smoke checks per `deploy-runbook.md` §5 pass |
| Trust-V1 flag is **disabled** | Ops | `dina-admin trust status` returns `false` |
| Threat model reviewed | Product / Security | `threat-model.md` skim done; the 7 "what V1 doesn't promise" items are acceptable for the cohort's use case |
| Mobile build deployed | Mobile | Trust tab gated by `loadTrustV1Enabled` returning `false` (default-hidden until flag flips) |
| Observability dashboards live | Ops | The 8 alert-grade metrics from `observability.md` show in the dashboard; alert rules wired |
| On-call rotation staffed | Ops | Soak window has a primary + secondary on-call, rotation calendar published |
| Rollback path tested | Ops | Test environment has been rolled back from V1-enabled to V1-disabled at least once; flip-time measured (< 60s) |
| Feedback channel | Product | Slack / Discord / form set up for cohort to file issues; ticket tracker has a "soak feedback" label |

---

## 3. Cohort selection

**Size**: 10–50 users. Smaller than 10 means you can't disambiguate
"this user hit a bug" from "this user is using it weirdly" — you
need at least a handful of users for issues to recur. Larger than
50 means you can't sustain high-touch support per user.

**Mix**:
- A few internal team members (your own dogfood — found bugs surface
  fastest when the people writing the code use it).
- A handful of "friendlies" — known users from prior beta programs
  who have given good feedback before.
- A handful of "average" target users — someone who matches your
  product's target persona, not a power user.

**Communications**:
- Each cohort member gets the V1 caveat list from the threat model
  (§7 of `threat-model.md`) before opt-in. Specifically the
  pseudonymity caveat (§1.1) — they need to know V1 namespaces are
  unlinkable to first-impression observers, NOT to dedicated
  investigators.
- A weekly check-in — async (Slack thread) or live (15-min call) —
  to surface friction that doesn't make it into the ticket tracker.

---

## 4. Day-0 ramp procedure

Once the cohort is selected:

1. **Enable the flag**. The kill switch:
   ```bash
   npx tsx src/admin/trust-flag-cli.ts enable
   ```
   Effect: AppView begins indexing `com.dina.trust.*` events; the
   xRPC trust-namespace gate opens. Mobile clients still see the
   tab hidden until the next bootstrap cycle hits the
   `loadTrustV1Enabled` fetcher (≤ 5 min by default — TN-FLAG-005's
   TTL).

2. **Notify the cohort**. They open the mobile app within the next
   hour and confirm the Trust tab appears. The first-run modal
   (TN-MOB-051) walks them through the V1 caveats (pseudonymity,
   what gets stored where).

3. **Watch the dashboards**. The first hour matters most:
   - `ingester.events.received` rate climbs to non-zero as cohort
     members publish their first records.
   - `ingester.rejections{reason="rate_limit"}` should stay at 0 —
     cohort members aren't bots; legitimate publish rate is far
     below the per-DID quota.
   - `xrpc.request_duration_ms` p95 stays under 1s for the
     well-known endpoints.
   - `scorer.<job>.cap_hit` stays at 0 — initial inflow is well
     under any per-run cap.

4. **Capture baselines**. After 24 hours, dump the metric values to
   a baseline file. These become the comparison for "is the next
   week's metric drift normal growth or an anomaly?"

---

## 5. Weekly cadence during soak

Each week of the soak window:

- **Mon morning** — review the week's tickets, metrics, on-call
  log. Triage: blocking (must fix before ramp) vs non-blocking
  (track, fix in parallel).
- **Mon afternoon** — fix blocking issues. Soak window pauses
  (no new cohort members) until blockers ship.
- **Wed** — async check-in with cohort. Send a short "how's it
  going?" — open-ended, NOT a survey. Free text reveals friction
  that closed-form questions miss.
- **Fri** — write up the week. What broke, what shipped, what's
  next. Post to the team channel; archive to the soak log.

---

## 6. Signals to roll back

If any of these happen, **flip the flag to disabled** and
investigate:

- Any cohort member's data leaks across namespaces (a
  pseudonymity bug, NOT the V1 caveat — the V1 caveat is "an
  investigator can correlate"; a leak would be "a casual observer
  can correlate", which V1 *does* promise to prevent).
- A trust-score regression that affects > 3 cohort members'
  rankings (one cohort member's complaint can be idiosyncratic;
  > 3 means it's systemic).
- An `ingester.rejections{reason="schema_invalid"}` rate spike on
  events from cohort members' DIDs — schema-invalid means our
  ingester rejected a record the mobile client published, which
  shouldn't happen for V1 if the schemas match.
- An `ingester.rejections{reason="signature_invalid"}` rate
  non-zero (once TN-ING-003 wires up) — possible attempted
  forgery against the cohort.
- A Postgres outage that lasts > 10 min — at small cohort scale
  this is pure overhead; better to pause the ramp than have the
  cohort experience a degraded surface.
- A confirmed sybil cluster targeting cohort members' subjects
  (the abuse-response posture is per-PDS suspension via
  TN-OPS-003; if abuse outpaces curation, fall back to flag
  disable).

```bash
# rollback (kill switch)
npx tsx src/admin/trust-flag-cli.ts disable
```

The flag flip is **not destructive** — disabling stops indexing
new records but doesn't unindex existing ones. Re-enabling
resumes from the Jetstream cursor (TN-ING-001 cursor-saving). A
cohort member who published while the flag was disabled has
their record sitting in the firehose; the ingester replays from
the saved cursor on re-enable.

---

## 7. Exit criteria — when to leave Phase 1

The soak window ends when:

| Criterion | Definition | Pass threshold |
|---|---|---|
| Stable ingestion | `ingester.rejections{reason!="feature_off"}` rate is at baseline (no anomalous reasons firing) | 14 consecutive days |
| Stable scoring | `scorer.<job>.cap_hit` is 0 across all 12 jobs | 7 consecutive days |
| Cohort retention | ≥ 80% of cohort members are still actively publishing each week | 4 consecutive weeks |
| No P0 / P1 tickets open | All blocker-level issues resolved | At ramp time |
| Threat-model items still acceptable | Re-review with cohort feedback | At ramp time |

If all five hold for the criteria periods, the cohort moves to
Phase 2 (open the flag for invitation-led growth).

If any breach for > 7 days, **stay in Phase 1**. Don't ramp on a
fragile foundation. Two weeks of Phase 1 stability buys months of
lower-friction Phase 2.

---

## 8. Soak log template

For each week of the soak, archive a one-pager:

```
# Week N — YYYY-MM-DD

## Cohort
- Active: <N> / 50
- New this week: <names>
- Departed this week: <names + brief reason>

## Metrics (avg over week vs prior week)
- ingester.events.received rate: <Δ>
- ingester.rejections rate by reason: <breakdown>
- xrpc latency p95: <ms>
- scorer cap-hit count: <Δ>

## Tickets
- New: <count, severities>
- Closed: <count>
- Open blockers: <list>

## Notable user feedback
- <quote 1>
- <quote 2>

## Decisions
- <decided this week, owners, dates>

## Next week
- <focus area>
```

This is operator-internal — it doesn't need to be polished, but
keeping it weekly gives Phase 2's launch decision a data
foundation rather than a vibe.

---

## 9. After the soak

When you exit Phase 1:

1. Snapshot the soak log into a single document for posterity
   (post-mortem-style — what worked, what didn't).
2. Update `threat-model.md` §8 ("Discovered post-V1") with any
   attack classes the cohort surfaced.
3. Update `observability.md` if the soak revealed metrics that
   should be in the alert-grade set but weren't.
4. Update the `BACKLOG.md` "Total to implement" line — Phase 1
   stability often surfaces small follow-ups that should land
   before GA.

The goal of the soak isn't to end without bugs — it's to end
with **known** bugs and a deliberate decision about which to fix
before ramping wider.
