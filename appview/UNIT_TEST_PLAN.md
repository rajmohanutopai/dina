# Dina AppView — Unit Test Plan

> **Scope:** Pure-function tests with zero external dependencies (no database, no network, no Docker).
> All tests run in-memory with mocked dependencies. Target runtime: < 10 seconds total.
>
> **Traceability IDs:** Each test has a unique ID in the format `UT-{section}-{number}`.
> IDs map to architecture sections and production hardening fixes (Fix 1–13).
>
> **Framework:** Vitest (TypeScript-native, Jest-compatible API, fast ESM support)

---

## §1 — Scorer Algorithms (`src/scorer/algorithms/`)

### §1.1 Trust Score (`trust-score.test.ts`)

Traces to: Architecture §"Trust Score Algorithm", Fix 12 (convergence + zero-trust)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-TS-001 | all-positive attestations → high score | Input with 10 positive attestations from vouched, scored authors | overallScore > 0.8, sentiment component > 0.9 |
| UT-TS-002 | all-negative attestations → low score | Input with 10 negative attestations from vouched, scored authors | overallScore < 0.3, sentiment component < 0.15 |
| UT-TS-003 | mixed sentiment → mid-range score | Input with 5 positive, 3 neutral, 2 negative | overallScore between 0.4 and 0.7 |
| UT-TS-004 | zero attestations → neutral default | Empty attestationsAbout array | sentiment component = 0.5 (no data = neutral) |
| UT-TS-005 | no vouches → low vouch component | vouchCount = 0 | vouch component = 0.1 |
| UT-TS-006 | 10 vouches → near-maximum vouch signal | vouchCount = 10 | vouch component > 0.9 |
| UT-TS-007 | logarithmic vouch diminishing returns | vouchCount = 100 vs vouchCount = 10 | Difference < 0.15 (logarithmic curve) |
| UT-TS-008 | high-confidence vouch bonus | highConfidenceVouches = 4 | vouch component includes +0.2 bonus |
| UT-TS-009 | no review history → zero reviewer score | totalAttestationsBy = 0 | reviewer component = 0.0 (Fix 12: zero-trust default) |
| UT-TS-010 | high deletion rate → harsh penalty | tombstoneCount = 5, totalAttestationsBy = 10 | reviewer component < 0.1 |
| UT-TS-011 | high evidence rate → bonus | withEvidenceCount = 8, totalAttestationsBy = 10 | reviewer component boosted by evidence term |
| UT-TS-012 | helpful ratio → positive signal | helpfulReactions = 90, unhelpfulReactions = 10 | reviewer component includes helpfulness boost |
| UT-TS-013 | network component logarithmic | inboundEdgeCount = 50 | network component near 1.0 |
| UT-TS-014 | delegation inbound bonus | delegationInboundCount = 5 | network component includes +0.2 delegation term |
| UT-TS-015 | critical flag → 70% reduction | flagSeverities = ['critical'] | raw score multiplied by 0.3 |
| UT-TS-016 | serious flag → 40% reduction | flagSeverities = ['serious'] | raw score multiplied by 0.6 |
| UT-TS-017 | warning flag → 15% reduction | flagSeverities = ['warning'] | raw score multiplied by 0.85 |
| UT-TS-018 | multiple flags compound | flagSeverities = ['serious', 'warning'] | raw * 0.6 * 0.85 |
| UT-TS-019 | tombstone threshold → 60% penalty | tombstoneCount ≥ COORDINATION_TOMBSTONE_THRESHOLD (3) | raw multiplied by 0.4 |
| UT-TS-020 | damping factor applied (Fix 12) | Any input | overallScore = 0.85 * raw + 0.15 * 0.1 |
| UT-TS-021 | damping guarantees minimum floor | All zero inputs, maximum penalties | overallScore ≥ 0.015 (BASE_SCORE * (1 - DAMPING)) |
| UT-TS-022 | score clamped to [0, 1] | Extreme positive inputs | overallScore ≤ 1.0 |
| UT-TS-023 | score clamped to [0, 1] (low end) | Extreme negative inputs | overallScore ≥ 0.0 |
| UT-TS-024 | recency decay — fresh attestation weighted more | Attestation from 1 day ago vs 365 days ago | Fresh attestation has significantly higher weight |
| UT-TS-025 | evidence multiplier (1.3×) | Attestation with evidence vs without | Evidence attestation weighted 30% higher |
| UT-TS-026 | verified multiplier (1.5×) | Attestation with isVerified=true vs false | Verified attestation weighted 50% higher |
| UT-TS-027 | bilateral/cosignature multiplier (1.4×) | Attestation with hasCosignature=true | Cosigned attestation weighted 40% higher |
| UT-TS-028 | **Fix 12: zero-trust default** | authorTrustScore = null (unscored) | Author weight = 0.0, attestation contributes nothing |
| UT-TS-029 | **Fix 12: vouch-gating** | authorTrustScore = 0.8 but authorHasInboundVouch = false | Author weight = 0.0 despite high score |
| UT-TS-030 | **Fix 12: vouch-gating passes** | authorTrustScore = 0.8, authorHasInboundVouch = true | Author weight = 0.8, attestation contributes normally |
| UT-TS-031 | **Fix 12: sybil resistance** | 1000 attestations from unvouched DIDs | overallScore unchanged from zero-attestation baseline |
| UT-TS-032 | confidence — zero signals | All input counts = 0 | confidence = 0.0 |
| UT-TS-033 | confidence — few signals | totalSignals = 2 (< 3) | confidence = 0.2 |
| UT-TS-034 | confidence — some signals | totalSignals = 8 (< 10) | confidence = 0.4 |
| UT-TS-035 | confidence — moderate signals | totalSignals = 15 (< 30) | confidence = 0.6 |
| UT-TS-036 | confidence — many signals | totalSignals = 50 (< 100) | confidence = 0.8 |
| UT-TS-037 | confidence — high signals | totalSignals = 100+ | confidence = 0.95 |
| UT-TS-038 | component weights sum to 1.0 | Verify constants | SENTIMENT_WEIGHT + VOUCH_WEIGHT + REVIEWER_WEIGHT + NETWORK_WEIGHT = 1.0 |
| UT-TS-039 | neutral sentiment counted as half positive | 10 neutral attestations from trusted authors | sentiment component = 0.5 |

### §1.2 Reviewer Quality (`reviewer-quality.test.ts`)

Traces to: Architecture §"Scorer Jobs — refresh-reviewer-stats"

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-RQ-001 | corroboration rate calculation | 7 of 10 attestations corroborated by others | corroborationRate = 0.7 |
| UT-RQ-002 | deletion rate calculation | 2 disputed deletions out of 20 attestations | deletionRate = 0.1 |
| UT-RQ-003 | evidence rate calculation | 15 of 20 attestations have evidence | evidenceRate = 0.75 |
| UT-RQ-004 | helpful ratio — all helpful | helpfulReactions = 100, unhelpfulReactions = 0 | averageHelpfulRatio = 1.0 |
| UT-RQ-005 | helpful ratio — no reactions | helpfulReactions = 0, unhelpfulReactions = 0 | averageHelpfulRatio = 0.5 (neutral default) |
| UT-RQ-006 | revocation rate | 3 revocations out of 30 attestations | revocationRate = 0.1 |
| UT-RQ-007 | agent-generated flag detection | isAgent = true if > 50% of attestations are isAgentGenerated | isAgent correctly detected |
| UT-RQ-008 | active domains extraction | Attestations spanning 5 domains | activeDomains contains all 5 unique domains |
| UT-RQ-009 | coordination flag count propagation | 2 coordination flags detected | coordinationFlagCount = 2 |
| UT-RQ-010 | zero attestations → zero rates | No attestations by this DID | All rates = 0, no division by zero |

### §1.3 Sentiment Aggregation (`sentiment-aggregation.test.ts`)

Traces to: Architecture §"Subject Scores — refresh-subject-scores"

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-SA-001 | weighted score calculation | 3 positive, 1 negative | weightedScore reflects ratio |
| UT-SA-002 | confidence from attestation count | 50 attestations | confidence > 0.7 |
| UT-SA-003 | dimension summary aggregation | 10 attestations with "quality: met/exceeded" | dimensionSummary shows distribution per dimension |
| UT-SA-004 | authenticity consensus — majority positive | 8 verified-authentic, 2 suspicious | authenticityConsensus = "authentic" |
| UT-SA-005 | authenticity consensus — split opinion | 5 authentic, 5 suspicious | authenticityConfidence < 0.5 |
| UT-SA-006 | would-recommend rate | 7 of 10 reviewers rated positive | wouldRecommendRate = 0.7 |
| UT-SA-007 | attestation velocity | 10 attestations in last 7 days | velocity = ~1.4/day |
| UT-SA-008 | empty attestation list | No attestations for subject | All aggregations = zero/null, no errors |
| UT-SA-009 | verified attestation count | 3 of 10 have verification records | verifiedAttestationCount = 3 |
| UT-SA-010 | lastAttestationAt tracking | Most recent attestation = 2026-02-20 | lastAttestationAt = 2026-02-20 |

### §1.4 Anomaly Detection (`anomaly-detection.test.ts`)

Traces to: Architecture §"Scorer Jobs — detect-coordination, detect-sybil"

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-AD-001 | coordination detection — temporal burst | 20 attestations for same subject within 1 hour | Flagged as coordinated campaign |
| UT-AD-002 | coordination detection — below threshold | 5 attestations for same subject within 48 hours | Not flagged |
| UT-AD-003 | sybil cluster detection — correlated timing | 5 DIDs all created attestations within same 5-minute window | Flagged as potential sybil cluster |
| UT-AD-004 | sybil detection — minimum cluster size | 2 correlated DIDs (below SYBIL_MIN_CLUSTER_SIZE = 3) | Not flagged |
| UT-AD-005 | statistical outlier — sentiment flip | Subject normally positive, sudden burst of 10 negative | Anomaly event generated |
| UT-AD-006 | no anomalies in normal traffic | Steady stream of diverse attestations | Zero anomaly events |

### §1.5 Recommendation (`recommendation.test.ts`)

Traces to: Architecture §"Resolve Endpoint — computeRecommendation"

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-RC-001 | proceed — high trust, no flags | scores.weightedScore > 0.8, no flags | action = "proceed", trustLevel = "high" |
| UT-RC-002 | caution — moderate trust | scores.weightedScore = 0.5, no flags | action = "caution", trustLevel = "moderate" |
| UT-RC-003 | verify — low trust, active flags | scores.weightedScore = 0.3, 2 flags | action = "verify", trustLevel = "low" |
| UT-RC-004 | avoid — very low trust, critical flag | overallTrustScore < 0.1, critical flag | action = "avoid", trustLevel = "untrusted" |
| UT-RC-005 | context: before-transaction → stricter | Same scores, context = "before-transaction" | Lower trustLevel threshold |
| UT-RC-006 | context: general-lookup → lenient | Same scores, context = "general-lookup" | Higher tolerance for low scores |
| UT-RC-007 | graph context boosts trusted | graphContext.shortestPath = 1, trustedAttestors.length > 0 | Trust level boosted |
| UT-RC-008 | no scores → unknown | scores = null, didProfile = null | action = "verify", reasoning explains no data |
| UT-RC-009 | reasoning includes flag types | Active flags present | reasoning mentions specific flag types |
| UT-RC-010 | authenticity suspicious → lower trust | authenticity.predominantAssessment = "suspicious" | Trust level reduced |
| UT-RC-011 | domain-specific score used when available | domain = "food", domainScore exists | Domain-specific score used over general score |
| UT-RC-012 | graph timeout handled gracefully | graphContext.mutualConnections = null | Recommendation proceeds without graph signal |

---

## §2 — Ingester Components (`src/ingester/`)

### §2.1 Record Validator (`record-validator.test.ts`)

Traces to: Architecture §"Record Validator"

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-RV-001 | valid attestation record | All required fields, valid sentiment enum | success = true, data populated |
| UT-RV-002 | missing required field (subject) | Attestation without subject | success = false, errors point to "subject" |
| UT-RV-003 | missing required field (createdAt) | Attestation without createdAt | success = false |
| UT-RV-004 | invalid sentiment enum | sentiment = "excellent" (not in enum) | success = false, errors mention enum values |
| UT-RV-005 | text exceeds max length | text = 3000 chars (max 2000) | success = false |
| UT-RV-006 | tags exceeds max count | 15 tags (max 10) | success = false |
| UT-RV-007 | tag exceeds max length | One tag = 60 chars (max 50) | success = false |
| UT-RV-008 | dimensions exceeds max count | 15 dimension ratings (max 10) | success = false |
| UT-RV-009 | evidence exceeds max count | 15 evidence items (max 10) | success = false |
| UT-RV-010 | valid vouch record | All required fields | success = true |
| UT-RV-011 | invalid vouch confidence | confidence = "extremely-high" | success = false |
| UT-RV-012 | valid reaction record | Valid targetUri and reaction enum value | success = true |
| UT-RV-013 | invalid reaction enum | reaction = "love" (not in enum) | success = false |
| UT-RV-014 | valid report record | Valid targetUri, reportType, optional text | success = true |
| UT-RV-015 | invalid report type enum | reportType = "illegal" (not in enum) | success = false |
| UT-RV-016 | report text exceeds max | text = 1500 chars (max 1000) | success = false |
| UT-RV-017 | report evidence max count | 6 evidence items (max 5) | success = false |
| UT-RV-018 | unknown collection → error | collection = "com.dina.trust.unknown" | success = false, error says "Unknown collection" |
| UT-RV-019 | valid attestation with optional fields | All optional fields populated (dimensions, evidence, mentions, cosignature, etc.) | success = true, all fields parsed |
| UT-RV-020 | subject ref — all type variants | type = "did", "content", "product", "dataset", "organization", "claim" | All pass validation |
| UT-RV-021 | subject ref — invalid type | type = "place" (not in enum) | success = false |
| UT-RV-022 | subject name max length | name = 250 chars (max 200) | success = false |
| UT-RV-023 | dimension rating — valid enum values | "exceeded", "met", "below", "failed" | All pass |
| UT-RV-024 | dimension rating — invalid value | value = "good" | success = false |
| UT-RV-025 | evidence item — valid structure | type + optional uri/hash/description | success = true |
| UT-RV-026 | evidence description max length | description = 400 chars (max 300) | success = false |
| UT-RV-027 | mention — valid structure | did (required) + optional role | success = true |
| UT-RV-028 | mentions exceeds max count | 15 mentions (max 10) | success = false |
| UT-RV-029 | relatedAttestations max count | 6 related attestations (max 5) | success = false |
| UT-RV-030 | cosignature — valid structure | did + sig + sigCreatedAt all present | success = true |
| UT-RV-031 | cosignature — missing sig field | Cosignature without sig | success = false |
| UT-RV-032 | confidence enum — all valid values | "certain", "high", "moderate", "speculative" | All pass |
| UT-RV-033 | confidence — invalid value | confidence = "low" | success = false |
| UT-RV-034 | all 19 collection types — valid minimal records | Minimal valid record for each of the 19 collections | All return success = true |
| UT-RV-035 | extra fields ignored (passthrough) | Record with extra fields not in schema | success = true (zod strips extras by default) |
| UT-RV-036 | relatedRecords max on report | 11 relatedRecords (max 10) | success = false |

### §2.2 Rate Limiter (`rate-limiter.test.ts`)

Traces to: Architecture §"Ingester-Side Rate Limiter", Fix 11

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-RL-001 | first record not rate limited | New DID, first call | isRateLimited returns false |
| UT-RL-002 | 50th record not rate limited | DID with 49 prior records | isRateLimited returns false |
| UT-RL-003 | **Fix 11: 51st record rate limited** | DID at count 50 | isRateLimited returns true |
| UT-RL-004 | **Fix 11: quarantine flag set on first limit** | DID just exceeding 50/hr | quarantine flag set to true |
| UT-RL-005 | subsequent records still rate limited | DID already quarantined, count at 55 | isRateLimited returns true |
| UT-RL-006 | different DIDs independent | DID-A at 50, DID-B at 0 | DID-A limited, DID-B not limited |
| UT-RL-007 | getQuarantinedDids returns flagged DIDs | 3 DIDs quarantined, 10 normal | Returns exactly the 3 quarantined DIDs |
| UT-RL-008 | LRU eviction under max capacity | MAX_TRACKED_DIDS entries, add one more | Oldest DID evicted, new DID tracked |
| UT-RL-009 | sliding window — TTL expiry resets count | Simulate 1-hour TTL expiry | DID's count resets, no longer rate limited |
| UT-RL-010 | counter increments on every call | Call isRateLimited 5 times for same DID | Count = 5 (side effect) |

### §2.3 Bounded Queue (`bounded-queue.test.ts`)

Traces to: Architecture §"Bounded Ingestion Queue", Fix 5, Fix 7

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-BQ-001 | push triggers processing | Push 1 event to empty queue | processFn called with event |
| UT-BQ-002 | concurrent workers capped at MAX_CONCURRENCY | Push 30 events, MAX_CONCURRENCY = 5 | At most 5 active workers at any time |
| UT-BQ-003 | **Fix 5: backpressure — ws.pause() at MAX_QUEUE_SIZE** | Push 1001 events (MAX = 1000) | ws.pause() called |
| UT-BQ-004 | **Fix 5: hysteresis — ws.resume() at 50%** | Queue drains from 1000 to 499 | ws.resume() called |
| UT-BQ-005 | no oscillation — resume only once below 50% | Queue fluctuates near threshold | pause/resume called at most once each |
| UT-BQ-006 | **Fix 7: getSafeCursor — no in-flight** | All events completed, highestSeen = 5000 | getSafeCursor returns 5000 |
| UT-BQ-007 | **Fix 7: getSafeCursor — with in-flight** | In-flight timestamps: [1000, 2000, 3000] | getSafeCursor returns 999 (min - 1) |
| UT-BQ-008 | **Fix 7: low watermark prevents data loss** | Event 1000 slow, event 2000 fast, event 2000 completes first | getSafeCursor still includes 1000 |
| UT-BQ-009 | error in processFn doesn't crash queue | processFn throws for one event | Other events continue processing, error logged |
| UT-BQ-010 | depth/active/inFlight accessors | Various queue states | Correct counts returned |
| UT-BQ-011 | pump resumes after worker completes | MAX_CONCURRENCY workers busy, one completes | Next queued event immediately dequeued |
| UT-BQ-012 | metrics emitted correctly | Push events, process events | gauge/incr called with correct metric names |
| UT-BQ-013 | **HIGH-04: failed item timestamp pinned in getSafeCursor** | Item fails processing | Its timestamp stays in failedTimestamps, getSafeCursor includes it |
| UT-BQ-014 | **MEDIUM-06: getSafeCursor scans all queued items** | Items queued in non-sequential order | getSafeCursor finds minimum across all queued items (not just head) |

### §2.4 Handler Router (`handlers/index.test.ts`)

Traces to: Architecture §"Handler Pattern"

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-HR-001 | routeHandler — attestation | collection = "com.dina.trust.attestation" | Returns attestationHandler |
| UT-HR-002 | routeHandler — vouch | collection = "com.dina.trust.vouch" | Returns vouchHandler |
| UT-HR-003 | routeHandler — all 19 collections registered | Iterate TRUST_COLLECTIONS | All return non-null handler |
| UT-HR-004 | routeHandler — unknown collection | collection = "com.dina.trust.foo" | Returns null |
| UT-HR-005 | routeHandler — non-dina collection | collection = "app.bsky.feed.post" | Returns null |
| UT-HR-006 | handler interface — handleCreate exists | Each handler in registry | Has handleCreate method |
| UT-HR-007 | handler interface — handleDelete exists | Each handler in registry | Has handleDelete method |

### §2.5 Deletion Handler — Logic Only (`deletion-handler.test.ts`)

Traces to: Architecture §"Deletion Handler", Fix 13

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-DH-001 | getSourceTable — attestation → attestations table | "com.dina.trust.attestation" | Returns attestations Drizzle table |
| UT-DH-002 | getSourceTable — vouch → vouches table | "com.dina.trust.vouch" | Returns vouches Drizzle table |
| UT-DH-003 | **Fix 13: all 17 record types mapped** | Iterate all entries in COLLECTION_TABLE_MAP | All 17 collections map to correct tables |
| UT-DH-004 | getSourceTable — unknown collection → undefined | "com.dina.trust.unknown" | Returns undefined |
| UT-DH-005 | getSourceTable — media (no dedicated table) | "com.dina.trust.media" — if inline | Returns expected table or undefined |
| UT-DH-006 | COLLECTION_TABLE_MAP completeness | Compare keys to TRUST_COLLECTIONS | All non-inline collections have entries |

### §2.6 Trust Edge Sync — Weight Heuristics (`trust-edge-sync.test.ts`)

Traces to: Architecture §"Trust Edge Sync"

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-TE-001 | vouch high confidence → weight 1.0 | confidence = "high" | weight = 1.0 |
| UT-TE-002 | vouch moderate → weight 0.6 | confidence = "moderate" | weight = 0.6 |
| UT-TE-003 | vouch low → weight 0.3 | confidence = "low" | weight = 0.3 |
| UT-TE-004 | endorsement worked-together → weight 0.8 | endorsementType = "worked-together" | weight = 0.8 |
| UT-TE-005 | endorsement observed-output → weight 0.4 | endorsementType = "observed-output" | weight = 0.4 |
| UT-TE-006 | delegation → weight 0.9 | Delegation record | weight = 0.9 |
| UT-TE-007 | cosigned attestation → weight 0.7 | Attestation with coSignature | weight = 0.7 |
| UT-TE-008 | positive attestation DID subject → weight 0.3 | DID-type subject, positive sentiment | weight = 0.3 |
| UT-TE-009 | **HIGH-07: negative attestation DID subject → no trust edge** | DID-type subject, negative sentiment | No trust edge created (HIGH-07: only positive creates edges) |
| UT-TE-010 | non-DID subject attestation → no trust edge | Product-type subject, positive sentiment | No trust edge created (only DID subjects) |

---

## §3 — Shared Utilities (`src/shared/`)

### §3.1 AT URI Parser (`shared/atproto/uri.test.ts`)

Traces to: Architecture §"Directory Structure — shared/atproto/uri.ts"

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-URI-001 | parse valid AT URI | "at://did:plc:abc/com.dina.trust.attestation/tid123" | did = "did:plc:abc", collection = "com.dina.trust.attestation", rkey = "tid123" |
| UT-URI-002 | parse AT URI — did:web | "at://did:web:example.com/collection/rkey" | Parsed correctly |
| UT-URI-003 | construct AT URI | did + collection + rkey | Produces correct AT URI string |
| UT-URI-004 | invalid URI — missing protocol | "did:plc:abc/collection/rkey" | Throws or returns error |
| UT-URI-005 | invalid URI — missing collection | "at://did:plc:abc" | Throws or returns error |
| UT-URI-006 | invalid URI — empty string | "" | Throws or returns error |
| UT-URI-007 | round-trip: parse → construct → parse | Valid URI | Identical output |
| UT-URI-008 | special characters in rkey | rkey with dashes and underscores | Parsed correctly |

### §3.2 Deterministic ID Generation (`shared/utils/deterministic-id.test.ts`)

Traces to: Architecture §"3-Tier Subject Identity", Fix 10

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-DI-001 | **Fix 10: Tier 1 — DID produces global ID** | ref = { type: "did", did: "did:plc:abc" } | id = sha256("did:did:plc:abc"), isAuthorScoped = false |
| UT-DI-002 | **Fix 10: Tier 1 — same DID, different authors → same ID** | Same DID ref, two different authorDids | Identical IDs |
| UT-DI-003 | **Fix 10: Tier 1 — URI produces global ID** | ref = { type: "content", uri: "https://example.com" } | id deterministic from URI, isAuthorScoped = false |
| UT-DI-004 | **Fix 10: Tier 1 — same URI, different authors → same ID** | Same URI ref, two different authorDids | Identical IDs |
| UT-DI-005 | **Fix 10: Tier 1 — identifier produces global ID** | ref = { type: "product", identifier: "asin:B01234" } | id deterministic, isAuthorScoped = false |
| UT-DI-006 | **Fix 10: Tier 1 — priority: DID > URI > identifier** | ref with did AND uri AND identifier | ID derived from DID (highest priority) |
| UT-DI-007 | **Fix 10: Tier 1 — priority: URI > identifier** | ref with uri AND identifier (no DID) | ID derived from URI |
| UT-DI-008 | **Fix 10: Tier 2 — name-only → author-scoped** | ref = { type: "business", name: "Darshini Tiffin Center" } | isAuthorScoped = true |
| UT-DI-009 | **Fix 10: Tier 2 — same name, different authors → different IDs** | Same name ref, author-A vs author-B | Different IDs (author isolation) |
| UT-DI-010 | **Fix 10: Tier 2 — same name, same author → same ID** | Same name ref, same authorDid | Identical IDs (deterministic) |
| UT-DI-011 | case normalization | "Darshini Tiffin" vs "darshini tiffin" | Same ID (toLowerCase applied) |
| UT-DI-012 | whitespace normalization | "  Darshini Tiffin  " vs "Darshini Tiffin" | Same ID (trim applied) |
| UT-DI-013 | ID format — prefix | Any input | ID starts with "sub_" |
| UT-DI-014 | ID format — length | Any input | ID = "sub_" + 32-char hex = 36 chars |
| UT-DI-015 | name fallback order | ref with no name, no URI, has DID | name = DID value |
| UT-DI-016 | name fallback — "Unknown Subject" | ref with no name, no URI, no DID | name = "Unknown Subject" |
| UT-DI-017 | different subject types → different IDs (Tier 2) | Same name, type "business" vs "organization" | Different IDs |

### §3.3 Retry Utility (`shared/utils/retry.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-RT-001 | succeeds on first try → no retry | Function succeeds immediately | Called once, returns result |
| UT-RT-002 | fails once then succeeds → one retry | First call throws, second succeeds | Called twice, returns second result |
| UT-RT-003 | exhausts all retries → throws | All attempts fail | Throws final error after max retries |
| UT-RT-004 | exponential backoff timing | 3 retries | Delays increase exponentially (1s, 2s, 4s) |
| UT-RT-005 | max delay cap | 10 retries | Delay never exceeds MAX_DELAY |

### §3.4 Batch Insert Helper (`shared/utils/batch.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-BA-001 | single batch — within limit | 50 items, batch size 100 | One batch call with all 50 items |
| UT-BA-002 | multiple batches | 250 items, batch size 100 | 3 batch calls (100, 100, 50) |
| UT-BA-003 | empty input | 0 items | Zero batch calls, no errors |
| UT-BA-004 | exact batch boundary | 200 items, batch size 100 | Exactly 2 batch calls (100, 100) |

### §3.5 Error Types (`shared/errors/`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-ER-001 | AppError — message and code | new AppError("msg", 500) | message = "msg", statusCode = 500 |
| UT-ER-002 | ValidationError extends AppError | new ValidationError(zodErrors) | statusCode = 400, errors attached |
| UT-ER-003 | NotFoundError extends AppError | new NotFoundError("Subject") | statusCode = 404, message includes "Subject" |
| UT-ER-004 | error serialization | JSON.stringify(error) | Includes message, code, errors array |

---

## §4 — Configuration (`src/config/`)

### §4.1 Environment Validation (`config/env.test.ts`)

Traces to: Architecture §"Environment & Configuration"

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-ENV-001 | valid environment — all required | DATABASE_URL set | Parses successfully |
| UT-ENV-002 | missing DATABASE_URL → throws | DATABASE_URL unset | Throws ZodError |
| UT-ENV-003 | invalid DATABASE_URL — not URL | DATABASE_URL = "not-a-url" | Throws ZodError |
| UT-ENV-004 | defaults applied — JETSTREAM_URL | JETSTREAM_URL unset | env.JETSTREAM_URL = "ws://jetstream:6008" |
| UT-ENV-005 | defaults applied — DATABASE_POOL_MAX | DATABASE_POOL_MAX unset | env.DATABASE_POOL_MAX = 20 |
| UT-ENV-006 | defaults applied — PORT | PORT unset | env.PORT = 3000 |
| UT-ENV-007 | defaults applied — LOG_LEVEL | LOG_LEVEL unset | env.LOG_LEVEL = "info" |
| UT-ENV-008 | invalid LOG_LEVEL enum | LOG_LEVEL = "verbose" | Throws ZodError |
| UT-ENV-009 | numeric coercion — DATABASE_POOL_MAX | DATABASE_POOL_MAX = "30" (string) | env.DATABASE_POOL_MAX = 30 (number) |
| UT-ENV-010 | numeric coercion — PORT | PORT = "8080" (string) | env.PORT = 8080 (number) |
| UT-ENV-011 | defaults applied — DATABASE_POOL_MIN | DATABASE_POOL_MIN unset | env.DATABASE_POOL_MIN = 2 |
| UT-ENV-012 | defaults applied — RATE_LIMIT_RPM | RATE_LIMIT_RPM unset | env.RATE_LIMIT_RPM = 60 |
| UT-ENV-013 | defaults applied — NEXT_PUBLIC_BASE_URL | NEXT_PUBLIC_BASE_URL unset | env.NEXT_PUBLIC_BASE_URL = "http://localhost:3000" |
| UT-ENV-014 | **MEDIUM-11: NODE_ENV defaults to development** | NODE_ENV unset | env.NODE_ENV = "development" |
| UT-ENV-015 | **MEDIUM-11: production mode accepts stricter config** | NODE_ENV = "production", DATABASE_URL + JETSTREAM_URL provided | Parses successfully in production mode |

### §4.2 Constants (`config/constants.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-CON-001 | scoring weights sum to 1.0 | SENTIMENT_WEIGHT + VOUCH_WEIGHT + REVIEWER_WEIGHT + NETWORK_WEIGHT | Equals 1.0 |
| UT-CON-002 | multipliers > 1.0 | EVIDENCE_MULTIPLIER, VERIFIED_MULTIPLIER, BILATERAL_MULTIPLIER | All > 1.0 (they boost, not reduce) |
| UT-CON-003 | page sizes within bounds | DEFAULT_PAGE_SIZE ≤ MAX_PAGE_SIZE | True |
| UT-CON-004 | tombstone threshold positive | COORDINATION_TOMBSTONE_THRESHOLD > 0 | True |
| UT-CON-005 | halflife positive | SENTIMENT_HALFLIFE_DAYS > 0 | True |

### §4.3 Lexicons (`config/lexicons.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-LEX-001 | TRUST_COLLECTIONS has 19 entries | Array length check | length = 19 |
| UT-LEX-002 | all entries prefixed with "com.dina.trust." | Iterate and check prefix | All match |
| UT-LEX-003 | no duplicate entries | Set comparison | Set size = array length |
| UT-LEX-004 | expected collections present | Check for attestation, vouch, endorsement, flag, reply, reaction, etc. | All 19 present |
| UT-LEX-005 | type safety — TrustCollection type | TypeScript compile-time check | Type derived from const array |

---

## §5 — API Cache (`src/api/middleware/`)

### §5.1 SWR Cache (`swr-cache.test.ts`)

Traces to: Architecture §"API Cache", Fix 6, Fix 8

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-SWR-001 | **Fix 6: fresh hit — serve from cache** | Key in cache, not expired | Returns cached data, fetchData NOT called |
| UT-SWR-002 | **Fix 6: total miss — fetch and cache** | Key not in cache | fetchData called, result cached |
| UT-SWR-003 | **Fix 6: stale hit — serve stale, refresh in background** | Key in cache, expired | Immediately returns stale data, background refresh triggered |
| UT-SWR-004 | **Fix 6: promise coalescing — concurrent requests** | 10 concurrent withSWR calls for same key | fetchData called exactly ONCE |
| UT-SWR-005 | promise coalescing — different keys independent | Concurrent calls for key-A and key-B | fetchData called once per key |
| UT-SWR-006 | background refresh failure → stale data preserved | Stale entry, background fetch throws | Stale data still served on next request |
| UT-SWR-007 | total miss failure → error propagated | No cached data, fetchData throws | Error thrown to caller |
| UT-SWR-008 | **Fix 8: O(1) LRU eviction** | Fill cache to MAX_CACHE_SIZE + 1 | Oldest entry evicted, newest retained |
| UT-SWR-009 | cache key generation — resolveKey | Different params → different keys | Each combination produces unique key |
| UT-SWR-010 | cache key — optional params omitted | requesterDid undefined | Key includes empty string for missing params |
| UT-SWR-011 | CACHE_TTLS correctness | RESOLVE = 5s, GET_PROFILE = 10s, SEARCH = 3s | Constants have correct values |
| UT-SWR-012 | TTL boundary — entry at exact expiry time | now = expiresAt exactly | Treated as stale (not fresh) |
| UT-SWR-013 | in-flight map cleaned up on success | Successful fetch | key removed from inFlight map |
| UT-SWR-014 | in-flight map cleaned up on error | Failed fetch | key removed from inFlight map |

---

## §6 — Jetstream Consumer — Event Processing Logic (`src/ingester/`)

### §6.1 JetstreamConsumer — processEvent routing (`jetstream-consumer.test.ts`)

Traces to: Architecture §"Consumer Implementation"

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-JC-001 | kind = "commit", operation = "create" → handleCreateOrUpdate | Valid create event | handleCreateOrUpdate called |
| UT-JC-002 | **HIGH-02/03: update → pure upsert (no delete)** | Valid update event | handleCreateOrUpdate called (create only — no delete) |
| UT-JC-003 | kind = "commit", operation = "delete" → handleDelete | Valid delete event | handleDelete called |
| UT-JC-004 | kind = "identity" → handleIdentityEvent | Identity event | handleIdentityEvent called |
| UT-JC-005 | kind = "account" → handleAccountEvent | Account event | handleAccountEvent called |
| UT-JC-006 | non-trust collection → skipped | collection = "app.bsky.feed.post" | No handler called |
| UT-JC-007 | **Fix 11: rate-limited DID → event dropped** | DID exceeding 50/hr | No handler called, metrics incremented |
| UT-JC-008 | **HIGH-06: rate limiting applies to all operations** | Rate-limited DID, operation = "delete" | Delete also blocked (HIGH-06: rate limiting before operation branch) |
| UT-JC-009 | validation failure → event skipped | Invalid record structure | Handler not called, metrics incremented |
| UT-JC-010 | unknown handler → event skipped | Valid record, unknown collection | No error thrown, logged as warning |
| UT-JC-011 | **HIGH-02/03: update = pure upsert (no delete)** | operation = "update" | Only handler.handleCreate called (no handleDelete — upsert handles it) |
| UT-JC-012 | cursor save interval — every 100 events | Process 100 events | saveCursor called once |
| UT-JC-013 | cursor save interval — 99 events → no save | Process 99 events | saveCursor not called |
| UT-JC-014 | **Fix 7: cursor value = queue.getSafeCursor** | Events being processed | Saved cursor = low watermark from queue |
| UT-JC-015 | highestSeenTimeUs tracks maximum | Events with time_us: [100, 500, 300] | highestSeenTimeUs = 500 |
| UT-JC-016 | reconnect backoff — exponential delay | Multiple disconnections | Delays: 1s, 2s, 4s, 8s, ... up to 60s max |
| UT-JC-017 | reconnect resets on successful connection | Reconnect then successful open | reconnectAttempts reset to 0 |
| UT-JC-018 | graceful shutdown — saves final cursor | SIGTERM received | saveCursor called with low watermark |
| UT-JC-019 | graceful shutdown — closes WebSocket | SIGTERM received | ws.close() called |
| UT-JC-020 | account takendown event → logged | account.status = "takendown" | Logger called with status info |
| UT-JC-021 | **JSON parse error → logged, not crashed** | WebSocket message = invalid JSON ("not json") | logger.error called with parse error, metrics.incr('ingester.errors.parse'), no crash |
| UT-JC-022 | account deleted event → logged | account.status = "deleted" | Logger called with status info |
| UT-JC-023 | account suspended event → logged | account.status = "suspended" | Logger called with status info |
| UT-JC-024 | **HIGH-05: queue push failure logged with metric** | Queue full, push returns false | Warning logged, metric incremented |
| UT-JC-025 | **HIGH-06: rate limiting blocks updates too** | Rate-limited DID, operation = "update" | Update blocked (rate limiting before operation branch) |

---

## §7 — Scorer Jobs — Scheduling Logic (`src/scorer/`)

### §7.1 Scheduler (`scheduler.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-SCH-001 | all 9 jobs registered | startScheduler called | 9 cron.schedule calls made |
| UT-SCH-002 | refresh-profiles runs every 5 min | Job schedule | schedule = "*/5 * * * *" |
| UT-SCH-003 | refresh-subject-scores runs every 5 min | Job schedule | schedule = "*/5 * * * *" |
| UT-SCH-004 | detect-coordination runs every 30 min | Job schedule | schedule = "*/30 * * * *" |
| UT-SCH-005 | detect-sybil runs every 6 hours | Job schedule | schedule = "0 */6 * * *" |
| UT-SCH-006 | decay-scores runs daily at 3 AM | Job schedule | schedule = "0 3 * * *" |
| UT-SCH-007 | cleanup-expired runs daily at 4 AM | Job schedule | schedule = "0 4 * * *" |
| UT-SCH-008 | refresh-reviewer-stats runs every 15 min | Job schedule | schedule = "*/15 * * * *" |
| UT-SCH-009 | refresh-domain-scores runs every hour | Job schedule | schedule = "0 * * * *" |
| UT-SCH-010 | process-tombstones runs every 10 min | Job schedule | schedule = "*/10 * * * *" |
| UT-SCH-011 | job error → caught and logged | Handler throws error | Error logged, no process crash |
| UT-SCH-012 | job duration tracked | Handler takes 500ms | Histogram metric recorded with duration |
| UT-SCH-013 | job error metric incremented | Handler throws | scorer.job.errors counter incremented |

### §7.2 Decay Scores Logic (`decay-scores.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-DS-001 | recent attestation — no decay | attestation from 1 day ago | Weight unchanged |
| UT-DS-002 | old attestation — decayed | Attestation from 365 days ago | Weight significantly reduced |
| UT-DS-003 | halflife calculation | At exactly SENTIMENT_HALFLIFE_DAYS | Weight = ~50% of original |
| UT-DS-004 | very old attestation — near zero | Attestation from 1000 days ago | Weight near zero but not exactly zero |

---

## §8 — XRPC Parameter Validation (`src/app/xrpc/`)

### §8.1 Resolve Params (`resolve-params.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-RP-001 | valid params — subject only | subject = '{"type":"did","did":"did:plc:abc"}' | Parses successfully |
| UT-RP-002 | valid params — all fields | subject + requesterDid + domain + context | Parses successfully |
| UT-RP-003 | missing subject → error | No subject param | Zod error |
| UT-RP-004 | invalid context enum | context = "shopping" | Zod error |
| UT-RP-005 | all context values valid | "before-transaction", "before-interaction", "content-verification", "product-evaluation", "general-lookup" | All parse |

### §8.2 Search Params (`search-params.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| UT-SP-001 | valid params — q only | q = "darshini" | Parses successfully |
| UT-SP-002 | valid params — all filters | q + category + domain + sentiment + tags + authorDid + since + until | Parses successfully |
| UT-SP-003 | limit bounds — too high | limit = 200 (max 100) | Zod error |
| UT-SP-004 | limit bounds — too low | limit = 0 (min 1) | Zod error |
| UT-SP-005 | limit default | limit unset | Default = 25 |
| UT-SP-006 | sort default | sort unset | Default = "relevant" |
| UT-SP-007 | invalid sort enum | sort = "popularity" | Zod error |
| UT-SP-008 | invalid sentiment enum | sentiment = "very-positive" | Zod error |
| UT-SP-009 | invalid subjectType enum | subjectType = "place" | Zod error |
| UT-SP-010 | tags — comma-separated parsing | tags = "food,quality,service" | Parses to array of 3 |
| UT-SP-011 | **MEDIUM-03: minConfidence filter accepted** | minConfidence = "high" | Parses successfully |

---

## Summary

| Section | Subsection | Test Count |
|---------|-----------|------------|
| §1 Scorer Algorithms | §1.1 Trust Score | 39 |
| §1 Scorer Algorithms | §1.2 Reviewer Quality | 10 |
| §1 Scorer Algorithms | §1.3 Sentiment Aggregation | 10 |
| §1 Scorer Algorithms | §1.4 Anomaly Detection | 6 |
| §1 Scorer Algorithms | §1.5 Recommendation | 12 |
| §2 Ingester Components | §2.1 Record Validator | 36 |
| §2 Ingester Components | §2.2 Rate Limiter | 10 |
| §2 Ingester Components | §2.3 Bounded Queue | 14 |
| §2 Ingester Components | §2.4 Handler Router | 7 |
| §2 Ingester Components | §2.5 Deletion Handler | 6 |
| §2 Ingester Components | §2.6 Trust Edge Sync | 10 |
| §3 Shared Utilities | §3.1 AT URI Parser | 8 |
| §3 Shared Utilities | §3.2 Deterministic ID | 17 |
| §3 Shared Utilities | §3.3 Retry Utility | 5 |
| §3 Shared Utilities | §3.4 Batch Insert | 4 |
| §3 Shared Utilities | §3.5 Error Types | 4 |
| §4 Configuration | §4.1 Environment | 15 |
| §4 Configuration | §4.2 Constants | 5 |
| §4 Configuration | §4.3 Lexicons | 5 |
| §5 API Cache | §5.1 SWR Cache | 14 |
| §6 Jetstream Consumer | §6.1 Event Processing | 25 |
| §7 Scorer Jobs | §7.1 Scheduler | 13 |
| §7 Scorer Jobs | §7.2 Decay Scores | 4 |
| §8 XRPC Params | §8.1 Resolve Params | 5 |
| §8 XRPC Params | §8.2 Search Params | 11 |
| **TOTAL** | | **295** |

---

## Fix Traceability Matrix

| Fix | Description | Unit Tests |
|-----|-------------|------------|
| Fix 1 | Idempotent upserts (crash-replay) | UT-JC-011 (update = upsert), integration coverage |
| Fix 2 | Atomic subject resolution | UT-DI-001 through UT-DI-017 (deterministic IDs) |
| Fix 3 | Super-node fan-out caps | Integration tests (needs DB) |
| Fix 4 | Transaction-scoped timeouts | Integration tests (needs DB) |
| Fix 5 | WebSocket backpressure | UT-BQ-003, UT-BQ-004, UT-BQ-005, UT-JC-024 |
| Fix 6 | SWR cache + promise coalescing | UT-SWR-001 through UT-SWR-014 |
| Fix 7 | Low watermark cursor | UT-BQ-006, UT-BQ-007, UT-BQ-008, UT-JC-014 |
| Fix 8 | O(1) LRU cache | UT-SWR-008 |
| Fix 9 | Incremental dirty-flag scoring | Integration tests (needs DB) |
| Fix 10 | 3-tier subject identity | UT-DI-001 through UT-DI-017 |
| Fix 11 | Ingester-side rate limiting | UT-RL-001 through UT-RL-010, UT-JC-007, UT-JC-008, UT-JC-025 |
| Fix 12 | Zero-trust + vouch-gating + damping | UT-TS-020, UT-TS-021, UT-TS-028 through UT-TS-031 |
| Fix 13 | Parameterized deletion handler | UT-DH-001 through UT-DH-006 |

---

## AppView Issue Traceability Matrix

| Issue | Description | Unit Tests |
|-------|-------------|------------|
| HIGH-01 | Graph API contract mismatch | Integration tests (IT-GR-*) |
| HIGH-02 | Non-transactional update (delete+create) | UT-JC-002, UT-JC-011 (updated: pure upsert) |
| HIGH-03 | False tombstones from update pattern | UT-JC-002, UT-JC-011 (updated: pure upsert) |
| HIGH-04 | Failed events advance cursor | UT-BQ-013 (failed timestamp pinned) |
| HIGH-05 | Queue drop detection missing | UT-JC-024 (push failure logged) |
| HIGH-06 | Rate limiting bypass for deletes | UT-JC-008, UT-JC-025 (updated: all ops rate-limited) |
| HIGH-07 | Negative sentiment creates trust edges | UT-TE-009 (updated: positive-only guard) |
| HIGH-08 | search_vector missing | Integration tests (IT-DCK-008) |
| HIGH-09 | Web server entrypoint missing | Integration tests (IT-WEB-001–005) |
| HIGH-10 | isVerified always false | Integration tests (IT-SC-044) |
| HIGH-11 | No migration service in Docker | Integration tests (IT-DCK-007) |
| MEDIUM-01 | Subject length unbounded | Integration tests (IT-API-043) |
| MEDIUM-02 | createdAt not validated as datetime | Covered by UT-RV-003 (validation tests) |
| MEDIUM-03 | subjectType/minConfidence filters missing | UT-SP-011 (minConfidence accepted) |
| MEDIUM-04 | Composite cursor pagination | Integration tests (IT-API-045, IT-API-046) |
| MEDIUM-05 | Inactive flags returned | Integration tests (IT-API-044) |
| MEDIUM-06 | getSafeCursor only checks head | UT-BQ-014 (scans all queued items) |
| MEDIUM-07 | Sybil detection uses broken DID check | Integration tests (IT-SC-043) |
| MEDIUM-08 | Tombstone count increment not idempotent | Integration tests (IT-SC-042) |
| MEDIUM-09 | Metrics are no-ops | Covered by existing UT-BQ-012, UT-SCH-012 |
| MEDIUM-10 | Rate limiter in-memory limitation | Documentation only (no test needed) |
| MEDIUM-11 | Production env validation | UT-ENV-014, UT-ENV-015 |
| MEDIUM-12 | Trust policy conflict target | Integration tests (IT-HND-009, IT-HND-010) |
