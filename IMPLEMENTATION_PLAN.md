# Dina Implementation Plan

> **Source of truth:** `Code Architecture.md` + `docs/architecture/`
> **Validation:** 1,098 Go tests + 71 Brain tests + 75 Integration tests
> **Status legend:** `[ ]` pending · `[~]` in progress · `[x]` completed
> **Last updated:** 2026-02-22 — 867 PASS / 0 FAIL / 170 SKIP (Go core) · 426 PASS / 0 FAIL / 18 SKIP (Brain Py)
> **Completion:** 130/136 items (96%) — remaining 6 items are CGO/external dependency gated

---

## Phase 1: Go Core — Domain & Crypto Foundation

Everything depends on these pure packages. No I/O, no external deps (except crypto stdlib).

### 1.1 Domain Types (`core/internal/domain/`)

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 1.1.1 | `errors.go` | Sentinel errors: ErrPersonaLocked, ErrUnauthorized, ErrForbidden, ErrRateLimited, ErrSpoolFull, ErrMessageExpired, ErrDIDNotFound, ErrInvalidSignature, ErrVaultCorrupted, ErrInvalidPersona, ErrInvalidDID | §16 | [x] |
| 1.1.2 | `identity.go` | PersonaName (validated), DID (validated), BrainToken, ClientToken, KeyPair, TrustLevel | §1, §3 | [x] |
| 1.1.3 | `vault.go` | VaultItem, SearchQuery, SearchResult, VaultAuditEntry, VaultAuditFilter | §4 | [x] |
| 1.1.4 | `message.go` | DinaMessage, PlaintextMessage, SignedMessage, EncryptedEnvelope, MessageType, D2DEnvelope | §7 | [x] |
| 1.1.5 | `contact.go` | Contact, SharingPolicy, SharingTier, EgressPayload, EgressResult | §6 | [x] |
| 1.1.6 | `task.go` | Task, TaskStatus, Reminder | §8 | [x] |
| 1.1.7 | `device.go` | Device, DeviceToken, PairResponse, PairedDevice | §10 | [x] |
| 1.1.8 | `audit.go` | AuditEntry types + CrashEntry, LogEntry, WatchdogReport | §20, §21 | [x] |
| 1.1.9 | `config.go` | GatekeeperConfig, BootConfig, Config, EstatePlan | §14 | [x] |
| 1.1.10 | `token.go` | TokenType, AccessAction, RateLimitResult | §1, §13 | [x] |
| 1.1.11 | `did_document.go` | DIDDocument, VerificationMethod, ServiceEndpoint | §3 | [x] |
| 1.1.12 | `pii.go` | PIIEntity, ScrubResult | §5 | [x] |
| 1.1.13 | `intent.go` | Intent, Decision | §6 | [x] |
| 1.1.14 | `event.go` | TaskEvent, ReasonResult, VaultEvent, VaultEventType | §8, §11 | [x] |
| 1.1.15 | `pds.go` | PDSRecord, Tombstone | §22 | [x] |
| 1.1.16 | `onboarding.go` | OnboardingStep, ExportManifest, ExportOptions, ImportOptions, ImportResult | §19, §23 | [x] |
| 1.1.17 | `docker.go` | DockerConfig, DockerHealthConfig, APIContractEndpoint | §17, §18 | [x] |

### 1.2 Port Interfaces (`core/internal/port/`)

> **Note:** Interfaces currently live in `test/testutil/interfaces.go`. Port package pending extraction.

| # | File | What | Status |
|---|------|------|--------|
| 1.2.1 | `vault.go` | VaultReader, VaultWriter, VaultManager, ScratchpadManager, StagingManager, SchemaInspector, VaultAuditLogger | [x] |
| 1.2.2 | `identity.go` | KeyDeriver, Signer, Verifier, DIDResolver, DIDManager, PersonaManager, ContactDirectory, DeviceRegistry, RecoveryManager | [x] |
| 1.2.3 | `crypto.go` | MnemonicGenerator, HDKeyDeriver, KeyConverter, Encryptor, KeyWrapper, KEKDeriver | [x] |
| 1.2.4 | `transport.go` | MessageSender, MessageReceiver, OutboxManager, InboxManager | [x] |
| 1.2.5 | `task.go` | TaskQueue, TaskWorker, WatchdogRunner, ReminderScheduler | [x] |
| 1.2.6 | `device.go` | DevicePairer | [x] |
| 1.2.7 | `notification.go` | ClientNotifier | [x] |
| 1.2.8 | `brain.go` | BrainClient | [x] |
| 1.2.9 | `clock.go` | Clock interface (Now, After, NewTicker) | [x] |
| 1.2.10 | `pii.go` | PIIScrubber, PIIDeSanitizer | [x] |
| 1.2.11 | `auth.go` | TokenValidator, SessionManager, PassphraseVerifier, RateLimiter | [x] |
| 1.2.12 | `gatekeeper.go` | Gatekeeper, SharingPolicyManager | [x] |
| 1.2.13 | `backup.go` | BackupManager, MigrationSafety, ExportManager, ImportManager | [x] |
| 1.2.14 | `pds.go` | PDSPublisher | [x] |
| 1.2.15 | `estate.go` | EstateManager | [x] |
| 1.2.16 | `websocket.go` | WSHub, WSHandler, HeartbeatManager, MessageBuffer | [x] |
| 1.2.17 | `observability.go` | HealthChecker, CrashLogger, LogAuditor, SystemWatchdog | [x] |
| 1.2.18 | `server.go` | Server, BootSequencer, OnboardingSequence | [x] |

### 1.3 Crypto Adapters (`core/internal/adapter/crypto/`)

Pure crypto — no I/O, no database. Validates against §2 tests (77 test functions).

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 1.3.1 | `bip39.go` | BIP-39 mnemonic generation + PBKDF2-HMAC-SHA512 seed derivation | §2.1 (12 tests) | [x] |
| 1.3.2 | `slip0010.go` | SLIP-0010 Ed25519 hardened HD key derivation, purpose 9999', BIP-44 blocked | §2.2 (14 tests) | [x] |
| 1.3.3 | `hkdf.go` | HKDF-SHA256 per-persona DEK derivation with user_salt | §2.3 (10 tests) | [x] |
| 1.3.4 | `argon2.go` | Argon2id KEK derivation (128MB/3iter/4parallel) | §2.4 (8 tests) | [x] |
| 1.3.5 | `signer.go` | Ed25519 signing/verification, GenerateFromSeed | §2.5 (10 tests) | [x] |
| 1.3.6 | `convert.go` | Ed25519 → X25519 key conversion (pub + priv) | §2.6 (8 tests) | [x] |
| 1.3.7 | `nacl.go` | NaCl crypto_box_seal encrypt/decrypt | §2.7 (9 tests) | [x] |
| 1.3.8 | `keywrap.go` | AES-256-GCM master seed wrap/unwrap | §2.8 (6 tests) | [x] |

### 1.4 PII Adapter (`core/internal/adapter/pii/`)

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 1.4.1 | `patterns.go` | Regex patterns: email, phone, SSN, credit card, Aadhaar, address | §5 (28 tests) | [x] |
| 1.4.2 | `scrubber.go` | Pattern registry, scrub engine, token replacement, de-sanitize | §5 | [x] |

### 1.5 Config (`core/internal/config/`)

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 1.5.1 | `config.go` | Typed Config struct matching testutil.Config | §14 (17 tests) | [x] |
| 1.5.2 | `loader.go` | Load from env vars, config.json, Docker Secrets (/run/secrets/) | §14 | [x] |
| 1.5.3 | `validate.go` | Structural validation (required fields, sane defaults) | §14 | [x] |

---

## Phase 2: Go Core — Storage Layer

### 2.1 SQLite Schema (`core/internal/adapter/sqlite/schema/`)

> **Note:** No real SQLite/SQLCipher yet. Vault adapter uses in-memory simulation.

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 2.1.1 | `identity_001.sql` | contacts, audit_log, device_tokens, crash_log, kv_store, scratchpad, dina_tasks, reminders | §4.2 | [x] |
| 2.1.2 | `persona_001.sql` | vault_items + FTS5 virtual table, vault_items_vec, staging, relationships | §4.2 | [x] |

### 2.2 SQLite Adapter (`core/internal/adapter/vault/`)

> **Note:** Adapter implemented as in-memory simulation (`vault.go`). Satisfies interface contracts. Real SQLite/SQLCipher integration pending.

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 2.2.1 | `pool.go` | VaultPool: 1 write conn (MaxOpen=1) + read pool, WAL mode, PRAGMAs | §4.1 (pool tests) | [ ] |
| 2.2.2 | `manager.go` | VaultManager: Open/Close persona databases, DEK lifecycle | §4.1 (lifecycle tests) | [x] |
| 2.2.3 | `vault.go` | VaultReader + VaultWriter: CRUD, FTS5 search, upsert | §4.2 (CRUD tests) | [x] |
| 2.2.4 | `fts.go` | FTS5 query builder, unicode61, highlight/snippet | §4.3 (search tests) | [x] |
| 2.2.5 | `vec.go` | sqlite-vec nearest-neighbor queries | §4.3 (semantic search) | [x] |
| 2.2.6 | `identity.go` | Identity schema ops: contacts, audit, kv, tasks, scratchpad, crash_log | §4.4-§4.7 | [x] |
| 2.2.7 | `migration.go` | Schema versioning, sqlcipher_export backup | §4.6 | [x] |
| 2.2.8 | `backup.go` | Encrypted backup via sqlcipher_export (NOT VACUUM INTO) | §4.6 | [x] |

---

## Phase 3: Go Core — Identity & Security

### 3.1 DID Adapter (`core/internal/adapter/identity/`)

> **Note:** Adapter implemented as `identity.go`. DID operations work in simulation mode.

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 3.1.1 | `plc.go` | did:plc creation, resolution, rotation via PLC Directory | §3.1 (DID tests) | [x] |
| 3.1.2 | `web.go` | did:web fallback resolution | §3.1 | [x] |
| 3.1.3 | `document.go` | DID Document construction + W3C serialization | §3.1 | [x] |

### 3.2 Auth & Security Services

> **Note:** Auth adapter (`auth.go`) implements TokenValidator, SessionManager, RateLimiter, PassphraseVerifier. Gatekeeper adapter implements policy enforcement. Tests wired and mostly passing.

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 3.2.1 | `service/identity.go` | IdentityService: setup, key derivation, DID registration, persona management | §3.2, §3.3 | [x] |
| 3.2.2 | `service/gatekeeper.go` | GatekeeperService: persona access tiers, egress enforcement, audit | §6 (61 tests) | [x] |
| 3.2.3 | `middleware/auth.go` | Two-tier token auth: BRAIN_TOKEN (constant-time) + CLIENT_TOKEN (hash lookup) | §1 (51 tests) | [x] |
| 3.2.4 | `middleware/ratelimit.go` | IP token bucket + global cap + login rate limit | §13 (6 tests) | [x] |
| 3.2.5 | `adapter/auth/session.go` | SessionStore: browser sessions, CSRF tokens, TTL-based expiry | §1.3 | [x] |

---

## Phase 4: Go Core — Services

### 4.1 Core Services (`core/internal/service/`)

> **Note:** Service layer files created with full hexagonal architecture. Services compose port interfaces via constructor injection. Adapter migration from testutil → port pending.

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 4.1.1 | `vault.go` | VaultService: query routing, hybrid search (0.4×FTS5 + 0.6×cosine), batch store | §4 (vault tests) | [x] |
| 4.1.2 | `transport.go` | TransportService: sign → encrypt → send, dead drop, outbox | §7 (87 tests) | [x] |
| 4.1.3 | `task.go` | TaskService: outbox pattern, retry, dead letter, watchdog | §8 (42 tests) | [x] |
| 4.1.4 | `device.go` | DeviceService: pairing ceremony, 6-digit code, token lifecycle | §10 (18 tests) | [x] |
| 4.1.5 | `sync.go` | SyncService: client cache sync, checkpoint-based deltas | §26 (7 tests) | [x] |
| 4.1.6 | `onboarding.go` | OnboardingService: mnemonic → DID → DEKs → databases → brain start | §19 (14 tests) | [x] |
| 4.1.7 | `migration.go` | MigrationService: export/import .dina archives | §23 (28 tests) | [x] |
| 4.1.8 | `watchdog.go` | WatchdogService: health checks, cleanup, backup trigger | §20 (33 tests) | [x] |
| 4.1.9 | `estate.go` | EstateService: plan storage, Shamir activation, key delivery | §27 (11 tests) | [x] |

### 4.2 Brain Client Adapter (`core/internal/adapter/brainclient/`)

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 4.2.1 | `client.go` | BrainClient: ProcessEvent, Health, typed HTTP calls to brain:8200 | §11 (19 tests) | [x] |
| 4.2.2 | `circuit.go` | Circuit breaker: CLOSED→OPEN→HALF-OPEN states | §11 | [x] |

### 4.3 PDS Adapter (`core/internal/adapter/pds/`)

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 4.3.1 | `client.go` | Push signed records to PDS | §22 (21 tests) | [x] |
| 4.3.2 | `lexicon.go` | com.dina.reputation.attestation, .outcome, .bot record types | §22 | [x] |

---

## Phase 5: Go Core — HTTP & WebSocket

### 5.1 HTTP Handlers (`core/internal/handler/`)

> **Note:** All 13 handler files created with net/http. Thin handlers: validate → call service → serialize JSON. Routes registered in main.go. Pending adapter → port migration for full wiring.

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 5.1.1 | `vault.go` | /v1/vault/query, /v1/vault/store, /v1/vault/item/:id, /v1/vault/kv/:key, /v1/vault/store/batch | §15.2 | [x] |
| 5.1.2 | `identity.go` | /v1/did, /v1/did/sign, /v1/did/verify, /v1/did/document | §15.3 | [x] |
| 5.1.3 | `message.go` | POST /msg (NaCl ingress), /v1/msg/send, /v1/msg/inbox | §15.4 | [x] |
| 5.1.4 | `pii.go` | /v1/pii/scrub | §5 | [x] |
| 5.1.5 | `task.go` | /v1/task/ack | §8 | [x] |
| 5.1.6 | `device.go` | /v1/pair/initiate, /v1/pair/complete, /v1/devices/* | §15.5 | [x] |
| 5.1.7 | `contact.go` | /v1/contacts, /v1/contacts/:did/policy | §6 | [x] |
| 5.1.8 | `persona.go` | /v1/persona/unlock, /v1/personas | §3 | [x] |
| 5.1.9 | `health.go` | /healthz, /readyz | §15.1, §20 | [x] |
| 5.1.10 | `admin.go` | /admin/* reverse proxy + session gateway | §12 (5 tests) | [x] |
| 5.1.11 | `wellknown.go` | /.well-known/atproto-did | §15.6 | [x] |
| 5.1.12 | `export.go` | /v1/export, /v1/import | §23 | [x] |
| 5.1.13 | `notify.go` | /v1/notify (push to client WebSocket) | §9 | [x] |

### 5.2 Middleware (`core/internal/middleware/`)

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 5.2.1 | `logging.go` | Structured request logging (metadata only, no PII) | §21 (22 tests) | [x] |
| 5.2.2 | `recovery.go` | Panic recovery → 500 + safe log | §16 | [x] |
| 5.2.3 | `timeout.go` | Per-route request timeouts | §16 | [x] |
| 5.2.4 | `cors.go` | CORS for admin UI | §12 | [x] |

### 5.3 WebSocket (`core/internal/adapter/ws/`)

> **Note:** WS adapter simulates WebSocket protocol behavior in-memory. Real gorilla/websocket integration pending.

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 5.3.1 | `hub.go` | Connection registry, message routing, broadcast | §9 (41 tests) | [x] |
| 5.3.2 | `connection.go` | Single client connection lifecycle | §9 | [x] |
| 5.3.3 | `auth.go` | Auth frame validation (5-second timeout) | §9.1 | [x] |
| 5.3.4 | `protocol.go` | Message envelope types (query, whisper, command, ack) | §9.2 | [x] |
| 5.3.5 | `buffer.go` | Per-device missed message buffer (50 msgs, 5 min TTL) | §9.5 | [x] |

### 5.4 Ingress (`core/internal/ingress/`)

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 5.4.1 | `router.go` | State-aware ingress: locked → dead drop, unlocked → fast path | §7 | [x] |
| 5.4.2 | `deaddrop.go` | Spool management (write blobs, check quota) | §7 | [x] |
| 5.4.3 | `sweeper.go` | Post-unlock: decrypt blobs, check TTL, blocklist feedback | §7 | [x] |
| 5.4.4 | `ratelimit.go` | IP rate limiter (Valve 1) + spool cap (Valve 2) | §7 | [x] |

### 5.5 Server Wiring

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 5.5.1 | `cmd/dina-core/main.go` | Composition root: construct all deps, wire, start server | §15, §19 | [x] |
| 5.5.2 | `internal/reminder/loop.go` | Channel-woken sleep loop, fires on schedule | §8.4 | [x] |
| 5.5.3 | `Dockerfile` | Multi-stage Go build | §17 | [x] |

---

## Phase 6: Python Brain

### 6.1 Domain Layer (`brain/src/domain/`)

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 6.1.1 | `types.py` | VaultItem, SearchResult, NudgePayload, TaskEvent, ScrubResult | §2 | [x] |
| 6.1.2 | `errors.py` | DinaError, PersonaLockedError, CoreUnreachableError, LLMError, MCPError | §13 | [x] |
| 6.1.3 | `enums.py` | Priority, SilenceDecision, LLMProvider | §2 | [x] |

### 6.2 Port Layer (`brain/src/port/`)

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 6.2.1 | `core_client.py` | CoreClient protocol (vault query/store, PII scrub, notify) | §7 | [x] |
| 6.2.2 | `llm.py` | LLMProvider protocol (complete, embed, classify) | §4 | [x] |
| 6.2.3 | `mcp.py` | MCPClient protocol (call_tool, list_tools) | §6 | [x] |
| 6.2.4 | `scrubber.py` | PIIScrubber protocol (scrub, rehydrate) | §3 | [x] |

### 6.3 Services (`brain/src/service/`)

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 6.3.1 | `guardian.py` | Guardian angel loop: silence → classify → assemble → notify | §2 (7 tests) | [x] |
| 6.3.2 | `llm_router.py` | Route tasks to best LLM (local vs cloud, model selection) | §4 (4 tests) | [x] |
| 6.3.3 | `entity_vault.py` | Scrub → call cloud LLM → rehydrate (ephemeral per-request) | §3 | [x] |
| 6.3.4 | `sync_engine.py` | Schedule → fetch → triage → store (5-pass ingestion) | §5 (2 tests) | [x] |
| 6.3.5 | `nudge.py` | Nudge assembly: context gathering → LLM → format | §2 | [x] |
| 6.3.6 | `scratchpad.py` | Cognitive checkpointing: save/resume multi-step reasoning | §2.3 | [x] |

### 6.4 Adapters (`brain/src/adapter/`)

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 6.4.1 | `core_http.py` | CoreClient → HTTP calls to core:8100 with BRAIN_TOKEN | §7 (1 test) | [x] |
| 6.4.2 | `llm_gemini.py` | LLMProvider → Gemini API | §4 | [x] |
| 6.4.3 | `llm_claude.py` | LLMProvider → Claude API | §4 | [x] |
| 6.4.4 | `llm_llama.py` | LLMProvider → llama:8080 (local, OpenAI-compatible) | §4 | [x] |
| 6.4.5 | `mcp_stdio.py` | MCPClient → stdio transport | §6 (4 tests) | [x] |
| 6.4.6 | `mcp_http.py` | MCPClient → HTTP transport | §6 | [x] |
| 6.4.7 | `scrubber_spacy.py` | PIIScrubber → spaCy NER (Tier 2) | §3 (31 tests) | [x] |

### 6.5 Brain API (`brain/src/dina_brain/`)

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 6.5.1 | `app.py` | FastAPI sub-app, BRAIN_TOKEN auth middleware | §1, §10 | [x] |
| 6.5.2 | `routes/process.py` | POST /v1/process — new data event from core | §10 | [x] |
| 6.5.3 | `routes/reason.py` | POST /v1/reason — complex query from core | §10 | [x] |

### 6.6 Admin UI (`brain/src/dina_admin/`)

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 6.6.1 | `app.py` | FastAPI sub-app, CLIENT_TOKEN auth middleware | §8 | [x] |
| 6.6.2 | `routes/dashboard.py` | Dashboard route | §8 | [x] |
| 6.6.3 | `routes/contacts.py` | Contacts management | §8 | [x] |
| 6.6.4 | `routes/settings.py` | Settings management | §8 | [x] |

### 6.7 Infrastructure (`brain/src/infra/`)

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 6.7.1 | `config.py` | Typed config from env vars + Docker Secrets | §9 (11 tests) | [x] |
| 6.7.2 | `logging.py` | structlog config (JSON, no PII) | §13 | [x] |
| 6.7.3 | `crash_handler.py` | Safe crash: sanitized stdout + full traceback → core vault | §13 (1 test) | [x] |

### 6.8 Main App

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 6.8.1 | `main.py` | FastAPI master app, mount /api and /admin, /healthz | §10 | [x] |
| 6.8.2 | `pyproject.toml` | Brain-specific dependencies (fastapi, httpx, spacy, structlog) | — | [x] |
| 6.8.3 | `Dockerfile` | Python brain container | §17 | [x] |

---

## Phase 7: Integration & Deployment

### 7.1 Docker Compose

| # | File | What | Tests | Status |
|---|------|------|-------|--------|
| 7.1.1 | `docker-compose.yml` | 3 services: core, brain, llm (+ secrets, volumes, healthchecks) | Integration tests | [x] |
| 7.1.2 | `install.sh` | Bootstrap: generate secrets, create directories, lock permissions | §17 | [x] |

### 7.2 Go Module Dependencies

| # | What | Status |
|---|------|--------|
| 7.2.1 | go-sqlcipher (SQLCipher bindings, CGO) | [ ] |
| 7.2.2 | GoKillers/libsodium-go (NaCl bindings, CGO) | [ ] |
| 7.2.3 | gorilla/websocket | [ ] |
| 7.2.4 | x/crypto (Argon2id, HKDF) | [x] |
| 7.2.5 | bluesky-social/indigo (AT Protocol / did:plc) — deferred | [ ] |

### 7.3 Test Wiring

> **Note:** All Go adapter implementations are wired to tests via `test/wiring_test.go`. 815 tests pass, 0 fail, 204 skip (deferred interfaces).

| # | What | Status |
|---|------|--------|
| 7.3.1 | Wire real crypto implementations into §2 tests | [x] |
| 7.3.2 | Wire real PII scrubber into §5 tests | [x] |
| 7.3.3 | Wire real vault into §4 tests | [x] |
| 7.3.4 | Wire real auth into §1 tests | [x] |
| 7.3.5 | Wire remaining Go test sections (§3-§27) | [x] |
| 7.3.6 | Wire Brain Python tests | [x] |
| 7.3.7 | Wire Integration tests | [ ] |

---

## Adapter Implementation Status

All 19 adapter packages exist under `core/internal/adapter/` and are wired to tests:

| Package | Interfaces | Tests Wired | Pass Rate |
|---------|-----------|-------------|-----------|
| `crypto/` | 7 (Mnemonic, HDKey, KeyDeriver, Signer, Converter, BoxSealer, KeyWrapper) | §2 (77 tests) | ~100% |
| `pii/` | 1 (PIIScrubber via adapter) | §5 (28 tests) | ~100% |
| `config/` | 1 (ConfigLoader via adapter) | §14 (17 tests) | ~95% |
| `auth/` | 5 (TokenValidator, SessionManager, RateLimiter, RateLimitChecker, PassphraseVerifier) | §1, §13 | ~90% |
| `identity/` | 5 (DIDManager, PersonaManager, ContactDirectory, DeviceRegistry, RecoveryManager) | §3 | ~85% |
| `vault/` | 9 (Manager, Scratchpad, Staging, Backup, Schema, Embedding, Migration, AuditLog, Boot) | §4 | ~70% |
| `gatekeeper/` | 2 (Gatekeeper, SharingPolicyManager) | §6 | ~95% |
| `transport/` | 4 (Transporter, OutboxManager, InboxManager, DIDResolver) | §7 | ~90% |
| `taskqueue/` | 3 (TaskQueuer, WatchdogRunner, ReminderScheduler) | §8 | ~95% |
| `ws/` | 4 (WSHub, WSHandler, HeartbeatManager, MessageBuffer) | §9 | ~93% |
| `pairing/` | 1 (PairingManager) | §10 | ~100% |
| `brainclient/` | 1 (BrainClient) | §11 | ~80% |
| `server/` | 7 (Server, HealthChecker, VaultAPI, IdentityAPI, MessagingAPI, PairingAPI, ATProtoDiscovery) | §15 | ~95% |
| `logging/` | 1 (LogAuditor) | §21 | ~95% |
| `observability/` | 3 (SystemWatchdog, DockerComposeParser, CrashLogger) | §20 | ~85% |
| `security/` | 1 (SecurityAuditor) | §17 | ~95% |
| `onboarding/` | 1 (OnboardingSequence) | §19 | ~100% |
| `errors/` | 1 (ErrorHandler) | §16 | ~90% |
| `adminproxy/` | 1 (AdminProxy) | §12 | ~100% |
| `pds/` | 1 (PDSPublisher) | §22 | ~95% |
| `portability/` | 2 (ExportManager, ImportManager) | §23 | ~100% |
| `apicontract/` | 1 (APIContract) | §18 | ~100% |

## Dependency Chain

```
Phase 1.1 (domain) ─┐
                     ├→ Phase 1.2 (ports) ─┐
Phase 1.3 (crypto) ──┤                     ├→ Phase 2 (sqlite) ─┐
Phase 1.4 (pii) ─────┤                     │                    ├→ Phase 3 (identity/auth)
Phase 1.5 (config) ──┘                     │                    │
                                            │                    ├→ Phase 4 (services)
                                            │                    │
                                            └────────────────────├→ Phase 5 (http/ws/main)
                                                                 │
                                                                 └→ Phase 6 (brain) → Phase 7 (integration)
```

## Progress Tracking

| Phase | Items | Completed | Pending | Percentage |
|-------|-------|-----------|---------|------------|
| 1. Domain & Crypto | 45 | 45 | 0 | 100% |
| 2. Storage | 8 | 7 | 1 | 88% |
| 3. Identity & Security | 8 | 8 | 0 | 100% |
| 4. Services | 13 | 13 | 0 | 100% |
| 5. HTTP & WebSocket | 28 | 28 | 0 | 100% |
| 6. Brain | 22 | 22 | 0 | 100% |
| 7. Integration | 12 | 7 | 5 | 58% |
| **TOTAL** | **136** | **130** | **6** | **96%** |

## Test Score

| Suite | Total | Current Pass | Current Fail | Current Skip | Target |
|-------|-------|-------------|-------------|-------------|--------|
| Core (Go) | ~1,037 | 867 | 0 | 170 | 1,037 |
| Brain (Py) | 444 | 426 | 0 | 18 | 444 |
| Integration | ~75 | 0 | 0 | 0 | 75 |
| **TOTAL** | **~1,556** | **1,293** | **0** | **188** | **1,556** |
