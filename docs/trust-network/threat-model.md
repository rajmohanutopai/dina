# Trust Network V1 — Threat Model & Known Limitations

> **Audience**: implementers, integrators, operators, and researchers
> evaluating Dina's Trust Network for production use.
>
> **Scope**: V1 (Plan §0–§17, lexicons `com.dina.trust.*` × 19 + `com.dina.service.profile`).
> V2 work that closes specific gaps is referenced inline.
>
> **Status**: this document enumerates the V1 attack surface and the
> *deliberate* limitations the team is shipping with — it is not an
> exhaustive penetration-test report. New attack classes discovered
> post-ship belong in the same file under "Discovered post-V1".

---

## 1. Identity & namespaces

### 1.1 Pseudonymous namespaces share one DID document (V1 caveat)

**The limitation.** A user can register N pseudonymous namespaces
under the path `m/9999'/4'/N'`. Each namespace gets its own
Ed25519 keypair, registered in the user's DID document under
`assertionMethod`. From a casual observer's point of view the
namespaces are unlinkable — they sign different records, surface
under different display names, and the AppView's `getProfile`
endpoint scopes attestations by signing key.

**What V1 does NOT prevent.** A determined investigator who can
fetch the author's DID document can enumerate every
`assertionMethod` entry and then trivially correlate every record
signed under any of those keys back to a single root DID. The DID
document itself is public (PLC directory). V1 pseudonymity is
"unlinkable to first-impression observers", *not* "unlinkable to
dedicated investigators".

**Mitigation (V1)**: explicit operator + user disclosure.
- `apps/mobile/app/(tabs)/index.tsx` first-run modal documents
  this caveat before the user creates their first namespace.
- `apps/mobile/app/settings/about-trust.tsx` keeps the disclosure
  one tap away after acknowledgement.
- README + this threat model.

**V2 closes the gap** by issuing a separate PDS account per
namespace (true cryptographic separation; no shared DID doc).
That requires the AppView to learn the link between namespace
PDS accounts via a privacy-preserving registration flow (still
under design).

### 1.2 Namespace-key compromise

**Risk.** A namespace key is published under `assertionMethod` in
the user's DID doc. If the device holding the key is compromised,
an attacker can sign records as that namespace until the user
rotates.

**V1 mitigation**:
- Keys are derived from the master mnemonic via SLIP-0010 — the
  device only needs the namespace key, not the master seed. A
  device theft does not reveal other namespaces.
- Rotation is supported via `packages/core/src/identity/plc_namespace_update.ts`.
- Revocation propagates as fast as the user's PDS publishes the
  updated DID doc + AppView re-resolves (TTL-bounded; see §3.3).

**Residual risk.** Between compromise and rotation, the attacker
can publish records that look authentic. AppView has no way to
distinguish "authentic record signed pre-rotation" from "attacker
record signed pre-rotation" without ground-truth out-of-band
context. Operators can manually flag affected records; there is
no automated signature-roll back.

### 1.3 PDS-host suspension is operator-manual in V1

**TN-OPS-003** ships a CLI (`dina-admin trust suspend-pds <host>`)
that adds a PDS host to a blocklist; the ingester drops records
from suspended hosts. This is the V1 abuse-response posture — no
automatic sybil cluster detection, no automatic suspension. An
operator must observe the abuse pattern, identify the source PDS
host(s), and manually suspend.

**Residual risk.** A coordinated abuser who rotates PDS hosts
faster than the operator can suspend will keep landing records
until the abuse pattern is detected at a higher layer (e.g.
sentiment-anomaly scorer flags a sudden cluster). V2 considers
automatic provisional suspension based on anomaly thresholds.

---

## 2. Trust score & ranking

### 2.1 The trust-score formula is public

**Why it's public.** Plan §7 defines the v1 formula in canonical
form, with frozen test vectors at
`appview/tests/unit/trust_score_conformance.test.ts`. Every
implementation pins the same vectors. This enables independent
verification — a reviewer can compute their own expected score
from public inputs and verify the AppView agrees.

**Attack surface.** An adversary can reverse-engineer optimal
record patterns to maximise their own score: balance dimensions,
diversify subjects, preserve recency, recruit friends to attest.

**V1 mitigation**:
- The formula is multi-input with diminishing returns: no single
  axis (review count, sentiment, recency) dominates. Gaming one
  axis costs effort without proportional gain.
- Sybil detection (`scorer/algorithms/sybil-detection.ts`) flags
  clusters of accounts with anomalous co-attestation patterns.
- Anomaly detection flags sudden score spikes for review.
- Friend boost (TN-SCORE-003) is **flag-not-multiplier**: any
  1-hop overlap → ×1.5 once, NOT ×1.5 per friend (so a heavily-
  networked viewer cannot stack a 1.5^N multiplier by recruiting
  friends).

**Residual risk.** Sybil detection is heuristic, not
proof-of-personhood. A coordinated 5-account cluster with
diverse-looking attestation patterns can probably evade the V1
detector. V2 considers reputation-staked attestations
(slashing-on-misbehaviour) but the design is open.

### 2.2 Reviewer trust score is reviewer-independent + cacheable

**Trade-off.** The v1 formula computes reviewer trust *per
reviewer*, not *per (reviewer, viewer)*. This makes scores
cacheable + comparable across viewers — the same reviewer has
the same trust score regardless of who's looking.

**Attack consequence.** A reviewer who builds a high score in one
network context (e.g. by attesting accurately to one community)
carries that score everywhere. There is no way for a viewer to
say "this reviewer is high-trust elsewhere but I've personally
seen them be wrong" — the only viewer-dependent signal in V1 is
the friend-boost flag.

**V1 mitigation**: viewers can mute / block reviewers
client-side; the AppView serves the unfiltered score and the
client filters before display. V2 considers per-viewer trust
calibration but the design is open.

### 2.3 Friend boost amplifies coordinated friending

**The mechanism.** TN-SCORE-003's `friendBoostFor` returns ×1.5
when ANY 1-hop reviewer of a subject overlaps the viewer's 1-hop
graph. This is *flag* semantics — overlap-or-not, not
per-overlap.

**Attack.** A viewer who friends 50 high-volume reviewers gets
the 1.5× boost on a much larger fraction of subjects than a
viewer who friends 5. Whether this is *abuse* or *desired
behaviour* is intentional by design — friending more people SHOULD
expand the friend-boost surface.

**Residual risk.** A coordinated cluster can mutually friend +
mutually attest to elevate each other's subjects in their
respective views. The AppView's sybil + anomaly detectors are
the V1 line of defence; a sufficiently-organic-looking cluster
may evade them.

### 2.4 Score formula gameability via dimensions

**The mechanism.** Attestations carry up to 10 `dimensions[]`
each. A reviewer who consistently rates "5 dimensions all
exceeded" appears more thorough than one who rates "1 dimension
met". The score formula rewards dimensional thoroughness.

**Attack.** An attacker can copy-paste high-dimension review
templates across many subjects to look thorough.

**V1 mitigation**: text similarity detection at the scorer
level (deferred — was descoped from V1 ingester gates pending
real-corpus ground-truth). Reviewer-quality scoring uses
review-text uniqueness as one input.

**Residual risk.** AI-generated reviews with diverse phrasing
defeat naive uniqueness detection. The `isAgentGenerated`
self-disclosure flag (TN-DB-001) lets honest agents declare
themselves; bad-faith agents will not. V1 trusts the flag.

---

## 3. Network protocol & infrastructure

### 3.1 AppView is a centralised indexer

**The architecture.** Per Plan §1, AppView is a centralised
service that consumes the Jetstream firehose, builds the trust
graph, and serves xRPC queries. Every Dina client + Home Node
that wants to query trust scores hits the same AppView (or one
in a small federation).

**Attack surface**:
- AppView availability is a hard dependency for trust queries.
  An attacker who can DoS the AppView blinds every client.
- A compromised AppView could serve doctored scores. Clients in
  V1 do not independently verify — the conformance vectors pin
  the *formula* but not the *inputs*; an AppView that drops
  inconvenient attestations from the index serves a coherent but
  false score.

**V1 mitigation**:
- Rate limiting (TN-API-007) bounds per-IP query load — slows
  scraping + DoS.
- The full record set is public on the firehose. A determined
  client can run their own AppView and cross-check.
- Trust scores cache for 1 hour client-side (`network_search`'s
  cache layer) — short AppView outages are absorbed.

**Residual risk.** No client-side independent verification
beyond running a parallel AppView. V2 considers an attestation
inclusion proof scheme so clients can verify "this attestation
was in the index at time T" without trusting the server.

### 3.2 Rate limiting is per-(IP, method)

**The mechanism.** TN-API-007 sets per-(IP, method) buckets
with differentiated tiers (60 / 120 / 600 per minute).

**Bypass.** Tor / VPN / botnets rotate IPs. Each new IP gets
a fresh bucket. A motivated attacker with 10k IPs can issue
10k × 60 = 600k requests/min before per-IP limits engage.

**V1 mitigation**:
- LRU cache bounds memory (a single attacker rotating IPs
  cannot OOM the AppView).
- Blocked-request counter visibility on dashboards lets ops see
  pressure.

**V1 does NOT have**: global rate caps, captcha challenges,
proof-of-work gates, IP reputation feeds. These are V2 work
gated on observed need (V1 ramp-up traffic doesn't justify the
complexity).

### 3.3 DID document caching + propagation latency

**The mechanism.** AppView caches resolved DID documents (TTL
≤ 5 minutes per Plan §3.5.4 / TN-AUTH-003).

**Attack.** Within the cache window, a recently-rotated key
will continue to validate at the AppView using the *old* DID
doc. An attacker who learns of an imminent rotation can frontrun
with one last batch of malicious records that the AppView will
accept under the still-cached doc.

**V1 mitigation**: short TTL (5 min) caps the window. Operators
can manually flush the AppView cache via `dina-admin` (V2 work;
V1 path is restart-the-service).

**Residual risk.** Up to 5 minutes of frontrun window per
rotation. Acceptable for V1 — a user who suspects compromise
should rotate PROACTIVELY (before the device is compromised),
not REACTIVELY.

---

## 4. Records & content

### 4.1 Schema validation is reactive, not preventive

**The mechanism.** TN-TEST-005's record-validator rejects
malformed records at ingest time (Zod schemas in
`record-validator.ts`).

**What it does NOT prevent**:
- A flood of *valid* but *useless* records — schema-conformant
  spam.
- A flood of records targeting a non-existent NSID — these are
  dropped at the routing layer, not at the schema layer, and
  consume rate-limit budget.

**V1 mitigation**: per-collection daily quotas (TN-ING-002) cap
each (DID, collection) tuple. An attacker who lands 1000
valid-but-spammy attestations per day per DID hits the cap and
gets `rate_limit` rejections.

### 4.2 Cosig replay-attack defence

**The mechanism.** Cosig requests carry `clientId` (caller-
generated UUID v4) + `expiresAt` ISO datetime. The recipient's
ingester rejects duplicate `clientId` (idempotency) AND
rejects expired requests (`now() > expiresAt` → reject).

**V1 mitigation**: replay attempts are detected at the schema
level. The AppView's cosig schema (`cosigSchema` in
record-validator.ts) bounds `clientId` length + `expiresAt`
ISO format; the cosig handler enforces idempotency.

**Residual risk.** A replay attempt within the first request's
expiry window AND before the original lands at the AppView
would race; the second-write loses the idempotency check
because the first hasn't landed yet. AppView's PK constraint on
`(recipient_did, client_id)` is the final defence — both
inserts cannot land concurrently.

### 4.3 `isAgentGenerated` is self-disclosed + unverified

**The mechanism.** Per Plan §3.5.7, attestations carry an
optional `isAgentGenerated: boolean`. Honest AI agents set this
true; bad-faith agents leave it false.

**V1 stance.** No automatic detection. Sentiment-anomaly +
sybil-cluster detection flag *some* AI-generated attestation
patterns by side effect (uniform sentiment, coordinated
bursts), but the heuristic isn't AI-vs-human-targeted.

**V2 considers**: confidence-bounded AI-content detection
(probability score per record), with operator review for
borderline cases. Not in V1 scope.

### 4.4 Subject enrichment is heuristic + best-effort

**The mechanism.** TN-ENRICH-005 (`subject_enrichment.ts`)
runs a cascading heuristic: host_category lookup → known_orgs
lookup → category_keywords lookup → identifier_parser → fall
through to `'claim'` (catch-all bucket).

**Attack.** A subject whose URI domain is in the heuristic
table (e.g. `amazon.com → product`) gets reliably categorised.
A subject whose URI is on a fresh / unknown domain falls
through to `'claim'`. Bad actors can host subject pages on
custom domains to escape category-targeted ranking signals.

**V1 mitigation**: weekly recompute (TN-ENRICH-006) re-runs
enrichment with the latest heuristic tables, so a domain
that's *added* to host_category.ts within the week
back-classifies existing subjects.

**Residual risk.** First-week-after-publication subjects fall
through to `'claim'`. Search filters by `category` will miss
them until the weekly recompute. Acceptable — V1 trust network
is not optimised for first-week-of-publication freshness.

---

## 5. Mobile + client-side concerns

### 5.1 Local outbox + offline publish

**The mechanism.** Mobile maintains a local offline outbox
(TN-MOB-004). Records are queued in the keystore, signed
locally, and published via PDS createRecord when the device
regains network.

**Attack surface**:
- A device theft can leak queued-but-unpublished records (the
  outbox is plaintext-ish in the keystore — encrypted at rest by
  iOS/Android keychain but accessible to a rooted attacker).
- A coercion scenario (someone forces the user to publish a
  pre-queued record) is not differentiable from a legitimate
  publish at the AppView layer.

**V1 stance**: device security (passcode, biometric, secure
enclave) is the user's responsibility. Dina assumes the device
is trusted.

### 5.2 Trust-V1 feature flag — closed-default

**The mechanism.** TN-FLAG-001/002/003 ship a master
`trust_v1_enabled` kill switch. AppView gates trust namespace
xRPC calls behind it; mobile gates the trust tab visibility.

**Default stance**: V1 ships **enabled** (Plan §13.10
cutover). Operator must explicitly disable for incident
response.

**Closed-default failure mode**: if the AppView config DB read
fails, the gate returns 503 (NOT pass-through). This trades a
few seconds of unnecessary 503 during a pg blip for the
guarantee that data the operator just disabled never leaks.
Asymmetric — pick the safer side (TN-FLAG-003 docstring).

---

## 6. Operational risks

### 6.1 Single-operator AppView

**The risk.** V1 ships with one canonical AppView per Dina
deployment. Operator key compromise → adversary controls trust
scoring for every Dina client of that deployment.

**V1 mitigation**:
- Conformance vectors pin the formula, so an obviously-doctored
  score (one that disagrees with the local recomputation against
  public records) is detectable by any client motivated to run
  the math.
- Multi-operator federation is V2 work.

### 6.2 Migration order matters

**TN-DB-010** ships a single migration `<YYYYMMDDHHMM>_trust_v1.sql`
with idempotent up + down. **TN-OPS-001** ships the deploy
runbook (migration order, rollback steps, restart sequence).

**Risk.** A botched migration partially populates schema —
ingester writes against a half-formed table. Recovery is
manual (DROP TABLE + re-run the up).

**V1 stance**: idempotent up + down. A failed up CAN be re-run.
The ingester checks for the post-migration state at startup +
refuses to start if the schema is stale.

### 6.3 Backup + restore

**The mechanism**: Postgres `pg_dump`. Mobile state restored
from cloud backup (iCloud Keychain / Android Backup) preserves
namespace keys.

**Attack.** A compromised cloud backup leaks namespace keys.

**V1 stance**: device-level keychain encryption (Apple iOS
Secure Enclave, Android StrongBox) is the V1 trust boundary.
Users who need stronger guarantees can opt out of cloud backup
+ keep keys device-local.

---

## 7. What V1 does NOT promise

This section is the explicit "don't expect this from V1" list.
Do not deploy V1 if any of these matter to your use case:

1. **Forensic-grade pseudonymity** between namespaces (§1.1).
2. **Proof-of-personhood** for sybil resistance (§2.1).
3. **Zero-trust verifiable scoring** without running your own
   AppView (§3.1).
4. **Post-rotation backdating defence** beyond the cache TTL
   window (§3.3).
5. **AI-generated content detection** beyond the self-disclosure
   flag (§4.3).
6. **Multi-operator federation** of trust scoring (§6.1).
7. **Coercion-resistant publishing** — the user is the trust
   anchor, and Dina assumes the user's device is trusted
   (§5.1).

---

## 8. Discovered post-V1

*(Empty at ship time. New attack classes get added here with
ID, date, mitigation status, and the Plan section that closes
them.)*
