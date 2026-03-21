# TODO

Tracks pending work only. See [ROADMAP.md](ROADMAP.md) for full specs and dependency chains.

---

## Shipped (Developer Alpha)

The following major features have been implemented and tested:

- [x] **Universal staging pipeline** — 4-phase ingestion (CLI, Telegram, D2D, connectors) with provenance tracking
- [x] **Async approval-wait-resume** — intent validation with session-scoped grants
- [x] **Device roles + pairing** — Ed25519 device keys, pairing ceremony, persisted across restarts
- [x] **Trust scoring** — Core queries AppView for trust resolution, integrated with gatekeeper
- [x] **D2D staging** — encrypted messages flow through staging pipeline
- [x] **Vault lockdown** — 4-tier persona access (default/standard/sensitive/locked) with gatekeeper enforcement
- [x] **70+ engineering review fixes** — security hardening, test infrastructure, API contract alignment

---

## Phase 1a — Sidecar Foundation (Cloud LLM)

### Brain (Python)

- [x] **1.1 Cloud API setup** — DONE. Gemini, Anthropic, gemini-embedding-001 configured. LLM router with multi-provider support.
- [ ] **1.3 Port YouTube analysis** — YouTube video analysis as ADK tool
- [ ] **1.4 Port memory search** — vector search + RAG as ADK tools
- [x] **1.2 dina-brain skeleton** — DONE. FastAPI app, guardian loop, silence classification, `/api/v1/process` and `/api/v1/reason` endpoints.
- [x] **1.5 Silence filter** — DONE. Three-priority classification (Fiduciary/Solicited/Engagement) with heuristic + LLM fallback.
- [x] **1.6 LLM routing** — DONE. Multi-provider (Gemini, Anthropic, local), Entity Vault scrubbing for sensitive personas.
- [x] **1.7 dina-core skeleton** — DONE. Go + net/http, SQLCipher vaults, vault/store/query, hybrid search (FTS5 + HNSW).
- [x] **1.8 DID key management** — DONE. BIP-39, SLIP-0010, HKDF vault DEKs, Ed25519 signing, persona unlock with TTL.
- [x] **1.9 PII scrubber** — DONE. 3-tier: regex (Go) + spaCy NER (Python) + Entity Vault pattern.
- [x] **1.10a Gatekeeper auth** — DONE. Ed25519 service keys, device keys, static allowlists, 4-tier persona access.
- [x] **1.10b Admin UI** — DONE. FastAPI admin at `/admin/*`, dashboard, settings, contacts, devices, chat, history.
- [x] **1.10c Task queue + scratchpad** — DONE. Outbox pattern in `dina_tasks`, staging scratchpad.

### Infrastructure

- [x] **1.10 docker-compose** — DONE. Core + Brain containers, healthchecks, service key provisioning, E2E and release compose files.

---

## Phase 1b — Guardian Angel Loop

### Brain (Python)

- [x] **1.15 Context assembly for nudges** — DONE. Brain queries vault for relationships/history, assembles nudge text.
- [x] **1.16 Nudge delivery (WebSocket)** — DONE. Core pushes nudges via WebSocket, `/v1/notify` endpoint.

### Dina-to-Dina

- [x] **1.17 Encrypted messaging + Dead Drop** — DONE. NaCl encryption, dead-drop spool, sweeper, rate limiting all working.
- [x] **1.17a Rate limiting** — DONE. IP token bucket, per-DID limits, spool cap, circuit breaker.
- [-] **1.19 Basic D2D messaging** — NaCl encryption + delivery working; signature verification + inbox persistence are stubs — see [D2D Pipeline Gaps](#d2d-pipeline-gaps)
- [ ] **1.19a NAT relay** — ~100 lines, forwards encrypted blobs, community-run

---

## Phase 1c — Safety & Persistence

- [x] **1.22a Migration CLI (export/import)** — DONE. `POST /v1/export` and `POST /v1/import` endpoints, AES-256-GCM encrypted archives.
- [x] **1.23 BIP-39 recovery** — DONE. 24-word mnemonic generation and restore.
- [x] **1.24 Persona system** — DONE. Per-persona SQLCipher files, HKDF-derived DEKs, 4-tier access (default/standard/sensitive/locked), audit log.
- [x] **1.29 Client authentication** — DONE. Ed25519 device pairing (initiate/complete), per-device revocable keys, persisted across restarts.
- [-] **1.22 Off-site backup** — encrypted vault snapshots to S3/Backblaze — encryption covered in Go §4 Vault; actual S3/Backblaze integration not done
- [ ] **1.29a Supply chain security** — pin digests day one, Cosign + SBOM when CI exists (see [SECURITY.md](SECURITY.md))

---

## Prompt Injection Defense (7-Layer Implementation)

**Architecture:** fully documented in [`docs/architecture/19-prompt-injection-defense.md`](docs/architecture/19-prompt-injection-defense.md). Layer 2 (Split Brain boundary) and Layer 6 (Egress Gatekeeper) are partially implemented. PII scrubbing (3-tier) and Entity Vault pattern provide defense-in-depth. Remaining layers (1,3,4,5,7) are not yet built.

**Principle:** You cannot prevent prompt injection — you contain the blast radius.

### Brain-side (Python)

- [ ] **Layer 1 Input: LLM input screening** — lightweight LLM classifier for common injection patterns. Fails open if LLM unavailable
- [ ] **Layer 1 Output: Schema validation** — structural Python code validates LLM output per stage. Quarantine on anomalous output
- [ ] **Layer 3: Tool isolation per stage** — per-stage tool allowlists, fresh LLM context per stage (context wipe), `ToolNotAllowedError`
- [ ] **Layer 4: MCP tool allowlist** — hardcoded `ALLOWED_MCP_TOOLS = {fetch_emails, fetch_calendar, web_search}`

### Core-side (Go)

- [-] **Layer 2: Split Brain serialization boundary** — Core validates structured fields (enum type, int tier 1-5, 200-char PII-scrubbed summary). Separate BRAIN_TOKENs — token scoping + field validation done; split into inbound/outbound containers not yet done
- [ ] **Layer 5: Vault query limits** — max 10 results, summaries only default, rate limiting per Brain token
- [-] **Layer 6: Egress Gatekeeper** — spaCy NER category classification, sharing policy, intent signal (`user_directed` vs `autonomous`) — sharing policy + egress done; spaCy classification + intent signal not yet wired

### Phase 2 Only

- [ ] **Layer 7: Dual-LLM validation** — two providers classify independently for health/financial personas

---

## Phase 1.5 — Client & Managed Hosting

- [ ] **1.30 Android client** — Kotlin + Jetpack Compose, WebSocket to Home Node
- [ ] **1.31 Android local cache** — SQLite, offline search, checkpoint sync
- [ ] **1.32 Android on-device LLM** — LiteRT-LM + Gemma 3n E2B
- [-] **1.33 Managed hosting** — multi-tenant, email signup + Gmail connect, billing
- [ ] **1.34 FunctionGemma 270M** — ultra-lightweight intent classification
- [x] **1.35 Telegram connector** — DONE. Bot API via long polling, messages ingested through universal staging pipeline.
- [ ] **1.37 Daily briefing** — end-of-day summary of Priority 3 (Engagement) items
- [ ] **1.38 Push notifications** — FCM/APNs, payload contains NO data
- [-] **1.39 Security hardening** — container updates, rate limiting audit, attack surface review

---

## Phase 2 — Intelligence & Trust

### Intelligence

- [x] **2.1 Embedding generation** — DONE. gemini-embedding-001 (768-dim), stored as BLOBs in SQLCipher, hydrated into HNSW in-memory index.
- [x] **2.2 Tier 2 Index** — DONE. HNSW in-memory (coder/hnsw) + FTS5 hybrid search: `0.4 x FTS5 + 0.6 x cosine`.
- [ ] **2.6 Fine-tuned PII model** — Gemma 3n E4B for higher accuracy
- [ ] **2.7 Multi-agent orchestration** — Google ADK Sequential/Parallel/Loop agents
- [ ] **2.15 Nomic Embed V2** — 475M MoE upgrade

### Trust

- [x] **2.3 Trust AppView** — DONE. TypeScript + PostgreSQL, Jetstream firehose consumer, 19 record type handlers, 9 scorer jobs, 5 xRPC endpoints (resolve, search, get-profile, get-attestations, get-graph). **AppView is for trust only** — D2D messaging is direct P2P.
- [ ] **2.4 Outcome data collection** — track Cart Handover purchases, follow-up surveys
- [ ] **2.5 Trust Rings (Ring 1-2)** — ZKP or Aadhaar e-KYC compromise

### Behavioral

- [ ] **2.8 Emotional state awareness** — classifier for upset/impulsive states, cooling-off
- [x] **2.9 Anti-Her safeguard** — DONE. Guardian detects loneliness/isolation patterns, nudges toward human connection.
- [ ] **2.10 Bot discovery** — decentralized via Trust Network

### Infrastructure

- [ ] **2.12 Desktop client** — Wails/Tauri
- [ ] **2.13 Tier 5 Deep Archive** — S3 Glacier + Compliance Mode Object Lock
- [ ] **2.14 UnifiedPush** — de-Googled push relay
- [ ] **2.16 Confidential Computing** — AWS Nitro / AMD SEV-SNP
- [ ] **2.17 Local LLM profile** — llama container, Gemma 3n E4B, 8GB minimum
- [ ] **2.18 CalDAV connector** — non-Google calendar support
- [ ] **2.19 DIDComm v2 JWE** — ECDH-1PU+A256KW wire upgrade
- [ ] **2.21 Key management UX** — social recovery, YubiKey/Ledger backup

---

## Phase 3 — Open Economy & Scale

- [ ] **3.1 Trust Rings (Ring 3+)** — LinkedIn/GitHub credentials, composite trust scores
- [ ] **3.2 Content verification (C2PA)** — media provenance
- [ ] **3.3 Social Radar** — real-time co-pilot from camera/mic
- [ ] **3.4 Open Economy (ONDC + UPI)** — D2D negotiation, zero middlemen
- [ ] **3.5 Expert Bridge** — structured expert knowledge, attribution + economics
- [ ] **3.6 Direct value exchange** — creators earn from reviews, micropayments
- [ ] **3.7 iOS client** — Swift + SwiftUI
- [ ] **3.8 Thin clients** — glasses, watch, browser via WebSocket
- [ ] **3.9 Foundation formation** — nonprofit, certified hosting partners
- [ ] **3.10 Full D2D commerce** — buyer ↔ seller negotiation, trust, delivery
- [ ] **3.11 Timestamp anchoring** — Merkle root on L2 chain
- [ ] **3.12 Noise XX sessions** — full forward secrecy
- [ ] **3.13 AppView sharded cluster** — Kafka, ScyllaDB, Kubernetes for 10M+ users
- [ ] **3.14 AppView verification** — cryptographic proof + consensus + PDS spot-check

---

## D2D Pipeline Gaps

NaCl encryption works E2E (Docker tests assert real decryption at `real_d2d.py:153`). These are the remaining gaps:

- [ ] **Wire Ed25519 signature into envelope** — `_ = sig` at `transport.go:131` discards the computed signature. Send it alongside the ciphertext so recipient can verify sender
- [ ] **Implement signature verification on receive** — `transport.go:222-244` resolves sender's DID but never verifies. Wire `ed25519.Verify()` after decryption
- [ ] **Persist inbox to SQLite** — currently in-memory Go slice, lost on restart
- [ ] **Implement outbox retry delivery** — `ProcessOutbox()` is a stub that counts. Wire actual re-delivery with exponential backoff
- [ ] **Complete dead-drop sweeper** — `sweeper.go` reads blobs but doesn't decrypt. Wire NaCl unseal + signature verify on vault unlock
- [ ] **PLC Directory client** — replace `DINA_KNOWN_PEERS` env var with real PLC Directory lookup. DID resolver interface already abstracted (`transport.DIDResolver`)

---

## AT Protocol Routing

**AppView + Relay are for the Trust Network (Layer 3) only.** D2D messaging (Layer 4) is direct P2P — no relay, no AppView, no firehose. See [`docs/architecture/09-layer4-dina-to-dina.md`](docs/architecture/09-layer4-dina-to-dina.md).

- [ ] **PLC Directory integration** — resolve DIDs dynamically instead of hardcoded `DINA_KNOWN_PEERS`
- [x] **Trust AppView** — DONE. TypeScript + PostgreSQL, Jetstream consumer for attestations/bot scores, 5 xRPC endpoints
- [ ] **DID document dual service** — advertise both `AtprotoPersonalDataServer` (trust PDS) and `DinaMessaging` (direct D2D endpoint)

---

## Notes

Things in ARCHITECTURE.md that the Code Architecture misses or underspecifies:

**1. CSRF protection on admin UI.** The spec (line 753) explicitly calls out a per-session CSRF token: "Core generates a CSRF token per session, injected as X-CSRF-Token header. Admin UI embeds it in forms." My `handler/admin.go` mentions "session gateway" but never mentions CSRF. This needs a dedicated middleware or inclusion in the session handling — it's a security boundary, not optional.

**2. The two-pass ingestion triage protocol.** The spec describes a specific multi-stage pipeline: Gmail category filter (kills 60-70%), regex pre-filter on sender/subject patterns, then LLM batch classification of 50 subjects per call at $0.003/year. My `sync_engine.py` references a `TriageClassifier` but doesn't capture this layered architecture. The triage deserves its own service or at minimum a clearly defined pipeline in the sync engine — it's not a single classify call, it's three cascading filters.

**3. OpenClaw health state machine.** The spec defines HEALTHY → DEGRADED → OFFLINE states with specific transition rules (3 consecutive failures trigger OFFLINE). My code architecture has no mention of connector health monitoring. This should be a first-class concept in the brain's service layer, likely in `sync_engine.py` or a dedicated `connector_health.py`.

**4. The `include_content: false` default on vault queries.** The spec makes this a deliberate security design — brain gets summaries only by default, must explicitly opt into raw `body_text`. My port interface for `VaultReader.Query()` doesn't capture this flag. This matters because it's the safe-path default that prevents brain from accidentally leaking raw content to cloud LLMs.

**5. Hybrid search mode with scoring formula.** The spec defines three query modes (fts5/semantic/hybrid) with a specific blend: `0.4 × fts5_rank + 0.6 × cosine_similarity`. My code architecture separates `Query()` and `VectorSearch()` as independent methods. The hybrid merge and scoring should be in `service/vault.go`, not left to the caller.

**6. `POST /v1/vault/crash` endpoint.** The spec has a dedicated endpoint for brain to store sanitized crash tracebacks encrypted in the vault. My handler list doesn't include it. This is how crash tracebacks stay out of stdout (PII risk) and go into encrypted storage instead.

**7. KV store endpoints for sync cursors.** The spec shows `PUT /v1/vault/kv/gmail_cursor` as the mechanism for brain to persist sync state. My code architecture doesn't have an explicit KV handler. This should be either a separate handler or part of `handler/vault.go` with a `/v1/vault/kv/:key` route.

**8. Pass-through search for cold archive.** The spec describes a specific protocol where vault queries that miss locally trigger a fallback to the provider API via MCP (e.g., "Search Gmail directly for older emails"). The user is explicitly warned that the search query is visible to Google. My sync engine doesn't model this two-zone (Living Self / Archive) query strategy.

**9. Daily briefing for silent items.** The spec says Priority 3 items are queued for a daily briefing summary. My guardian loop mentions silence classification but doesn't model the briefing assembly as a distinct scheduled operation.

**10. Export/Import as CLI commands, not HTTP.** The spec uses `docker exec dina-core dina export`, implying a CLI subcommand. My `handler/export.go` suggests HTTP endpoints. The spec's approach is better — export/import are admin operations that shouldn't be exposed over the network. This means the Go binary needs a `cmd/dina-core/main.go` that dispatches to either `serve` (HTTP) or `export`/`import` (CLI) based on arguments.

---

Things in the Code Architecture that aren't in the spec (additions):

**1. `port/clock.go` — Clock interface for deterministic testing.** The spec doesn't mention this but it's essential for testable reminder loops, task timeouts, TTL checks, and session expiry. Correct addition.

**2. Circuit breaker on brain client.** The spec describes brain crash recovery via the outbox pattern but doesn't explicitly name a circuit breaker. I added `adapter/brain/circuit.go`. This is a correct architectural decision — without it, a dead brain causes core to hang on HTTP calls.

**3. Channel-based reminder wake.** The spec's reminder loop uses `time.Sleep()`. I added a channel-based wake mechanism (from my architecture review Issue #4). This fixes the bug where newly added reminders are missed while sleeping. Correct improvement.

**4. Vault state Observer pattern.** The spec describes the sweeper waking on vault unlock but doesn't formalize it as an observer/channel pattern. I made it explicit with `VaultEvent` and channel subscriptions. Correct — makes the decoupling explicit instead of implicit.

**5. Sealed Envelope type progression.** The spec describes sign-then-encrypt but doesn't formalize it as `PlaintextMessage → SignedMessage → EncryptedEnvelope` type safety. I added this to prevent cryptographic ordering bugs at the type level. Correct addition.

**6. Memory zeroing on shutdown.** The spec mentions key wrapping but not explicit memory zeroing of DEKs on shutdown. I added `zeroBytes()`. Correct for a security-critical system.

**7. Typed log fields.** The spec says "no PII in logs" and describes CI linters. I went further with typed `LogField` structs that prevent arbitrary string logging. More restrictive than the spec but aligned with its intent.

**8. Global Argon2id concurrency cap.** From my architecture review (Issue #3). The spec only has per-IP rate limiting on login. I added a system-wide cap to prevent memory DoS. Correct improvement.

---

One structural divergence:

The spec shows brain calling core's PII scrubber (`POST /v1/pii/scrub`) for Tier 1, then running spaCy locally (Tier 2), then optionally calling llama (Tier 3). My code architecture models this as a `ScrubberChain` (Chain of Responsibility) which is the right abstraction, but the chain hides the fact that Tier 1 is a **network call to core** while Tiers 2 and 3 are **local to brain**. The Entity Vault service needs to make this split explicit — it's not a uniform chain, it's a cross-container call followed by local processing.

---

Bottom line: The code architecture is faithful to the spec in structure and intent. The 10 gaps are mostly missing endpoints and protocol details that exist in the spec but I didn't surface in the handler/service layer. The 8 additions are all defensible improvements. The one structural issue (PII chain hiding the network boundary) is worth fixing before implementation. None of these are design conflicts — they're gaps to fill.


Dina to Dina

  ┌─────────────────────────────┬────────────────────────┬───────────────────────────────────────────────┐
  │            Step             │         Status         │                    Detail                     │
  ├─────────────────────────────┼────────────────────────┼───────────────────────────────────────────────┤
  │ DID → public key resolution │ Working                │ Pre-cached via DINA_KNOWN_PEERS env var       │
  ├─────────────────────────────┼────────────────────────┼───────────────────────────────────────────────┤
  │ Ed25519 → X25519 conversion │ Working                │ Real curve math, both directions              │
  ├─────────────────────────────┼────────────────────────┼───────────────────────────────────────────────┤
  │ Ed25519 signing             │ Computed but discarded │ _ = sig — never sent to recipient             │
  ├─────────────────────────────┼────────────────────────┼───────────────────────────────────────────────┤
  │ NaCl sealed box encryption  │ Working                │ Real crypto/nacl/box.Seal with ephemeral keys │
  ├─────────────────────────────┼────────────────────────┼───────────────────────────────────────────────┤
  │ HTTP delivery to recipient  │ Working                │ POST raw ciphertext to /msg                   │
  ├─────────────────────────────┼────────────────────────┼───────────────────────────────────────────────┤
  │ NaCl decryption             │ Working                │ Real crypto/nacl/box.OpenAnonymous            │
  ├─────────────────────────────┼────────────────────────┼───────────────────────────────────────────────┤
  │ Signature verification      │ Stub                   │ Resolves sender's DID but never verifies sig  │
  ├─────────────────────────────┼────────────────────────┼───────────────────────────────────────────────┤
  │ Inbox persistence           │ In-memory only         │ Lost on restart                               │
  ├─────────────────────────────┼────────────────────────┼───────────────────────────────────────────────┤
  │ Outbox retry                │ Stub                   │ Queue exists but ProcessOutbox() just counts  │
  └─────────────────────────────┴────────────────────────┴───────────────────────────────────────────────┘


  The gaps: signing is computed but thrown away (so the recipient can't verify who sent it), and both inbox and outbox are in-memory (lost on restart). The E2E test at real_d2d.py:153 that asserts "inbox count
  went up" is validating that real NaCl decryption succeeded — that part is solid.
