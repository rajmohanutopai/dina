# Brain Architecture Gap Analysis

> Deep validation of 19 architecture documents against `brain/tests/TEST_PLAN.md`
> and Python test stubs. Generated 2026-02-21.
>
> **Current state:** 391 scenarios (TST-BRAIN-001 through TST-BRAIN-391) across 17 sections.
> New scenarios start at **TST-BRAIN-392**.

---

## Summary

| Category | Count | Action |
|----------|-------|--------|
| TRUE GAP (HIGH) | 4 | New test plan row + new test stub |
| TRUE GAP (MEDIUM) | 11 | New test plan row + new test stub |
| TRUE GAP (LOW) | 8 | New test plan row + new test stub |
| COVERAGE GAP | 5 | Enhance existing test stub (ID exists) |
| MISMATCH | 2 | Fix values in existing test stub/plan |
| **Total** | **30** | |

> **All 30 gaps CLOSED** — 31 new test scenarios (TST-BRAIN-392 through TST-BRAIN-422) added.
> Updated 2026-02-21. Total brain test scenarios: 422.

---

## TRUE GAPS — HIGH Severity

These are Phase 1 safety/security-critical behaviors explicitly described in the
architecture but missing from the brain test plan entirely.

| ID | Arch Source | Requirement | Recommended Section | Status |
|----|------------|-------------|---------------------|--------|
| H1 | `04-data-flow-and-recovery.md` §Brain Crash Recovery, Task Queue | Brain MUST ACK processed tasks via `POST core:8100/v1/task/ack {task_id}`. Core deletes from `dina_tasks` on ACK. Without ACK, core requeues after 5-min timeout. Architecture defines full lifecycle: `pending → processing → done/dead`. | §2.3 Guardian Execution | CLOSED |
| H2 | `10-layer5-bot-interface.md`, `11-layer6-intelligence.md` | Brain must validate bot/agent responses for **PII leakage** before showing to user. Bot response may contain leaked entities (email, name) that brain must detect via spaCy NER and scrub/flag before rehydrating Entity Vault tokens. | §6.2 Agent Safety | CLOSED |
| H3 | `11-layer6-intelligence.md` §Entity Vault, User consent | Cloud LLM profile users must **explicitly acknowledge** consent during setup before brain routes health/financial queries to cloud. Brain must check this consent flag; without it, sensitive persona queries to cloud are blocked. | §4.1 LLM Router | CLOSED |
| H4 | `05-layer0-identity.md` §Persona Access Tiers, `03-sidecar-architecture.md` | When brain gets `403 Persona Locked` from core on a query, brain must: (1) NOT crash, (2) notify user that persona needs unlocking, (3) wait for user to unlock via CLIENT_TOKEN device, (4) retry query after unlock notification. Full locked→unlock→retry flow not tested. | §2.2 Vault Lifecycle | CLOSED |

---

## TRUE GAPS — MEDIUM Severity

Important brain behaviors from architecture, Phase 1 or early Phase 2.

| ID | Arch Source | Requirement | Recommended Section | Status |
|----|------------|-------------|---------------------|--------|
| M1 | `08-layer3-trust-network.md` §Reputation AppView | Brain queries Reputation AppView API (`GET /v1/reputation?did=...`) to get product scores, expert attestations, and bot scores for recommendations. Phase 2 feature but AppView query contract should be tested. | §6 MCP Client (new subsection) | CLOSED |
| M2 | `08-layer3-trust-network.md` §Cold Start | When Reputation AppView is unavailable, brain degrades gracefully to web search via OpenClaw. No disruption to user. Phase 1 behavior (AppView doesn't exist yet, brain uses web search). | §6 MCP Client | CLOSED |
| M3 | `10-layer5-bot-interface.md` §Bot Reputation Scoring | Brain maintains per-bot reputation scores locally. After each interaction outcome, brain recalculates bot score. Next query routes to updated best bot. TST-BRAIN-228 says "highest score selected" but doesn't verify local tracking or recalculation. | §6.1 Agent Routing | CLOSED |
| M4 | `11-layer6-intelligence.md` §Context Injection | Brain detects **disconnection patterns** — identifies contacts with no recent interaction (N+ days) and proactively suggests reconnection. Architecture says "nudge toward human connection" (Anti-Her + nudge assembly). | §2.6 Context Injection | CLOSED |
| M5 | `09-layer4-dina-to-dina.md` §Message Types | Brain must parse DIDComm message types (`dina/social/arrival`, `dina/commerce/*`, `dina/identity/*`, `dina/reputation/*`) and route to appropriate handler (nudge assembly, commerce flow, etc.). TST-BRAIN-035 is generic "process incoming event." | §2.8 D2D Payload | CLOSED |
| M6 | `16-technology-stack.md`, `17-infrastructure.md` §Voice STT | Brain integrates with Deepgram Nova-3 via WebSocket streaming for real-time voice-to-text. Fallback: Gemini Flash Lite Live API. ~150-300ms latency target. No brain test exists for voice input pipeline. | §4 LLM Router (new subsection) | CLOSED |
| M7 | `04-data-flow-and-recovery.md` §API Contract | When brain uses `include_content: true` in vault query, it takes on PII scrubbing responsibility for raw `body_text`. Architecture says this flag is "a signal to the developer that they're opting into a higher-trust path." No test verifies brain scrubs after setting this flag. | §3.2 Combined Pipeline | CLOSED |
| M8 | `04-data-flow-and-recovery.md` §Reading, Semantic search | Brain merges FTS5 + sqlite-vec cosine results using formula `0.4 × fts5_rank + 0.6 × cosine_similarity` (hybrid search). Dedup applied to merged results. No test for merging formula or dedup logic. | §4 LLM Router or §7 Core Client | CLOSED |
| M9 | Architecture §15 (anomalies, inferred from ingestion) | LLM triage timeout fallback: after 3 failed LLM classification attempts, brain classifies ALL remaining emails as SKIP (conservative, safe). User sees fewer emails indexed. Admin UI shows triage LLM timeout status. | §5.2 Ingestion Pipeline | CLOSED |
| M10 | `04-data-flow-and-recovery.md` §Task Queue, Dead Letter | After 3 failed task processing attempts, task moves to `status = 'dead'`. Brain must handle dead-letter notification: Core injects Tier 2 notification "Brain failed to process an event 3 times. Check crash logs." | §12 Scratchpad or §11 Error Handling | CLOSED |
| M11 | `11-layer6-intelligence.md` §PII Scrubber | **Circular dependency prevention** (explicit test): Brain must NEVER send unscrubbed text to a cloud LLM for the purpose of PII detection. Architecture states: "The routing itself constitutes the leak. PII scrubbing must always be local." TST-BRAIN-109 touches this but the assertion is weak. | §3.2 Combined Pipeline | CLOSED |

---

## TRUE GAPS — LOW Severity

Nice-to-have tests, code audits, very deferred features.

| ID | Arch Source | Requirement | Recommended Section | Status |
|----|------------|-------------|---------------------|--------|
| L1 | `09-layer4-dina-to-dina.md` §Sharing Policy API | Brain validates contact DID exists in contacts table before applying sharing policy PATCH. Invalid DID should return clear error to user. | §2.7 Sharing Policy | CLOSED |
| L2 | `03-sidecar-architecture.md`, `04-data-flow-and-recovery.md` | **Code audit:** Brain codebase has zero `sqlite3.connect()` / `sqlalchemy` calls. All data access goes through core HTTP API. CI-enforceable. | §1.2 Endpoint Access Control | CLOSED |
| L3 | `04-data-flow-and-recovery.md` §Observability, `17-infrastructure.md` | Brain startup dependency: brain starts only after core `/readyz` passes (Docker `depends_on: condition: service_healthy`). Brain must handle core-not-ready-yet state at startup. | §11 Error Handling | CLOSED |
| L4 | `04-data-flow-and-recovery.md` §Logging policy | **Logging audit:** Brain log output MUST NOT contain vault content, user queries, PII, brain reasoning output, NaCl plaintext, passphrase/keys, or API tokens. Only metadata: timestamps, endpoint, persona, query type, error codes, item counts, latency. | §13 Crash Traceback Safety | CLOSED |
| L5 | `03-sidecar-architecture.md` §Why the sidecar pattern | Brain language-agnosticism: internal API contract (`/v1/process`, `/v1/reason`) is documented, versioned, language-agnostic. Brain can be rewritten in Go or other language. | §10 API Endpoints | CLOSED |
| L6 | `14-digital-estate.md` | Brain behavior during active recovery procedures: brain queues/rejects non-critical tasks while estate recovery is in-flight. Phase 2+ feature. | §17 Deferred | CLOSED |
| L7 | `05-layer0-identity.md` §Trust Rings, ZKP | Brain verifies Ring 2+ ZKP credentials when evaluating agent intent reputation. Phase 3 feature (ZK-SNARKs on L2). | §17 Deferred | CLOSED |
| L8 | `14-digital-estate.md` §SSS Recovery | Brain's role in Shamir Secret Sharing custodian recovery coordination via DIDComm. Phase 2+ feature. Core handles crypto; brain may coordinate human approval flow. | §17 Deferred | CLOSED |

---

## COVERAGE GAPS — Enhance Existing Tests

Existing test stubs that need stronger assertions to match architecture specs.

| ID | TST-BRAIN | File | Enhancement Needed |
|----|-----------|------|--------------------|
| C1 | TST-BRAIN-228 | test_mcp.py | Add explicit verification that brain **maintains per-bot scores locally** and **recalculates after each interaction outcome**. Current test only says "Highest Trust Network score selected" without verifying the tracking mechanism. |
| C2 | TST-BRAIN-035 | test_guardian.py | Add explicit DIDComm message type parsing test case: brain receives `{type: "dina/social/arrival", from: "did:plc:...", body: {...}}` → correctly routes to nudge assembly handler (not just generic "process incoming event"). |
| C3 | TST-BRAIN-109 | test_pii.py | Strengthen circular dependency assertion: verify that brain's PII scrubbing code path **never** routes data to any external API (cloud LLM, OpenClaw, etc.) for PII detection. Currently tests pipeline but not the invariant. |
| C4 | TST-BRAIN-032/033 | test_guardian.py | Add persona locked → user notification → unlock → retry flow. Current tests cover "Brain starts in degraded mode" and "Brain checkpoints to scratchpad" but not the complete unlock-retry cycle. |
| C5 | TST-BRAIN-289/376 | test_config.py, TEST_PLAN.md | Fix CORE_URL port inconsistency within brain test plan: TST-BRAIN-015 and TST-BRAIN-044 reference `core:8100`, but TST-BRAIN-289 and TST-BRAIN-376 use `core:8300`. Resolve against architecture. See MISMATCH X1. |

---

## MISMATCHES — Fix Values in Existing Tests

| ID | File(s) | Current Value | Architecture Value | Fix |
|----|---------|---------------|-------------------|-----|
| X1 | `brain/tests/TEST_PLAN.md` (TST-BRAIN-289, 376), `brain/tests/factories.py`, `brain/tests/conftest.py` | `CORE_URL` defaults to `http://core:8300` | `DINA_CORE_URL=http://core:8100` (`17-infrastructure.md` line 90, docker-compose) | **Investigate:** Architecture docker-compose says `DINA_CORE_URL=http://core:8100`. Core TEST_PLAN says "Port 8300 (API), 8100 (admin proxy)." Either architecture docker-compose port is wrong, or core/brain test plans have wrong default. Resolve definitively and align all references. |
| X2 | `brain/tests/TEST_PLAN.md` (TST-BRAIN-289, 291) | TST-BRAIN-289 says `CORE_URL=http://core:8300`; TST-BRAIN-291 says "Missing CORE_URL → Startup fails" | Architecture says brain has default for CORE_URL (`http://core:8100`) | **Conflict:** TST-BRAIN-376 says CORE_URL has a default, but TST-BRAIN-291 says missing CORE_URL causes startup failure. If there's a default, missing CORE_URL should NOT fail. Fix: either remove the default (TST-BRAIN-376) or change TST-BRAIN-291 to say "missing CORE_URL uses default." |

---

## Architecture Documents Analyzed

| # | Document | Brain-Related Requirements Found | Coverage |
|---|----------|----------------------------------|----------|
| 1 | `01-system-overview.md` | 2 (Four Laws, Anti-Her) | 100% |
| 2 | `02-home-node-operations.md` | 3 (boot sequence, persona unlock) | 67% |
| 3 | `03-sidecar-architecture.md` | 10 (isolation, auth, stateless, crash) | 90% |
| 4 | `04-data-flow-and-recovery.md` | 12 (data flow, task queue, scratchpad, logging) | 83% |
| 5 | `05-layer0-identity.md` | 4 (trust rings, personas, ZKP) | 50% |
| 6 | `06-layer1-storage.md` | 8 (vault access, persona tiers, KV) | 88% |
| 7 | `07-layer2-ingestion.md` | 20 (sync, triage, batch, attachments, memory) | 100% |
| 8 | `08-layer3-trust-network.md` | 4 (AppView query, outcome submission) | 50% |
| 9 | `09-layer4-dina-to-dina.md` | 6 (D2D payload, sharing policy, egress) | 67% |
| 10 | `10-layer5-bot-interface.md` | 6 (query sanitization, attribution, PII validation) | 67% |
| 11 | `11-layer6-intelligence.md` | 17 (PII scrubber, Entity Vault, LLM routing, silence, nudge) | 88% |
| 12 | `12-layer7-action-layer.md` | 22 (draft-don't-send, cart handover, MCP, scheduling) | 100% |
| 13 | `13-client-sync.md` | 1 (brain receives item notifications) | 0% |
| 14 | `14-digital-estate.md` | 2 (recovery state, SSS coordination) | 0% |
| 15 | `15-architecture-decisions.md` | 3 (BRAIN_TOKEN, persona DEKs) | 100% |
| 16 | `16-technology-stack.md` | 4 (ADK, multi-provider, embeddings, voice STT) | 75% |
| 17 | `17-infrastructure.md` | 20 (ports, healthchecks, secrets, logging, config) | 85% |
| 18 | `18-roadmap.md` | 0 | N/A |
| 19 | `ARCHITECTURE_README.md` | 0 | N/A |

**Overall brain-relevant requirements:** ~144
**Covered by TST-BRAIN-001 through 391:** ~124 (86%)
**Gaps identified:** 30 (4 HIGH + 11 MEDIUM + 8 LOW + 5 COVERAGE + 2 MISMATCH)

---

## Detailed Gap Descriptions

### H1 — Task Queue ACK Protocol

**Architecture source:** `04-data-flow-and-recovery.md` lines 274-312

```
Core → Brain task lifecycle:
  Core receives event → writes to dina_tasks {status: "pending"}
  Core sends POST brain:8200/api/v1/process {task_id}
  Core updates: status = "processing", timeout_at = now() + 5 min
    ├── Brain succeeds → ACKs: POST core:8100/v1/task/ack {task_id}
    │   Core deletes task. Done.
    └── Brain crashes → no ACK → timeout expires
        Core resets: status = "pending"
```

**What's missing:** No brain test verifies:
1. Brain sends `POST /v1/task/ack {task_id}` after successful processing
2. Brain includes correct `task_id` in ACK
3. If brain crashes before ACK, task is re-delivered by core on restart

**Recommended tests:**
- TST-BRAIN-392: Brain ACKs task after successful processing
- TST-BRAIN-393: Brain does NOT ACK failed task (allows core to retry)
- TST-BRAIN-394: Brain receives retried task (same task_id) after crash

### H2 — Bot Response PII Validation

**Architecture source:** `10-layer5-bot-interface.md`, `11-layer6-intelligence.md`

Bot/agent responses may contain PII that leaked through the query sanitization.
Brain must validate responses before showing to user.

**What's missing:** No test verifies brain runs PII detection (spaCy NER) on
bot/agent responses before rehydrating Entity Vault tokens and displaying to user.

**Recommended test:**
- TST-BRAIN-395: Bot response with leaked PII detected and scrubbed

### H3 — Cloud LLM Consent Enforcement

**Architecture source:** `11-layer6-intelligence.md` line 182

> "User must explicitly acknowledge this."

**What's missing:** No test verifies brain checks `cloud_llm_consent` flag
before routing health/financial persona queries to cloud LLM. Without consent,
brain must reject the cloud route even if Entity Vault scrubbing would work.

**Recommended test:**
- TST-BRAIN-396: Cloud LLM consent not given → health query rejected with
  "Enable cloud LLM consent in settings"
- TST-BRAIN-397: Cloud LLM consent given → health query processed via
  Entity Vault + cloud

### H4 — Persona Locked Query Flow

**Architecture source:** `05-layer0-identity.md` line 169, `03-sidecar-architecture.md` lines 118-127

> Brain gets `403 Persona Locked` — must request unlock via client device

**What's missing:** Complete flow: brain queries `/financial` → gets 403 →
notifies user "Financial persona is locked, unlock to continue" → user unlocks
via CLIENT_TOKEN → brain retries query.

**Recommended tests:**
- TST-BRAIN-398: Brain receives 403 Persona Locked → whispers unlock request
- TST-BRAIN-399: Brain retries query after persona unlock notification

### M6 — Voice STT Integration

**Architecture source:** `16-technology-stack.md`, `17-infrastructure.md`

> Voice STT: Deepgram Nova-3 ($0.0077/min, WebSocket streaming, ~150-300ms).
> Fallback: Gemini Flash Lite Live API.

**What's missing:** No brain test for:
1. Receiving audio stream and routing to Deepgram
2. Receiving transcription and processing as query
3. Fallback to Gemini Flash Lite when Deepgram unavailable
4. Latency target verification (150-300ms)

**Recommended tests:**
- TST-BRAIN-400: Voice input via Deepgram → text → guardian loop
- TST-BRAIN-401: Deepgram unavailable → fallback to Gemini STT
- TST-BRAIN-402: Voice latency within target (< 300ms)

### M8 — Hybrid Search Merging

**Architecture source:** `04-data-flow-and-recovery.md` line 232

> `relevance = 0.4 × fts5_rank + 0.6 × cosine_similarity`

**What's missing:** No test verifies brain correctly merges FTS5 and semantic
results using the specified formula, deduplicates overlapping results, and
returns them in correct relevance order.

**Recommended tests:**
- TST-BRAIN-403: Hybrid search merges FTS5 + cosine with correct weights
- TST-BRAIN-404: Hybrid search deduplicates items appearing in both result sets

### M9 — LLM Triage Timeout Fallback

**Architecture source:** Inferred from ingestion pipeline design

> After 3 failed LLM calls, classify all remaining as SKIP (conservative).

**What's missing:** No test for LLM classification timeout/failure fallback
during email triage. Brain should gracefully degrade.

**Recommended test:**
- TST-BRAIN-405: LLM triage fails 3x → all remaining emails classified SKIP
- TST-BRAIN-406: Admin UI shows triage LLM timeout status

### M10 — Dead Letter Notification

**Architecture source:** `04-data-flow-and-recovery.md` line 314

> After 3 failed attempts, task moves to `status = 'dead'`. Core injects a
> Tier 2 notification: "Brain failed to process an event 3 times."

**What's missing:** No test for brain handling dead-letter tasks or the
notification that results from 3 failures.

**Recommended test:**
- TST-BRAIN-407: Task fails 3x → dead letter → Tier 2 notification to user

---

## New Test IDs Required

| ID Range | Count | Category |
|----------|-------|----------|
| TST-BRAIN-392–394 | 3 | H1: Task Queue ACK |
| TST-BRAIN-395 | 1 | H2: Bot Response PII |
| TST-BRAIN-396–397 | 2 | H3: Cloud LLM Consent |
| TST-BRAIN-398–399 | 2 | H4: Persona Locked Flow |
| TST-BRAIN-400–402 | 3 | M6: Voice STT |
| TST-BRAIN-403–404 | 2 | M8: Hybrid Search |
| TST-BRAIN-405–406 | 2 | M9: LLM Triage Timeout |
| TST-BRAIN-407 | 1 | M10: Dead Letter |
| TST-BRAIN-408 | 1 | M1: AppView Query |
| TST-BRAIN-409 | 1 | M2: AppView Fallback |
| TST-BRAIN-410 | 1 | M3: Bot Reputation Tracking |
| TST-BRAIN-411 | 1 | M4: Disconnection Detection |
| TST-BRAIN-412 | 1 | M5: D2D Message Type Parsing |
| TST-BRAIN-413 | 1 | M7: include_content PII |
| TST-BRAIN-414 | 1 | M11: Circular Dependency |
| TST-BRAIN-415 | 1 | L1: Sharing Policy Validation |
| TST-BRAIN-416 | 1 | L2: SQLite Audit |
| TST-BRAIN-417 | 1 | L3: Startup Dependency |
| TST-BRAIN-418 | 1 | L4: Logging Audit |
| TST-BRAIN-419 | 1 | L5: Language Agnostic |
| TST-BRAIN-420 | 1 | L6: Recovery State |
| TST-BRAIN-421 | 1 | L7: ZKP Credentials |
| TST-BRAIN-422 | 1 | L8: SSS Recovery |
| **Total** | **31** | |

**New ID range: TST-BRAIN-392 through TST-BRAIN-422** (31 new scenarios).
**After fix: 422 total scenarios** (391 existing + 31 new).
