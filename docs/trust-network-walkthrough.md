# Trust Network V1 — Walkthrough

> **Audience**: developers, integrators, and curators who want a single
> entry point into what Dina's Trust Network V1 is, how it's wired,
> and where to look for deeper context.
>
> **Scope**: V1 (the `com.dina.trust.*` × 19 lexicons +
> `com.dina.service.profile`, the AppView's three daemons, the 12
> scheduled jobs, the 11 xRPC endpoints, the `appview_config`
> operator surface, the mobile Trust tab). V2 work is referenced
> inline where it closes a documented V1 gap.
>
> **Companion docs**:
> - `docs/appview-walkthrough.md` — the broader AppView architecture
>   guide (predates V1; covers the database / FTS / scoring
>   plumbing in depth).
> - `docs/trust-network/threat-model.md` — V1 limitations
>   enumerated (TN-DOCS-002).
> - `docs/trust-network/deploy-runbook.md` — production deploy
>   procedure (TN-OPS-001).
> - `docs/trust-network/ops-runbook.md` — incident-response
>   runbook for on-call operators (TN-OPS-002).
> - `docs/TRUST_NETWORK_V1_BACKLOG.md` — line-item backlog with
>   per-task substantive completion notes.
> - `docs/TRUST_NETWORK_V1_TASKS.md` — same task IDs cross-listed
>   against the Plan v3 sections.

---

## 1. Why a Trust Network

Every time you transact online, you trust strangers. The signals
you have (star ratings, reviews, a platform's algorithmic ranking)
are the things the platform monetises — they're for sale. **The
Trust Network is the first layer of the internet that ranks by
*verified truth* instead of *ad spend***.

Trust Network V1 is built on the AT Protocol. Every trust record
is a signed, portable, user-owned object in a Personal Data
Server. The AppView is one possible *view* of this data — anyone
can build their own AppView that reads the same firehose and
computes trust differently. That's the point.

A user reviews a restaurant. The review is signed by their
namespace key, published to their PDS, picked up by Jetstream,
indexed by the AppView, and cross-referenced against:

- Their own trust score (have they been a credible reviewer
  historically?)
- The viewer's social graph (is this reviewer 1-hop in my
  network — friend boost ×1.5)
- The subject's other reviews (consistency with the trust band)
- Sybil + anomaly detection (is this part of a coordinated
  cluster?)
- Operator-curated overrides (is the publishing PDS host
  suspended for abuse?)

The output: a search result that ranks restaurants by *who
your network trusts* rather than by *who paid for placement*.

---

## 2. The architecture

The AppView is **three daemons sharing one Postgres**:

```
Jetstream firehose
        │
        ▼
   ┌────────────┐
   │  Ingester  │  → Postgres  ┐
   └────────────┘               │
                                ▼
   ┌────────────┐         ┌──────────┐
   │   Scorer   │  ← cron │ Postgres │ ← xRPC
   └────────────┘         └──────────┘    │
                                ▲         │
                                │         ▼
                                │    ┌────────┐
                                └────│  Web   │ ← clients
                                     └────────┘
```

**Ingester** consumes the Jetstream firehose, validates each
record against `record-validator.ts`, runs the schema gates
(rate-limit / quota / feature-off / signature / namespace-active /
PDS-not-suspended), and persists to Postgres. Rejected records
land in `ingest_rejections` with one of five closed reasons
(`rate_limit`, `signature_invalid`, `schema_invalid`,
`namespace_disabled`, `feature_off` — and once the gate wires up,
`pds_suspended`).

**Scorer** runs 12 background jobs on cron (see §6 below).

**Web** serves 11 xRPC endpoints (see §7 below) at
`/xrpc/com.dina.trust.*` + `/xrpc/com.dina.service.*`.

The three daemons can run in one process (single-node V1
default) or three processes (horizontal scale). State is in
Postgres; restart is safe.

---

## 3. Records — what gets attested

The Trust Network exposes 20 record types, all under
`com.dina.*` AT Protocol NSIDs. Schemas live in
`appview/src/ingester/record-validator.ts` (TN-TEST-005 covers
every schema with happy-path + rejection tests).

| NSID | Purpose |
|---|---|
| `com.dina.trust.attestation` | The core review record — subject + category + sentiment + dimensions + evidence + tags |
| `com.dina.trust.vouch` | "I vouch for this person professionally" — DID-targeted, weighted by relationship |
| `com.dina.trust.endorsement` | Skill endorsement — DID + skill |
| `com.dina.trust.flag` | Subject-level abuse flag (4-severity closed enum) |
| `com.dina.trust.reply` | Threaded reply with intent (agree, dispute, clarify, etc.) |
| `com.dina.trust.reaction` | Lightweight reaction (helpful, suspicious, etc., 8-value enum) |
| `com.dina.trust.reportRecord` | Operator-actionable abuse report (13-value reason taxonomy) |
| `com.dina.trust.revocation` | Retract a previously-published record |
| `com.dina.trust.delegation` | Grant another DID limited authority on your behalf |
| `com.dina.trust.collection` | Curated list ("my recommendations for office chairs") |
| `com.dina.trust.media` | Photo / video attached to a parent record |
| `com.dina.trust.subject` | First-class subject record (the thing being attested about) |
| `com.dina.trust.amendment` | Edit / correction of an earlier record |
| `com.dina.trust.verification` | Fact-check verdict (confirmed / denied / inconclusive) |
| `com.dina.trust.reviewRequest` | Solicit reviews from your network for a subject |
| `com.dina.trust.comparison` | Side-by-side comparison of multiple subjects |
| `com.dina.trust.subjectClaim` | Same-as / related / part-of links between subjects |
| `com.dina.trust.trustPolicy` | Per-user policy declaration (depth limits, blocked DIDs, etc.) |
| `com.dina.trust.notificationPrefs` | Notification routing for the user's mobile client |
| `com.dina.service.profile` | Service registry (notary bots, transit oracles, etc.) — discovery namespace, NOT trust-namespace |

**Pseudonymous namespaces** (`namespace_<N>` under
`m/9999'/4'/N'` derivation) attach to attestations + endorsements
via the optional `namespace` field. Each namespace gets its own
Ed25519 signing key, registered in the user's DID document under
`assertionMethod`. See `docs/trust-network/threat-model.md` §1.1
for the V1 pseudonymity caveat.

---

## 4. Subject enrichment

Subjects are pure data containers; the AppView enriches them at
ingest time + on a weekly recompute cycle. The cascade
(`appview/src/util/subject_enrichment.ts`):

1. **`host_category.ts`** — known PDS host → category map
   (e.g. `etsy.com → product`).
2. **`known_orgs.ts`** — Wikidata-anchored organisation catalog
   (~150 entries, QID-keyed).
3. **`category_keywords.ts`** — name-keyword classifier for
   subjects without identifying URI.
4. **`identifier_parser.ts`** — typed identifier extraction
   (ISBN-13, GTIN-13, MPN, etc.).
5. Fallback: `'claim'` (catch-all bucket).

Output: `subject.category`, `subject.metadata` (jsonb),
`subject.language` (BCP-47 from `franc-min`), `subject.enrichedAt`.

The weekly **`subject-enrich-recompute`** job (TN-ENRICH-006)
re-runs the enrichment for any subject older than 7 days OR
never enriched, so curator updates to the heuristic tables
propagate inside one week without a hand-rolled backfill.

---

## 5. Scoring — the trust formula

Plan §7 defines the v1 formula in canonical form. Conformance
vectors are pinned in
`appview/tests/unit/trust_score_conformance.test.ts` (TN-TEST-001).
Every implementation must produce byte-for-byte identical scores
against the same inputs — that's the anchor for cross-AppView
verification.

Inputs to a single subject score:

- **Reviewer trust** (per attestation) — composite of reviewer
  history (review count, reviewer-quality, sybil-proximity).
- **Sentiment band** — `positive` / `neutral` / `negative`,
  weighted into the aggregate.
- **Dimension thoroughness** — `dimensions[]` count + value
  distribution.
- **Recency** — exponential decay with daily ticks.
- **Coordination signals** — sybil + anomaly scores reduce the
  contribution of suspicious reviewers.

Output: `subject_scores.score` ∈ [0, 1], with a 4-band label:
- ≥ 0.8 → `'high'`
- ≥ 0.5 → `'moderate'`
- ≥ 0.3 → `'low'`
- otherwise → `'very-low'`
- NULL `score` → `'unrated'`

The viewer-side **friend boost** (TN-SCORE-003) is a flag, not
a multiplier: if any of the subject's reviewers overlap the
viewer's 1-hop graph, the search ranking score gets ×1.5 once.
Multiple overlapping friends → still ×1.5 (regression-pinned —
stacking would let heavily-networked viewers push crowd-favoured
subjects above their actual ranking, defeating the sort-by-
relevance contract).

---

## 6. The 12 scheduled scorer jobs

Schedule lives in `appview/src/scorer/scheduler.ts`. Each job is
in `appview/src/scorer/jobs/`.

| Job | Cron | Purpose |
|---|---|---|
| `refresh-profiles` | `*/5 * * * *` | propagate did_profiles updates (alias→DID, etc.) |
| `refresh-subject-scores` | `*/5 * * * *` | drain `subject_dirty_flags`, recompute scores |
| `refresh-reviewer-stats` | `*/15 * * * *` | per-reviewer review-count, reviewer-quality, sybil-proximity |
| `refresh-domain-scores` | `0 * * * *` | per-domain aggregate trust (for the optional domain filter) |
| `detect-coordination` | `*/30 * * * *` | rolling co-attestation pattern detection |
| `detect-sybil` | `0 */6 * * *` | sybil-cluster detection (scan-and-flag) |
| `process-tombstones` | `*/10 * * * *` | apply per-record revocations |
| `decay-scores` | `0 3 * * *` | daily exponential-decay tick |
| `cleanup-expired` | `0 4 * * *` | drop expired delegations / cosigs / etc. |
| `cosig-expiry-sweep` | `30 * * * *` | hourly: mark expired cosig requests |
| `subject-orphan-gc` | `0 5 * * 0` | weekly: drop subjects with no surviving attestations |
| `subject-enrich-recompute` | `0 2 * * 0` | weekly: re-run enrichment for stale subjects |

All jobs have per-run caps (each job's docstring documents the
specific value); a single tick can never run unboundedly long.
The cap-hit metric (`scorer.<job>.cap_hit`) signals when the
sizing assumption is breached.

---

## 7. The 11 xRPC endpoints

Wired in `appview/src/web/server.ts`. Each endpoint has its own
file in `appview/src/api/xrpc/`. All 11 share the per-(IP,
method) rate-limit middleware (TN-API-007) with differentiated
tiers (60 / 120 / 600 per minute).

| Endpoint | Tier | Purpose |
|---|---|---|
| `com.dina.trust.search` | 60/min | Free-text + filter search over attestations (TN-API-001 added category/language/location/metadata/minReviewCount filters) |
| `com.dina.trust.subjectGet` | 120/min | Subject detail with reviewer groups (contacts / extended / strangers) (TN-API-002) |
| `com.dina.trust.resolve` | 60/min | Resolve a free-text or DID into a subjectId + trust verdict (TN-API-003) |
| `com.dina.trust.networkFeed` | 60/min | Viewer's 1-hop reviewers' recent attestations (TN-API-004) |
| `com.dina.trust.attestationStatus` | 600/min | Outbox-watcher polling: pending → indexed / rejected (TN-API-005) |
| `com.dina.trust.cosigList` | 60/min | Mobile cosig inbox — recipient-filtered, status-filtered (TN-API-006) |
| `com.dina.trust.getProfile` | 120/min | Per-DID profile (legacy, predates V1) |
| `com.dina.trust.getAttestations` | 120/min | Per-author attestation feed (legacy, predates V1) |
| `com.dina.trust.getGraph` | 60/min | Graph traversal — N-hop expansion |
| `com.dina.service.search` | 60/min | Service discovery — capability + location |
| `com.dina.service.isDiscoverable` | 60/min | Predicate: is this service profile public? |

The trust-namespace endpoints are gated by the `trust_v1_enabled`
master kill switch (TN-FLAG-003); flipping disable returns 503
for `com.dina.trust.*` traffic but leaves `com.dina.service.*`
unaffected.

---

## 8. Operator surface

The AppView is operator-controlled at three points:

**The kill switch (TN-FLAG-002)** — `dina-admin trust enable|
disable|status` flips `trust_v1_enabled` in `appview_config`.
Plan §13.10 ramp default: ON. Operators flip OFF for incident
response.

**Re-enrichment force (TN-ENRICH-007)** —
`dina-admin trust enrich --subject-id <id>` re-runs the
heuristic cascade on a single subject when an urgent
re-categorisation is needed before the weekly batch.

**PDS suspension (TN-OPS-003)** —
`dina-admin trust suspend-pds add|remove|list <args>` manages
the abuse-response allowlist-by-exclusion. The schema + reader
+ CLI ship in V1; the ingester gate that consults the table
during event processing wires up in a follow-up (the operator-
facing infrastructure is in place ahead of the gate so curators
can build the suspension list before the gate goes live).

All three CLIs live in `appview/src/admin/`, open a fresh DB
connection per invocation, exit 0 on success, 1 on argument /
DB error, and (where applicable) 2 on "not found" semantics so
operators can distinguish a real mutation from a no-op without
log parsing.

---

## 9. Mobile surface

The mobile client (Expo / React Native, in `apps/mobile/`)
exposes Trust Network V1 behind the `trust_v1_enabled` flag
(TN-FLAG-005). When enabled, the user sees:

- **Trust tab** — feed + search + facet bar (TN-MOB-011 — backlog).
- **Subject detail** (`[subjectId].tsx`) — header card + reviewer
  groups by graph distance (TN-MOB-012 — backlog).
- **Compose** (`write.tsx`) — attestation flow, optional
  pseudonymous namespace selector (TN-MOB-013 — backlog).
- **Namespace management** (`namespace.tsx`) — list / create /
  rotate / disable namespaces (TN-MOB-014 — backlog).
- **Cosig inbox** — receive + accept / reject co-signature
  requests, drives D2D `trust.cosig.accept` on accept (TN-MOB-042
  — backlog).
- **Outbox** — local queue + state machine for offline publish
  (TN-MOB-004 — done; surface is TN-MOB-017 backlog).

The data layer (`apps/mobile/src/trust/*.ts`) ships ahead of
the screens so the state machines + AppView clients can
land + be tested in isolation. Per the backlog, screens
(TN-MOB-011..017) are open work; the data layer + flag plumbing
is done.

---

## 10. Where to go next

| If you want to … | Read |
|---|---|
| Understand the broader AppView architecture | `docs/appview-walkthrough.md` |
| Understand V1's deliberate limits | `docs/trust-network/threat-model.md` |
| Deploy V1 to production | `docs/trust-network/deploy-runbook.md` |
| Respond to an incident | `docs/trust-network/ops-runbook.md` |
| Track open work | `docs/TRUST_NETWORK_V1_BACKLOG.md` |
| Cross-reference Plan v3 sections | `docs/TRUST_NETWORK_V1_TASKS.md` |
| Review the trust-score formula | `appview/src/scorer/algorithms/trust-score.ts` + `appview/tests/unit/trust_score_conformance.test.ts` |
| Add a new record type | `appview/src/ingester/record-validator.ts` (Zod schema), `appview/src/ingester/handlers/<name>.ts` (handler), `appview/src/db/schema/<name>.ts` (table), then update the totals in BACKLOG.md |
| Add a new xRPC endpoint | `appview/src/api/xrpc/<name>.ts`, wire in `appview/src/web/server.ts`, add to TN-API-007's `PER_METHOD_LIMITS_RPM` table |
| Add a new operator CLI | match the `appview/src/admin/trust-flag-cli.ts` pattern (positional args, exit 0/1/2 semantics, fresh DB per invocation, pure `run<X>Command` for testability) |
