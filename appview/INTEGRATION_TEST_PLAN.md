# Dina AppView — Integration Test Plan

> **Scope:** Tests requiring real PostgreSQL (via testcontainers), actual Drizzle ORM queries,
> and multi-component interactions. These tests verify that the components work correctly
> together and that all 13 production hardening fixes function end-to-end.
>
> **Infrastructure:** Each test file gets a fresh Postgres instance via `testcontainers`.
> Database migrations run before each suite. Teardown drops the database after each suite.
>
> **Traceability IDs:** Each test has a unique ID in the format `IT-{section}-{number}`.
> IDs map to architecture sections and production hardening fixes (Fix 1–13).
>
> **Framework:** Vitest + testcontainers (Postgres 17) + Drizzle ORM

---

## §1 — Ingester Handlers: Create + Delete (`tests/integration/ingester/`)

### §1.1 Attestation Handler (`attestation-handler.test.ts`)

Traces to: Architecture §"Attestation Handler", Fix 1 (idempotency), Fix 2 (atomic subject), Fix 9 (dirty flags), Fix 10 (3-tier identity)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-ATT-001 | create attestation — basic insert | Minimal valid attestation | Row in attestations table with all fields |
| IT-ATT-002 | create attestation — all optional fields | Attestation with dimensions, evidence, mentions, tags, cosignature, bilateral, related | All JSONB fields populated correctly |
| IT-ATT-003 | subject resolved via Tier 1 (DID) | subject.did = "did:plc:abc" | subjects row with globally deterministic ID, authorScopedDid = null |
| IT-ATT-004 | subject resolved via Tier 1 (URI) | subject.uri = "https://example.com" | subjects row with global ID |
| IT-ATT-005 | subject resolved via Tier 1 (identifier) | subject.identifier = "google-maps:ChIJ_abc" | subjects row with global ID |
| IT-ATT-006 | **Fix 10: subject resolved via Tier 2 (name-only)** | subject = { type: "business", name: "Test Place" }, no DID/URI/identifier | subjects row with authorScopedDid = author DID |
| IT-ATT-007 | **Fix 10: same name, different authors → different subjects** | Two attestations: same name, different authorDids | Two distinct subject rows |
| IT-ATT-008 | **Fix 10: same name, same author → same subject** | Two attestations: same name, same authorDid | One subject row (upserted) |
| IT-ATT-009 | **Fix 10: same DID, different authors → same subject (Tier 1)** | Two attestations: same subject DID, different authorDids | One subject row |
| IT-ATT-010 | mention edges created | Attestation with 3 mentions | 3 rows in mention_edges table |
| IT-ATT-011 | mention edges idempotent on replay | Same attestation ingested twice | Still exactly 3 mention_edge rows (onConflictDoNothing) |
| IT-ATT-012 | **Fix 9: dirty flags set — subject** | New attestation | subject_scores row with needs_recalc = true |
| IT-ATT-013 | **Fix 9: dirty flags set — author profile** | New attestation | did_profiles row for authorDid with needs_recalc = true |
| IT-ATT-014 | **Fix 9: dirty flags set — mentioned DIDs** | Attestation with mentions | did_profiles rows for each mentioned DID |
| IT-ATT-015 | **Fix 9: dirty flags set — subject DID** | subject.type = "did", subject.did = "did:plc:xyz" | did_profiles row for subject DID |
| IT-ATT-016 | search content populated | Attestation with text, name, tags | searchContent field = concatenation |
| IT-ATT-017 | tsvector index functional | Insert attestation, query with plainto_tsquery | Record found via full-text search |
| IT-ATT-018 | **Fix 1: idempotent upsert — replay same event** | Same attestation URI inserted twice | No error, single row, updated indexedAt |
| IT-ATT-019 | **Fix 1: upsert updates changed fields** | Same URI, different sentiment on second insert | sentiment updated to new value |
| IT-ATT-020 | cosigner DID extracted | Attestation with coSignature | cosignerDid field set, hasCosignature = true |
| IT-ATT-021 | agent-generated flag | isAgentGenerated = true | Column set correctly |
| IT-ATT-022 | tags stored as array | tags = ["food", "quality"] | PostgreSQL text[] array |
| IT-ATT-023 | domain nullable | No domain field | domain = null (not error) |

### §1.2 Vouch Handler (`vouch-handler.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-VCH-001 | create vouch — basic insert | Valid vouch record | Row in vouches table |
| IT-VCH-002 | **Fix 1: idempotent upsert** | Same vouch URI twice | No error, single row |
| IT-VCH-003 | trust edge created | Vouch with confidence = "high" | trust_edges row with weight = 1.0 |
| IT-VCH-004 | trust edge weight varies by confidence | "high" → 1.0, "moderate" → 0.6, "low" → 0.3 | Correct weights |
| IT-VCH-005 | dirty flags set — subject DID | Vouch for did:plc:xyz | did_profiles dirty for subject |
| IT-VCH-006 | dirty flags set — author DID | Vouch by did:plc:author | did_profiles dirty for author |

### §1.3 Endorsement Handler (`endorsement-handler.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-END-001 | create endorsement — basic insert | Valid endorsement | Row in endorsements table |
| IT-END-002 | **Fix 1: idempotent upsert** | Same URI twice | Single row |
| IT-END-003 | trust edge created | Endorsement type = "worked-together" | trust_edges row with weight = 0.8 |
| IT-END-004 | dirty flags set | Endorsement | Both author and subject DIDs marked dirty |

### §1.4 Flag Handler (`flag-handler.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-FLG-001 | create flag — basic insert | Valid flag record | Row in flags table |
| IT-FLG-002 | **Fix 1: idempotent upsert** | Same URI twice | Single row |
| IT-FLG-003 | dirty flags set | Flag against subject | subject_scores and did_profiles marked dirty |

### §1.5 Reply Handler (`reply-handler.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-RPL-001 | create reply — basic insert | Valid reply record | Row in replies table |
| IT-RPL-002 | reply with intent "dispute" | intent = "dispute" | Column set correctly |
| IT-RPL-003 | **Fix 1: idempotent upsert** | Same URI twice | Single row |

### §1.6 Reaction Handler (`reaction-handler.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-RXN-001 | create reaction — basic insert | Valid reaction record | Row in reactions table |
| IT-RXN-002 | **Fix 1: idempotent — onConflictDoNothing** | Same reaction URI twice | Single row, no update (reactions are immutable) |
| IT-RXN-003 | all reaction types | "helpful", "unhelpful", "agree", "disagree", "verified", "can-confirm", "suspicious", "outdated" | All stored correctly |

### §1.7 Report Record Handler (`report-record-handler.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-RPT-001 | create report — basic insert | Valid report record | Row in report_records table |
| IT-RPT-002 | **Fix 1: idempotent upsert** | Same URI twice | Single row |
| IT-RPT-003 | all report types stored | Each of the 13 report types | All stored correctly |

### §1.8 Revocation Handler (`revocation-handler.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-REV-001 | create revocation — marks attestation as revoked | Revocation targeting attestation URI | attestations.isRevoked = true, revokedByUri set |
| IT-REV-002 | **Fix 1: idempotent upsert** | Same revocation URI twice | Single row |
| IT-REV-003 | dirty flags set for revoked attestation's subject | Revocation | Subject and author of original attestation marked dirty |

### §1.9 Delegation Handler (`delegation-handler.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-DLG-001 | create delegation — basic insert | Valid delegation | Row in delegations table |
| IT-DLG-002 | trust edge created | Delegation | trust_edges row with weight = 0.9 |
| IT-DLG-003 | **Fix 1: idempotent upsert** | Same URI twice | Single row |

### §1.10 Remaining Handlers — Minimal Smoke Tests

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-HND-001 | collection handler — create + idempotent | Collection record | Row created, replay safe |
| IT-HND-002 | media handler — create + idempotent | Media record | Row created, replay safe |
| IT-HND-003 | subject handler — create + idempotent | Subject record | Row created, replay safe |
| IT-HND-004 | amendment handler — create + marks original | Amendment targeting attestation | attestations.isAmended = true, latestAmendmentUri set |
| IT-HND-005 | verification handler — create + idempotent | Verification record | Row created, replay safe |
| IT-HND-006 | review-request handler — create + idempotent | ReviewRequest record | Row created, replay safe |
| IT-HND-007 | comparison handler — create + idempotent | Comparison record | Row created, replay safe |
| IT-HND-008 | subject-claim handler — create + idempotent | SubjectClaim record | Row created, replay safe |
| IT-HND-009 | trust-policy handler — create + idempotent | TrustPolicy record | Row created, replay safe |
| IT-HND-010 | notification-prefs handler — create + idempotent | NotificationPrefs record | Row created, replay safe |

---

## §2 — Deletion Handler + Tombstones (`tests/integration/ingester/`)

### §2.1 Deletion — Undisputed Clean Delete (`deletion-handler.test.ts`)

Traces to: Architecture §"Deletion Handler", Fix 13

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-DEL-001 | clean delete — no disputes, no tombstone | Attestation with zero reports, zero dispute replies, zero suspicious reactions | Row deleted from attestations, no tombstone created |
| IT-DEL-002 | clean delete — trust edge removed | Vouch deleted (undisputed) | trust_edges row for that sourceUri removed |
| IT-DEL-003 | clean delete metrics | Clean deletion | ingester.deletion.clean metric incremented |

### §2.2 Deletion — Disputed Delete (Tombstone Created)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-DEL-004 | disputed — has report → tombstone | Attestation with 1 report record | Tombstone created with reportCount = 1 |
| IT-DEL-005 | disputed — has dispute reply → tombstone | Attestation with reply.intent = "dispute" | Tombstone with disputeReplyCount = 1 |
| IT-DEL-006 | disputed — has suspicious reaction → tombstone | Attestation with reaction = "suspicious" | Tombstone with suspiciousReactionCount = 1 |
| IT-DEL-007 | tombstone preserves metadata | Disputed attestation deleted | Tombstone has: authorDid, subjectId, category, sentiment, domain, originalCreatedAt |
| IT-DEL-008 | tombstone — durationDays calculated | Record created 10 days ago, deleted now | durationDays = 10 |
| IT-DEL-009 | tombstone — hadEvidence flag | Original had evidence array | hadEvidence = true |
| IT-DEL-010 | tombstone — hadCosignature flag | Original had coSignature | hadCosignature = true |
| IT-DEL-011 | tombstone — record still deleted | Disputed, tombstone created | Original row removed from attestations |
| IT-DEL-012 | tombstone metrics | Tombstone created | ingester.tombstone.created + ingester.deletion.tombstoned metrics |

### §2.3 Deletion — Multi-Table Correctness (Fix 13)

Traces to: Fix 13 (Parameterized Deletion Handler)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-DEL-013 | **Fix 13: delete vouch → queries vouches table** | Vouch with dispute, then deleted | Tombstone metadata from vouches table (not attestations) |
| IT-DEL-014 | **Fix 13: delete flag → queries flags table** | Flag with report, then deleted | Tombstone metadata from flags table |
| IT-DEL-015 | **Fix 13: delete endorsement → queries endorsements table** | Disputed endorsement deleted | Tombstone from endorsements table |
| IT-DEL-016 | **Fix 13: delete reply → queries replies table** | Reply with dispute, then deleted | Tombstone from replies table |
| IT-DEL-017 | **Fix 13: delete delegation → queries delegations table** | Disputed delegation deleted | Tombstone from delegations, trust edge removed |
| IT-DEL-018 | **Fix 13: delete report → queries report_records table** | Reported report record deleted | Tombstone from report_records table |
| IT-DEL-019 | **Fix 13: each deleted handler type → row actually removed** | Delete one record of each type | Verify row gone from correct table, not from attestations |
| IT-DEL-020 | **Fix 13: wrong table would miss tombstone** | Regression guard: ensure vouch deletion checks vouches table specifically | If we hardcoded attestations, test would fail (tombstone missing) |

---

## §3 — Trust Edge Sync (`tests/integration/ingester/`)

### §3.1 Trust Edge Creation + Removal (`trust-edge-sync.test.ts`)

Traces to: Architecture §"Trust Edge Sync"

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-TE-001 | vouch create → trust edge added | Create vouch record | trust_edges row: fromDid = author, toDid = subject |
| IT-TE-002 | endorsement create → trust edge added | Create endorsement | trust_edges row with correct type and weight |
| IT-TE-003 | delegation create → trust edge added | Create delegation | trust_edges row with edgeType = "delegation" |
| IT-TE-004 | cosigned attestation → trust edge added | Attestation with coSignature | trust_edges with type = "cosign" |
| IT-TE-005 | positive DID attestation → trust edge added | Positive attestation about a DID subject | trust_edges with type = "positive-attestation", weight = 0.3 |
| IT-TE-006 | vouch delete → trust edge removed | Delete vouch | trust_edges row removed |
| IT-TE-007 | endorsement delete → trust edge removed | Delete endorsement | trust_edges row removed |
| IT-TE-008 | delegation delete → trust edge removed | Delete delegation | trust_edges row removed |
| IT-TE-009 | **Fix 1: idempotent edge creation** | Same vouch replayed | trust_edges: still one row (onConflictDoNothing) |
| IT-TE-010 | multiple edge types from same author to same target | Vouch + endorsement + delegation | 3 separate trust_edges rows |
| IT-TE-011 | negative DID attestation → no trust edge | Negative attestation about a DID subject | No trust_edges row created |
| IT-TE-012 | delete record with no trust edge → no-op | Delete a flag (no trust edge source) | No error, trust_edges unaffected |

---

## §4 — Subject Resolution (3-Tier Identity)

### §4.1 Concurrent Subject Creation (Fix 2 + Fix 10) (`concurrent-subjects.test.ts`)

Traces to: Architecture §"3-Tier Subject Identity", Fix 2, Fix 10

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-SUB-001 | **Fix 2: 50 concurrent creates → exactly 1 subject** | 50 parallel resolveOrCreateSubject with same DID subject | Exactly 1 row in subjects table |
| IT-SUB-002 | **Fix 2: concurrent creates — no errors** | 50 parallel calls | Zero UniqueConstraintViolation errors |
| IT-SUB-003 | **Fix 2: concurrent creates — all return same ID** | 50 parallel calls | All return identical subject ID |
| IT-SUB-004 | **Fix 10: progressive identifier enrichment** | Call 1: Google Maps identifier. Call 2: Zomato identifier. Same subject. | identifiers_json contains BOTH identifiers |
| IT-SUB-005 | **Fix 10: Tier 1 DID → globally deterministic** | Same DID from 5 different authors | 1 subject row, authorScopedDid = null |
| IT-SUB-006 | **Fix 10: Tier 2 name-only → author-scoped** | "Test Place" from 5 different authors | 5 distinct subject rows |
| IT-SUB-007 | **Fix 10: Tier 2 same author same name → deduplicated** | Same author, same name, 5 times | 1 subject row |

### §4.2 Canonical Merge Chain (Fix 10 Tier 3) (`subject-merge-chain.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-SUB-008 | simple merge — A → B | Set A.canonicalSubjectId = B.id | resolveOrCreateSubject for A returns B |
| IT-SUB-009 | chain merge — A → B → C | A → B, B → C | resolveOrCreateSubject for A returns C |
| IT-SUB-010 | cycle detection — A → B → A | Create circular pointers | Returns one of the IDs (doesn't infinite loop) |
| IT-SUB-011 | max depth exceeded | Chain of 6 merges (depth > MAX_CHAIN_DEPTH=5) | Returns last reachable ID, warning logged |
| IT-SUB-012 | processMerge — self-merge rejected | sourceId = targetId | No-op, no DB change |
| IT-SUB-013 | processMerge — cycle prevention | B already points to A, attempt A → B | Merge rejected |
| IT-SUB-014 | processMerge — both subjects marked dirty | Merge A → B | Both A and B have needs_recalc = true |
| IT-SUB-015 | resolve endpoint follows canonical chain | Subject A merged to B, query for A | API returns B's scores |

---

## §5 — Idempotency (Fix 1) (`tests/integration/ingester/idempotency.test.ts`)

Traces to: Fix 1 (Crash-Replay Survival)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-IDP-001 | **Fix 1: replay attestation 10 times → 1 row** | Same attestation event replayed 10× | Exactly 1 row in attestations, no error |
| IT-IDP-002 | **Fix 1: replay vouch 10 times → 1 row** | Same vouch event replayed 10× | Exactly 1 row in vouches |
| IT-IDP-003 | **Fix 1: replay reaction → onConflictDoNothing** | Same reaction replayed | 1 row, not updated (immutable) |
| IT-IDP-004 | **Fix 1: replay with changed data → updated** | Attestation replayed with different sentiment | sentiment = new value (onConflictDoUpdate) |
| IT-IDP-005 | **Fix 1: all 19 handler types — replay safe** | One record per collection, each replayed twice | No errors, correct row counts |
| IT-IDP-006 | **Fix 1: crash simulation — cursor replay** | Insert 100 events, save cursor at 50, "crash", replay from 50 | 100 unique rows total, no duplicates |
| IT-IDP-007 | **Fix 1: concurrent replay — same event from two workers** | Two workers process same event simultaneously | 1 row, no constraint violation |

---

## §6 — Backpressure + Low Watermark (`tests/integration/ingester/`)

### §6.1 Backpressure (`backpressure.test.ts`)

Traces to: Fix 5 (WebSocket OOM)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-BP-001 | **Fix 5: burst of 5000 events → bounded queue** | Push 5000 events in tight loop | Queue never exceeds MAX_QUEUE_SIZE |
| IT-BP-002 | **Fix 5: ws.pause() called at threshold** | Queue reaches MAX_QUEUE_SIZE | Mock ws.pause() called |
| IT-BP-003 | **Fix 5: ws.resume() at 50% drain** | Queue drains from full to below 50% | Mock ws.resume() called |
| IT-BP-004 | **Fix 5: all events eventually processed** | 5000 events pushed with backpressure | All 5000 processFn calls completed |
| IT-BP-005 | **Fix 5: memory bounded** | 10,000 events burst | Peak memory usage below threshold (no OOM) |

### §6.2 Low Watermark Cursor (`low-watermark.test.ts`)

Traces to: Fix 7 (Concurrent Worker Data Loss)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-LW-001 | **Fix 7: slow event + fast event → cursor = slow - 1** | Event 1000 (50ms), Event 2000 (5ms). Event 2000 finishes first. | getSafeCursor = 999 (not 2000) |
| IT-LW-002 | **Fix 7: all events complete → cursor = highestSeen** | All events finish processing | getSafeCursor = max(time_us) |
| IT-LW-003 | **Fix 7: crash mid-processing → replay from low watermark** | 5 events in-flight, simulate crash | Cursor saved = min(in-flight) - 1 |
| IT-LW-004 | **Fix 7: replay from low watermark → no data loss** | Save cursor, "crash", replay | All events present in DB (idempotent replay) |
| IT-LW-005 | **Fix 7: graceful shutdown saves low watermark** | SIGTERM with 3 in-flight events | Final cursor = min(in-flight timestamps) - 1 |

---

## §7 — Rate Limiter with Database Effects (`tests/integration/ingester/rate-limiter.test.ts`)

Traces to: Fix 11

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-RL-001 | **Fix 11: 50 records → all written to DB** | DID writes 50 attestations | 50 rows in attestations |
| IT-RL-002 | **Fix 11: 51st record → dropped, no DB write** | DID writes 51st attestation | 50 rows (51st not in DB) |
| IT-RL-003 | **Fix 11: rate-limited DID → zero DB I/O** | After hitting limit, send 100 more | DB query count unchanged |
| IT-RL-004 | **Fix 11: quarantine feeds sybil detection** | DID rate-limited, then detectSybil queries quarantined | DID appears in quarantine list |
| IT-RL-005 | **Fix 11: different DIDs not affected** | DID-A at limit, DID-B writes | DID-B records all written |

---

## §8 — Graph Queries (`tests/integration/graph/`)

### §8.1 One-Hop Queries (`one-hop.test.ts`)

Traces to: Architecture §"Graph Queries"

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-GR-001 | direct trust edge exists → shortestPath = 1 | A vouches for B, query A→B | shortestPath = 1 |
| IT-GR-002 | no direct edge → shortestPath != 1 | A has no edge to B | shortestPath != 1 |
| IT-GR-003 | trusted attestors — 1 hop | A trusts B, B attested about subject S | trustedAttestors includes B |
| IT-GR-004 | trusted attestors — limit 10 | A trusts 20 attestors for subject | Returns at most 10 |
| IT-GR-005 | trusted attestors — only non-revoked | A trusts B, B's attestation revoked | B not in trustedAttestors |

### §8.2 Two-Hop Queries (`two-hop.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-GR-006 | two-hop path exists → shortestPath = 2 | A→C, C→B (no A→B) | shortestPath = 2 |
| IT-GR-007 | prefers 1-hop over 2-hop | A→B direct AND A→C→B | shortestPath = 1 |
| IT-GR-008 | no 2-hop path → shortestPath = null | No path within 2 hops | shortestPath = null |
| IT-GR-009 | 2-hop fan-out capped at MAX_EDGES_PER_HOP | A has 1000 outbound edges | Only top 500 by weight considered |

### §8.3 Mutual Connections (`mutual-connections.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-GR-010 | mutual connections — simple case | A→C, B→C | mutualConnections = 1 |
| IT-GR-011 | mutual connections — zero | No shared connections | mutualConnections = 0 |
| IT-GR-012 | mutual connections — multiple | A→C, A→D, A→E, B→C, B→D | mutualConnections = 2 |

### §8.4 Super-Node Protection (Fix 3) (`supernode-timeout.test.ts`)

Traces to: Fix 3 (Fan-Out Caps), Fix 4 (Transaction-Scoped Timeouts)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-GR-013 | **Fix 3: super-node fan-out capped** | DID with 10,000 outbound edges | Query uses LIMIT 500, completes in bounded time |
| IT-GR-014 | **Fix 3: statement timeout → graceful null** | Inject artificial delay to exceed 100ms | mutualConnections = null (not error) |
| IT-GR-015 | **Fix 3: rest of resolve response proceeds** | Graph timeout triggered | Subject scores, flags, recommendation all still returned |
| IT-GR-016 | **Fix 4: timeout doesn't poison connection pool** | Graph query times out, then run normal query on same pool | Normal query succeeds with no timeout |
| IT-GR-017 | **Fix 4: SET LOCAL scoped to transaction** | After graph timeout, check pool connection | No statement_timeout set on recycled connection |
| IT-GR-018 | graph visualization — getGraphAroundDid | DID with 5 depth-1, 10 depth-2 connections | nodes and edges arrays populated, capped at depth 2 |
| IT-GR-019 | graph visualization — domain filter | Domain = "food" | Only trust edges with domain "food" or null returned |
| IT-GR-020 | graph visualization — depth cap at 2 | Request maxDepth = 5 | Actual depth capped at 2 |

---

## §9 — Scorer Jobs (`tests/integration/scorer/`)

### §9.1 Refresh Profiles — Incremental (Fix 9) (`refresh-profiles.test.ts`)

Traces to: Architecture §"Incremental Dirty-Flag Scoring", Fix 9

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-SC-001 | **Fix 9: only dirty profiles processed** | 100 profiles, 5 dirty | Only 5 profiles recomputed (95 untouched) |
| IT-SC-002 | **Fix 9: clean profiles not updated** | Profile with needs_recalc = false | computedAt unchanged after refresh |
| IT-SC-003 | **Fix 9: dirty flag flipped to false after processing** | Dirty profile refreshed | needs_recalc = false, computedAt = now |
| IT-SC-004 | **Fix 9: BATCH_SIZE respected** | 10,000 dirty profiles | Only 5,000 processed per run |
| IT-SC-005 | **Fix 9: overflow detection** | More dirty than BATCH_SIZE | Metrics show "overflow" |
| IT-SC-006 | no dirty profiles → no-op | All profiles clean | Zero DB updates, debug log |
| IT-SC-007 | new DID → profile created by dirty flag | First attestation for new DID | did_profiles row created with needs_recalc = true by markDirty |
| IT-SC-008 | profile fields computed correctly | DID with 10 positive, 5 negative attestations, 3 vouches | All aggregate fields match manual calculation |
| IT-SC-009 | overallTrustScore computed via computeTrustScore | Profile with rich data | overallTrustScore matches algorithm output |
| IT-SC-010 | error in one profile doesn't stop batch | 5 dirty, 1 causes error | 4 successfully refreshed, 1 logged as error |

### §9.2 Refresh Subject Scores — Incremental (Fix 9) (`refresh-subject-scores.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-SC-011 | **Fix 9: only dirty subjects processed** | 50 subjects, 3 dirty | 3 refreshed |
| IT-SC-012 | **Fix 9: dirty flag flipped** | After refresh | needs_recalc = false |
| IT-SC-013 | subject score aggregation | Subject with 8 positive, 2 negative | weightedScore reflects 80% positive |
| IT-SC-014 | dimension summary aggregation | 10 attestations with "quality" dimension | dimensionSummaryJson includes distribution |
| IT-SC-015 | attestation velocity computed | 20 attestations over 10 days | velocity = 2.0 |
| IT-SC-016 | verified attestation count | 5 verified attestations | verifiedAttestationCount = 5 |

### §9.3 Trust Score Convergence (Fix 12) (`trust-score-convergence.test.ts`)

Traces to: Fix 12 (Circular Dependency)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-SC-017 | **Fix 12: iterative scoring converges within 5 ticks** | Network of 10 DIDs, run refreshProfiles 5 times | Score deltas < 0.01 by tick 5 |
| IT-SC-018 | **Fix 12: unvouched sybils → zero weight** | 100 sybil DIDs (no vouches) all attest about subject | Subject score unchanged from zero-attestation state |
| IT-SC-019 | **Fix 12: one real vouch breaks sybil ceiling** | 1 real user vouches for 1 sybil | Only that sybil's attestations gain weight |
| IT-SC-020 | **Fix 12: damping factor prevents collapse** | All inputs zero (worst case) | overallTrustScore ≥ 0.015 (BASE * (1-DAMPING)) |
| IT-SC-021 | **Fix 12: vouch-gating — scored but unvouched = zero** | DID has trust score 0.8 but zero vouches | Attestations weighted at 0.0 |

### §9.4 Detect Coordination (`detect-coordination.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-SC-022 | temporal burst detected | 20 attestations for same subject within 1 hour, from 10 DIDs | Coordination anomaly event created |
| IT-SC-023 | normal traffic not flagged | 5 attestations per day over 2 weeks | No anomaly events |
| IT-SC-024 | coordination window — 48 hours | Events outside 48-hour window | Not counted together |
| IT-SC-025 | coordination flags propagated to profiles | Coordination detected for DIDs A, B, C | coordinationFlagCount incremented on their profiles |

### §9.5 Detect Sybil (`detect-sybil.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-SC-026 | sybil cluster — minimum 3 DIDs | 3 DIDs with correlated behavior | Flagged as sybil cluster |
| IT-SC-027 | 2 correlated DIDs — below threshold | 2 DIDs (SYBIL_MIN_CLUSTER_SIZE = 3) | Not flagged |
| IT-SC-028 | quarantined DIDs accelerate detection | Rate-limited DIDs passed to sybil detector | Investigated preferentially |

### §9.6 Process Tombstones (`process-tombstones.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-SC-029 | tombstone patterns aggregated per DID | DID with 5 tombstones | Profile updated with disputedThenDeletedCount = 5 |
| IT-SC-030 | tombstone threshold → trust penalty | DID ≥ COORDINATION_TOMBSTONE_THRESHOLD | overallTrustScore reduced by 60% |

### §9.7 Decay Scores (`decay-scores.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-SC-031 | old scores decayed | Subject with no recent attestations | weightedScore reduced |
| IT-SC-032 | recent scores not decayed | Subject with fresh attestations | weightedScore unchanged |

### §9.8 Cleanup Expired (`cleanup-expired.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-SC-033 | expired delegations removed | Delegation past expiry date | Row removed from delegations table |
| IT-SC-034 | expired review requests removed | ReviewRequest past expiry | Row removed |
| IT-SC-035 | non-expired records untouched | Active delegation | Row remains |

### §9.9 Refresh Reviewer Stats (`refresh-reviewer-stats.test.ts`)

Traces to: Architecture §"Scorer Jobs — refresh-reviewer-stats"

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-SC-036 | reviewer stats computed from attestations | DID with 20 attestations, 5 with evidence, 2 revoked | corroborationRate, evidenceRate, revocationRate all correct |
| IT-SC-037 | reviewer stats — agent detection | DID where > 50% of attestations have isAgentGenerated = true | isAgent = true on profile |
| IT-SC-038 | reviewer stats — active domains extracted | DID with attestations spanning "food", "tech", "travel" | activeDomains = ["food", "tech", "travel"] |

### §9.10 Refresh Domain Scores (`refresh-domain-scores.test.ts`)

Traces to: Architecture §"Scorer Jobs — refresh-domain-scores", domain_scores table

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-SC-039 | domain scores computed per DID per domain | DID with 10 food attestations, 5 tech attestations | domain_scores rows for (DID, food) and (DID, tech) |
| IT-SC-040 | domain score uses domain-specific attestations only | DID with mixed domain attestations | Food domain score only considers food attestations |
| IT-SC-041 | domain scores — DID with no domain attestations | DID with domain=null attestations only | No domain_scores rows created |

---

## §10 — API Endpoints (`tests/integration/api/`)

### §10.1 Resolve Endpoint (`resolve.test.ts`)

Traces to: Architecture §"Resolve (The Money Endpoint)"

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-API-001 | resolve — DID subject with scores | Subject with precomputed scores | Returns trustLevel, confidence, attestationSummary |
| IT-API-002 | resolve — subject not found | Unknown subject JSON | Returns SubjectNotFound error |
| IT-API-003 | resolve — invalid params | Missing subject parameter | Returns 400 InvalidRequest |
| IT-API-004 | resolve — DID profile included | Subject is a DID, profile exists | didProfile fields in response |
| IT-API-005 | resolve — flags included | Subject has active flags | flags array populated |
| IT-API-006 | resolve — graph context (with requesterDid) | Requester has trust edge to subject | graphContext.shortestPath = 1 |
| IT-API-007 | resolve — graph context null (no requesterDid) | No requesterDid param | graphContext = null |
| IT-API-008 | resolve — authenticity consensus | Content subject with verified authenticity | authenticity.predominantAssessment present |
| IT-API-009 | resolve — recommendation computed | Full data present | recommendation action + reasoning present |
| IT-API-010 | resolve — context affects recommendation | context = "before-transaction" | Stricter thresholds applied |
| IT-API-010a | resolve — malformed subject JSON → 400 | subject = "not-valid-json{" | Returns 400 InvalidRequest |
| IT-API-010b | resolve — domain-specific score used when available | domain = "food", subject has domain score | Domain score used over general score |

### §10.2 Resolve — Cache Integration (Fix 6) (`resolve-cache.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-API-011 | **Fix 6: 100 concurrent resolve → 1 DB query** | 100 parallel requests, same subject | DB query count = 1 (promise coalesced) |
| IT-API-012 | **Fix 6: stale-while-revalidate** | First request caches, TTL expires, second request | Second returns stale data instantly, background refresh |
| IT-API-013 | **Fix 6: different subjects → separate queries** | 10 different subjects, each with 10 concurrent requests | 10 DB queries total |
| IT-API-014 | **Fix 6: cache key includes requesterDid** | Same subject, different requesters | Different cache entries |

### §10.3 Search Endpoint (`search.test.ts`)

Traces to: Architecture §"Search Endpoint"

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-API-015 | search — full-text query | q = "darshini tiffin" | Returns attestations with matching text |
| IT-API-016 | search — category filter | category = "service" | Only service attestations returned |
| IT-API-017 | search — domain filter | domain = "food" | Only food domain attestations |
| IT-API-018 | search — sentiment filter | sentiment = "positive" | Only positive attestations |
| IT-API-019 | search — authorDid filter | authorDid = specific DID | Only that author's attestations |
| IT-API-020 | search — tags filter | tags = "quality,value" | Only attestations with both tags |
| IT-API-021 | search — date range (since/until) | since = "2026-01-01", until = "2026-02-01" | Only attestations in range |
| IT-API-022 | search — sort by recent | sort = "recent" | Ordered by recordCreatedAt DESC |
| IT-API-023 | search — sort by relevant (with q) | sort = "relevant", q = "excellent" | Ordered by ts_rank |
| IT-API-024 | search — pagination cursor | First page returns cursor, fetch page 2 | Continuation works, no duplicates |
| IT-API-025 | search — limit respected | limit = 10, 50 matching | Returns exactly 10 + cursor |
| IT-API-026 | search — excludes revoked attestations | Mix of active and revoked | Revoked not in results |
| IT-API-027 | search — empty results | q = "nonexistent12345" | Empty results array, no cursor |
| IT-API-028 | search — invalid params | limit = 200 (exceeds max 100) | 400 error |
| IT-API-029 | search — subjectType filter | subjectType = "product" | Only product-type attestations returned |
| IT-API-030 | search — minConfidence filter | minConfidence = "high" | Only attestations with confidence "high" or "certain" |

### §10.4 Get Profile Endpoint (`get-profile.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-API-031 | get profile — existing DID | DID with profile | Full profile data returned |
| IT-API-032 | get profile — non-existent DID | Unknown DID | 404 or empty profile |
| IT-API-033 | get profile — includes reviewer stats | DID with attestations by | Reviewer fields populated |
| IT-API-034 | get profile — includes trust score | DID with computed score | overallTrustScore present |

### §10.5 Get Attestations Endpoint (`get-attestations.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-API-035 | get attestations — by subject | subjectId | All attestations for that subject |
| IT-API-036 | get attestations — by author | authorDid | All attestations by that author |
| IT-API-037 | get attestations — pagination | limit + cursor | Pagination works correctly |
| IT-API-038 | get attestations — includes thread replies | Attestation with replies | Replies included or separately fetchable |

### §10.6 Get Graph Endpoint (`get-graph.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-API-039 | get graph — center DID | DID with trust edges | nodes and edges arrays |
| IT-API-040 | get graph — depth limit | maxDepth = 1 | Only 1-hop nodes |
| IT-API-041 | get graph — domain filter | domain = "food" | Only food-related edges |
| IT-API-042 | get graph — empty graph | DID with no trust edges | Empty nodes (just center) and edges |

---

## §11 — Database Schema + Indexes (`tests/integration/db/`)

### §11.1 Schema Correctness (`schema.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-DB-001 | migrations run cleanly | Fresh database, apply all migrations | No errors |
| IT-DB-002 | all 27 tables exist | Query information_schema for: attestations, vouches, endorsements, flags, replies, reactions, report_records, revocations, delegations, collections, media, subjects, amendments, verifications, review_requests, comparisons, subject_claims, trust_policies, notification_prefs, mention_edges, tombstones, trust_edges, anomaly_events, ingester_cursor, did_profiles, subject_scores, domain_scores | All 27 expected tables present |
| IT-DB-003 | attestations — primary key on uri | Duplicate uri insert | Constraint violation (without onConflict) |
| IT-DB-004 | trust_edges — unique on sourceUri | Duplicate sourceUri insert | Constraint violation |
| IT-DB-005 | tombstones — unique on originalUri | Duplicate originalUri insert | Constraint violation |
| IT-DB-006 | subjects — primary key on id | Duplicate id insert | Constraint violation |
| IT-DB-007 | did_profiles — primary key on did | Duplicate did insert | Constraint violation |
| IT-DB-008 | subject_scores — primary key on subjectId | Duplicate subjectId insert | Constraint violation |
| IT-DB-009 | subject_scores — foreign key to subjects | Insert with non-existent subjectId | Foreign key violation |

### §11.2 Index Verification (`indexes.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-DB-010 | attestations indexes exist | Query pg_indexes | idx_att_author, idx_att_subject, idx_att_sentiment, idx_att_domain, idx_att_category, idx_att_created, idx_att_tags, idx_att_cosigner, idx_att_subject_sentiment, idx_att_author_domain |
| IT-DB-011 | trust_edges indexes exist | Query pg_indexes | idx_te_from, idx_te_to, idx_te_from_to, idx_te_type |
| IT-DB-012 | **Fix 9: partial index on needs_recalc** | Query pg_indexes for did_profiles | idx_did_profiles_needs_recalc with WHERE clause |
| IT-DB-013 | **Fix 9: partial index on subject_scores** | Query pg_indexes | idx_subject_scores_needs_recalc with WHERE clause |
| IT-DB-014 | GIN index on tags | Query pg_indexes | idx_att_tags using GIN |
| IT-DB-015 | GIN index on identifiers_json | Query pg_indexes for subjects | idx_subjects_identifiers using GIN |
| IT-DB-016 | tsvector search index | Full-text search query plan uses index | EXPLAIN shows index scan |
| IT-DB-017 | partial index on author_scoped_did | Query pg_indexes | WHERE author_scoped_did IS NOT NULL |
| IT-DB-018 | partial index on canonical_subject_id | Query pg_indexes | WHERE canonical_subject_id IS NOT NULL |
| IT-DB-019 | tombstone indexes exist | Query pg_indexes for tombstones | idx_tomb_author, idx_tomb_subject, idx_tomb_deleted |
| IT-DB-020 | subjects DID index exists | Query pg_indexes for subjects | idx_subjects_did |
| IT-DB-021 | domain_scores table exists with indexes | Query pg_indexes for domain_scores | Primary key and relevant indexes present |

### §11.3 Query Performance (`query-performance.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-DB-022 | attestation lookup by subject — uses index | EXPLAIN ANALYZE | Index scan, not seq scan |
| IT-DB-023 | trust_edge lookup by from_did — uses index | EXPLAIN ANALYZE | Index scan |
| IT-DB-024 | dirty flag query — uses partial index | EXPLAIN ANALYZE on WHERE needs_recalc = true | Partial index scan |
| IT-DB-025 | full-text search — uses GIN index | EXPLAIN ANALYZE on tsvector query | GIN index scan |

---

## §12 — Dirty Flags Integration (`tests/integration/ingester/dirty-flags.test.ts`)

Traces to: Architecture §"Incremental Dirty-Flag Scoring", Fix 9

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-DF-001 | markDirty — creates subject_scores row if not exists | New subject | subject_scores row with needs_recalc = true |
| IT-DF-002 | markDirty — creates did_profiles row if not exists | New DID | did_profiles row with needs_recalc = true |
| IT-DF-003 | markDirty — sets existing row dirty | Profile with needs_recalc = false | Flipped to true |
| IT-DF-004 | markDirty — author always marked | Any attestation | Author's profile dirty |
| IT-DF-005 | markDirty — subject DID marked (when DID type) | Attestation about did:plc:xyz | did_profiles for xyz dirty |
| IT-DF-006 | markDirty — cosigner marked | Attestation with coSignature.did | Cosigner's profile dirty |
| IT-DF-007 | markDirty — mentioned DIDs marked | Attestation with 3 mentions | All 3 mentioned DID profiles dirty |
| IT-DF-008 | markDirty — subject_scores marked | Attestation for subject S | subject_scores for S dirty |
| IT-DF-009 | cascade: attestation → dirty → scorer refresh → clean | Full cycle | Profile starts dirty, ends clean after scorer run |

---

## §13 — Cursor Management (`tests/integration/ingester/cursor.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-CUR-001 | loadCursor — no prior cursor → 0 | Fresh database | cursor = 0 |
| IT-CUR-002 | saveCursor → loadCursor round-trip | Save 12345, then load | Returns 12345 |
| IT-CUR-003 | saveCursor — upsert on conflict | Save twice for same service | 1 row, second value |
| IT-CUR-004 | cursor per service URL | Save for ws://jetstream:6008 and ws://other:6008 | 2 distinct rows |
| IT-CUR-005 | **Fix 7: low watermark cursor value** | Save via getSafeCursor with in-flight | Saved value = min(in-flight) - 1 |

---

## §14 — Backfill Script (`tests/integration/backfill/backfill.test.ts`)

Traces to: Architecture §"Bootstrap & Backfill Strategy"

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-BF-001 | backfill from mock PDS — single DID | Mock PDS with 10 attestations | 10 rows in DB |
| IT-BF-002 | backfill — idempotent replay | Backfill same PDS twice | 10 rows (not 20) |
| IT-BF-003 | backfill — multiple collections | Mock PDS with attestations, vouches, flags | All 3 tables populated |
| IT-BF-004 | backfill — rate limiting applied | DID with 100 records (exceeds 50/hr) | Only 50 written, rest rate-limited |
| IT-BF-005 | backfill — invalid records skipped | Mock PDS with 5 valid, 2 invalid | 5 rows, 2 skipped |
| IT-BF-006 | backfill — concurrent PDS connections | 5 mock PDSes, maxConcurrentPds = 3 | Max 3 simultaneous connections |
| IT-BF-007 | backfill — PDS failure doesn't stop others | 1 of 5 PDSes returns 500 | Other 4 still backfilled |
| IT-BF-008 | backfill — pagination (cursor-based) | Mock PDS with 250 records, page size 100 | All 250 records fetched via 3 pages |
| IT-BF-009 | backfill → live transition seamless | Backfill 100 records, then live ingest 10 (5 overlap) | 105 unique rows total |
| IT-BF-010 | backfill — filterDids limits scope | filterDids = [did:plc:abc], PDS has 10 DIDs | Only records from did:plc:abc backfilled |

---

## §15 — Label Service (`tests/integration/labels/`)

### §15.1 Label Detectors (`label-detectors.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-LBL-001 | fake-review detector — correlated timing | Cluster of reviews within minutes | Label "fake-review" applied |
| IT-LBL-002 | ai-generated detector — undisclosed | High isAgentGenerated count without disclosure | Label "ai-generated" applied |
| IT-LBL-003 | self-promotion detector | Author reviewing their own DID | Label "self-promotion" applied |
| IT-LBL-004 | coordinated detector | Group of DIDs all reviewing same subject | Label "coordinated" applied |
| IT-LBL-005 | conflict-of-interest detector | Author has delegation from subject DID | Label "conflict-of-interest" applied |
| IT-LBL-006 | no labels for clean reviews | Normal, diverse, independent reviews | Zero labels applied |

---

## §16 — Docker Integration (`tests/integration/docker/`)

### §16.1 Docker Compose Smoke Tests (`docker.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-DCK-001 | postgres container healthy | docker compose up postgres | Healthcheck passes |
| IT-DCK-002 | jetstream container healthy | docker compose up jetstream | Healthcheck passes on :6008/health |
| IT-DCK-003 | ingester connects to postgres + jetstream | All 3 containers up | Ingester logs "Jetstream connection established" |
| IT-DCK-004 | scorer connects to postgres | Scorer container up | Scorer logs "Scorer job registered" for all 9 jobs |
| IT-DCK-005 | web container serves health endpoint | Web container up | GET /healthz returns 200 |
| IT-DCK-006 | migrations run on startup | Fresh postgres, start ingester | Tables created successfully |

---

## §17 — End-to-End Flows (`tests/e2e/`)

### §17.1 Ingest to Page (`ingest-to-page.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-E2E-001 | attestation → ingester → DB → scorer → API → page | Inject event via mock Jetstream, wait for scorer, query /resolve | Full response with scores |
| IT-E2E-002 | vouch → trust edge → graph query | Inject vouch, query getGraph | Vouch appears as trust edge in graph |
| IT-E2E-003 | disputed delete → tombstone → profile penalty | Create, report, delete attestation. Run scorer. | Tombstone exists, profile shows penalty |
| IT-E2E-004 | subject merge → canonical resolution | Create 2 subjects, merge, query /resolve | Returns merged subject's scores |
| IT-E2E-005 | search flow | Inject 10 attestations with varied text, query /search | Full-text search returns relevant results |

### §17.2 Subject Page (`subject-page.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-E2E-006 | subject page renders | Subject with 5 attestations | HTML page with attestation cards |
| IT-E2E-007 | subject page shows score | Subject with computed scores | Trust score badge visible |
| IT-E2E-008 | subject page shows dimensions | Subject with dimension ratings | Dimension grid rendered |

### §17.3 Search Flow (`search-flow.test.ts`)

| ID | Test Name | Description | Expected Result |
|----|-----------|-------------|-----------------|
| IT-E2E-009 | search page — text query | Query "darshini" | Results displayed |
| IT-E2E-010 | search page — filter by category | Category = "service" | Filtered results |
| IT-E2E-011 | search page — pagination | > 25 results | Next page link works |

---

## Summary

| Section | Subsection | Test Count |
|---------|-----------|------------|
| §1 Ingester Handlers | §1.1–§1.10 All 19 handlers | 61 |
| §2 Deletion + Tombstones | §2.1–§2.3 Clean/Disputed/Multi-table | 20 |
| §3 Trust Edge Sync | §3.1 Create + Remove | 12 |
| §4 Subject Resolution | §4.1–§4.2 Concurrent + Merge Chain | 15 |
| §5 Idempotency (Fix 1) | Full replay tests | 7 |
| §6 Backpressure + Low Watermark | §6.1–§6.2 Fix 5 + Fix 7 | 10 |
| §7 Rate Limiter + DB | Fix 11 | 5 |
| §8 Graph Queries | §8.1–§8.4 1-hop/2-hop/mutual/super-node | 20 |
| §9 Scorer Jobs | §9.1–§9.10 All 9 jobs + convergence + domain | 41 |
| §10 API Endpoints | §10.1–§10.6 Resolve/Search/Profile/Graph | 44 |
| §11 Database Schema | §11.1–§11.3 Schema/Indexes/Performance | 25 |
| §12 Dirty Flags | Full cycle | 9 |
| §13 Cursor Management | Load/Save/Low Watermark | 5 |
| §14 Backfill Script | PDS backfill scenarios | 10 |
| §15 Label Service | Detectors | 6 |
| §16 Docker Integration | Smoke tests | 6 |
| §17 End-to-End Flows | §17.1–§17.3 Full stack | 11 |
| **TOTAL** | | **307** |

---

## Fix Traceability Matrix

| Fix | Description | Integration Tests |
|-----|-------------|-------------------|
| Fix 1 | Idempotent upserts (crash-replay) | IT-IDP-001 to IT-IDP-007, IT-ATT-018/019, IT-VCH-002, IT-END-002, IT-FLG-002, IT-RPL-003, IT-RXN-002, IT-RPT-002, IT-REV-002, IT-DLG-003, IT-TE-009, IT-HND-001–010, IT-BF-002 |
| Fix 2 | Atomic subject resolution | IT-SUB-001 to IT-SUB-007 |
| Fix 3 | Super-node fan-out caps | IT-GR-013 to IT-GR-015 |
| Fix 4 | Transaction-scoped timeouts | IT-GR-016, IT-GR-017 |
| Fix 5 | WebSocket backpressure | IT-BP-001 to IT-BP-005 |
| Fix 6 | SWR cache + promise coalescing | IT-API-011 to IT-API-014 |
| Fix 7 | Low watermark cursor | IT-LW-001 to IT-LW-005, IT-CUR-005 |
| Fix 8 | O(1) LRU cache | Covered in unit tests (UT-SWR-008) |
| Fix 9 | Incremental dirty-flag scoring | IT-SC-001 to IT-SC-012, IT-DF-001 to IT-DF-009, IT-DB-012/013 |
| Fix 10 | 3-tier subject identity | IT-ATT-003 to IT-ATT-009, IT-SUB-001 to IT-SUB-015 |
| Fix 11 | Ingester-side rate limiting | IT-RL-001 to IT-RL-005, IT-BF-004 |
| Fix 12 | Zero-trust + vouch-gating + damping | IT-SC-017 to IT-SC-021 |
| Fix 13 | Parameterized deletion handler | IT-DEL-013 to IT-DEL-020 |

---

## Cross-Reference: Architecture Section → Tests

| Architecture Section | Unit Tests | Integration Tests |
|---------------------|-----------|-------------------|
| Jetstream Consumer | UT-JC-001–023 | IT-BP-001–005, IT-LW-001–005 |
| Record Validator | UT-RV-001–036 | — (pure function) |
| Rate Limiter | UT-RL-001–010 | IT-RL-001–005 |
| Bounded Queue | UT-BQ-001–012 | IT-BP-001–005, IT-LW-001–005 |
| Handler Pattern | UT-HR-001–007 | IT-ATT through IT-HND (all handlers) |
| Attestation Handler | — | IT-ATT-001–023 |
| Deletion Handler | UT-DH-001–006 | IT-DEL-001–020 |
| Trust Edge Sync | UT-TE-001–010 | IT-TE-001–012 |
| Subject Resolution | UT-DI-001–017 | IT-SUB-001–015 |
| Dirty Flags | — | IT-DF-001–009, IT-SC-001–012 |
| Trust Score Algorithm | UT-TS-001–039 | IT-SC-017–021 |
| Reviewer Quality | UT-RQ-001–010 | IT-SC-008–009 |
| Recommendation | UT-RC-001–012 | IT-API-009–010 |
| SWR Cache | UT-SWR-001–014 | IT-API-011–014 |
| Graph Queries | — | IT-GR-001–020 |
| Resolve Endpoint | UT-RP-001–005 | IT-API-001–014, IT-API-010a/010b |
| Search Endpoint | UT-SP-001–010 | IT-API-015–030 |
| Database Schema | — | IT-DB-001–025 |
| Scorer Scheduler | UT-SCH-001–013 | — |
| Scorer Jobs | UT-DS-001–004 | IT-SC-001–041 |
| Backfill | — | IT-BF-001–010 |
| Label Service | — | IT-LBL-001–006 |
| Docker | — | IT-DCK-001–006 |
| Environment Config | UT-ENV-001–013 | — |
| Constants | UT-CON-001–005 | — |
| Lexicons | UT-LEX-001–005 | — |
| AT URI Parser | UT-URI-001–008 | — |
| Error Types | UT-ER-001–004 | — |

---

## Combined Total: Unit + Integration

| Plan | Tests |
|------|-------|
| Unit Test Plan | **288** |
| Integration Test Plan | **307** |
| **Grand Total** | **595** |
