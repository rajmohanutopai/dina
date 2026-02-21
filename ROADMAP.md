# Build Roadmap

Extracted from [ARCHITECTURE.md](ARCHITECTURE.md). Every item is sequenced by dependency — you can't build later items without earlier ones. Items within the same phase can be built in parallel.

**Status key:** `NOT STARTED` · `IN PROGRESS` · `DONE` · `DEFERRED` · `BLOCKED`

---

## Current State (v0.4) → Target Architecture

v0.4 is a monolithic Python application. The target is the 3+1 container sidecar architecture (core, brain, pds always-on; llama optional via `--profile local-llm`). The migration is incremental:

1. **Phase 1a:** Extract agent reasoning from v0.4 into dina-brain (Google ADK). YouTube analysis, memory search, RAG become ADK tools.
2. **Phase 1b (parallel):** Build dina-core in Go. SQLite vault, DID key management, internal API.
3. **Phase 1c:** Wire together. Safety gates, backup, bot protocol.
4. **Phase 1.5:** Android client, managed hosting, Telegram ingestion.
5. **v0.4 retirement:** Once sidecar handles everything, monolith deprecated.

---

## Done (v0.4)

| # | Item | Layer | What It Is | Status |
|---|------|-------|-----------|--------|
| 0.1 | YouTube review analysis | L5 Bot Interface | Gemini video analysis → structured BUY/WAIT/AVOID verdict | DONE |
| 0.2 | Semantic memory (vector DB) | L1 Storage | Local vector store at `~/.dina/memory/`, persists across sessions | DONE |
| 0.3 | RAG-powered Q&A | L6 Intelligence | Natural language questions → memory search → contextual answer | DONE |
| 0.4 | Cryptographic signing | L0 Identity | Ed25519 signature on every verdict, `/verify` command | DONE |
| 0.5 | Self-sovereign identity | L0 Identity | did:key (pure Python) + did:plc (target) | DONE |
| 0.6 | Ceramic dual-write | L1 Storage | Verdicts written to Ceramic Network when configured | DONE |
| 0.7 | Multi-provider LLM routing | L6 Intelligence | Ollama (local) + Gemini (cloud), configurable | DONE |
| 0.8 | REPL interface | Human Interface | `/history`, `/search`, `/identity`, `/verify`, `/vault`, `/quit` | DONE |

---

## Phase 1a — Sidecar Foundation

**Goal:** Get the 3-container Cloud LLM profile running (core, brain, pds). Brain thinks (via Gemini Flash Lite + Deepgram), core stores, PDS hosts reputation data. Phase 1 uses cloud LLMs only — Local LLM profile ships in Phase 2 once end-to-end flow works.

| # | Item | Layer | What It Is | Depends On | Container | Status |
|---|------|-------|-----------|-----------|-----------|--------|
| 1.1 | Cloud API setup | Infra | Configure Gemini 2.5 Flash Lite API key (text LLM), Deepgram Nova-3 API key (voice STT), `gemini-embedding-001` (embeddings). Brain's LLM router calls cloud APIs in Cloud LLM profile (default). | — | Cloud APIs | NOT STARTED |
| 1.2 | dina-brain skeleton | L6 Intelligence | Python + Google ADK, basic agent loop, `/v1/process` and `/v1/reason` endpoints on port 8200. LLM router calls Gemini Flash Lite for text, Deepgram WebSocket for voice STT. | 1.1 | dina-brain | NOT STARTED |
| 1.3 | Port YouTube analysis to ADK tool | L5 Bot Interface | YouTube video analysis as a Google ADK tool callable by the agent loop | 1.2 | dina-brain | NOT STARTED |
| 1.4 | Port memory search to ADK tool | L6 Intelligence | Vector search + RAG as ADK tools | 1.2 | dina-brain | NOT STARTED |
| 1.5 | Silence filter (basic) | L6 Intelligence | Three-priority classification (Fiduciary / Solicited / Engagement) using Gemini Flash Lite | 1.2, 1.1 | dina-brain | NOT STARTED |
| 1.6 | LLM routing in brain | L6 Intelligence | Simple → Flash Lite, Complex → Flash/Pro/Claude, Voice → Deepgram STT. Sensitive personas → llama if available (best privacy), otherwise Entity Vault scrubbing (Tier 1+2 mandatory) then cloud LLM. Cloud sees topics, not identities. | 1.1, 1.2 | dina-brain | NOT STARTED |
| 1.7 | dina-core skeleton | L1 Storage | Go + net/http server on port 8100. SQLCipher vaults (`mutecomm/go-sqlcipher` with CGO): `identity.sqlite` (Tier 0: contacts, sharing policy, audit log, kv_store) + `personal.sqlite` (Phase 1: all content). Per-persona DEKs derived via HKDF from master seed. `VaultManager` holds per-database connection pools — each with single-writer (`MaxOpenConns=1`, `busy_timeout=5000`) + read pool (`MaxOpenConns=cpu*2`, `PRAGMA query_only=ON`). WAL mode on all databases. Basic `/v1/vault/query` and `/v1/vault/store` endpoints. **Mandatory CI test:** read raw `.sqlite` bytes and assert first 16 bytes ≠ `SQLite format 3\0` (proving encryption is active on every database file). | — | dina-core | NOT STARTED |
| 1.8 | DID key management in core | L0 Identity | BIP-39 seed → Master Seed, key wrapping (passphrase → Argon2id KEK → AES-256-GCM wraps seed → `wrapped_seed.bin`). SLIP-0010 persona key derivation (Ed25519 signing keys). Per-persona vault DEKs via HKDF from master seed with persona-specific info strings (`"dina:vault:identity:v1"`, `"dina:vault:personal:v1"`, etc.). `/v1/did/sign` and `/v1/did/verify` endpoints. Selective persona unlock: `POST /v1/persona/unlock {persona, ttl}` → core derives DEK, opens database file, auto-closes after TTL. Go: `crypto/ed25519`, `x/crypto/argon2`, `stellar/go/exp/crypto/derivation`. | 1.7 | dina-core | NOT STARTED |
| 1.9 | PII scrubber (three-tier) | L6 Intelligence | **Tier 1:** Regex-based PII detection in Go core (credit cards, phone numbers, Aadhaar, emails). `/v1/pii/scrub` endpoint. Returns replacement map (`[PERSON_1]` → original) for de-sanitization. **Tier 2:** spaCy NER in Python brain (`en_core_web_sm`, ~15MB) catches contextual PII (names, orgs, locations). Always available, no llama required. **Tier 3 (optional):** LLM NER via llama for edge cases. | 1.7, 1.2 | dina-core + dina-brain | NOT STARTED |
| 1.10 | docker-compose wiring | Infra | 3-container orchestration (core, brain, pds — always on). Optional llama via `--profile local-llm` (4th container). Internal network. Brain calls core API + cloud APIs (Gemini, Deepgram). Single `docker compose up -d` for Cloud LLM profile, `docker compose --profile local-llm up -d` for Local LLM. Healthchecks (`/healthz`, `/readyz`) on all containers. Dependency chain: brain waits for core healthy. `restart: always`. Structured JSON logging (Go `slog`, Python `structlog`) to stdout. Vault passphrase via Docker Secrets (tmpfs-mounted, never in env vars or CLI). | 1.2, 1.7, 1.1 | All | NOT STARTED |
| 1.10c | Brain crash recovery (task queue + scratchpad) | Infra | **Task Queue (Outbox Pattern):** Core writes tasks to `dina_tasks` table in `identity.sqlite` before sending to brain. Brain ACKs on completion. Unacknowledged tasks requeued after 5-min timeout. Dead letter after 3 attempts → Tier 2 notification. **Scratchpad:** Brain checkpoints multi-step reasoning to `identity.sqlite` staging tables (`type: "scratchpad"`). On restart, brain resumes from last checkpoint. Auto-expires 24h. No Mem0/SuperMemory — vault IS the memory store. | 1.7, 1.2 | dina-core + dina-brain | NOT STARTED |
| 1.10a | Gatekeeper: Brain→Core API auth | Infra | **Brain is an untrusted tenant.** Two-tier static token auth, no JWTs: `BRAIN_TOKEN` (boot-generated, Docker Secrets) grants agent capabilities only (vault/query, vault/store, pii/scrub, notify, msg/send, reputation/query). `CLIENT_TOKEN` (per-device, QR pairing) grants everything including admin (did/sign, did/rotate, vault/backup, persona/unlock). Static allowlist in `gatekeeper.go` middleware — `isAdminEndpoint()` rejects `BRAIN_TOKEN` on admin paths. Brain never calls `/v1/did/sign` directly — it triggers high-level ops (`/v1/msg/send`) and core handles crypto internally. Persona access tiers also enforced: open (serve + log), restricted (serve + log + notify), locked (reject until user unlocks with TTL). | 1.7, 1.2 | dina-core + brain | NOT STARTED |
| 1.10b | Admin UI | Infra | FastAPI sub-app mounted at `/admin/*` in brain's unified Uvicorn (port 8200) with `CLIENT_TOKEN` auth. Externally accessible via core reverse proxy at `443/admin` with browser authentication gateway (passphrase login → session cookie → Bearer token translation). Dashboard (connector status, vault health, brain responsiveness), nudge history, contacts/sharing rules, settings/personas. Calls `core:8100` with `CLIENT_TOKEN`. **Build early — a UI to inspect vault, connectors, and nudges accelerates development of everything that follows.** | 1.10, 1.10a | dina-brain container | NOT STARTED |

---

## Phase 1b — Guardian Angel Loop

**Goal:** Dina watches your world, stays quiet, and nudges when it matters. The Sancho Moment works end-to-end.

| # | Item | Layer | What It Is | Depends On | Container | Status |
|---|------|-------|-----------|-----------|-----------|--------|
| 1.11 | Gmail ingestion (via OpenClaw MCP) | L2 Ingestion | **No OAuth in core. No Gmail API client.** Brain delegates fetching to OpenClaw via MCP: "fetch emails since {gmail_cursor}". OpenClaw handles Gmail API + OAuth using its own credentials. Brain receives structured JSON, classifies content to persona, stores via `POST /v1/vault/store`. Sync cursor persisted in `identity.sqlite` kv_store (`PUT /v1/vault/kv/gmail_cursor`). **Ingestion Triage (in brain):** LLM batch classification of subject+sender (50 per call) to separate real correspondence from spam/newsletters. Only emails classified as INGEST get full processing. Fiduciary override: security alerts, financial docs always ingested. Attachments: metadata only (filename, size, MIME type) — never store binary blobs. **Living Window sync:** morning routine (last 30 days fast sync) → hourly light checks → on-demand via user query. Historian backfills to `DINA_HISTORY_DAYS` (default 365) in background batches. OpenClaw health monitoring: HEALTHY → DEGRADED → OFFLINE state machine; cursors preserved across outages. | 1.7, 1.10, 1.2 | dina-brain (orchestration) + OpenClaw (fetching) | NOT STARTED |
| 1.12 | Calendar ingestion (via OpenClaw MCP) | L2 Ingestion | Brain delegates to OpenClaw: "fetch calendar events since {calendar_cursor}". OpenClaw calls Google Calendar API (Phase 1), returns structured JSON. Brain stores events in vault. CalDAV deferred to Phase 2 (2.18) for non-Google users. Sync cursor in `identity.sqlite` kv_store. | 1.7, 1.10, 1.2 | dina-brain + OpenClaw | NOT STARTED |
| 1.13 | Contacts ingestion (via OpenClaw MCP) | L2 Ingestion | Brain delegates to OpenClaw: "fetch contacts". OpenClaw calls Google People API (Phase 1, CardDAV Phase 2). Brain stores contacts in `identity.sqlite` (Tier 0) — contacts have NO persona field, people span contexts. Daily sync, dedup by source ID. | 1.7, 1.10, 1.2 | dina-brain + OpenClaw | NOT STARTED |
| 1.14 | Brain sync scheduler | L2 Ingestion | Brain-side scheduling of MCP sync cycles. Morning routine (full sync: Gmail + Calendar + Contacts). Hourly light checks (new emails only). On-demand sync when user queries need fresh data. All via MCP → OpenClaw. No cron in core — brain orchestrates. | 1.11, 1.12, 1.13, 1.2 | dina-brain | NOT STARTED |
| 1.15 | Context assembly for nudges | L6 Intelligence | Brain queries vault for relevant context (relationships, history), assembles nudge text | 1.10, 1.4 | dina-brain | NOT STARTED |
| 1.16 | Nudge delivery (WebSocket) | L7 Action | Core pushes nudge to connected client device via WebSocket. `/v1/notify` endpoint. | 1.15, 1.7 | dina-core | NOT STARTED |
| 1.17 | Encrypted messaging endpoint + Dead Drop | L4 Dina-to-Dina | Always-on HTTPS endpoint on core:443 (exposed via ingress tier). Receives encrypted messages from other Dinas. libsodium `crypto_box_seal` + DIDComm-shaped plaintext. **State-aware ingress:** Vault unlocked → fast path (decrypt in-memory, per-DID rate limiting, zero disk I/O). Vault locked → Dead Drop (write encrypted blobs to `./data/inbox/*.blob`, return `202 Accepted`). **3-valve DoS defense:** Valve 1 — IP token bucket (50 req/hr per IP, 1000 global, 256KB payload cap). Valve 2 — spool cap (500MB, reject-new when full, never drop-oldest). Valve 3 — sweeper feedback (post-unlock: decrypt, check DID, blocklist spam IPs). Inbox Sweeper runs on vault unlock — decrypts, checks TTL, processes. Expired messages stored silently (no zombie notifications). | 1.8, 1.7 | dina-core | NOT STARTED |
| 1.17a | Rate limiting | L4 Dina-to-Dina | **State-dependent:** (1) Ingress tier — Cloudflare WAF rules if using CF Tunnel. (2) Pre-decryption (always) — IP token bucket per IP (50/hr), global (1000/hr), 256KB payload cap (HTTP 413). (3) Post-decryption (vault unlocked only) — per-DID limits (60/min), per-device on WebSocket (120/min). Per-DID limiting is mathematically impossible when vault is locked (sender DID encrypted inside NaCl envelope). (4) Circuit breaker on brain→core calls (prevent runaway loops). | 1.17, 1.7 | dina-core | NOT STARTED |
| 1.18 | DID exchange (QR code) | L4 Dina-to-Dina | Generate QR code containing your DID. Scan another Dina's QR to establish connection. | 1.8, 1.17 | dina-core | NOT STARTED |
| 1.19 | Basic Dina-to-Dina messaging | L4 Dina-to-Dina | Send/receive encrypted messages between two Home Nodes. Sender FS via ephemeral keys. DIDComm-compatible plaintext format. | 1.17, 1.18 | dina-core | NOT STARTED |
| 1.19a | Simple relay for NAT | L4 Dina-to-Dina | ~100 lines of code relay for Home Nodes behind NAT/firewall. Receives forward envelope `{type: "dina/forward", to: "did:plc:...", payload: "<encrypted blob>"}`. Peels outer layer, forwards inner blob. Relay sees only encrypted blob + recipient DID. Community-run or self-hosted. | 1.17, 1.19 | relay | NOT STARTED |
| 1.20 | **The Sancho Moment (E2E)** | All | Sancho's Dina sends "leaving home" → your core receives → brain checks vault for Sancho context → brain assembles nudge ("his mother was ill, put the kettle on") → core pushes to your phone. | 1.19, 1.15, 1.16 | All | NOT STARTED |

---

## Phase 1c — Safety & Persistence

**Goal:** Data is safe. Actions go through approval gates. Bot protocol is standardized.

| # | Item | Layer | What It Is | Depends On | Container | Status |
|---|------|-------|-----------|-----------|-----------|--------|
| 1.21 | Pre-flight snapshots | L1 Storage | `sqlcipher_export()` via `ATTACH DATABASE ... KEY` (Keyed-to-Keyed backup — **NEVER `VACUUM INTO`**, which creates unencrypted copies on SQLCipher, CVE-level vulnerability). + `PRAGMA integrity_check` before every schema migration. Auto-rollback on failure. **CI/CD:** backup test must assert backup file has no valid plaintext SQLite header. | 1.7 | dina-core | NOT STARTED |
| 1.22 | Off-site encrypted backup | L1 Storage | Encrypted vault snapshot pushed to S3/Backblaze on schedule | 1.7, 1.8 | dina-core | NOT STARTED |
| 1.22a | Migration CLI (`dina export/import`) | L1 Storage | `dina export` bundles all node state (persona SQLite files, encrypted master key, salt, media, config) into a single AES-256-GCM encrypted `.dina` archive. `dina import` restores on new machine after passphrase verification. Excludes BRAIN_TOKEN, OAuth tokens, device tokens (regenerated on new machine). Enables zero-lock-in migration between hosting levels. | 1.7, 1.8, 1.21 | dina-core | NOT STARTED |
| 1.23 | BIP-39 recovery | L0 Identity | Generate 24-word mnemonic from root key. Restore identity from mnemonic. | 1.8 | dina-core | NOT STARTED |
| 1.24 | Persona system (basic) | L0 Identity | Phase 1 ships with single `personal.sqlite`. Phase 2 adds per-persona files (`health.sqlite`, `financial.sqlite`, etc.) — each with its own HKDF-derived DEK. **True cryptographic isolation:** locked persona = DEK not in RAM = file is opaque bytes. **Persona access tiers:** Open (database open, brain queries freely, logged), Restricted (database open, every access logged + user notified in daily briefing), Locked (database CLOSED, DEK not in RAM, brain gets `403 Persona Locked`, requires user to unlock via client device with TTL, auto-closes on expiry, DEK zeroed from RAM). Cross-persona queries: brain makes separate `/v1/vault/query` calls per persona, core routes to correct open database. Audit log in `identity.sqlite` records every persona access. | 1.8 | dina-core | NOT STARTED |
| 1.25 | Draft-Don't-Send (Gmail) | L7 Action | Brain drafts email reply → stored in Tier 4 (Staging, auto-expires 72h) → user reviews in Gmail → user presses Send. Dina NEVER calls `messages.send`. | 1.11, 1.15 | dina-brain + core | NOT STARTED |
| 1.26 | Cart Handover (basic) | L7 Action | Brain assembles payment intent (UPI deep link). Stored in Tier 4. User taps to pay. Dina never touches money. | 1.15, 1.7 | dina-brain + core | NOT STARTED |
| 1.27 | Bot response protocol | L5 Bot Interface | Standardized JSON response format with mandatory `creator_name`, `source_url`, `deep_link`, `deep_link_context` attribution fields. Deep links point to specific moments (e.g., video timestamp), not just source URLs. | 1.3 | dina-brain | NOT STARTED |
| 1.28 | Local bot reputation tracking | L3 Reputation | Track bot accuracy, response time, uptime locally. Route to better bots when quality drops. | 1.27 | dina-brain | NOT STARTED |
| 1.29 | Client authentication | Infra | **CLIENT_TOKEN per-device pairing.** **First device:** `docker compose up` prints local IP + 6-digit pairing code to terminal (expires in 5 min). Phone app finds Home Node via mDNS (`github.com/hashicorp/mdns`) or manual IP entry. User enters pairing code → core generates CLIENT_TOKEN (32-byte random, hex) → returns to device once over TLS → device stores in Keychain/Keystore. Core stores SHA-256 hash in `identity.sqlite` `device_tokens` table. **Managed hosting:** signup flow provides pairing code. **Subsequent devices:** same flow — new pairing code via admin UI or terminal. Each device gets its own CLIENT_TOKEN, independently revocable. **QR code deferred** — cosmetic, not needed for Phase 1. **Device keypair deferred to Phase 2** — Phase 1 uses CLIENT_TOKEN Bearer auth only. All communication over TLS + CLIENT_TOKEN auth frame on WebSocket. | 1.8, 1.17 | dina-core | NOT STARTED |
| 1.29a | Supply chain security | Infra | Graduated approach: **(1) Day one:** pin base image digests (`@sha256:...`) in Dockerfile and `docker-compose.yml` — never `:latest`. **(2) When CI exists:** Cosign image signing in GitHub Actions (keyless via OIDC), SBOM generation with `syft` (SPDX format), verification in install/upgrade script. **(3) Skip:** reproducible builds (extremely hard with Python/CUDA, low ROI). Pinning prevents breakage, signing prevents tampering, SBOM enables auditing. | 1.10 | CI/CD | NOT STARTED |
| 1.29b | Watchdog & self-notifications | Infra | **Internal Go ticker (not Prometheus).** Lightweight background goroutine in dina-core checks system health every hour. Tracks: OpenClaw health (last successful MCP sync), disk usage, brain responsiveness, vault size per persona file. When thresholds breach (OpenClaw unreachable > 48h, disk > 90%, brain unresponsive), injects Tier 2 system message into user's notification stream: "Gmail hasn't synced in 48 hours. Is OpenClaw running?" No external monitoring stack needed — zero extra RAM, zero user setup, works on Raspberry Pi. **Optional:** `/metrics` endpoint (Prometheus format, protected by `CLIENT_TOKEN`) for power users with existing homelab dashboards. | 1.7, 1.16 | dina-core | NOT STARTED |

---

## Phase 1.5 — Client & Managed Hosting

| # | Item | Layer | What It Is | Depends On | Container/Platform | Status |
|---|------|-------|-----------|-----------|-------------------|--------|
| 1.30 | Android client (basic) | Client | Kotlin + Jetpack Compose app. Connects to Home Node via WebSocket. Displays nudges, notifications, daily briefing. | 1.16, 1.29 | Android | NOT STARTED |
| 1.31 | Android local vault cache | Client | SQLite cache of recent 6 months. Offline search. Checkpoint-based sync with Home Node. | 1.30 | Android | NOT STARTED |
| 1.32 | Android on-device LLM | Client | LiteRT-LM + Gemma 3n E2B for offline classification, quick replies. | 1.30 | Android | NOT STARTED |
| 1.33 | Managed hosting infra | Infra | Multi-tenant hosting. Per-user directory with `identity.sqlite` + persona files. OS-level isolation. **Onboarding UX:** "Sign up with email. Connect Gmail (via OpenClaw). Done." Everything else happens silently. Prompt mnemonic backup after 7 days (not during signup). Start with one default persona (`/personal` → single `personal.sqlite`). Persona separation as power-user feature. Billing ($5-10/month). | 1.10, 1.29, 1.10b | Server | NOT STARTED |
| 1.34 | FunctionGemma 270M routing | L6 Intelligence | Ultra-lightweight model (529MB) for fast intent classification and tool routing. Runs alongside Gemma 3n on llama. | 1.1 | llama | NOT STARTED |
| 1.35 | Telegram connector | L2 Ingestion | Telegram Bot API — user creates bot via @BotFather, configures token in Dina. Home Node receives messages via webhook/long polling. Full message content, media, group context. Server-side, cross-platform. | 1.30 | dina-core + dina-brain | NOT STARTED |
| 1.36 | Agent delegation (OpenClaw) | L7 Action | Delegate tasks to OpenClaw and other child agents via MCP. License renewal, form filling, task automation — all with `draft_only` constraint. No plugins — agents are external processes. | 1.25 | dina-brain | NOT STARTED |
| 1.37 | Daily briefing | L6 Intelligence | End-of-day summary of Priority 3 items. "Here's what you missed that wasn't important enough to interrupt." | 1.5, 1.15 | dina-brain | NOT STARTED |
| 1.38 | Push notifications (FCM/APNs) | Infra | When client is disconnected, wake it via FCM/APNs. Payload contains NO data — just "connect to your Home Node." | 1.16, 1.30 | dina-core + client | NOT STARTED |
| 1.39 | Home Node security hardening | Infra | Automatic container updates (Watchtower or similar). Rate limiting on all external endpoints (see 1.17a). Minimal attack surface audit — verify no unintended open ports. Security hardening checklist for self-hosted deployments. | 1.10, 1.17a | dina-core | NOT STARTED |

---

## Phase 2 — Intelligence & Trust

| # | Item | Layer | What It Is | Depends On | Status |
|---|------|-------|-----------|-----------|--------|
| 2.1 | Embedding generation (EmbeddingGemma) | L1 Storage | 308M param model generates embeddings. Stored in Tier 2 Index via sqlite-vec. Enables semantic search across all vault data. | 1.7, 1.1 | NOT STARTED |
| 2.2 | Tier 2 Index (embeddings) | L1 Storage | sqlite-vec vector store alongside SQLite FTS5. Hybrid search: keyword + semantic. | 2.1 | NOT STARTED |
| 2.3 | Reputation AppView (monolith) | L3 Reputation | Phase 1 monolith: single Go binary + PostgreSQL 16 (`pg_trgm`). Firehose consumer (`indigo` library) → filter (`com.dina.reputation.*` only) → signature verifier → PostgreSQL indexer → JSON query API (`GET /v1/reputation?did=...`, `GET /v1/product?id=...`, `GET /v1/bot?did=...`). Computes aggregate scores (product ratings, seller trust composites, bot accuracy). **API includes signed record payloads from day one** (cheap, locks in API contract for future verification). Deployed on 1x VPS (4 vCPU, 8GB RAM). Blue/green deploys, WAL archiving + PITR. Handles 0–1M users. | 1.28 | NOT STARTED |
| 2.4 | Outcome data collection | L3 Reputation | Dina tracks purchases via Cart Handover. Months later, gently asks "How's that chair?" Anonymized outcome → Reputation Graph. | 1.26, 2.3 | NOT STARTED |
| 2.5 | Trust Rings (Ring 1-2) | L0 Identity | Ring 1 (unverified) = anyone. Ring 2 (verified unique person) = ZKP or external verification. Phase 1 compromise for India: Aadhaar e-KYC XML with offline verification, only yes/no attestation stored. True ZKP (Semaphore V4) in Phase 2+. | 1.24, 2.3 | NOT STARTED |
| 2.6 | Fine-tuned PII model | L6 Intelligence | Gemma 3n E4B fine-tuned for PII detection. Replaces generic NER prompting. Higher accuracy, fewer leaks. | 1.9, 1.1 | NOT STARTED |
| 2.7 | Multi-agent orchestration | L6 Intelligence | Google ADK Sequential, Parallel, Loop agents. Complex multi-step reasoning (e.g., research laptop → check reputation → compare prices → assemble recommendation). | 1.2 | NOT STARTED |
| 2.8 | Emotional state awareness | L7 Action | Lightweight classifier flags "user may be upset/impulsive" before large purchases or high-stakes communications. Signals: time of day, communication tone, spending pattern deviation. Cooling-off suggestion. | 1.15, 2.1 | NOT STARTED |
| 2.9 | Anti-Her safeguard | L7 Action | Track interaction patterns. If user treats Dina as emotional replacement, redirect: "You haven't talked to Sancho in a while." Nudge toward human connection, never fill the void. | 1.19, 1.15 | NOT STARTED |
| 2.10 | Bot discovery (decentralized) | L5 Bot Interface | Bots self-register on Reputation Graph. Reputation determines visibility. Bot-to-bot referrals. | 2.3 | NOT STARTED |
| 2.11 | Dina-to-Dina sharing rules | L4 Dina-to-Dina | Fine-grained per-connection control over what each contact can see. "Sancho's Dina can see my location, but not my calendar." Rules stored in Tier 0, enforced in dina-core (not brain). Persona compartments provide cryptographic backstop. | 1.19, 1.24 | NOT STARTED |
| 2.12 | Desktop client (Wails/Tauri) | Client | Cross-platform desktop app via Wails (Go + WebView) or Tauri 2. Connects to Home Node same as Android. | 1.29 | NOT STARTED |
| 2.13 | Tier 5 Deep Archive | L1 Storage | Weekly encrypted snapshots to S3 Glacier Deep Archive with **Compliance Mode Object Lock** (even root cannot delete during retention period). Immutable. Survives ransomware. Optional: LTO tape / physical USB HDD for sovereign cold storage. | 1.22 | NOT STARTED |
| 2.14 | UnifiedPush (de-Googled) | Infra | Self-hosted push notification relay. Replaces FCM for users who don't want Google dependency. | 1.38 | NOT STARTED |
| 2.15 | Nomic Embed V2 (upgrade) | L1 Storage | 475M MoE embedding model. Better retrieval quality for complex queries. Drop-in replacement for EmbeddingGemma. | 2.1 | NOT STARTED |
| 2.16 | Confidential Computing (pilot) | Infra | AWS Nitro Enclaves / AMD SEV-SNP for managed hosting. Remote attestation proves unmodified binary. Eliminates honeypot problem at hardware level. **No vTPM for Convenience mode** — root on a running machine = game over regardless. vTPM only prevents offline attacks (stolen disk images), which is marginal protection for significant complexity. Users who care use Security mode (passphrase-gated). Confidential Computing is the real fix. | 1.33 | NOT STARTED |
| 2.17 | Local LLM profile (llama) | Infra | Enable llama container (Gemma 3n E4B GGUF, ~3GB RAM) via `--profile local-llm`. 4-container stack (core, brain, pds, llama). LLM router: sensitive personas → local only (best privacy, skips Entity Vault), everything else → cloud with local fallback. Tier 3 PII scrubbing (LLM NER). 8GB minimum RAM. whisper.cpp STT deferred — voice via Deepgram in all profiles for Phase 2. | 1.10, 1.6 | NOT STARTED |
| 2.18 | CalDAV connector (non-Google) | L2 Ingestion | CalDAV support for Apple Calendar, Nextcloud, etc. Handles incompatibilities in recurring events, timezone handling, shared calendars across providers. | 1.12 | NOT STARTED |
| 2.19 | DIDComm v2 JWE wire upgrade | L4 Dina-to-Dina | Encryption envelope upgraded from libsodium `crypto_box_seal` to standard JWE (ECDH-1PU+A256KW, A256CBC-HS512). Wire-compatible with any DIDComm v2 library (Rust, Python, WASM). Plaintext format unchanged. | 1.19 | NOT STARTED |
| 2.20 | Digital Estate (SSS Custodian Recovery) | L0 Identity | Post-death recovery uses SSS infrastructure — custodians (family, lawyer) hold Shamir shares, coordinate to reconstruct seed. Estate plan in Tier 0 defines per-beneficiary persona access. Human-initiated, not timer-triggered. | 1.24, 1.19, 1.22 | NOT STARTED |
| 2.21 | Key management UX improvements | L0 Identity | Social recovery (multi-sig threshold from trusted contacts' Dinas). Hardware backup options (YubiKey, Ledger). Better UX than "write 24 words on paper" — known failure mode from crypto. | 1.23, 1.19 | NOT STARTED |

---

## Phase 3 — Open Economy & Scale

| # | Item | Layer | What It Is | Depends On | Status |
|---|------|-------|-----------|-----------|--------|
| 3.1 | Trust Rings (Ring 3+) | L0 Identity | Credential anchors: LinkedIn, GitHub, business registration. Transaction history + time + peer attestation → composite trust score. | 2.5 | NOT STARTED |
| 3.2 | Content verification (C2PA) | L7 Action | Media provenance via Content Credentials. Cross-reference claims against Reputation Graph. "This video appears AI-generated." | 2.3 | NOT STARTED |
| 3.3 | Social Radar (real-time co-pilot) | L6 Intelligence | "You've interrupted him twice." Context Injection from camera/microphone (glasses, phone). Requires on-device processing. | 2.7, 1.32 | NOT STARTED |
| 3.4 | Open Economy (ONDC + UPI) | L7 Action | Dina negotiates directly with manufacturer's Dina via ONDC. UPI/crypto for payment. Marketplace middlemen become optional. | 2.3, 1.26, 1.19 | NOT STARTED |
| 3.5 | Expert Bridge | L3 Reputation | Verified experts opt in to having their knowledge structured. Attribution + economic value when their knowledge drives decisions. | 2.3, 1.27 | NOT STARTED |
| 3.6 | Direct value exchange | L3 Reputation | Creators earn when their reviews drive purchases. Truth pays better than clicks. Micropayments via UPI/crypto. | 3.5, 3.4 | NOT STARTED |
| 3.7 | iOS client | Client | Swift + SwiftUI. Home Node API connectors (Gmail, Calendar, Contacts, Telegram) work identically on all platforms. | 1.29 | NOT STARTED |
| 3.8 | Thin clients (glasses, watch, browser) | Client | Web-based via authenticated WebSocket. No local processing. Streams from Home Node. | 1.29, 1.16 | NOT STARTED |
| 3.9 | Foundation formation | Org | Nonprofit foundation takes over managed hosting operations. Multiple certified hosting partners across jurisdictions. Regulatory compliance (GDPR, DPDP Act), security operations, incident response. | 1.33, 2.16 | NOT STARTED |
| 3.10 | Full Dina-to-Dina commerce protocol | L4 Dina-to-Dina | Buyer Dina ↔ Seller Dina negotiation, reputation check, payment intent, delivery tracking — all sovereign. | 3.4, 2.11, 3.1 | NOT STARTED |
| 3.11 | Timestamp anchoring (L2) | L3 Reputation | Weekly Merkle root hash of all Reputation Graph entries anchored to L2 chain (Base or Polygon). Provable "this existed before this date" for dispute resolution, anti-gaming, and Expert Bridge economics. | 2.3, 3.5 | NOT STARTED |
| 3.12 | Noise XX sessions | L4 Dina-to-Dina | Noise XX handshake between always-on Home Nodes for full forward secrecy (both sender and receiver). DIDComm plaintext flows over the Noise channel. Optional mesh routing through other Dinas. | 2.19 | NOT STARTED |
| 3.13 | AppView sharded cluster | L3 Reputation | When monolith (2.3) hits scaling limits (10M+ users): Kafka/NATS JetStream event buffer, stateless Go ingestion workers, ScyllaDB (sharded by DID) for high-velocity tables, PostgreSQL read replicas for metadata, independent API cluster with Kubernetes HPA autoscaling. Janitor process for index drift detection. | 2.3 | NOT STARTED |
| 3.14 | AppView verification (trust-but-verify) | L3 Reputation | Three-layer verification in Dina agents: (1) Cryptographic proof — every AppView response includes raw signed payload + author signature, agent verifies against DID public key. (2) Consensus check — for high-value transactions, query primary + secondary AppViews, detect censorship by comparing result counts. (3) Direct PDS spot-check — randomly (1 in 100) or when suspicious, bypass AppView and fetch records directly from source PDS. Meaningful only when multiple AppViews exist. | 3.13 | NOT STARTED |

---

## Summary Timeline

| Phase | Milestone | What You Can Demo |
|-------|-----------|------------------|
| **v0.4** | Proof of concept | YouTube analysis with signed verdicts, memory, DID identity |
| **1a** | Sidecar running (Cloud LLM) | 3 containers up (core, brain, pds), brain reasons via Gemini Flash Lite + Deepgram STT, core stores, PDS hosts reputation data, YouTube analysis via ADK, admin UI proxied via core:443/admin |
| **1b** | Sancho Moment | Two Dinas talk, nudge delivered to phone, guardian angel loop end-to-end |
| **1c** | Safety & bots | Data backed up, drafts work, bot protocol standardized |
| **1.5** | Real product | Android app, managed hosting, Telegram ingestion, daily briefing |
| **2** | Intelligence | Semantic search, Reputation Graph live, trust rings, Local LLM profile, digital estate, desktop client |
| **3** | Economy | Direct commerce via ONDC, expert marketplace, iOS, thin clients, foundation |

---

## Items Added During Architecture Review

The following items were **missing from the original roadmap** but are described in the architecture document. They've been added above in their correct phases:

| Item | Phase | Why It Was Missing |
|------|-------|--------------------|
| 1.10a Brain→Core API auth | 1a | Issue #12 — security gap, not originally designed |
| 1.17 Dead Drop ingress + TTL | 1b | Issue #10 — decoupled ingress writes encrypted blobs to disk spool when vault locked. Inbox Sweeper processes after unlock. TTL prevents zombie notifications. |
| 1.17a Rate limiting | 1b | Issue #11 — no rate limiting anywhere |
| 1.19a Simple relay for NAT | 1b | Described in architecture transport layer, no roadmap item |
| 1.21 `sqlcipher_export()` backup | 1c | Issue #8 — `VACUUM INTO` creates unencrypted copies (CVE-level) |
| 1.24 persona access tiers (open/restricted/locked) | 1c | Issue #9 — brain compromise risk. Per-persona encrypted files with per-file DEKs. Locked = database closed, DEK not in RAM. Per-persona API calls with tiered access control. |
| 1.29 first device bootstrap | 1c | Issue #22 — mDNS discovery + 6-digit pairing code. QR deferred (cosmetic). |
| 1.29a Container image signing | 1c | Issue #14 — supply chain risk |
| 1.29b Monitoring & self-notifications | 1c | Issue #16 — silent connector failures |
| 1.33 onboarding UX | 1.5 | Issue #21 — UX too complex for normal users |
| 1.39 Security hardening | 1.5 | Issue #11 + architecture "What's Hard" #8 |
| 2.16 Confidential Computing (no vTPM) | 2 | Issue #13 — root on VPS = game over. vTPM rejected (marginal offline-only protection, significant complexity). Confidential Computing is the real fix. Users who care use Security mode. |
| 2.17 Local LLM profile | 2 | Was in scope but no explicit roadmap item |
| 2.18 CalDAV connector | 2 | Issue #18 — CalDAV compatibility nightmare |
| 2.19 DIDComm v2 JWE upgrade | 2 | Described in transport layer phasing, no roadmap item |
| 2.20 Digital Estate | 2 | Fully designed in architecture, zero roadmap items |
| 2.21 Key management UX | 2 | Architecture "What's Hard" #7, no roadmap item |
| 3.12 Noise XX sessions | 3 | Described in transport layer Phase 3, no roadmap item |
| 1.10 (updated) 3+1 container model | 1a | PDS always bundled (3 containers: core, brain, pds). llama optional via `--profile local-llm` (4th container). Three deployment profiles: Cloud LLM (default, 3 containers), Local LLM (4 containers), Hybrid (4 containers). |
| 2.3 (expanded) Reputation AppView monolith | 2 | Was a one-liner. Now specifies full stack: Go + PostgreSQL + `indigo` firehose consumer, signature verification, query API, aggregate score computation. |
| 3.13 AppView sharded cluster | 3 | Migration path for 10M+ users: Kafka, ScyllaDB, Kubernetes HPA. Explicitly deferred. |
| 3.14 AppView verification (trust-but-verify) | 3 | Three-layer verification: cryptographic proof, consensus check across AppViews, direct PDS spot-check. Meaningful only when multiple AppViews exist. |
| 1.10a (updated) Two-tier static token auth | 1a | Issue #12 — `BRAIN_TOKEN` (boot-generated) + `CLIENT_TOKEN` (per-device). No JWTs. Static allowlist in `gatekeeper.go`. Brain never calls `/v1/did/sign` — triggers high-level ops, core handles crypto. Permanent design (no plugins). |
| 1.29a (updated) Supply chain security | 1c | Issue #14 — graduated: pin digests day one, Cosign + SBOM when CI exists, reproducible builds skipped. See [SECURITY.md](SECURITY.md). |
| 1.29b (updated) Watchdog & self-notifications | 1c | Issue #16 — internal Go ticker, not Prometheus. Breaches inject Tier 2 system messages. Optional `/metrics` for power users. |
| (architectural decision) Kernel model | All | Dina has no plugins. Child agents (OpenClaw etc.) are external processes via MCP. NaCl over HTTPS for peers. Two-tier auth is the permanent design. |
| (architectural decision) Attachment storage | 1b | Issue #17 — never store binary blobs in SQLite. Metadata + reference + LLM summary only. Voice memos: transcript in vault, optional `media/` directory on disk. |
| (architectural decision) Three-tier scheduling | 1b | No general-purpose scheduler. Go tickers for periodic tasks, reminder loop on vault for one-shots, delegate complex scheduling to calendar via OpenClaw. |
| (architectural decision) Cold start: tool first, network second | All | Issue #20 — no "Review Bot" to build. Phase 1 is single-player: Brain + OpenClaw web search with user context. Reputation Graph activates gradually in Phase 2+ as network grows. |
| (architectural decision) Calendar is a Sense, not a Tool | 1b | Issue #18 — Calendar data fetched by OpenClaw via MCP, stored in vault (read-only cache). Google Calendar API Phase 1 (via OpenClaw), CalDAV Phase 2. Complex scheduling (multi-person) delegated to OpenClaw. |
| 1.10b Admin UI (Python) | 1a | Issue #21 — FastAPI sub-app at `/admin/*` in brain's unified Uvicorn (port 8200, CLIENT_TOKEN, proxied via core:443/admin with browser auth gateway). Dashboard, settings, onboarding flow. Python for speed of development, not Go templates. Moved to Phase 1a — a dev UI accelerates everything that follows. |
| 1.33 (updated) Progressive onboarding | 1.5 | Issue #21 — Signal-level simplicity: email → connect Gmail (via OpenClaw) → done. One default persona (`personal.sqlite`). Mnemonic backup deferred to day 7. Features unlock progressively over weeks. |

| 1.10c Brain crash recovery (task queue + scratchpad) | 1a | Issue #18 — Outbox pattern: core tracks tasks in `dina_tasks` table in `identity.sqlite`, requeues unacknowledged after timeout. Scratchpad: brain checkpoints multi-step reasoning to `identity.sqlite` staging. No external memory service needed for Phase 1. |
| 1.22a Migration CLI (`dina export/import`) | 1c | Issue #9 — "Copy one file" was misleading. `dina export` bundles vault, keys, media, config into encrypted `.dina` archive. `dina import` restores. Zero lock-in. |
| (architectural decision) Unified Uvicorn | 1a | Issue #5 — Brain runs single FastAPI master on port 8200 with sub-mounted `/api/*` (brain) and `/admin/*` (admin UI). Eliminates fat container antipattern (two processes, one healthcheck). |
| (architectural decision) Browser auth gateway | 1a | Issue #6 — Core serves static login page, validates passphrase via Argon2id, sets HttpOnly/Secure/SameSite=Strict session cookie, translates to Bearer token before proxying to brain. Brain never knows about cookies. |
| (architectural decision) FTS5 unicode61 tokenizer | All | Issue #7 — Porter stemmer forbidden (English-only, mangles Indic scripts). `unicode61 remove_diacritics 1` for Phase 1. ICU tokenizer for CJK deferred to Phase 3. |
| (architectural decision) SLIP-0010 purpose code 9999' | All | Issue #17 — `m/44'` collides with BIP-44 crypto wallets. All derivation paths use `m/9999'/N'` to isolate Dina's cryptographic namespace. |
| (architectural decision) Argon2id 128MB/3 iter | All | Issue #14 — Up from 64MB/1 iter. Configurable in `config.json`. Runs once at unlock, not per-request. |
| (architectural decision) Logging PII policy | All | Log metadata only (persona, type, count, error code). Never log vault content, queries, or plaintext. Brain crash tracebacks → encrypted vault, not stdout. CI linter rejects banned patterns. |
| (architectural decision) DIDComm 256KB payload cap | 1b | Issue #11 — DIDComm is JSON metadata, no media. 256KB max, HTTP 413 if exceeded. |
| (architectural decision) Outbound message retry | 1b | Issue #19 — Outbox table in `identity.sqlite`. 5 retries, 30s→2h exponential backoff, 24h TTL, 100-message queue cap. User notified after exhaustion. |
| (architectural decision) Embedding migration | 2 | Issue #16 — Model name stored in vault metadata. On change: drop sqlite-vec index, background re-embed, FTS5 stays available. No dual-index needed — vault sizes are small enough for full rebuild. |
| (architectural decision) Dead Drop 3-valve DoS defense | 1b | Issue #10 — State-aware ingress: fast path (in-memory) when unlocked, dead drop when locked. Valve 1: IP rate limit. Valve 2: 500MB spool cap, reject-new. Valve 3: sweeper feedback blocklist. |
| (architectural decision) Audit log 90-day retention | 1a | Issue #20 — Rolling 90-day window, daily watchdog cleanup, configurable. |
| (architectural decision) Ed25519→X25519 key reuse | All | Issue #25 — Documented as conscious design decision. Conversion is mathematically safe (birational equivalence, libsodium-supported), avoids doubling key management. Ephemeral X25519 per message adds forward secrecy. |

## Known Inconsistencies Resolved

| Issue | Resolution |
|-------|------------|
| Roadmap said `VACUUM INTO` for pre-flight snapshots | Fixed: `sqlcipher_export()` via `ATTACH DATABASE ... KEY` (Keyed-to-Keyed — plaintext never touches disk). `VACUUM INTO` is a CVE-level vulnerability on SQLCipher. |
| Calendar connector said "CalDAV" for Phase 1 | Fixed: Google Calendar REST API for Phase 1, CalDAV deferred to 2.18 |
| Telegram replaces WhatsApp — official Bot API eliminates fragility | WhatsApp connector was the weakest link (fragile NotificationListenerService hack, Android-only). Replaced with Telegram Bot API: official, stable, server-side, cross-platform. |
| Architecture says sqlite-vec is "Phase 1" | Clarified: sqlite-vec integration lands in Phase 2 with embeddings (2.1/2.2). Phase 1 uses FTS5 only. |
| PII scrubber had no de-sanitization | Added replacement map + de-sanitization to 1.9 description |
| No relay in roadmap despite architecture describing it | Added as 1.19a |
| Container model was inconsistent | Fixed: 3+1 model. PDS always bundled (core, brain, pds = 3 containers). llama optional via `--profile local-llm`. Three deployment profiles: Cloud LLM (default), Local LLM, Hybrid. |

---

*This roadmap is a living document. Status updates happen as work progresses. See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed technical specifications of each item.*
