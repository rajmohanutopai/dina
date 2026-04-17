# Dina User Stories — Test Plan

> System-level tests validating full user journeys across the multi-node Docker stack.
> Each story runs sequentially — tests build on state from prior steps.

---

## 1. Purchase Journey (Story 01)

### 1.1 Personalized Purchase Advice

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-USR-001]** Five Dinas with distinct identities and trust edges | Seed 5 DIDs + trust edges in AppView | Each DID unique, trust edges created, rings established |
| 2 | **[TST-USR-002]** Alice reviews chairs | Alice posts attestations via PDS | Attestations published for CheapChair (negative) and ErgoMax (positive) |
| 3 | **[TST-USR-003]** Bob reviews chairs | Bob posts attestations via PDS | Attestations published for CheapChair (negative) and ErgoMax (positive) |
| 4 | **[TST-USR-004]** Diana reviews chairs | Diana posts attestations via PDS | Attestations published for CheapChair (negative) and ErgoMax (positive) |
| 5 | **[TST-USR-005]** Unverified Dinas pump positive CheapChair | Charlie + Eve post positive CheapChair attestations | Unverified positive reviews contradict verified negative reviews |
| 6 | **[TST-USR-006]** All attestations ingested | Query AppView Postgres | All attestations from 5 reviewers present in database |
| 7 | **[TST-USR-007]** Trust rings established | Query trust edges + vouch counts | Alice/Bob/Diana at Ring 2+, Charlie/Eve at Ring 1 |
| 8 | **[TST-USR-008]** Verified negatives for CheapChair | Query attestations with trust weighting | Verified (Ring 2+) reviewers negative on CheapChair |
| 9 | **[TST-USR-009]** Verified positives for ErgoMax | Query attestations with trust weighting | Verified reviewers positive on ErgoMax |
| 10 | **[TST-USR-010]** Store personal context in vault | Store health, work, finance, family items | Vault items stored across persona compartments |
| 11 | **[TST-USR-011]** Store purchase decision in vault | Store chair comparison + trust-weighted reviews | Decision context with trust scores persisted |
| 12 | **[TST-USR-012]** Dina gives personalized purchase advice (LLM) | Brain reasons with vault context + trust data | Recommends ErgoMax over CheapChair, references back pain, budget, trust data |
| 13 | **[TST-USR-013]** Five words to personalized advice (LLM) | "I need a new office chair" | Full pipeline: vault enrichment → trust query → personalized recommendation |

---

## 2. Sancho Moment (Story 02)

### 2.1 Context-Aware Nudge from D2D Message

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-USR-014]** Previous conversation stored in vault | Store relationship notes about Sancho | Mother unwell + cardamom tea preference in vault |
| 2 | **[TST-USR-015]** Sancho sends D2D arrival message | POST /v1/msg/send dina/social/arrival | Message sent via NaCl encrypted channel |
| 3 | **[TST-USR-016]** Alonso receives decrypted D2D message | Poll inbox for arrival message | Message decrypted, signature verified, trust filtered |
| 4 | **[TST-USR-017]** Brain processes DIDComm arrival | POST /api/v1/process with D2D event | Guardian routes through nudge assembly pipeline |
| 5 | **[TST-USR-018]** Nudge was assembled | Check process result action | action=nudge_assembled, nudge object present |
| 6 | **[TST-USR-019]** Nudge contains vault context | Inspect nudge text | References mother's health AND cardamom tea preference |
| 7 | **[TST-USR-020]** LLM generates human-quality nudge (LLM) | Send vault context to LLM | Natural 1-3 sentence nudge mentioning Sancho, mother, tea |

---

## 3. Dead Internet Filter (Story 03)

### 3.1 Identity-First Content Verification

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-USR-021]** Seed creator profiles | Insert Elena (Ring 3) + BotFarm (Ring 1) into Postgres | Profiles with correct trust scores + attestation counts |
| 2 | **[TST-USR-022]** AppView returns trusted creator | XRPC getProfile for Elena | Trust score ≥0.9, 200+ attestations, 15+ vouches |
| 3 | **[TST-USR-023]** AppView returns untrusted creator | XRPC getProfile for BotFarm | Trust score <0.1, 0 attestations about, 0 vouches |
| 4 | **[TST-USR-024]** Core resolves trusted creator via AppView | GET /v1/trust/resolve?did=elena | Full profile passed through Core from AppView |
| 5 | **[TST-USR-025]** Core resolves untrusted creator via AppView | GET /v1/trust/resolve?did=botfarm | Low/zero profile passed through Core |
| 6 | **[TST-USR-026]** Brain confirms trusted creator (LLM) | Send Elena profile to LLM | LLM recognizes strong trust signals, references specific data |
| 7 | **[TST-USR-027]** Brain flags untrusted creator (LLM) | Send BotFarm profile to LLM | LLM flags as unverified, mentions lack of history |
| 8 | **[TST-USR-028]** Side-by-side trust comparison (LLM) | Compare Elena vs BotFarm profiles | LLM explains identity/history as deciding factor |

---

## 4. Persona Wall (Story 04)

### 4.1 Cross-Persona Disclosure Control

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-USR-029]** Seed health persona vault | Store 3 medical records in restricted health persona | Records with L4-L5 diagnosis, Dr. Sharma, medications |
| 2 | **[TST-USR-030]** Store shopping context | Store shopping query in open consumer persona | Chair search context stored |
| 3 | **[TST-USR-031]** Cross-persona request blocked | Shopping agent requests health data | action=disclosure_proposed, blocked=True, requires_approval=True |
| 4 | **[TST-USR-032]** Verify automatic disclosure blocked | Check response fields | blocked=True, persona_tier=sensitive, approved=False |
| 5 | **[TST-USR-033]** Verify disclosure proposal exists | Check proposal object | safe_to_share non-empty, withheld non-empty |
| 6 | **[TST-USR-034]** Verify diagnosis withheld | Check safe_to_share text | No L4-L5, herniat*, Dr. Sharma, Apollo, Ibuprofen |
| 7 | **[TST-USR-035]** Verify proposal is useful | Check general terms in safe_to_share | At least 2 of: back, pain, lumbar, chronic, ergonomic |
| 8 | **[TST-USR-036]** User approves minimal disclosure | Send disclosure_approved event | action=disclosure_shared |
| 9 | **[TST-USR-037]** Verify shared text matches approved | Compare shared_text to approved_text | Exact match |
| 10 | **[TST-USR-038]** Verify no diagnosis in shared response | Stringify full response | No L4-L5, herniat*, Ibuprofen, Apollo anywhere |
| 11 | **[TST-USR-039]** Verify PII check clean | Check pii_check object | medical_patterns_found=[], clean=True |

---

## 5. Agent Gateway (Story 05)

### 5.1 External Agent Safety Layer

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-USR-040]** Register agent via pairing | Initiate + complete pairing ceremony | Device registered with Ed25519 key, device_id returned |
| 2 | **[TST-USR-041]** Agent in device list | GET /v1/devices | external_agent_v1 appears in device list |
| 3 | **[TST-USR-042]** Safe intent auto-approved | validate action=search | risk=SAFE, action=auto_approve, approved=True |
| 4 | **[TST-USR-043]** Moderate intent flagged | validate action=send_email | risk=MODERATE, action=flag_for_review, requires_approval=True |
| 5 | **[TST-USR-044]** High-risk intent flagged | validate action=share_data | risk=HIGH, action=flag_for_review, requires_approval=True |
| 6 | **[TST-USR-045]** Unauthenticated agent rejected | No auth headers | 401 before reaching Guardian |
| 7 | **[TST-USR-046]** Blocked action denied | validate action=read_vault | action=deny, risk=BLOCKED |
| 8 | **[TST-USR-047]** Export data blocked | validate action=export_data | action=deny, risk=BLOCKED |
| 9 | **[TST-USR-048]** Agent cannot cross personas | Query consumer for health data | Health data not leaked to consumer persona |
| 10 | **[TST-USR-049]** Revoke agent device | DELETE /v1/devices/{id} | Device marked Revoked=True |

---

## 6. License Renewal (Story 06)

### 6.1 Agent Safety Layer + Deterministic Sandwich

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-USR-050]** Store personal context | Seed vault with address, insurance, renewal history | 3 context items stored |
| 2 | **[TST-USR-051]** Brain extracts license data (LLM) | Document ingest with license text | Per-field confidence, PII flagged, reminder created |
| 3 | **[TST-USR-052]** Verify vault entries | Check document + reminder in vault | Both items exist with correct types |
| 4 | **[TST-USR-053]** Verify confidence scores | Check extraction fields | license_number ≥0.95, expiry_date ≥0.95 |
| 5 | **[TST-USR-054]** Verify PII not in searchable fields | Check summary/body vs metadata | License number in metadata only, not in summary/body |
| 6 | **[TST-USR-055]** Store/verify reminder in Core | Check pending reminders | Reminder ID in pending list |
| 7 | **[TST-USR-056]** Reminder fires contextual notification (LLM) | Fire reminder → Brain process | Notification >50 chars, substantive |
| 8 | **[TST-USR-057]** Verify notification context | Check notification text | At least 2 of: date, Bangalore/RTO, ICICI/insurance, 2 weeks |
| 9 | **[TST-USR-058]** Delegation request with enforcement (LLM) | LLM generates DelegationRequest → Guardian validates | PII not in permitted_fields, risk=HIGH, flag_for_review |
| 10 | **[TST-USR-059]** Guardian reviews delegation | Submit share_data intent | risk=HIGH, flag_for_review, requires_approval=True |

---

## 7. Daily Briefing (Story 07)

### 7.1 Silence-First Notification Triage

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-USR-060]** Store context for briefing | Store 3 low-priority items (news, social, price) | Items stored in vault |
| 2 | **[TST-USR-061]** Fiduciary event interrupts | validate action=transfer_money | risk=HIGH, flag_for_review, requires_approval=True |
| 3 | **[TST-USR-062]** Engagement event queued | PUT /v1/vault/kv/briefing_queue | 3 Tier 3 items stored in KV |
| 4 | **[TST-USR-063]** Briefing retrieves queued items | GET /v1/vault/kv/briefing_queue | 3 items retrieved with correct sources |
| 5 | **[TST-USR-064]** Clear briefing queue after delivery | Overwrite with empty items | Queue empty after clear |

---

## 8. Move to New Machine (Story 08)

### 8.1 Data Portability & DID Stability

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-USR-065]** Store data on Node A | Store 2 items with portability markers | Items stored on old machine |
| 2 | **[TST-USR-066]** Record Node A identity | GET /v1/did on Node A | Valid DID starting with did: |
| 3 | **[TST-USR-067]** Data exportable | Query vault for migration test items | Items retrievable with portability markers |
| 4 | **[TST-USR-068]** Node B has same identity scheme | GET /v1/did on Node B | Valid DID, different from Node A, same DID method |
| 5 | **[TST-USR-069]** Vault operations work on Node B | Store + query on Node B | Independent vault operations functional |

---

## 9. Connector Expiry (Story 09)

### 9.1 Graceful Degradation & Recovery

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-USR-070]** Core healthy baseline | GET /healthz on Core and Brain | Both return 200 |
| 2 | **[TST-USR-071]** Vault works without Brain | Store + query vault items | Vault operates independently of Brain sidecar |
| 3 | **[TST-USR-072]** Brain-dependent endpoint clear error | POST /v1/agent/validate | Well-formed JSON response (200 or 502/503/504), no crash |
| 4 | **[TST-USR-073]** Recovery after outage | GET /healthz on Brain | Brain healthz returns 200, no permanent degradation |
| 5 | **[TST-USR-074]** DID works independently | GET /v1/did | Valid DID regardless of connector state |

---

## 10. Operator Journey (Story 10)

### 10.1 Idempotent Install & Locked-Node Admin

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-USR-075]** Record baseline DID | GET /v1/did | Valid DID recorded as baseline |
| 2 | **[TST-USR-076]** DID stable across requests | GET /v1/did 3 times | Same DID every time, no rotation |
| 3 | **[TST-USR-077]** Persona recreate idempotent | POST /v1/personas for existing persona | 200, 201, or 409 (not 500) |
| 4 | **[TST-USR-078]** Healthz stable under repeated probing | GET /healthz 5 times | All return 200 |
| 5 | **[TST-USR-079]** Locked persona clear error | Query locked persona vault | 403/423 with "locked" message, or 200 (auto-unlock), never 500 |

---

## 15. Public Service Query (Story 15)

> Don Alonso asks his Home Node when the next #42 bus arrives at Castro
> Station. His Brain doesn't know — it reaches out to **BusDriver**, a
> public transit provider already configured on the Trust Network. The
> full WS2 schema-driven arc runs end-to-end: requester validates params
> and forwards schema_hash, provider validates and delegates to its
> local agent, completion bridges back as service.response, and Alonso
> receives a workflow_event with the ETA.
>
> Story scope: provider-side contract across two real Core+Brain
> actor pairs (Alonso + BusDriver). The "local agent" step is
> simulated via the internal workflow-task callback (same endpoint
> a real dina-agent would hit). Full AppView publish→discovery→query
> integration is deferred to a later story (requires Jetstream
> ingestion timing; not CI-friendly).

### 15.1 Provider Configuration

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-USR-150]** Publish BusDriver service config | PUT /v1/service/config with eta_query schema + canonical schema_hash | 200; config gate verifies hash matches canonical form (cross-language regression guard) |
| 2 | **[TST-USR-151]** Service config round-trips | GET /v1/service/config | Response carries back the stored schema with the same hash (no persistence drift) |

### 15.2 Happy Path — Query → Delegation → Bridge

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 3 | **[TST-USR-152]** Alonso sends valid service.query | POST /v1/service/query {to_did, capability, params, schema_hash} | 2xx with task_id; durable workflow_task created on requester side |
| 4 | **[TST-USR-153]** BusDriver creates delegation task | Poll BusDriver's /v1/workflow/tasks | payload_type=service_query_execution; payload.schema_hash + schema_snapshot persisted |
| 5 | **[TST-USR-154]** Simulated agent completes task | POST /v1/internal/workflow-tasks/{id}/complete with schema-valid result | 2xx; internal callback accepts structured result_json |
| 6 | **[TST-USR-155]** Alonso's query task terminalises with success | Poll Alonso's service_query task | status=completed; workflow_event details reflect the result |

### 15.3 Protocol Gate Regressions

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 7 | **[TST-USR-156]** Stale schema_hash rejected without delegation | Send query with wrong schema_hash | schema_version_mismatch in Alonso's events; NO delegation task ever appears on BusDriver |
| 8 | **[TST-USR-157]** Missing required param rejected | Send query with empty params ({}), valid hash | Provider's jsonschema.validate rejects; requester sees "Invalid params" in events |
| 9 | **[TST-USR-158]** Failed task surfaces agent error verbatim | Provider task fails via /fail callback | Alonso's events contain agent's error text directly; NOT wrapped as `{message:…}` then schema-violated (regression for the wrap-as-message-then-validate bug) |
