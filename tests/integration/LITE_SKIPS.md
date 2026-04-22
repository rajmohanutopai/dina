# Lite-suite skip registry (task 8.58)

When an integration test under `tests/integration/` cannot run against
the Home Node Lite (TypeScript) stack, the skip is recorded here with
a reason and a milestone at which it becomes expected to pass.

This file is the **source of truth** for Lite-mode skips. The target
per the milestone plan is **zero skips at M5**; up to ~5% skipped with
documented reason is acceptable at M1–M4 gates (task 8.59).

## Format

Each entry uses the same 5-column shape:

| Test file / case | Skip reason | Category | Planned unlock | Notes |

- **Test file / case** — `test_file.py::TestClass::test_name` precise
  enough to disambiguate parametrised cases
- **Skip reason** — **one line** describing what fails under Lite
  (e.g. "Lite brain-server `/api/v1/reason` route pending Phase 5c")
- **Category** — one of:
  - `lite-bug` — Lite behaviour diverges from the oracle; needs a Lite fix
  - `go-specific-assertion` — test string-matches Go's exact shape;
    rewrite to oracle-neutral assertion
  - `wire-drift` — Lite emits slightly different wire bytes; Lite fix
  - `environmental` — runtime-level gap (e.g. CGO-only tooling, Python-only library)
  - `pending-route` — Lite brain-server route not yet implemented
  - `pending-feature` — Lite feature not yet implemented (e.g. D2D handshake)
- **Planned unlock** — milestone tag (`M1` / `M2` / `M3` / `M4` / `M5`)
  OR specific task ID (`task 1.32` / `task 5.19`) at which the skip
  is expected to be removable
- **Notes** — any context a future reader needs (e.g. a workaround that
  partially covers the assertion; an upstream library bug)

## Category taxonomy — how to pick

A test that fails under Lite but passes under Go falls into exactly
one of the six categories. Picking the right one matters because the
fix path is category-specific (see task 8.53's classification step):

```
      ┌─────────────────────────────────────────────────────────────┐
      │ Test fails against Lite but passes against Go               │
      └──────────────────────────┬──────────────────────────────────┘
                                 │
            ┌────────────────────┼───────────────────────┐
            │                    │                       │
 ┌──────────▼────────┐  ┌────────▼──────────┐  ┌─────────▼─────────┐
 │ Lite emits wrong  │  │ Test asserts      │  │ Lite route /      │
 │ behaviour vs the  │  │ Go-specific       │  │ feature / infra   │
 │ spec / oracle     │  │ string / error    │  │ not yet in M-gate │
 │ → lite-bug        │  │ prose / shape     │  │ → pending-route   │
 │ OR                │  │ → go-specific-    │  │    / -feature     │
 │ wire-drift        │  │    assertion      │  │                   │
 │ (wire-byte level) │  │                   │  │                   │
 └───────────────────┘  └───────────────────┘  └───────────────────┘
```

## Current registry

> **Status: Phase 8a in progress (tasks 8.1-8.4 scaffold done iter 54-55;
> 8.10, 8.11 migration-prepared iter 63).**
> Entries below represent tests that have been statically prepared
> for Lite migration — skip markers applied where needed, docstrings
> confirmed oracle-neutral where applicable. Runtime validation
> (actually running under DINA_LITE=docker against Lite containers)
> lands with each test file's target milestone.

| Test file / case | Skip reason | Category | Planned unlock | Notes |
|------------------|-------------|----------|----------------|-------|
| `test_docker_infra.py::TestNetworkIsolation::*` (5 tests) | Go stack has `dina-brain-net` + `dina-pds-net` multi-net topology; Lite compose has single `dina-lite` bridge | `environmental` | M1 + Phase 7/8 Lite network-topology decision | Network isolation is architecturally different between stacks — not a Lite bug |
| `test_docker_infra.py::TestHealthAndLogs::test_pds_healthcheck_endpoint` | Lite compose has no PDS container; connects to external test-pds.dinakernel.com | `environmental` | never — Lite will not ship a PDS sidecar | Documented architectural split; Go stack may also drop local PDS over time |
| `test_docker_infra.py` other PDS-touching tests | Same as above | `environmental` | N/A | — |
| `test_pii_scrubber.py::*` (tasks 8.11 + 8.51) | *(no skips — file is oracle-neutral per docstring)* | — | M1 basic patterns; M5 full | Assertions check PII presence/absence, not Go-specific error prose. Same file covers both task 8.11 "basic patterns" (M1) and 8.51 "full" (M5) — file has no pattern-level vs full-pipeline split; every test is content-agnostic and runs as-is against Lite when M1's `/v1/pii/scrub` + Lite PII scrubber are live. |
| `test_home_node.py::TestLLMRouting::*` | Go's Python router ≠ Lite's `ModelRouter` (task 5.24); different routing scheme | `pending-feature` | Phase 5d router wiring | Re-audit per-test when Lite router lands |
| `test_home_node.py::TestOnlineModeLLMRouting::*` | Go's "online mode" heuristic baked into Python router | `pending-feature` | Phase 5d router wiring | Same as above — Lite's per-task policy is different scheme |
| `test_home_node.py::TestBrainTokenAuth::*` | Go uses pre-shared BRAIN_TOKEN; Lite uses Ed25519 service keys (SLIP-0010) | `environmental` | N/A (different auth mechanisms, both enforce the boundary) | CLAUDE.md §Security Architecture |
| `test_home_node.py::TestAdminUI::*` | Lite's admin-UI form-factor is open task 5.50 (decision pending) | `pending-feature` | task 5.50 resolution | Not a Lite bug; architectural decision in-flight |
| `test_home_node.py::TestDevicePairing::*` | Lite pairing uses CLI-initiated flow (task 7.33 pending); Go uses 6-digit-code + admin UI | `pending-route` | task 7.33 (MsgBox brain-server round-trip) | Different UX + transport; both valid |
| `test_home_node.py::TestOnboarding::*` | Lite's install-lite.sh is CLI-interactive, different from Go's managed onboarding | `pending-feature` | Phase 5 brain-server finish | Onboarding flow diverges architecturally |
| `test_home_node.py::TestBrainLocalLLM::*` | Go uses llama-server subprocess; Lite uses node-llama-cpp peer-dep (task 5.29) | `pending-feature` | task 5.29 integration tests | Different integration layer |
| `test_home_node.py::TestCloudLLMRateLimited::*` | Go's rate-limit logic is Python-router-specific; Lite uses `TokenLedger` (task 5.28) | `pending-feature` | Phase 5d router | Not direct 1:1 mapping |
| `test_dina_to_dina.py::TestSanchoArrival::*` | Whisper-assembly + silence-tiers land with M2 persona model (tasks 8.13-8.18) | `pending-feature` | M2 | Task 8.9's M1 scope is D2D wire smoke only |
| `test_dina_to_dina.py::TestSellerNegotiation::*` | Depends on Trust Network (M3, task 8.20+) + persona-gating (M2, task 8.13+) | `pending-feature` | M3 | M1 covers wire only |
| `test_dina_to_dina.py::TestSharingPolicyAndEgress::*` | Sharing-tier enforcement needs Lite's `SharingPolicyManager` (M2) + audit WAL (M2) | `pending-feature` | M2 | PII egress works wire-level; the sharing-policy GATE needs M2 |
| `test_ingestion.py::TestFullIngestionPipelines::*` | Requires Brain's `/api/v1/process` + LLM classification (Phase 5c) | `pending-route` | Phase 5c brain-server | M1 smoke doesn't need full pipeline |
| `test_ingestion.py::TestOAuthTokenLifecycle::*` | Go's connector-service OAuth refresh heuristics; Lite uses different model | `pending-feature` | Phase 5 connector work | Different refresh semantics; not a Lite bug |
| `test_memory_flows.py::TestPrivateRecall::*` | Requires `/api/v1/reason` LLM-driven recall (Phase 5c) | `pending-route` | Phase 5c brain-server | Pure vault CRUD covered elsewhere; this file tests LLM-assisted recall |
| `test_memory_flows.py::TestMemoryIngestion::*` | Requires connector→`/api/v1/process`→vault pipeline (Phase 5c) | `pending-route` | Phase 5c brain-server | Vault-store + FTS retrieval work wire-level; this class tests the full LLM pipeline |
| `test_didcomm.py::TestSharingRules::*` | Per-contact sharing rules need Lite's `SharingPolicyManager` (M2) + persona-tier gating | `pending-feature` | M2 | Wire-level DIDComm (TestConnectionEstablishment, TestMessageTypes) is M1-compatible and unmarked |
| `test_persona_tiers.py::*` (file-level) | The 4-tier persona model is the M2 gate (tasks 8.13-8.18) | `pending-feature` | M2 | Whole file skipped via pytestmark; Lite's sensitive/locked tier landing with Phase 5+ |
| `test_personas.py::*` (file-level) | Persona compartments (creation / isolation / auto-selection) all depend on M2 persona subsystem | `pending-feature` | M2 | File-level skip — every test exercises the persona state machine, not just vault CRUD |
| `test_storage_tiers.py::TestTier4Staging::*` | Tier-4 staging (drafts, payment intents, auto-expire) is M2 scope | `pending-feature` | M2 | Lite's staging subsystem lands Phase 5+ |
| `test_storage_tiers.py::TestTier5DeepArchive::*` | Tier-5 immutable snapshots + right-to-delete is M4 chaos/recovery scope | `pending-feature` | M4 | Archive subsystem not yet in Lite |
| `test_storage_tiers.py::TestStagingAreaLifecycle::*` | Draft→claimed→resolved lifecycle is M2 staging | `pending-feature` | M2 | Same arch dependency as TestTier4Staging |
| `test_tiered_content.py::*` (file-level) | L0/L1/L2 PATCH-enrich flow needs Brain's `/api/v1/process` + embedding service (Phase 5c) | `pending-route` | Phase 5c | Storage primitives (FTS5 + HNSW) already in Lite; Brain route pipelines missing |
| `test_audit.py::*` (file-level) | Persistent audit trail (append-only WAL, hash chain, per-persona partitioning) is M2 scope | `pending-feature` | M2 | Lite's audit subsystem lands with Phase 5+ |
| `test_security.py::TestPersonaIsolation::*` | Cryptographic persona-DEK isolation is the M2 gate | `pending-feature` | M2 | HKDF per-compartment derivation lands with Phase 5+ |
| `test_security.py::TestMultiUserIsolation::*` | Multi-user per-database is Go's `--instance` mode; Lite is single-tenant | `pending-feature` | Phase 13 operator journey (task 9.16) | Not a Lite M1-M5 concern |
| `test_trust_network.py::*` (file-level) | Trust Network (attestations, outcomes, bot trust, AT Protocol publishing) is the M3 gate | `pending-feature` | M3 | Lite trust-scorer + AppView integration land with Phase 5+ |
| `test_trust_rings.py::*` (file-level) | Trust rings + composite trust function — M3 scope | `pending-feature` | M3 | Entire file exercises the ring model |
| `test_ws2_service_query.py::*` (file-level) | WS2 service-query workflow (M3 hero scenario per README BusDriver demo) | `pending-feature` | M3 | Requires Lite's WS2 brain-side routes (Phase 5+) |
| `test_source_trust.py::*` (file-level) | Source trust + provenance + retrieval-policy filtering — M3 scope | `pending-feature` | M3 | Lite's provenance subsystem lands with Phase 5+ |
| `test_open_economy.py::*` (file-level) | Open economy protocol (D2D transactions + plugin economy + multi-party) — M3 scope | `pending-feature` | M3 | Depends on trust rings + cart handover (task 8.25) |
| `test_cart_handover.py::*` (file-level) | Cart handover (staging-tier draft → trust-gated cart → human completes) — M3 scope | `pending-feature` | M3 | Depends on M2 staging + M3 trust rings |
| `test_deep_links.py::*` (file-level) | Deep-link source attribution (creator credit, timestamped source, sponsored-vs-authentic ranking) — M3 scope | `pending-feature` | M3 | Depends on M3 attestation pipeline |
| `test_chaos.py::*` (file-level) | Chaos engineering (failure injection, graceful degradation) — M4 scope | `pending-feature` | M4 | probe-ws-reconnect.sh (task 11.10) is the Lite-side chaos infrastructure |
| `test_crash_recovery.py::*` (file-level) | Crash recovery (Core/Brain/LLM/power-loss) — M4 scope | `pending-feature` | M4 | soak-runner.sh (task 11.7) is the harness for Lite when M4 features land |
| `test_migration.py::*` (file-level) | Intra-Lite migration (schema bumps, export/import, device re-pairing) — M4 scope | `pending-feature` | M4 | User-story 08 "Move to new machine"; NOT Go→Lite migration (that's explicitly unsupported per lite-adoption-gate.md) |
| `test_performance.py::*` (file-level) | Go-stack's own perf tests; Lite perf gates live in probe suite (tasks 11.1-11.10) | `pending-feature` | M4 | Native Lite probes supersede — probe-throughput.py / probe-ask-latency-vs-go.py / soak-runner.sh / benchmark.sh |
| `test_client_sync.py::*` (file-level) | Client device sync (rich + thin + QR onboarding) — M4 scope | `pending-feature` | M4 | Lands with Phase 5+ + Phase 7 pairing (task 7.33) |
| `test_compliance.py::*` (file-level) | Compliance + audit + data-subject rights — M5 scope | `pending-feature` | M5 | Consent tracking + erasure + portability subsystems land with M5 |
| `test_arch_validation.py::*` (file-level) | Architecture-validation HIGH severity gaps (SSS shards, export encryption, bot-query sanitization, STT routing) — M5 scope | `pending-feature` | M5 | Module-level test functions (no classes); file-level pytestmark applies to all |
| `test_anti_her.py::*` (file-level) | Anti-Her safeguards (emotional-dependency detection, connection nudges, emotional boundary) — Four Laws enforcement at M5 | `pending-feature` | M5 | Depends on silence-classifier (task 8.48) + whisper (8.50) |
| `test_contract_wire_format.py::*` (file-level) | Python Brain's Pydantic wire-compat with Go Core; Lite wire-compat lives in `@dina/protocol` conformance vectors | `pending-feature` | M5 | Running against Lite would mix stacks — `npm run conformance` is the Lite wire gate |
| `test_safety_layer.py::*` (file-level) | Safety layer (agent intent risk classifier + revocation + persona access) — M5 scope | `pending-feature` | M5 | Depends on M2 staging + M2 audit + M3 trust rings |
| `test_arch_medium_1.py::*` (file-level) | Arch validation MEDIUM severity gaps M1-M30 (dead-drop, service-auth, HKDF, hybrid search, ...) — M5 scope | `pending-feature` | M5 | Grab-bag of subsystem invariants |
| `test_agency.py::*` (file-level) | User-agency protection (impulse + manipulation + dead-internet filter) — M5 scope | `pending-feature` | M5 | Depends on emotional-state classifier + M3 bot-trust |
| `test_arch_medium_2.py::*` (file-level) | Arch validation MEDIUM severity gaps M31-M60 — M5 scope | `pending-feature` | M5 | Pair of arch_medium_1 |
| `test_arch_medium_3.py::*` (file-level) | Arch validation remaining gaps TST-INT-665 through 690 — M5 scope | `pending-feature` | M5 | Closes arch_validation trio (8.35 + 8.36 + 8.37 + 8.38) |
| `test_async_approval.py::*` (file-level) | Async approve-wait-resume flow — M5 scope | `pending-feature` | M5 | Ask-registry primitive done (tasks 5.19+5.20); HTTP wiring pending Phase 5+ |
| `test_delegation.py::*` (file-level) | Task delegation to external agents with oversight — M5 scope | `pending-feature` | M5 | Depends on M2 staging + safety-layer (task 8.47) |
| `test_digital_estate.py::*` (file-level) | Digital estate (SSS custodian recovery, beneficiary access, destruction gating) — M5 scope | `pending-feature` | M5 | SSS arch invariants already in task 8.35 |
| `test_draft_dont_send.py::*` (file-level) | Draft-Don't-Send protocol (drafts + payment intents in Tier 4 staging, human-approved) — M5 scope | `pending-feature` | M5 | Depends on M2 staging + safety-layer + cart-handover + crash-recovery |
| `test_phase2.py::*` (file-level) | Phase 2+ advanced features (TEE, ingress tiers, Noise forward secrecy, progressive disclosure, 3-layer verification, timestamp anchor, bot protocol, push, deployment profiles) — cross-M5 | `pending-feature` | M5 | 12 classes across many subsystems |
| `test_silence_tiers.py::*` (file-level) | Silence First 3-tier system (Fiduciary / Solicited / Engagement) — M5 scope + Four Laws | `pending-feature` | M5 | Silence-classifier + whisper-assembler land Phase 5+ |
| `test_staging_pipeline.py::*` (file-level) | Staging-ingest pipeline (connector → staging → classify → resolve) — M5 scope | `pending-feature` | M5 | Depends on M2 staging (8.15, 8.18) + Brain classifier |
| `test_whisper.py::*` (file-level) | Whispers (private vault-derived contextual overlay) + disconnect detection — M5 scope | `pending-feature` | M5 | Silence-classifier (8.48) + whisper-assembler |
| `tests/release/test_rel_*.py::*` (directory-level via conftest) | Whole release suite (REL-001 through REL-023+) — Phase 9c release acceptance under DINA_LITE_RELEASE=docker | `pending-feature` | M5 | Applied via `pytest_collection_modifyitems` hook in `tests/release/conftest.py` — covers tasks 9.17 (REL suite blanket skip), 9.18 (`test_rel_008_agent_gateway.py` + `test_rel_023_cli_agent.py` — dummy-agent container compat), 9.19 (`test_rel_023_cli_agent.py` — CLI pairing). Blanket skip until Lite M5 acceptance scenarios land per-test |

## Milestone gates

Per task 8.59, the acceptance criteria:

| Gate | Max allowed skips | Expected categories |
|------|-------------------|---------------------|
| M1 (v0.1.0) | ≤ 10% of suite | `pending-route` dominant |
| M2 (v0.2.0) | ≤ 7% | `pending-feature` dominant (persona tiers, audit) |
| M3 (v0.3.0) | ≤ 5% | `pending-feature` dominant (trust, WS2) |
| M4 (v0.4.0) | ≤ 5% | `environmental` only |
| **M5 (v1.0.0)** | **0** (target) / ≤ 5% acceptable with documented reason | any |

Per task 8.59 the **M5 acceptance bar is 0 skips ideally, ≤ 5% with
an inline reason if pragmatically necessary**. Tightening is always
welcome; the 5% ceiling is what blocks the v1.0.0 tag.

## When adding a new entry

1. Put it in the table alphabetically by test-file name.
2. If the skip applies to all cases in a file, one entry is enough —
   don't enumerate every parametrised case.
3. If more than 5 entries share a category, extract a separate section
   above the main table (e.g. "### Pending brain routes") and
   cross-reference from the main table to keep it scannable.

## Related

- Task 8.53 — per-failing-test classification (picks the category)
- Task 8.54 — go-specific-assertion rewrite path
- Task 8.55 — wire-drift resolution (Go is oracle, fix Lite)
- Task 8.56 — environmental resolution (conftest branch)
- Task 8.57 — error-string-match adjustments registry
  (`LITE_ERROR_STRINGS.md`)
- Task 8.59 — milestone skip percentage acceptance criteria
