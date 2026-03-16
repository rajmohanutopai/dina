# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Important:** Always consult `README.md` for the full product vision, design philosophy, and long-term direction. Always consult `ARCHITECTURE.md` for the full engineering blueprint. Every technical decision should align with the principles described in both.

## Project Overview

**Dina** — The Architecture of Agency. Inspired by the novel *[UTOPAI](https://github.com/rajmohanutopai/utopai/blob/main/UTOPAI_2017_full.pdf)* (2012–2017).

Dina is a **sovereign personal AI** and the **safety layer for autonomous agents**. She is a digital extension of *your* will, interests, and values. She serves one master: the human who created her. Not advertisers, not platforms, not corporations. This singular loyalty naturally produces a "Pull Economy" where the agent fetches verified truth on demand instead of being fed ads.

Dina also solves a critical safety gap: autonomous agents today operate without oversight — leaking credentials, accepting commands from anyone, acting without guardrails. Any agent supporting the Dina protocol submits its **intent** to Dina before acting. Dina checks: does this violate your privacy rules? Is this vendor trusted? Are you in the right state to make this decision? Safe tasks pass through silently. Risky actions (sending email, moving money, sharing data) are flagged for your review. The agent never holds your keys, never sees your full history, and never acts without oversight.

### The Four Laws

Every design decision must honour these:

1. **Silence First** — Never push content. Only speak when the human asked, or when silence would cause harm. Three priority levels: Fiduciary (interrupt — silence causes harm), Solicited (notify — user asked), Engagement (save for briefing — silence merely misses an opportunity).
2. **Verified Truth** — Rank by trust, not by ad spend. The Trust Network replaces marketing.
3. **Absolute Loyalty** — The human holds the encryption keys. The agent cannot access the data without them. Loyalty is enforced by math, not by a privacy policy.
4. **Never Replace a Human** — Dina never simulates emotional intimacy. When the human needs connection, Dina connects them to other humans — never to herself.

### Core Principles

- **Anti-Her:** Dina must never become an emotional crutch. She connects you to humans, never replaces them.
- **Thin Agent / Kernel not Platform:** Dina is an orchestrator, not an omniscient brain. She delegates to specialist bots via MCP. **No plugins, no untrusted code inside the process.** Child agents (OpenClaw, etc.) communicate via MCP — they cannot touch the vault, keys, or personas.
- **Sovereign Identity:** One root identity (`did:plc`), multiple **personas** as separate cryptographic compartments. Each persona is a separate encrypted database file with its own DEK. No external system can cross compartments.
- **Trust Rings:** Unverified → Verified (ZKP) → Verified + Actioned (transactions, time, peer attestation). Trust is a composite function: `f(identity anchors, transaction history, outcome data, peer attestations, time)`.
- **Deep Link Default:** Dina credits sources — not just extracts. Creators get traffic, users get truth.
- **Cart Handover:** Dina advises on purchases but never touches money.
- **Agent Safety Layer:** Any agent acting on your behalf submits intent to Dina first.

## Architecture: Home Node

Dina runs on a **Home Node** — a small, always-on server (VPS, Raspberry Pi, or managed service). Client devices (phone, laptop, glasses) connect to it. See `ARCHITECTURE.md` for the full 310KB engineering spec.

### Three Pillars

```
core/               Go Core — sovereign cryptographic kernel
                    Identity, encrypted vault, crypto, DIDComm, WebSocket, PII scrubber, gatekeeper
                    Port 443 (external HTTPS), Port 8100 (internal API for brain)

brain/              Python Brain (sidecar) — intelligence & orchestration
                    Guardian angel loop (Google ADK), silence classification, nudge assembly,
                    agent orchestration (MCP → OpenClaw), admin UI, PII scrubber (spaCy)
                    Port 8200 (internal: /api/* brain API, /admin/* admin UI)

appview/            TypeScript AppView — decentralized Trust Network
                    Ingester (Jetstream firehose), Scorer (9 background jobs), Web (5 xRPC endpoints)
                    PostgreSQL backend, 19 AT Protocol record types
                    Port 3000 (xRPC API)

cli/                Python CLI — Ed25519 signed requests, device pairing, OpenClaw skill
admin-cli/          Admin CLI tool (dina-admin)
```

### Docker Containers (Production)

```
docker-compose.yml:
  dina-core       Go + net/http          Vault keeper. Only process that opens SQLite files.
  dina-brain      Python + FastAPI        Analyst. Thinks, never holds keys.
  dina-pds        AT Protocol PDS         Trust Network records (com.dina.trust.* lexicons).
  llama           llama.cpp (optional)    Local LLM (Gemma 3n). --profile local-llm.
```

### The Sidecar Pattern

- **Core is the vault keeper** — stores, retrieves, encrypts, never interprets, never calls external APIs.
- **Brain is the analyst** — thinks, searches strategically, reasons, delegates fetching via MCP, never holds keys.
- **Brain is an untrusted tenant.** Core treats every brain request like an external client: verify, authorize, log. A compromised brain can only access open personas.
- **The internal API** between core and brain (`/v1/vault/query`, `/v1/vault/store`, `/v1/did/sign`, `/v1/pii/scrub`, `/v1/notify`) is the protocol surface. Any language can implement a brain.

### Key Data Flows

**Ingestion:** Brain → MCP → OpenClaw (fetches Gmail/Calendar) → Brain classifies → `POST core:8100/v1/vault/store` → SQLCipher write

**Semantic search:** Client → Core → `POST brain:8200/api/v1/reason` → Brain generates embedding → `POST core:8100/v1/vault/query` → Core runs hybrid search (FTS5 + HNSW cosine) → Brain reasons over results → Core pushes to client

**Nudge (Sancho Moment):** DIDComm message arrives → Core → `POST brain:8200/api/v1/process` → Brain queries vault (relationship, messages, calendar) → LLM assembles nudge → `POST core:8100/v1/notify` → Core pushes to client via WebSocket

**Trust query:** Brain → AppView xRPC `com.dina.trust.resolve` → Trust score + recommendation (proceed/caution/verify/avoid)

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Core | Go + net/http | Sovereign cryptographic kernel |
| Brain | Python + Google ADK + FastAPI | LLM reasoning, agent orchestration, admin UI |
| AppView | TypeScript + Node.js | Trust Network (AT Protocol) |
| Storage | SQLite + SQLCipher (AES-256-CBC per page) | Encrypted per-persona vault files |
| Search | FTS5 (keyword) + HNSW in-memory (semantic) | Hybrid search: `0.4 × FTS5 + 0.6 × cosine` |
| Identity | `did:plc` (AT Protocol) + Ed25519 (SLIP-0010) | Self-sovereign identity, key derivation |
| Key Mgmt | BIP-39 mnemonic → SLIP-0010 (signing) + HKDF (vault DEKs) | Hierarchical deterministic keys under purpose `m/9999'` |
| Trust | AT Protocol PDS + AppView | Decentralized trust network (19 record types) |
| Messaging | NaCl `crypto_box_seal` over HTTPS | Dina-to-Dina encrypted P2P |
| PII | 3-tier: regex (Go) + spaCy NER (Python) + LLM NER (optional) | Raw data never leaves Home Node |
| Agents | MCP (Model Context Protocol) | External agent communication (OpenClaw, etc.) |
| Embedding | EmbeddingGemma / gemini-embedding-001 (768-dim) | Semantic search vectors |
| Privacy | ZK-SNARKs (Phase 2+) | Prove facts without revealing raw data |

## Security Model

### Authentication (3 methods)

| Method | Who | How | Scope |
|--------|-----|-----|-------|
| **Ed25519 Service Keys** | Core ↔ Brain | SLIP-0010 derived keypairs. Signed canonical: `{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{SHA256(BODY)}`. Headers: `X-DID`, `X-Timestamp`, `X-Signature`. 5-min window + nonce cache. | Agent operations only — never admin |
| **CLIENT_TOKEN** | Admin web UI | 32-byte random, SHA-256 hashed in `device_tokens` table. Browser uses passphrase → session cookie → Core injects Bearer token. | Admin access |
| **Ed25519 Device Keys** | CLI, paired devices | Per-device keypair registered during pairing. Same signature format as service keys. | Full access including admin |

### Persona Access Tiers (4-Tier Gatekeeper)

| Tier | Boot State | Users | Brain | Agents | Example |
|------|-----------|-------|-------|--------|---------|
| **Default** | Auto-open | Free | Free | Free | `/general` |
| **Standard** | Auto-open | Free | Free | Session grant | `/consumer`, `/social`, `/work` |
| **Sensitive** | Closed | Confirm | Approval | Approval | `/health` |
| **Locked** | Closed | Passphrase | Denied | Denied | `/financial` |

Agents work within named sessions (`dina session start --name "task"`). Grants are scoped to sessions and revoked on session end. Legacy tiers (open/restricted) auto-migrate on load.

### Key Architecture Decisions

- **Service keys are install-time only, load-only at runtime** (fail-closed). Derived from master seed via SLIP-0010: Core at `m/9999'/3'/0'`, Brain at `m/9999'/3'/1'`.
- **`install.sh`** calls `provision_derived_service_keys.py` (secrets via env vars, not argv).
- **Private keys isolated by Docker bind mounts** — Core's private key never exists in Brain's container filesystem and vice versa.
- **Brain never touches SQLite.** All vault access goes through Core's HTTP API.
- **No JWTs.** Static allowlist at compile time. Brain triggers high-level operations; Core handles all crypto.

## Build & Development

### Quick Start (Docker — Production)

```bash
git clone https://github.com/rajmohanutopai/dina.git
cd dina
./install.sh    # generates secrets, picks LLM provider, builds containers, shows DID + recovery phrase
```

### Development (Local)

```bash
# Go Core (must build from core/ directory)
cd core && go build -tags fts5 ./cmd/dina-core/

# Python Brain
cd brain && pip install -e .
python -m uvicorn brain.src.main:app --port 18200

# AppView (TypeScript)
cd appview && npm install && npm run build

# Tests
cd core && go test ./...                              # Go unit tests
cd brain && pytest                                     # Python unit tests
python scripts/test_status.py --suite integration      # Integration tests (builds Go, starts services)
DINA_RATE_LIMIT=100000 pytest tests/integration/       # Direct pytest (needs high rate limit)
```

### Key Build Details

- **CGO + FTS5:** `go build -tags fts5 ./cmd/dina-core/` required for SQLite FTS5 support
- **go-sqlcipher v4.4.2** bundles SQLite 3.33.0 — no `unixepoch()` (use `strftime('%s','now')`)
- **Rate limit:** Default 60/min; tests need `DINA_RATE_LIMIT=100000`

### Test Infrastructure

#### 5-Tier Hierarchy

| Tier | Location | Env Var | Docker Containers | What it validates |
|------|----------|---------|--------------------|-------------------|
| **Unit** | `core/test/`, `brain/` | — | None | Pure logic, no I/O |
| **Integration** | `tests/integration/` (714 tests) | `DINA_INTEGRATION=docker` | 1× Core + 1× Brain | Core↔Brain contract, vault ops, persona isolation |
| **E2E** | `tests/e2e/` (110 tests) | `DINA_E2E=docker` | 4× Core+Brain (multi-node) | Cross-node scenarios: Don Alonso, Sancho, ChairMaker, Albert |
| **System** | `tests/system/` | via `run_user_story_tests.sh` | 2× Core+Brain + PDS + AppView + Postgres + PLC + Jetstream | 10 user stories, full stack end-to-end |
| **Release** | `tests/release/` (23 scenarios) | `DINA_RELEASE=docker` | Core + Brain + dummy-agent | Release validation (REL-001..REL-023), CLI testing via dummy-agent |

#### Running Tests

```bash
# --- Master runner (all 3 suites in sequence) ---
./run_all_tests.sh                    # Stops on first suite failure
./run_all_tests.sh --continue         # Run all suites even on failure
./run_all_tests.sh --only 2           # Run only user stories
./run_all_tests.sh --skip 3           # Skip release suite

# --- Individual suites ---
python scripts/test_status.py --restart       # Suite 1: Integration (builds Go, starts services, runs pytest)
./run_user_story_tests.sh --brief             # Suite 2: 10 user stories against multi-node stack
python scripts/test_release.py                # Suite 3: 23 release scenarios

# --- Direct pytest (needs services already running) ---
DINA_INTEGRATION=docker pytest tests/integration/    # Real HTTP clients
pytest tests/integration/                             # Mock mode (default)
./scripts/run_e2e_all.sh                               # E2E suite wrapper

# --- Selective user stories ---
./run_user_story_tests.sh --story 4            # Run only story 04 (Persona Wall)
./run_user_story_tests.sh --all                # Stories 01-10 (default: 01-05)
```

#### `test_status.py` — Unified Test Runner

The main orchestrator (`scripts/test_status.py`, ~68KB). Three service start modes:

| Mode | Method | When |
|------|--------|------|
| Local | `_start_local()` | Integration tests. Builds Go binary, starts uvicorn, provisions keys. |
| Docker | `_start_docker()` | `--docker` flag. Uses `DockerServices` class. |
| Main Stack | `_start_main_stack()` | E2E tests. Full compose with fake PLC. |

Local mode builds Go (`cd core && go build -tags fts5 -o dina-core ./cmd/dina-core`), provisions service keys via SLIP-0010, sets `DINA_TEST_MODE=1`, `DINA_RATE_LIMIT=100000`, health-checks both services, then runs pytest. Handles SIGINT/SIGTERM for cleanup.

#### Dual-Mode Fixture Pattern

`tests/integration/conftest.py` (859 lines) implements dual-mode fixtures:

```python
# Same test file runs against mocks (fast) or real Docker services (full contract validation)
if DINA_INTEGRATION == "docker":
    yield RealVault(core_url, headers)     # HTTP calls to running Go Core
else:
    yield MockVault()                       # In-memory dict, no I/O
```

60+ mock classes in `tests/integration/mocks/` with corresponding Real* counterparts: `RealVault`, `RealGoCore`, `RealPythonBrain`, `RealPIIScrubber`, `RealServiceAuth`, `RealAdminAPI`, `RealWebSocketClient`, `RealPairingManager`, `RealDockerCompose`.

#### Multi-Node E2E (`tests/e2e/conftest.py`)

4-actor setup, each a full Home Node:

| Actor | Role | Ring | Pre-populated data |
|-------|------|------|--------------------|
| Don Alonso | Primary user | 3 (owner) | Personas, devices, contacts, sharing policies, vault data, estate plan |
| Sancho | Trusted friend | 2 | Relationship data |
| ChairMaker | Vendor/seller | 3 | Product listings |
| Albert | Contact | 2 | Contact relationship |

Includes MockOpenClaw (50 emails, calendar events, web search results), MockReviewBot (trust 94), MockMaliciousBot (trust 12). `reset_node_state` fixture clears per-test mutable state while preserving session setup.

#### 10 User Stories (`run_user_story_tests.sh`)

| # | Story | Validates |
|---|-------|-----------|
| 01 | Purchase Journey | Product research → trust scoring → cart handover |
| 02 | Sancho Moment | Anti-Her: detects loneliness, nudges toward humans |
| 03 | Dead Internet Filter | Trust Network filters AI-generated content |
| 04 | Persona Wall | Cryptographic persona isolation |
| 05 | Agent Gateway | Autonomous agent intent → Dina approval/block |
| 06 | License Renewal | Subscription/license management |
| 07 | Daily Briefing | Silence First priority-based notification aggregation |
| 08 | Move to New Machine | Backup/restore, key migration |
| 09 | Connector Expiry | OAuth token refresh, connector lifecycle |
| 10 | Operator Journey | Multi-tenant operator managing multiple Dinas |

Docker isolation via `COMPOSE_PROJECT_NAME="dina-system-${SESSION_ID}"`. Port auto-allocation from 19300, steps by 500 on conflict, retries up to 5 times. Brief mode writes grouped logs to `/tmp/dina-user-story-*`.

#### System Tests (`tests/system/conftest.py`)

Full stack: 2× Core+Brain + PLC + PDS + Jetstream + AppView + Postgres via `docker-compose-system.yml`. `SystemServices` class manages lifecycle. `BrainSigner` extracts Core's Ed25519 private key from running container to sign requests. `seed_appview()` inserts test trust data directly into Postgres.

#### Release Tests (`tests/release/conftest.py`)

`DINA_RELEASE=docker` with `ReleaseDockerServices` + dummy-agent container. `agent_paired` fixture runs full pairing ceremony: generates Ed25519 keypair in container, writes CLI config, pairs via Core API (initiate → complete). 4 personas: personal, health, financial, consumer.

#### Key Patterns Across All Tiers

- **Session-scoped services**: Docker stacks start once per session, not per test
- **Persona setup as autouse fixture**: Every tier creates + unlocks + clears personas at session start
- **Health-check polling**: All services waited on via HTTP `/healthz` endpoints
- **Port conflict handling**: Auto-allocation with retry logic prevents CI collisions
- **Signal-safe cleanup**: Registered cleanup handlers survive SIGINT/SIGTERM
- **`DINA_RATE_LIMIT=100000`**: Disables rate limiting in test mode
- **`keygen-<actor>` init containers**: E2E/system compose files provision keys into named Docker volumes

## Project Structure

```
core/                   Go Home Node
  cmd/dina-core/          Composition root (main.go — single file, all wiring explicit)
  internal/
    adapter/              External adapters (SQLCipher, HTTP clients)
    config/               Configuration loading
    domain/               Domain types (vault items, personas, contacts)
    handler/              HTTP handlers (vault, DID, PII, admin)
    ingress/              Rate limiting, Dead Drop spool
    middleware/            Auth, logging, CORS
    port/                 Port interfaces (hexagonal architecture)
    service/              Business logic
    websocket/            Client WebSocket server
    reminder/             Notification/reminder service
  test/                   Go test files

brain/                  Python Brain (sidecar)
  src/
    main.py               Master FastAPI app (sub-mounts brain + admin)
    dina_brain/            Brain API sub-app (/api/*, Ed25519 service key auth)
    dina_admin/            Admin UI sub-app (/admin/*, CLIENT_TOKEN auth)
    adapter/               External adapters
    domain/                Domain types
    port/                  Port interfaces
    service/               Business logic
    infra/                 Infrastructure (LLM routing, embedding)

appview/                TypeScript AppView (Trust Network)
  src/
    ingester/              Jetstream firehose consumer
    scorer/                9 background scoring jobs
    web/                   5 xRPC API endpoints
    handlers/              19 record type handlers
    db/                    Drizzle ORM, PostgreSQL queries
    config/                Zod-validated config, constants, lexicons

cli/                    Python CLI (Ed25519 signed requests, pairing)
admin-cli/              Admin CLI (dina-admin)
scripts/                Test runner, utilities
tests/                  Integration + E2E tests
  integration/            714 integration tests (dual-mode: mock/docker)
  e2e/                    110 E2E tests
docs/                   Architecture docs, walkthroughs
  core-walkthrough.md     Detailed Go Core walkthrough
  brain-walkthrough.md    Detailed Python Brain walkthrough
  security-walkthrough.md Security model explained
  appview-walkthrough.md  Trust Network walkthrough
```

## Storage Architecture

### Vault Files (SQLCipher encrypted, per-persona)

```
/var/lib/dina/                        (inside container)
  identity.sqlite                      Tier 0: contacts, sharing policy, audit log, kv_store, device_tokens, dina_tasks
  vault/
    personal.sqlite                    Phase 1: all content here (single persona)
    health.sqlite                      Phase 2: per-persona files
    financial.sqlite
    ...
  keyfile                              Convenience mode only (raw master seed, chmod 600)
  wrapped_seed.bin                     Security mode (AES-256-GCM wrapped master seed)
  inbox/                               Dead Drop spool (encrypted blobs, locked state)
  config.json                          Gatekeeper tiers, settings
```

### Key Schema Tables

- **`identity.sqlite`**: `contacts`, `audit_log`, `kv_store`, `device_tokens`, `dina_tasks`, `crash_log`
- **Per-persona `.sqlite`**: `vault_items`, `vault_items_fts` (FTS5), `relationships`
- **Embeddings**: Stored as BLOBs in `vault_items` rows, hydrated into HNSW in-memory index on persona unlock

### Search Modes

| Mode | Engine | Best for |
|------|--------|----------|
| `fts5` | SQLite FTS5 (`unicode61 remove_diacritics 1`) | Exact keyword matching |
| `semantic` | In-memory HNSW (`coder/hnsw`, 768-dim cosine) | Fuzzy meaning-based matching |
| `hybrid` (default) | Both, merged | Most queries: `0.4 × FTS5_rank + 0.6 × cosine_similarity` |

## Common Gotchas

- **FTS5 build tag:** `go-sqlcipher` needs `-tags fts5` for FTS5 support
- **FTS5 query sanitization:** Hyphens in queries become NOT operators; wrap terms in quotes
- **`unixepoch()` not available:** SQLite <3.38 (go-sqlcipher bundles 3.33.0); use `CAST(strftime('%s','now') AS INTEGER)`
- **`WITHOUT ROWID` + FTS5:** Incompatible — FTS5 content tables need rowid
- **Rate limit:** Default 60/min; tests need `DINA_RATE_LIMIT=100000`
- **Go context keys:** Use typed `contextKey("agent_did")` not bare string — Go interface equality
- **Go build must run from `core/` directory:** `cd core && go build ./cmd/dina-core/`
- **Brain starts via:** `python -m uvicorn brain.src.main:app --port 18200`
- **PII must never reach stdout:** Log metadata only (persona, type, count, latency), never vault content or user queries
- **Service keys are load-only at runtime:** `EnsureExistingKey()` only — no `EnsureKey()` (generate-capable) exists

## Rules

- **No git commands.** Do not run any git commands (commit, push, checkout, etc.) unless the user explicitly asks.
- **Stay inside the project.** Never read, write, or modify files outside the `/Users/rajmohan/OpenSource/dina/` directory.
