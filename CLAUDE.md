# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Important:** Always consult `README.md` for the product vision and design philosophy, and `ARCHITECTURE.md` for the engineering blueprint. The deeper design docs live under `docs/` — notably `docs/PLUGIN_ARCHITECTURE.md`, `docs/AGENT_CONTROL_PLANE.md`, `docs/CONTACT_SERVICES_ARCHITECTURE.md`, and `docs/CURATION_SERVICES_ARCHITECTURE.md`. Every technical decision should align with the principles in README + ARCHITECTURE.

## What ships today

**Dina is a TypeScript codebase. The mobile app is the product.** The same `@dina/core`, `@dina/brain`, and `@dina/protocol` packages run on a phone (Expo/React Native, a full Home Node on-device) and on a server (Fastify, `apps/home-node-lite`). Only the platform adapters differ.

- **iOS: live on the App Store** (`https://apps.apple.com/app/id6781713799`). **Android: in progress.**
- **Local server:** `apps/home-node-lite` (two Fastify processes — Core `:8100`, Brain `:8200`).
- **External agents / CLI:** the Python `dina-agent` (`cli/`, published on PyPI) pairs with a Home Node.

**Legacy Go/Python stack (`legacy/`) is a reference oracle, not the product.** `legacy/go-core/` (Go Core) and `legacy/python-brain/` (Python Brain) are the mature original implementation, kept as a behavior oracle and runnable reference. **Do not add new product behavior to `legacy/`** unless explicitly maintaining the reference stack or a parity test. When this doc describes Go/Python specifics, they apply to the legacy stack only.

## Project Overview

**Dina** — The Architecture of Agency. Inspired by the novel *[UTOPAI](https://github.com/rajmohanutopai/utopai/blob/main/UTOPAI_2017_full.pdf)* (2012–2017).

Dina is a **sovereign personal AI** and the **user-owned authority / control plane for autonomous agents**. She is a digital extension of *your* will, interests, and values. She serves one master: the human who created her. Not advertisers, not platforms, not corporations. This singular loyalty naturally produces a "Pull Economy" where the agent fetches verified truth on demand instead of being fed ads.

Dina also solves a critical safety gap: autonomous agents today operate without oversight — leaking credentials, accepting commands from anyone, acting without guardrails. Any agent supporting the Dina protocol submits its **intent** to Dina before acting. Dina checks: does this violate your privacy rules? Is this vendor trusted? Are you in the right state to make this decision? Safe tasks pass through silently. Risky actions (sending email, moving money, sharing data) are flagged for your review. The agent never holds your keys, never sees your full history, and never acts without oversight. See `docs/AGENT_CONTROL_PLANE.md` for the "control plane for agents" framing (compose with MCP / A2A / Microsoft AGT rather than rebuild).

### The Four Laws

Every design decision must honour these:

1. **Silence First** — Never push content. Only speak when the human asked, or when silence would cause harm. Three priority levels: Fiduciary (interrupt — silence causes harm), Solicited (notify — user asked), Engagement (save for briefing — silence merely misses an opportunity).
2. **Verified Truth** — Rank by trust, not by ad spend. PeerLens replaces marketing.
3. **Absolute Loyalty** — The human holds the encryption keys. The agent cannot access the data without them. Loyalty is enforced by math, not by a privacy policy.
4. **Never Replace a Human** — Dina never simulates emotional intimacy. When the human needs connection, Dina connects them to other humans — never to herself.

### Core Principles

- **Anti-Her:** Dina must never become an emotional crutch. She connects you to humans, never replaces them.
- **Kernel, not Platform:** Dina is an orchestrator, not an omniscient brain. She delegates *doing* to specialist agents/services. **No untrusted code ever runs inside Dina's trust boundary.** External agents (OpenClaw, etc.) communicate via MCP; peers via D2D — neither touches the vault, keys, or personas.
- **Plugins are signed contracts, never in-process code.** The plugin substrate (`docs/PLUGIN_ARCHITECTURE.md`, `packages/core/src/plugins/*`, `packages/protocol/src/plugins/*`) preserves the kernel rule: a plugin is a signed, content-addressed manifest that runs *either* as **data** interpreted by a hardened first-party interpreter (a generalized `capability_runtime`), *or* as **code** out-of-process, paired as a device with its own Ed25519 key on a private lane (`plugin:<install_id>`). Plugins are **not agents** (a plugin is a bounded capability installed *into* Dina; an agent is an external reasoner acting *under* Dina's authority). Substrate is **P0 / not wired end-to-end** yet (no install/consent/uninstall routes or screens; repo-proof verifier unwired).
- **Sovereign Identity:** One root identity (`did:plc`), multiple **personas** as separate cryptographic compartments. Each persona is a separate encrypted database file with its own DEK. No external system can cross compartments.
- **Trust Rings:** Unverified → Verified (ZKP) → Verified + Actioned (transactions, time, peer attestation). Trust is a composite: `f(identity anchors, transaction history, outcome data, peer attestations, time)`.
- **Deep Link Default:** Dina credits sources — not just extracts. Creators get traffic, users get truth.
- **Cart Handover:** Dina advises on purchases but never touches money.
- **Agent Safety Layer:** Any agent acting on your behalf submits intent to Dina first.

## Architecture

Dina runs on a **Home Node** — the always-on private core that holds identity, memory, and policy. On mobile the whole Home Node runs **on-device**; on a server it runs as two Fastify processes. Other devices (laptop, browser, glasses) connect to a server Home Node. See `ARCHITECTURE.md` for the current engineering blueprint (a lean ~500-line doc; the old 310KB spec was retired).

### The stack

```
packages/protocol/   @dina/protocol — zero-dep wire contract: DID docs, D2D/RPC/auth envelopes,
                     capability + plugin schemas, canonical-signing builder, conformance vectors.
                     This is the compatibility law; any-language ports target it.
packages/core/       @dina/core — vault keeper domain (pure, transport-agnostic).
                     Vault + hybrid search, 4-tier gatekeeper, staging, D2D, workflow, service,
                     identity, crypto, memory/ToC, people, plugins substrate. No I/O of its own.
packages/brain/      @dina/brain — analyst/orchestrator (pure, headless). Ask/remember agentic
                     loops, LLM routing (+ PII scrub/rehydrate), silence classification, guard
                     scan / Anti-Her, service discovery, MCP delegation gate. Holds no keys.
packages/home-node/  @dina/home-node — shared composition helpers (wireWorkflowPlane, service
                     runtime, D2D sender) + a runtime contract. NOT the composition root.
packages/*-node/     Server adapters: storage-node (better-sqlite3-multiple-ciphers / SQLCipher v4),
                     crypto-node (@noble/* + libsodium + argon2), fs-node, net-node, keystore-node.
packages/*-expo/     Mobile adapters: storage-expo (op-sqlite), keystore-expo, fs/net-expo, and
                     crypto-expo (polyfills that let core's @noble crypto run on Hermes — no
                     adapter class; native Argon2id override).
packages/adapter-conformance/  Cross-adapter parity/conformance suite (node/expo must match).

apps/mobile/         Expo/React Native — a full Home Node on-device. Brain↔Core is InProcessTransport
                     (direct dispatch, no HTTP, no signing). Tabs: Chat, People, Network(PeerLens),
                     Activity; plus Reminders/Vault/Settings/Agents in a sheet.
apps/home-node-lite/ Server Home Node. core-server (:8100, vault keeper) + brain-server (:8200,
                     analyst, loopback-only). Brain↔Core is HttpCoreTransport (signed HTTP).
                     Optional web UI: /dev (chat SPA) and /web (the mobile app exported to RN-Web).
appview/             PeerLens AppView — Jetstream ingester + scorer jobs + xRPC. PostgreSQL (Drizzle).
msgbox/              Go relay — zero-knowledge sealed-box mailbox for NAT'd nodes (outbound WS).
cli/                 Python dina-agent — paired external agent/device (signing, MsgBox transport,
                     pairing, MCP server, agent-daemon).
services/plc/        Local did:plc directory helper (dev stub).
legacy/              Reference oracle: go-core/, python-brain/, admin-cli/, bin/, compose/.
```

### The Sidecar Pattern (both stacks)

- **Core is the vault keeper** — stores, retrieves, encrypts, enforces persona access + egress, signs, does D2D. Never interprets, never calls external APIs, never runs an LLM.
- **Brain is the analyst** — thinks, classifies, reasons, routes to LLMs, delegates via MCP. Never holds keys, never touches SQLite.
- **Brain is an untrusted tenant.** A compromised Brain can only reach open personas.
- **The boundary is enforced by runtime:** on a **server**, Core and Brain are two OS processes with separately bind-mounted keys, and every Brain→Core call carries an Ed25519 signed header. On **mobile**, both halves share one JS VM — the boundary is a typed import graph (`CoreClient` interface; `InProcessTransport` dispatches into `CoreRouter`), and no signing is used (it adds nothing when both halves run in the same VM). The handler-level gatekeeper (sensitive-persona unlock, audit log) runs regardless of transport.
- **The Core↔Brain contract** is the hand-written routes in `packages/core/src/server/routes/*` (validated by `__tests__/server/routes/*`), reached via the `CoreClient` interface (`packages/core/src/client/core-client.ts`) — NOT the legacy OpenAPI spec (see below).

### Key Data Flows

**Remember (ingest):** user → Brain orchestrator → `core.stagingIngest` → staging state machine (`received → classifying → {stored | pending_unlock | pending_approval}`) → agentic classify/route/link → vault store → topic-touch updates the working-memory ToC.

**Ask:** user → Brain agentic loop (`reasoning/agentic_loop.ts`) → intent classifier reads the ToC and picks sources (`vault | peerlens | provider_services | general_knowledge`) → tool calls (vault search, `find_person`, `search_peerlens`, `search_provider_services`, `query_service`, `delegate_to_agent`, …) → LLM (PII scrub on egress + rehydrate) → guard scan (Anti-Her always stripped) → answer. A tool returning `approval_required` serializes loop state and suspends (Pattern A); resumes with zero re-LLM cost after approval.

**Trust query:** Brain → AppView xRPC `com.dinakernel.peerlens.resolve` / `getProfile` → rating + recommendation (proceed/caution/verify/avoid).

**D2D:** send → egress 4-gate → Ed25519 sign + NaCl `crypto_box_seal` → WebSocket-first via MsgBox `/forward` (HTTP fallback, outbox retry). Receive → unseal → verify sig → **sender binding** (inner `from` must equal transport-authenticated DID) → replay cache → trust eval → stage-or-quarantine.

**Transport selection:** mobile `InProcessTransport` (direct); server `HttpCoreTransport` (signed HTTP); NAT'd/remote clients tunnel signed requests inside a NaCl sealed-box through MsgBox (`CoreRPCRequest` envelope).

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Core / Brain | TypeScript (`@dina/core`, `@dina/brain`) — pure, transport-agnostic | Vault keeper + analyst; run on mobile (Hermes) and server (Node ≥ 22 / Fastify) |
| Mobile | Expo / React Native | Full Home Node on-device (iOS live, Android in progress) |
| Server | Fastify (`apps/home-node-lite`) | Two-process Home Node (Core `:8100`, Brain `:8200`) |
| Wire contract | `@dina/protocol` (zero runtime deps) | Byte-exact envelopes + canonical signing + conformance vectors |
| Storage | SQLite + SQLCipher (AES-256, per page). Server: `better-sqlite3-multiple-ciphers`. Mobile: `op-sqlite`. | Encrypted per-persona vault files, each with its own DEK |
| Search | FTS5 (keyword) + in-RAM HNSW (semantic, hydrated on unlock) | Hybrid: `0.4 × FTS5 + 0.6 × cosine`, then PeerLens trust re-rank |
| Crypto | `@noble/*` (Ed25519/X25519/secp256k1/hashes) + libsodium (sealed box) + argon2 | Same pure-JS crypto on both platforms; byte-identical derivations |
| Identity | `did:plc` (AT Protocol), `did:web` escape hatch | Self-sovereign, key-rotatable identity |
| Key Mgmt | BIP-39 → SLIP-0010 (signing, `m/9999'`) + HKDF-SHA256 (per-persona vault DEKs) | Two independent branches from one master seed |
| LLM | Claude / OpenAI / Gemini / OpenRouter (BYOK). Local llama = named default, no real adapter yet. | Reasoning, classification; PII-scrubbed on egress, tiered primary/lite/heavy |
| Trust | AT Protocol community PDS + AppView | Decentralized PeerLens (19 `com.dinakernel.peerlens.*` lexicons) |
| Messaging | NaCl `crypto_box_seal` over WS/HTTPS via MsgBox relay | Dina-to-Dina encrypted P2P, offline-buffered |
| Agents | MCP (Model Context Protocol) | External agent communication (OpenClaw, etc.) |
| Plugins | Signed manifests: interpreted (data) or runner (out-of-process code, paired as device) | See `docs/PLUGIN_ARCHITECTURE.md`. P0 substrate, not wired end-to-end |
| PII | Regex + Presidio-style deterministic patterns + allow-list; Entity Vault for cloud LLM. NER V2. | Raw data never leaves the Home Node |
| Embedding | EmbeddingGemma / gemini-embedding-001 (768-dim) | Semantic search vectors |

## Security Model

### Authentication

All non-in-process hops into Core use **Ed25519 signed requests**. Canonical payload: `{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{NONCE}\n{SHA256_HEX(BODY)}`, sent as headers `X-DID`, `X-Timestamp`, `X-Nonce`, `X-Signature`. ±5-min timestamp window + nonce replay cache + per-DID rate limit, all fail-closed. The signed pipeline lives in `packages/core/src/auth/*`; the canonical builder is in `@dina/protocol`.

**Caller types** (`auth/caller_type.ts`) → **authz matrix** (`auth/authz.ts`, boundary-safe path-prefix rules):

| Caller | Who | Notes |
|--------|-----|-------|
| **service** | Brain / admin / connector (server split) | Per-service least privilege (e.g. brain: vault/msg/pii; connector: vault/store only). Not used on mobile (in-process, no signing). |
| **device** | Paired devices / user CLI | Registered during the pairing ceremony (`/v1/pair/initiate` admin + `/v1/pair/complete` public — the pairing code is the credential). |
| **agent** | Paired device with `role='agent'` | Subject to the deterministic persona-access gate; needs a grant for non-free personas. |
| **plugin** | Runner-mode plugin instance | Paired device, role `plugin`, own Ed25519 key, revocable. |

On **mobile**, the owner's in-app calls run in-process (`trustedInProcess`) and read every open persona directly — no signing. Agents/plugins are always gated regardless of transport.

### Persona Access Tiers (4-Tier Gatekeeper)

| Tier | Boot State | Owner | Brain | Agents | Example |
|------|-----------|-------|-------|--------|---------|
| **Default** | Auto-open | Free | Free | Free | `/general` |
| **Standard** | Auto-open | Free | Free | Session/durable grant | `/consumer`, `/social`, `/work` |
| **Sensitive** | Closed | Confirm | Approval | Approval | `/health` |
| **Locked** | Closed | Passphrase | Denied | Denied | `/financial` |

The single deterministic (non-LLM) check is `requireAgentPersonaAccess` (`packages/core/src/agent/access.ts`) — it fires **only for agent callers**. For a sensitive/locked persona with no grant it creates an **idempotent approval workflow task and returns without reading the vault** (the approval card carries agent DID + persona + scope, never contents). Grants are durable (`agent_persona_grants`, 1h TTL, persona-scoped, `write` satisfies `read`) and revoke on device revocation. Session-scoped grants (intent validation + `dina ask` vault reads) are keyed on `(agentDid, sessionId, …)` and cleared on session end / cold relaunch. Legacy tiers (open/restricted) auto-migrate on load.

### Key Architecture Decisions

- **Two derivation branches from one master seed** so a leaked vault DEK never yields a signing key: SLIP-0010 (Ed25519, hardened-only, purpose `9999'`) for the signing tree; HKDF-SHA256 over the raw seed for per-persona SQLCipher DEKs (`dina:vault:{persona}:v1`). DEKs are never stored (only a hash for validation).
- **Master seed at rest:** convenience mode = raw seed in `keyfile` (0600); security mode = AES-256-GCM-wrapped under an Argon2id-derived KEK.
- **Service keys are load-only at runtime** (fail-closed) on the server split. Core `m/9999'/3'/0'`, Brain `m/9999'/3'/1'`.
- **Brain never touches SQLite.** All vault access goes through Core.
- **Egress + persona gating happen in Core, in compiled code, before any external delegation** — no LLM in the enforcement path.
- Prompt-injection defense is **Tier 1 only** today (regex PII + guard scan); the rest of the layered defense is designed but unbuilt. Entity Vault provides defense-in-depth for cloud LLM calls.

## Build & Development

Prerequisites: **Node ≥ 22** (`nvm use` honours `.nvmrc`), then `npm install` at the repo root. No native build toolchain needed on macOS / Linux x64/arm64 (SQLCipher binaries ship prebuilt).

### Mobile app

```bash
cd apps/mobile
npm start            # Expo dev server. Press i for iOS, a for Android.
```

### Local Home Node server (home-node-lite)

```bash
npm install                                           # repo-root workspace install
cd apps/home-node-lite/core-server  && npm start      # Fastify Core, listens :8100
cd apps/home-node-lite/brain-server && npm start      # Fastify Brain, listens :8200 (loopback-only)
# Optional web UI: DINA_BRAIN_DEV_UI=1 (/dev chat) or DINA_BRAIN_WEB_UI=1 (/web = mobile app as RN-Web)
```

See `apps/home-node-lite/README.md` and `docs/HOME_NODE_LITE_TASKS.md` for the milestone roadmap (pre-M1; some boot steps are `'pending'`).

### External agent / CLI

```bash
pip install dina-agent        # or: cd cli && pip install -e .
dina configure                # pair with a Home Node using a dina1:… setup code from the app (Settings → Agents)
dina mcp-server               # expose the CLI to Claude Code / OpenClaw / Codex as MCP tools
```

### Workspace commands (from repo root)

```bash
npm test              # jest across every package + app
npm run typecheck     # composite tsc --build
npm run lint          # eslint across packages/ + apps/
npm run format        # prettier check
npm run audit:prod    # npm audit --omit=dev --audit-level=high
```

### `@dina/protocol` — the byte-exact wire contract

`packages/protocol/` is the independently consumable wire-format package. **Zero runtime deps** (no `dependencies` block; enforced by `__tests__/dep_hygiene.test.ts` — no `@dina/*` imports, no third-party runtime imports). Crypto is kept out via injected callbacks (e.g. `Ed25519VerifyFn`).

- **Wire types + helpers** — DID documents, D2D/RPC/auth envelopes, capability + **plugin** schemas; canonical-sign builder (`canonical_sign.ts`); envelope builders; validators.
- **Conformance spec** — `docs/conformance.md` pins the L1–L4 levels an implementation claims compliance against; `docs/features/` has per-feature guides.
- **12 frozen conformance vectors** under `conformance/vectors/`: ed25519 sign/verify, did:key derivation, canonical request string, SHA-256 body hash, BLAKE2b(24) sealed-box nonce, NaCl sealed-box, auth challenge/response, D2D envelope round-trip, PLC document, trust score v1, and two plugin vectors (`plugin_digests`, `plugin_release_rkey`).
- **Runnable self-check** — `conformance/suite.ts` + `conformance/http_harness.ts`.

Dina-language ports (Go / Rust / Swift / Kotlin / Python) target this package. Wire-format changes go through `packages/protocol/docs/conformance.md` §changelog and bump the protocol major.

### Legacy build (reference stack only)

The Go/Python reference stack lives under `legacy/` and builds via `legacy/bin/install.sh` (Docker Compose: `dina-core` Go, `dina-brain` Python + FastAPI, optional `llama`). Build Go Core from `legacy/go-core/` with `go build -tags fts5 ./cmd/dina-core/` (CGO + FTS5 required). Do not add new product behavior here.

### OpenAPI Contract — LEGACY (deprecated Go/Python stack only)

> ⚠️ `api/core-api.yaml` is **no longer the source of truth**. The live Core↔Brain contract for the TS product is the hand-written routes in `packages/core/src/server/routes/*` (validated by the `__tests__/server/routes/*` contract tests). The OpenAPI files + their `make generate` / `make check-generate` codegen exist only to keep the deprecated-stack types internally consistent; `@dina/protocol`'s generated `CoreAPI*` types are a legacy schema-conformance **test fixture**, not a runtime contract.

**Wire format:** all JSON uses `snake_case`.

## Test Infrastructure

**Primary (TS product):** `npm test` runs jest across every package + app. Notable suites: `packages/*/__tests__` (core/brain/protocol domain + route contracts), `packages/adapter-conformance` (node vs expo parity), and the Home Node Lite web E2E — Playwright + Gemini-judge human-perspective runs under `apps/home-node-lite/web/__e2e__/` (see `docs/E2E_TESTING.md`, `docs/E2E_TEST_PLAN.md`). MRS ("full-status") runners live under `scripts/test/`.

- **Rate limit:** default 60/min; tests need `DINA_RATE_LIMIT=100000`.
- **`scripts/test/run_all_tests.sh`** — `--unit-only` runs TS + legacy unit tests without Docker; bare form adds the Docker suites.

**Legacy (reference-stack Docker suites, Go+Python).** Still present for oracle validation:

| Tier | Location | Env Var | What it validates |
|------|----------|---------|-------------------|
| Integration | `tests/integration/` | `DINA_INTEGRATION=docker` | Core↔Brain contract, vault ops, persona isolation (dual-mode mock/docker) |
| E2E | `tests/e2e/` | `DINA_E2E=docker` | Multi-node: Don Alonso, Sancho, ChairMaker, Albert |
| System | `tests/system/` | via `run_user_story_tests.sh` | 10 user stories, full stack + AppView + PLC + Jetstream |
| Release | `tests/release/` | `DINA_RELEASE=docker` | REL-001..023, CLI via dummy-agent |
| Sanity | `tests/sanity/` | — | Real Telegram, OpenClaw (MCP), Gmail |

The 10 user stories (`run_user_story_tests.sh`): 01 Purchase Journey, 02 Sancho Moment (Anti-Her), 03 Dead Internet Filter, 04 Persona Wall, 05 Agent Gateway, 06 License Renewal, 07 Daily Briefing, 08 Move to New Machine, 09 Connector Expiry, 10 Operator Journey. Dual-mode fixtures (`tests/integration/conftest.py`) run against mocks (fast) or real Docker Go Core. `scripts/test_status.py` orchestrates the legacy local/docker/main-stack modes.

## Storage Architecture

### Vault Files (SQLCipher encrypted, per-persona)

Server layout (`/var/lib/dina/`, or the app's document dir on mobile via op-sqlite):

```
identity.sqlite      Tier 0: contacts, sharing policy, audit log, kv_store, device_tokens, dina_tasks
vault/
  personal.sqlite    default persona (Phase 1: single persona holds content)
  health.sqlite      per-persona files
  financial.sqlite
keyfile              convenience mode only (raw master seed, 0600)
wrapped_seed.bin     security mode (AES-256-GCM wrapped master seed)
inbox/               Dead Drop spool (encrypted blobs, arrives while locked)
config.json          gatekeeper tiers, settings
```

### Key Schema Tables

- **`identity.sqlite`**: `contacts`, `audit_log`, `kv_store`, `device_tokens`, `dina_tasks`, `crash_log`, plus workflow/grant/plugin tables (`agent_persona_grants`, plugin install/decision tables).
- **Per-persona `.sqlite`**: `vault_items`, `vault_items_fts` (FTS5), `vault_item_subjects` (person→item links), `relationships`.
- **Embeddings**: stored as BLOBs in `vault_items`, hydrated into an in-RAM HNSW index on persona unlock, destroyed on lock.

### Search Modes

| Mode | Engine | Best for |
|------|--------|----------|
| `fts5` | SQLite FTS5 (`unicode61 remove_diacritics 1`); tokens OR-joined so stop-words don't zero out NL queries | Exact keyword matching |
| `semantic` | In-RAM HNSW (768-dim cosine), brute-force fallback before the index is built | Fuzzy meaning-based matching |
| `hybrid` (default) | Both, merged, then PeerLens trust re-rank | `0.4 × FTS5 + 0.6 × cosine`, ×0.7 caveated / ×1.2 self-contact / ×0.6 low-confidence |

## Common Gotchas

### Cross-stack invariants (apply to the TS product)

- **Sealed-box nonce = BLAKE2b(24).** NOT truncated SHA-512 (a Go-only bug that broke interop with every libsodium binding). Any new encrypted-envelope flow must use BLAKE2b(24) — the frozen `blake2b_24_sealed_nonce` conformance vector pins this.
- **Never bypass the working-memory ToC.** Brain extracts topics/entities from ingested content (`enrichment/topic_touch_pipeline.ts`) and calls `core.memoryTouch`; the salience store + Table of Contents live in **Core** (`packages/core/src/memory/*`), and the intent classifier renders the ToC into its prompt before choosing sources. Brain only touches/reads it — don't recompute it Brain-side. (Note: there is **no EWMA in Brain**; salience math is Core-side.)
- **Contact preference model.** `live_capability` on topics is retired. Users assert preferences on contacts via `preferred_for: ["dentist", "transit", …]`; the resolver matches an utterance's role to a contact (`find_preferred_provider`) before falling back to public service discovery. Don't re-introduce `live_capability` — see `packages/core/src/contacts/*`.
- **MsgBox transport for NAT'd clients.** Requests tunnel signed HTTP-in-JSON inside a NaCl sealed-box over an outbound WebSocket to the relay. The CLI reads `DINA_MSGBOX_URL`, `DINA_HOMENODE_DID`, `DINA_TRANSPORT` (`direct`/`msgbox`/`auto`); route through `transport.select_transport(...)`, never raw `httpx` against `core_url`. Success responses must be encrypted (plaintext 2xx is refused outside dev/test).
- **RPC bridge forwards through the full handler chain**, not a raw mux — so auth/logging/rate-limit/body-limit run and the caller DID lands in context. Passing the raw mux is the classic "signed request → 401" bug.
- **`/api/v1/ask` is async.** Core returns 202 (`status: in_flight` + `request_id`) after a fast-path wait; poll `/api/v1/ask/<id>/status` until terminal (`complete` / `failed` / `expired` / `pending_approval`). Handle 202 the way the CLI does in `cli/src/dina_cli/main.py`.
- **PII must never reach stdout.** Log metadata only (persona, type, count, latency) — never vault content, queries, or plaintext.
- **Two derivations, one seed.** DEKs come from HKDF over the raw master seed; signing keys from the SLIP-0010 tree. Keep them independent; forbid BIP-44 purpose `44'`.

### FTS5 / SQLite

- **FTS5 query sanitization:** hyphens become NOT operators; sanitize/quote terms (`sanitizeFTSMatch`).
- **`WITHOUT ROWID` + FTS5** are incompatible — FTS5 content tables need a rowid.
- **`unixepoch()` unavailable** on bundled older SQLite; use `CAST(strftime('%s','now') AS INTEGER)`.

### Legacy stack only (`legacy/`)

- **FTS5 build tag:** `go-sqlcipher` needs `-tags fts5`; build from `legacy/go-core/`.
- **Brain starts via:** `cd legacy/python-brain && python -m uvicorn src.main:app --port 18200`.
- **Go context keys:** use typed `contextKey("agent_did")`, not a bare string.
- **Service keys load-only:** `EnsureExistingKey()` only — no generate-capable path.
- **`plc_probe` fails startup on DID drift** in test/dev — re-seed via `scripts/seed_test_identities.py`.
- **Provider-side Brain reloads `service_config` on a 60s poll** with backoff; don't wire single-shot config loads.

## Rules

- **No git writes — ever, unless explicitly asked in the moment.** Do not run `git commit`, `git push`, or any git write (branch, tag, reset, discarding checkout) unless the user explicitly requests it *in that turn*. This is the user's personal work; they control exactly when commits/pushes happen. A prior approval does not carry over — re-confirm each time. Read-only git (status, log, diff, fetch, pull) is fine.
- **Stay inside the project.** Never read, write, or modify files outside the project root (`/Users/rajmohan/OpenSource/dina2/dina/`).
- **Don't add new product behavior to `legacy/`.** It's a reference oracle; new work goes in `packages/` + `apps/`.
